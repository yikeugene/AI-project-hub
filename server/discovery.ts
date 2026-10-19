import { appError, errorMessage } from './validation.js';
import { DEFAULT_LOCALE, type Locale } from '../shared/i18n.js';
import { translateError } from '../shared/messages.js';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ScanCandidate, ScanResult } from '../shared/types.ts';
import { isLocalAbsolutePath, isWithinDirectory } from './commands.ts';

export interface ScanOptions { depth?: number; maxDirectories?: number; timeoutMs?: number }
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out',
  'target', 'bin', 'obj', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.tox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.next', '.nuxt', '.output',
  '.turbo', '.parcel-cache', '.yarn', '.pnpm-store', '.gradle', '.idea', '.vscode', '.vs',
  '.ai-project-hub', '$recycle.bin', 'system volume information',
]);
const PROJECT_MARKERS = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'pipfile', 'cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'mix.exs',
  'pubspec.yaml', 'cmakelists.txt', 'makefile', 'deno.json', 'deno.jsonc', 'project.godot',
]);
const MAX_ENTRIES = 100_000;
const MAX_WARNINGS = 100;

function filesystemCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Canonical on-disk spelling and realpath also collapse Windows case and junction aliases. */
export async function canonicalDirectory(input: string): Promise<string> {
  if (typeof input !== 'string' || !isLocalAbsolutePath(input)) {
    throw appError(400, 'path.localAbsolute');
  }
  try {
    const canonical = path.normalize(await realpath(input));
    if (!isLocalAbsolutePath(canonical)) throw appError(400, 'path.unsupported');
    if (!(await stat(canonical)).isDirectory()) throw appError(400, 'path.notDirectory');
    // normalize() retains a trailing separator: remove it, except on a filesystem root.
    return canonical.length > path.parse(canonical).root.length && canonical.endsWith(path.sep) ? canonical.slice(0, -1) : canonical;
  } catch (error) {
    const code = filesystemCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw appError(400, 'path.missing', { path: input });
    if (code === 'EACCES' || code === 'EPERM') throw appError(400, 'path.denied', { path: input });
    throw error;
  }
}

class ScanLimit extends Error {}
function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export async function scanProjects(input: string, options: ScanOptions = {}, locale: Locale = DEFAULT_LOCALE): Promise<ScanResult> {
  const depth = boundedInteger(options.depth ?? 4, 'Scan depth', 0, 12);
  const maxDirectories = boundedInteger(options.maxDirectories ?? 10_000, 'Directory limit', 1, 10_000);
  const timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 'Scan timeout', 1, 15_000);
  const deadline = Date.now() + timeoutMs;
  const result: ScanResult = { candidates: [], warnings: [], truncated: false, visited: 0 };
  const warn = (message: string) => { if (result.warnings.length < MAX_WARNINGS) result.warnings.push(message); };
  let directoryLimitWarned = false;
  const warnDirectoryLimit = () => {
    if (!directoryLimitWarned) warn(translateError('scan.directories', locale, { count: maxDirectories }));
    directoryLimitWarned = true;
  };
  const checkTime = () => { if (Date.now() >= deadline) throw new ScanLimit(translateError('scan.timeout', locale, { milliseconds: timeoutMs })); };
  // The race bounds slow filesystem requests too; outstanding reads cannot cause further traversal.
  const timed = async <T>(operation: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScanLimit(translateError('scan.timeout', locale, { milliseconds: timeoutMs }))), Math.max(0, remaining));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  let entriesRead = 0;
  try {
    const root = await timed(canonicalDirectory(input));
    const queue: { directory: string; level: number }[] = [{ directory: root, level: 0 }];
    const seen = new Set<string>();
    let position = 0;
    while (position < queue.length) {
      checkTime();
      if (result.visited >= maxDirectories) {
        result.truncated = true;
        warnDirectoryLimit();
        break;
      }
      const { directory, level } = queue[position++];
      try {
        const info = await timed(lstat(directory));
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        const canonical = await timed(realpath(directory));
        if (!isWithinDirectory(canonical, root) || seen.has(canonical)) continue;
        seen.add(canonical);
        result.visited++;
        let gitMarker = false;
        try {
          const git = await timed(lstat(path.join(canonical, '.git')));
          gitMarker = !git.isSymbolicLink() && (git.isDirectory() || git.isFile());
        } catch (error) { if (filesystemCode(error) !== 'ENOENT') throw error; }
        if (gitMarker) {
          result.candidates.push({ path: canonical, name: path.basename(canonical) || canonical, kind: 'git', markers: ['.git'] });
          continue; // Never discover packages or submodules inside an existing project.
        }
        const available = Math.max(0, maxDirectories - result.visited - (queue.length - position));
        // Stream entries instead of allocating an unbounded readdir() array.
        const readDirectory = async () => {
          const handle = await opendir(canonical, { bufferSize: 64 });
          const markers: string[] = [];
          const children: string[] = [];
          let omittedChildren = false;
          try {
            while (true) {
              checkTime();
              const entry = await handle.read();
              if (!entry) break;
              if (++entriesRead > MAX_ENTRIES) throw new ScanLimit(translateError('scan.entries', locale, { count: MAX_ENTRIES }));
              if (entry.isSymbolicLink()) continue;
              const name = entry.name.toLowerCase();
              if (entry.isFile() && (PROJECT_MARKERS.has(name) || /\.(sln|slnx|csproj|fsproj|vbproj)$/.test(name))) {
                markers.push(entry.name);
              }
              if (level < depth && entry.isDirectory() && !SKIP_DIRECTORIES.has(name)) {
                if (children.length < available) children.push(entry.name);
                else omittedChildren = true;
              }
            }
          } finally { await handle.close(); }
          return { markers, children, omittedChildren };
        };
        const { markers, children, omittedChildren } = await timed(readDirectory());
        if (markers.length) {
          result.candidates.push({ path: canonical, name: path.basename(canonical) || canonical, kind: 'project', markers: markers.sort() });
          continue;
        }
        if (omittedChildren) {
          result.truncated = true;
          warnDirectoryLimit();
        }
        for (const child of children.sort()) queue.push({ directory: path.join(canonical, child), level: level + 1 });
      } catch (error) {
        if (error instanceof ScanLimit) throw error;
        warn(translateError('scan.skipped', locale, { path: directory, detail: error instanceof Error ? errorMessage(error, locale) : translateError('scan.unreadable', locale) }));
      }
    }
  } catch (error) {
    if (!(error instanceof ScanLimit)) throw error;
    result.truncated = true;
    warn(error.message);
  }
  result.candidates.sort((a: ScanCandidate, b: ScanCandidate) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}
