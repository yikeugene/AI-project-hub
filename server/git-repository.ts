import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { GitSnapshot } from '../shared/types.ts';
import { GIT_READ_ONLY_ARGS, parseGitLog, parseGitStatus } from './git.ts';
import { GitOperationError } from './git-errors.ts';
import { isLocalAbsolutePath, isWithinDirectory } from './commands.ts';
import { isolatedGitEnvironment, resolveGitTools, type GitTools } from './git-tools.ts';
import { runGitProcess, type GitProcessResult } from './git-process.ts';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
export const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function text(bytes: Buffer): string { try { return utf8.decode(bytes); } catch { throw new GitOperationError('unsupported', 'Non-UTF-8 Git paths are not supported for writing.'); } }
export function digest(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
export function objectId(format: 'sha1' | 'sha256', type: string, content: Buffer): string { return createHash(format).update(`${type} ${content.length}\0`).update(content).digest('hex'); }
export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
export async function exists(filename: string): Promise<boolean> { try { await lstat(filename); return true; } catch (error) { if (missing(error)) return false; throw error; } }
export async function boundedFile(filename: string, maximum = MAX_FILE_BYTES): Promise<Buffer | null> {
  let before;
  try { before = await lstat(filename); } catch (error) { if (missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new GitOperationError('unsupported', 'Linked or non-regular files are not supported.');
  if (before.size > maximum) throw new GitOperationError('unsupported', 'The Git data exceeds the supported size.');
  const handle = await open(filename, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw new GitOperationError('stale');
    const bytes = Buffer.alloc(Math.min(maximum + 1, opened.size + 1));
    let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await handle.stat();
    if (size > maximum || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new GitOperationError('stale');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
export function literalPath(value: string): string {
  if (!value || value.length > 4096 || value.includes('\0') || path.isAbsolute(value) || /^[a-z]:/i.test(value) || value.startsWith('/')) throw new GitOperationError('invalid');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^\.git(?:[ .]|$)/i.test(part))) throw new GitOperationError('invalid');
  if (process.platform === 'win32' && (value.includes('\\') || parts.some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new GitOperationError('unsupported', 'This path cannot be represented safely on Windows.');
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new GitOperationError('invalid');
  return value;
}
export interface FrozenFile { path: string; bytes: string | null; mode: string | null }
export async function freezeFile(directory: string, relative: string, fileMode = true): Promise<FrozenFile> {
  literalPath(relative);
  const parts = relative.split('/');
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new GitOperationError('unsupported'); }
    catch (error) { if (missing(error)) return { path: relative, bytes: null, mode: null }; throw error; }
  }
  const filename = path.join(directory, ...parts);
  const bytes = await boundedFile(filename);
  if (!bytes) return { path: relative, bytes: null, mode: null };
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new GitOperationError('stale');
  return { path: relative, bytes: bytes.toString('base64'), mode: fileMode && (info.mode & 0o111) !== 0 ? '100755' : '100644' };
}
export interface IndexEntry { path: string; mode: string; oid: string }
export interface RefEntry { name: string; oid: string; symbolic: string }
export interface RepositoryIdentity { directory: string; gitDir: string; commonDir: string; objectDir: string; key: string; identity: string; format: 'sha1' | 'sha256' }
export interface Repository extends RepositoryIdentity {
  tools: GitTools; config: Map<string, string[]>; configDigest: string; head: string | null; symbolicHead: string | null;
  refs: RefEntry[]; index: Buffer | null; indexDigest: string; entries: IndexEntry[]; unsupported: string[]; operationState: string | null;
}
export const SAFE_ARGS = [...GIT_READ_ONLY_ARGS, '-c', 'core.quotePath=false', '-c', 'diff.external=', '-c', 'core.pager=', '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true'];
export function configKey(key: string): string { const parts = key.split('.'); return parts.length > 2 ? `${parts[0].toLowerCase()}.${parts.slice(1, -1).join('.')}.${parts.at(-1)!.toLowerCase()}` : key.toLowerCase(); }
export function value(config: Map<string, string[]>, key: string): string | undefined { return config.get(configKey(key))?.at(-1); }
export function enabled(value: string | undefined): boolean { return value !== undefined && !/^(false|no|off|0)$/i.test(value); }

export async function rawGit(repo: Pick<Repository, 'tools' | 'directory' | 'gitDir'>, args: string[], allowFailure = false): Promise<GitProcessResult> {
  const result = await runGitProcess(repo.tools, [...SAFE_ARGS, `--git-dir=${repo.gitDir}`, `--work-tree=${repo.directory}`, ...args], {
    cwd: repo.directory, env: isolatedGitEnvironment(repo.tools), readOnly: true, maxOutputBytes: MAX_TOTAL_BYTES,
  });
  if (result.code && !allowFailure) throw new GitOperationError('failed', 'Cannot read the repository.');
  return result;
}
async function noLink(filename: string, directory = true): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new GitOperationError('unsupported');
}
async function ordinaryStorage(root: string, maximum = 20_000): Promise<boolean> {
  const queue = [root]; let count = 0;
  while (queue.length) {
    const directory = queue.pop()!;
    const info = await lstat(directory).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > maximum || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) return false;
      if (entry.isDirectory()) queue.push(path.join(directory, entry.name));
    }
  }
  return true;
}
export async function openRepository(input: string): Promise<Repository> {
  if (!isLocalAbsolutePath(input)) throw new GitOperationError('unsafe');
  const tools = await resolveGitTools();
  let directory: string;
  try { directory = await realpath(input); await noLink(directory); } catch { throw new GitOperationError('unavailable'); }
  if ([tools.git, tools.credential, tools.host, tools.hooks].some(filename => filename && isWithinDirectory(filename, directory))) throw new GitOperationError('unsafe');
  const marker = path.join(directory, '.git');
  const markerInfo = await lstat(marker).catch(() => null);
  if (!markerInfo || markerInfo.isSymbolicLink() || (!markerInfo.isDirectory() && !markerInfo.isFile())) throw new GitOperationError('unavailable');
  const run = async (args: string[]) => {
    const result = await runGitProcess(tools, [...SAFE_ARGS, ...args], { cwd: directory, env: isolatedGitEnvironment(tools), readOnly: true });
    if (result.code) throw new GitOperationError('unavailable');
    return text(result.stdout).replace(/\r?\n$/, '');
  };
  if (/[\r\n]/.test(directory)) throw new GitOperationError('unsupported');
  const top = await realpath(await run(['rev-parse', '--show-toplevel']));
  if (!isWithinDirectory(top, directory) || !isWithinDirectory(directory, top)) throw new GitOperationError('unavailable');
  const gitDir = await realpath(await run(['rev-parse', '--absolute-git-dir']));
  const commonDir = await realpath(await run(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  await noLink(gitDir); await noLink(commonDir);
  const format = await run(['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') throw new GitOperationError('unsupported');
  const objectDir = path.join(commonDir, 'objects');
  await noLink(objectDir);
  const key = process.platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  const identities = await Promise.all([directory, gitDir, commonDir, objectDir].map(async filename => { const info = await stat(filename); return [filename, info.dev, info.ino, info.birthtimeMs]; }));
  const identity = digest(JSON.stringify([identities, markerInfo.isFile() ? (await boundedFile(marker, 16384))?.toString('base64') : 'directory']));
  const base = { tools, directory, gitDir };
  const configResult = await runGitProcess(tools, ['config', '--null', '--list', '--includes'], { cwd: directory, env: isolatedGitEnvironment(tools, true), readOnly: true });
  if (configResult.code) throw new GitOperationError('unsafe');
  const config = new Map<string, string[]>();
  for (const record of text(configResult.stdout).split('\0').filter(Boolean)) {
    const at = record.indexOf('\n'), key = configKey(at < 0 ? record : record.slice(0, at));
    const values = config.get(key) ?? [];
    values.push(at < 0 ? '' : record.slice(at + 1)); config.set(key, values);
  }
  const unsupported: string[] = [];
  if (![directory, gitDir, commonDir, objectDir].every(item => isLocalAbsolutePath(item))) unsupported.push('objectLayout');
  for (const storage of [objectDir, path.join(commonDir, 'refs'), path.join(commonDir, 'logs'), path.join(gitDir, 'logs')]) {
    if (!await ordinaryStorage(storage)) unsupported.push('objectLayout');
  }
  for (const filename of [path.join(gitDir, 'HEAD'), path.join(commonDir, 'packed-refs'), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')]) {
    const info = await lstat(filename).catch(() => null);
    if (info && (info.isSymbolicLink() || !info.isFile())) unsupported.push('objectLayout');
  }
  const unsafeKeys = /^(?:core\.(?:sshcommand|gitproxy)|ssh\.|url\..*\.(?:insteadof|pushinsteadof)$|remote\..*\.(?:uploadpack|receivepack|proxy|vcs|partialclonefilter)$|http(?:\..+)?\.(?:proxy|extraheader|cookiefile|savecookies|sslcert|sslkey|sslcainfo|sslcapath)$)/;
  if ([...config].some(([key, values]) => unsafeKeys.test(key) && values.some(Boolean))) unsupported.push('customHelpers');
  if ([...config].some(([key, values]) => /^(?:commit|tag)\.gpgsign$/.test(key) && enabled(values.at(-1)))) unsupported.push('signing');
  if (value(config, 'core.fsmonitor') && enabled(value(config, 'core.fsmonitor'))) unsupported.push('fsmonitor');
  if (enabled(value(config, 'core.prefersymlinkrefs'))) unsupported.push('objectLayout');
  if (['core.sparsecheckout', 'index.sparse', 'core.splitindex'].some(key => enabled(value(config, key)))) unsupported.push('specialIndex');
  if ([...config].some(([key, values]) => key === 'extensions.partialclone' || /remote\..*\.promisor/.test(key) && enabled(values.at(-1)))) unsupported.push('partialClone');
  if (value(config, 'extensions.refstorage') && value(config, 'extensions.refstorage') !== 'files') unsupported.push('refStorage');
  if ([...config].some(([key, values]) => /^http(?:\..+)?\.sslverify$/.test(key) && !enabled(values.at(-1)))) unsupported.push('tls');
  const hooks = value(config, 'core.hookspath');
  if (hooks && hooks !== '/dev/null') unsupported.push('hooks');
  if (!hooks) {
    const hookDir = path.join(commonDir, 'hooks');
    const hookInfo = await lstat(hookDir).catch(() => null);
    if (hookInfo?.isSymbolicLink()) unsupported.push('hooks');
    else if (hookInfo?.isDirectory()) {
      for (const filename of await readdir(hookDir)) {
        if (filename.endsWith('.sample')) continue;
        const info = await lstat(path.join(hookDir, filename));
        if (info.isSymbolicLink() || info.isFile() && (process.platform === 'win32' || (info.mode & 0o111) !== 0)) { unsupported.push('hooks'); break; }
      }
    }
  }
  for (const relative of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) if (await exists(path.join(commonDir, relative))) unsupported.push('objectLayout');
  const packs = await readdir(path.join(objectDir, 'pack')).catch(() => []);
  if (packs.some(filename => filename.endsWith('.promisor'))) unsupported.push('partialClone');
  const operationFiles = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG'];
  let operationState: string | null = null;
  for (const filename of operationFiles) if (await exists(path.join(gitDir, filename))) { operationState = filename; break; }
  const symbolic = await rawGit(base, ['symbolic-ref', '--no-recurse', '-q', 'HEAD'], true);
  if (symbolic.code !== 0 && symbolic.code !== 1) throw new GitOperationError('failed');
  const symbolicHead = symbolic.code === 0 ? text(symbolic.stdout).trimEnd() : null;
  const headResult = await rawGit(base, ['rev-parse', '--verify', 'HEAD'], true);
  const head = headResult.code === 0 ? text(headResult.stdout).trim() : null;
  if (head !== null && !OID.test(head)) throw new GitOperationError('unsafe');
  if (head === null && !symbolicHead) throw new GitOperationError('unsafe');
  const refsResult = await rawGit(base, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/']);
  const refs: RefEntry[] = text(refsResult.stdout).split('\n').filter(Boolean).map(record => {
    const [name, oid, symbolic] = record.replace(/\r$/, '').split('\0');
    if (!name || !OID.test(oid) || symbolic === undefined) throw new GitOperationError('unsafe');
    return { name, oid, symbolic };
  });
  if (refs.some(ref => ref.name.startsWith('refs/replace/'))) unsupported.push('replaceRefs');
  const index = await boundedFile(path.join(gitDir, 'index'), MAX_TOTAL_BYTES);
  const entries: IndexEntry[] = [];
  if (index) {
    const checksumLength = format === 'sha1' ? 20 : 32;
    if (index.length < 12 + checksumLength || index.subarray(0, 4).toString() !== 'DIRC') throw new GitOperationError('unsafe');
    if (!createHash(format).update(index.subarray(0, -checksumLength)).digest().equals(index.subarray(-checksumLength))) throw new GitOperationError('unsafe');
    if (index.readUInt32BE(4) !== 2) unsupported.push('indexVersion');
  }
  const listed = await rawGit(base, ['ls-files', '--stage', '-z']);
  for (const record of text(listed.stdout).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || !OID.test(match[2])) throw new GitOperationError('unsafe');
    if (match[3] !== '0') unsupported.push('conflicts');
    if (!['100644', '100755'].includes(match[1])) unsupported.push('specialFiles');
    entries.push({ mode: match[1], oid: match[2], path: match[4] });
  }
  const flags = await rawGit(base, ['ls-files', '-v', '-z']);
  if (text(flags.stdout).split('\0').filter(Boolean).some(record => record[0] !== 'H')) unsupported.push('indexFlags');
  if (index && index.readUInt32BE(4) === 2) {
    let offset = 12;
    const count = index.readUInt32BE(8), hashBytes = format === 'sha1' ? 20 : 32;
    for (let i = 0; i < count; i++) {
      const start = offset;
      if (offset + 42 + hashBytes > index.length - hashBytes) throw new GitOperationError('unsafe');
      const flags = index.readUInt16BE(offset + 40 + hashBytes);
      if ((flags & 0xc000) !== 0) unsupported.push('indexFlags');
      const end = index.indexOf(0, offset + 42 + hashBytes);
      if (end < 0) throw new GitOperationError('unsafe');
      offset = start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    while (offset < index.length - hashBytes) {
      if (offset + 8 > index.length - hashBytes) throw new GitOperationError('unsafe');
      const signature = index.subarray(offset, offset + 4).toString('ascii');
      const size = index.readUInt32BE(offset + 4);
      if (!/^[A-Z]/.test(signature)) unsupported.push('indexExtension');
      offset += 8 + size;
    }
    if (offset !== index.length - hashBytes) throw new GitOperationError('unsafe');
  }
  return { ...base, commonDir, objectDir, key, identity, format, config, configDigest: digest(configResult.stdout), head, symbolicHead, refs, index, indexDigest: digest(index ?? 'absent'), entries, unsupported: [...new Set(unsupported)], operationState };
}

export interface AttributeFiles { files: FrozenFile[]; info: string | null; global: string | null; exclude: string | null; globalExclude: string | null }
async function configuredRules(repo: Repository, key: string, defaultName: string): Promise<Buffer | null> {
  const setting = value(repo.config, key);
  let filename: string;
  if (setting !== undefined) {
    if (!setting || setting === '/dev/null') return null;
    if (setting.length > 4096 || setting.includes('\0')) throw new GitOperationError('unsupported');
    const output = (await rawGit(repo, ['-c', `${key}=${setting}`, 'config', '--null', '--path', '--get', key])).stdout;
    if (!output.length || output.at(-1) !== 0) throw new GitOperationError('unsafe');
    filename = path.resolve(repo.directory, text(output.subarray(0, -1)));
  } else {
    const home = process.env.HOME || process.env.USERPROFILE;
    const configHome = process.env.XDG_CONFIG_HOME || (home && path.join(home, '.config'));
    if (!configHome) return null;
    filename = path.join(configHome, 'git', defaultName);
  }
  if (!isLocalAbsolutePath(filename)) throw new GitOperationError('unsupported');
  return await boundedFile(filename, 1024 * 1024);
}
export async function captureAttributes(repo: Repository, paths: string[]): Promise<AttributeFiles> {
  const names = new Set(['.gitattributes']);
  for (const name of paths) {
    literalPath(name);
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) names.add(`${parts.slice(0, i).join('/')}/.gitattributes`);
  }
  if (names.size > 2000) throw new GitOperationError('unsupported');
  const files: FrozenFile[] = [];
  for (const name of [...names].sort()) files.push(await freezeFile(repo.directory, name, false));
  const global = await configuredRules(repo, 'core.attributesfile', 'attributes');
  const globalExclude = await configuredRules(repo, 'core.excludesfile', 'ignore');
  const info = await boundedFile(path.join(repo.commonDir, 'info/attributes'), 1024 * 1024);
  const exclude = await boundedFile(path.join(repo.commonDir, 'info/exclude'), 1024 * 1024);
  const result = { files, info: info?.toString('base64') ?? null, global: global?.toString('base64') ?? null, exclude: exclude?.toString('base64') ?? null, globalExclude: globalExclude?.toString('base64') ?? null };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new GitOperationError('unsupported');
  return result;
}
export interface GitView {
  root: string; gitDir: string; worktree: string; indexPath: string; env: NodeJS.ProcessEnv; args: string[];
  git(args: string[], input?: Buffer | string, allowFailure?: boolean, limit?: number): Promise<GitProcessResult>;
  dispose(): Promise<void>;
}
export async function createGitView(repo: Repository, attributes: AttributeFiles, frozenWorktree = false): Promise<GitView> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-git-view-'));
  const gitDir = path.join(root, 'git'), worktree = frozenWorktree ? path.join(root, 'worktree') : repo.directory;
  try {
    await mkdir(path.join(gitDir, 'objects'), { recursive: true });
    await mkdir(path.join(gitDir, 'refs'), { recursive: true });
    await mkdir(path.join(gitDir, 'info'), { recursive: true });
    if (frozenWorktree) {
      await mkdir(worktree);
      for (const file of attributes.files) if (file.bytes !== null) {
        const destination = path.join(worktree, ...file.path.split('/'));
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, Buffer.from(file.bytes, 'base64'));
      }
    }
    if (attributes.info !== null) await writeFile(path.join(gitDir, 'info/attributes'), Buffer.from(attributes.info, 'base64'));
    if (attributes.exclude !== null) await writeFile(path.join(gitDir, 'info/exclude'), Buffer.from(attributes.exclude, 'base64'));
    const global = path.join(root, 'attributes');
    await writeFile(global, Buffer.from(attributes.global ?? '', 'base64'));
    const globalExclude = path.join(root, 'excludes');
    await writeFile(globalExclude, Buffer.from(attributes.globalExclude ?? '', 'base64'));
    await writeFile(path.join(gitDir, 'HEAD'), repo.symbolicHead ? `ref: ${repo.symbolicHead}\n` : `${repo.head}\n`);
    await writeFile(path.join(gitDir, 'packed-refs'), '# pack-refs with: sorted\n' + repo.refs.map(ref => `${ref.oid} ${ref.name}\n`).join(''));
    for (const ref of repo.refs.filter(ref => ref.symbolic)) {
      if (!ref.name.startsWith('refs/') || ref.name.split('/').some(part => !part || part === '..')) throw new GitOperationError('unsafe');
      await mkdir(path.dirname(path.join(gitDir, ref.name)), { recursive: true });
      await writeFile(path.join(gitDir, ref.name), `ref: ${ref.symbolic}\n`);
    }
    await writeFile(path.join(gitDir, 'config'), `[core]\n\trepositoryformatversion = ${repo.format === 'sha256' ? 1 : 0}\n\tbare = false\n${repo.format === 'sha256' ? '[extensions]\n\tobjectformat = sha256\n' : ''}`);
    const indexPath = path.join(gitDir, 'index');
    if (repo.index) await writeFile(indexPath, repo.index);
    const overrides: string[] = [];
    for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.filemode', 'core.ignorecase']) {
      const setting = value(repo.config, key);
      if (setting !== undefined) overrides.push('-c', `${key}=${setting}`);
    }
    const args = [...SAFE_ARGS, '-c', `core.attributesFile=${global}`, '-c', `core.excludesFile=${globalExclude}`, ...overrides, `--git-dir=${gitDir}`, `--work-tree=${worktree}`];
    const env = { ...isolatedGitEnvironment(repo.tools), GIT_OBJECT_DIRECTORY: repo.objectDir, GIT_INDEX_FILE: indexPath };
    return {
      root, gitDir, worktree, indexPath, args, env,
      async git(commands, input, allowFailure = false, limit = MAX_TOTAL_BYTES) {
        const result = await runGitProcess(repo.tools, [...args, ...commands], { cwd: root, env, readOnly: true, maxOutputBytes: limit }, input);
        if (result.code && !allowFailure) throw new GitOperationError('failed', 'The safe Git command was refused.');
        return result;
      },
      async dispose() { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); },
    };
  } catch (error) { await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined); throw error; }
}
export async function readSnapshot(repo: Repository, attributes: AttributeFiles): Promise<GitSnapshot> {
  const view = await createGitView(repo, attributes);
  try {
    const status = parseGitStatus(text((await view.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-ahead-behind'])).stdout), true);
    const commits = repo.head ? parseGitLog(text((await view.git(['log', '--max-count=12', '--no-show-signature', '--no-decorate', '--no-color', '--format=%H%x00%h%x00%s%x00%cI%x00', repo.head, '--'])).stdout)) : [];
    return { ...status, isRepo: true, branches: repo.refs.filter(ref => ref.name.startsWith('refs/heads/')).map(ref => ref.name.slice(11)), commits, lastCommitAt: commits[0]?.date ?? null, observedAt: new Date().toISOString() };
  } finally { await view.dispose(); }
}

export function serializeIndex(repo: Repository, entries = repo.entries): Buffer {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const result: Buffer[] = [header];
  for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    const filename = Buffer.from(entry.path), hash = Buffer.from(entry.oid, 'hex');
    const buffer = Buffer.alloc(Math.ceil((42 + hash.length + filename.length + 1) / 8) * 8);
    buffer.writeUInt32BE(parseInt(entry.mode, 8), 24); hash.copy(buffer, 40);
    buffer.writeUInt16BE(Math.min(filename.length, 0xfff), 40 + hash.length); filename.copy(buffer, 42 + hash.length); result.push(buffer);
  }
  const content = Buffer.concat(result); return Buffer.concat([content, createHash(repo.format).update(content).digest()]);
}
export function treeId(format: 'sha1' | 'sha256', entries: IndexEntry[]): string {
  interface Tree { files: Map<string, IndexEntry>; children: Map<string, Tree> }
  const make = (): Tree => ({ files: new Map(), children: new Map() });
  const root = make();
  for (const entry of entries) {
    literalPath(entry.path); const parts = entry.path.split('/'); let tree = root;
    for (const part of parts.slice(0, -1)) { if (!tree.children.has(part)) tree.children.set(part, make()); tree = tree.children.get(part)!; }
    if (tree.files.has(parts.at(-1)!)) throw new GitOperationError('unsupported');
    tree.files.set(parts.at(-1)!, entry);
  }
  const hash = (tree: Tree): string => {
    const records = [...tree.files].map(([name, entry]) => ({ key: name, name, mode: entry.mode, oid: entry.oid }));
    for (const [name, child] of tree.children) records.push({ key: `${name}/`, name, mode: '40000', oid: hash(child) });
    records.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    return objectId(format, 'tree', Buffer.concat(records.map(record => Buffer.concat([Buffer.from(`${record.mode} ${record.name}\0`), Buffer.from(record.oid, 'hex')]))));
  };
  return hash(root);
}
