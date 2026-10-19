import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Lookups never ask a shell, search '.', or resolve relative PATH entries. */
export interface ExecutableLookupOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  extraDirectories?: string[];
  excludeDirectory?: string;
}

export function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const actual = Object.keys(env).find((entry) => entry.toLowerCase() === key.toLowerCase());
  return actual ? env[actual] : undefined;
}

export function isWithinDirectory(candidate: string, directory: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const relative = paths.relative(normalize(directory), normalize(candidate));
  return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
}

export function isLocalAbsolutePath(value: string, platform = process.platform): boolean {
  if (!value || value.includes('\0') || /^[\\/]{2}/.test(value)) return false;
  return platform === 'win32' ? /^[a-z]:[\\/]/i.test(value) : path.posix.isAbsolute(value);
}

export function trustedPathDirectories(env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const entries = (environmentValue(env, 'PATH') ?? '').split(paths.delimiter);
  return [...new Set(entries.map((entry) => entry.replace(/^"(.*)"$/, '$1'))
    .filter((entry) => isLocalAbsolutePath(entry, platform)).map((entry) => paths.normalize(entry)))];
}

export async function findTrustedExecutable(names: string[], options: ExecutableLookupOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  // Names are supplied by our code, not API requests. Guard this boundary too.
  if (names.some((name) => !/^[a-zA-Z0-9._ -]+$/.test(name) || name === '.' || name === '..')) {
    throw new Error('Executable lookup requires a fixed file name.');
  }
  const directories = [...(options.extraDirectories ?? []), ...trustedPathDirectories(env, platform)];
  const excluded = [process.cwd(), options.excludeDirectory].filter((entry): entry is string => Boolean(entry));
  const excludedCanonical = await Promise.all(excluded.map(async (entry) => {
    try { return await realpath(entry); } catch { return entry; }
  }));
  const seen = new Set<string>();
  for (const directory of directories) {
    if (!isLocalAbsolutePath(directory, platform)) continue;
    for (const name of names) {
      const candidate = paths.join(directory, name);
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || excluded.some((root) => isWithinDirectory(candidate, root, platform))) continue;
      seen.add(key);
      try {
        const canonical = await realpath(candidate);
        if (!isLocalAbsolutePath(canonical, platform)
          || excludedCanonical.some((root) => isWithinDirectory(canonical, root, platform))) continue;
        if (!(await stat(canonical)).isFile()) continue;
        await access(canonical, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return canonical;
      } catch { /* A missing/inaccessible PATH entry is not a capability. */ }
    }
  }
  return null;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface CommandResult { stdout: string; stderr: string; code: number }

/** A bounded, non-shell child process. Nonzero exit codes are returned to the caller. */
export function runCommand(executable: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new Error('Command limits must be positive.'));
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }
    let finished = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* Still reject promptly if the process already exited. */ }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Command timed out after ${Math.ceil(timeoutMs)} ms.`)), timeoutMs);
    const collect = (target: Buffer[]) => (data: Buffer) => {
      if (finished) return;
      bytes += data.length;
      if (bytes > maxOutputBytes) { fail(new Error('Command exceeded the output limit.')); return; }
      target.push(data);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.stdout?.once('error', fail);
    child.stderr?.once('error', fail);
    child.once('error', (error) => fail(new Error(`Cannot start command: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === null) { reject(new Error(`Command terminated${signal ? ` (${signal})` : ''}.`)); return; }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code });
    });
  });
}
