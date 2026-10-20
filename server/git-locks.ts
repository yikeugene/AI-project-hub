import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitOperationError } from './git-errors.ts';
import { boundedFile, exists, SAFE_ARGS, type GitView, type Repository } from './git-repository.ts';
import { isolatedGitEnvironment } from './git-tools.ts';
import { runGitProcess, startGitProcess, type GitProcess } from './git-process.ts';

const queues = new Map<string, Promise<void>>();
const fenced = new Set<string>();
export interface RepositoryLock { fence(processesExited: boolean): Promise<void> }
export async function withRepositoryLock<T>(repo: Repository, planId: string, task: (lock: RepositoryLock) => Promise<T>, recovering = false): Promise<T> {
  const previous = queues.get(repo.key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  queues.set(repo.key, queued);
  await previous;
  const lockPath = path.join(repo.commonDir, 'ai-project-hub.operation.lock');
  const fencePath = path.join(repo.commonDir, 'ai-project-hub.operation.fence');
  let handle: FileHandle | undefined, fenceHandle: FileHandle | undefined;
  let owner: { dev: number; ino: number } | undefined;
  let retain = false;
  const nonce = randomBytes(32).toString('hex');
  const fence = async (processesExited: boolean) => {
    retain ||= !processesExited; fenced.add(repo.key);
    try {
      fenceHandle ??= await open(fencePath, 'wx', 0o600);
      const record = Buffer.from(JSON.stringify({ version: 1, planId, repositoryKey: repo.key, owner: nonce, processesExited: !retain }));
      await fenceHandle.truncate(0); await fenceHandle.write(record, 0, record.length, 0); await fenceHandle.sync();
    } catch { retain = true; }
  };
  try {
    if (!recovering && (fenced.has(repo.key) || await exists(fencePath))) throw new GitOperationError('unknown');
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GitOperationError('busy'); throw new GitOperationError('unsafe'); }
    owner = await handle.stat();
    await handle.writeFile(nonce); await handle.sync();
    const lock = { fence };
    try { return await task(lock); }
    catch (error) {
      if (!recovering && error instanceof GitOperationError && error.code === 'unknown') await lock.fence(!error.processExitUnverified);
      throw error;
    }
  } finally {
    try {
      if (handle) {
        await handle.close();
        if (!retain) {
          const contents = await boundedFile(lockPath, 64).catch(() => null);
          const current = await lstat(lockPath).catch(() => null);
          if (contents?.toString('ascii') === nonce && current?.ino === owner?.ino && current?.dev === owner?.dev && !current?.isSymbolicLink()) await rm(lockPath);
          else throw new GitOperationError('unknown');
        }
      }
    } catch {
      await fence(false); throw new GitOperationError('unknown');
    } finally {
      try { await fenceHandle?.close(); }
      finally { release(); if (queues.get(repo.key) === queued) queues.delete(repo.key); }
    }
  }
}

export async function acknowledgeRepositoryFence(repo: Repository, planId: string): Promise<void> {
  await withRepositoryLock(repo, planId, async () => {
    const queue = [repo.commonDir, repo.gitDir], seen = new Set<string>(); let count = 0;
    const ownLock = path.join(repo.commonDir, 'ai-project-hub.operation.lock');
    while (queue.length) {
      const directory = queue.pop()!;
      if (seen.has(directory)) continue; seen.add(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 50_000 || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new GitOperationError('unknown');
        const filename = path.join(directory, entry.name);
        if (entry.name.endsWith('.lock') && filename !== ownLock) throw new GitOperationError('busy');
        if (entry.isDirectory()) queue.push(filename);
      }
    }
    const filename = path.join(repo.commonDir, 'ai-project-hub.operation.fence');
    const raw = await boundedFile(filename, 4096);
    if (!raw) { if (fenced.has(repo.key)) throw new GitOperationError('unknown'); return; }
    let record;
    try { record = JSON.parse(raw.toString('utf8')); } catch { throw new GitOperationError('unknown'); }
    if (record.version !== 1 || record.planId !== planId || record.repositoryKey !== repo.key || !/^[a-f0-9]{64}$/.test(record.owner) || record.processesExited !== true) throw new GitOperationError('unknown');
    await rm(filename); fenced.delete(repo.key);
  }, true);
}

export interface IndexLock { install(bytes: Buffer, validateLocks: () => Promise<void>): Promise<void>; release(retain?: boolean): Promise<void> }
export async function lockIndex(repo: Repository): Promise<IndexLock> {
  const filename = path.join(repo.gitDir, 'index.lock');
  let handle: FileHandle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) { throw new GitOperationError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'unsafe'); }
  const owner = await handle.stat();
  let closed = false, installed = false;
  const owned = async () => { const current = await lstat(filename).catch(() => null); return current && current.isFile() && !current.isSymbolicLink() && current.ino === owner.ino && current.dev === owner.dev; };
  return {
    async install(bytes, validateLocks) {
      if (closed || !await owned()) throw new GitOperationError('unknown');
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); closed = true;
      if (!await owned()) throw new GitOperationError('unknown');
      await validateLocks();
      await rename(filename, path.join(repo.gitDir, 'index')); installed = true;
    },
    async release(retain = false) {
      if (!closed) { await handle.close(); closed = true; }
      if (!installed && !retain && await owned()) await rm(filename);
    },
  };
}

export interface RefCommand { kind: 'verify' | 'update' | 'create' | 'symref-verify' | 'symref-update'; ref: string; old?: string; next?: string }
function commandInput(commands: RefCommand[]): string {
  return commands.map(command => {
    if (!command.ref || /[\0\r\n]/.test(command.ref) || /[\0\r\n]/.test(command.old ?? '') || /[\0\r\n]/.test(command.next ?? '')) throw new GitOperationError('invalid');
    const prefix = `option no-deref\0${command.kind} ${command.ref}\0`;
    if (command.kind === 'verify' || command.kind === 'symref-verify') return prefix + (command.old ?? '') + '\0';
    if (command.kind === 'create') return prefix + command.next + '\0';
    if (command.kind === 'symref-update') return prefix + command.next + '\0ref\0' + command.old + '\0';
    return prefix + command.next + '\0' + command.old + '\0';
  }).join('');
}
export function headCommands(repo: Repository): RefCommand[] {
  return repo.symbolicHead
    ? [{ kind: 'symref-verify', ref: 'HEAD', old: repo.symbolicHead }, { kind: 'verify', ref: repo.symbolicHead, old: repo.head ?? '0'.repeat(repo.format === 'sha1' ? 40 : 64) }]
    : [{ kind: 'verify', ref: 'HEAD', old: repo.head! }];
}
export interface RefTransaction { assertPrepared(minimumMs?: number): Promise<void>; commit(): Promise<void>; abort(): Promise<void> }
async function nativeTransaction(repo: Repository, commands: RefCommand[], gitDir: string, env: NodeJS.ProcessEnv): Promise<RefTransaction> {
  const child = await startGitProcess(repo.tools, [...SAFE_ARGS, '-c', 'user.name=AI Project Hub', '-c', 'user.email=git-operation@local.invalid', `--git-dir=${gitDir}`, `--work-tree=${repo.directory}`, 'update-ref', '--stdin', '-z'], {
    cwd: repo.directory, env, timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
  });
  let done = false;
  let locks: Array<{ filename: string; ino: number; dev: number }> = [];
  try {
    child.write(`start\0${commandInput(commands)}prepare\0`); await child.waitFor('prepare: ok\n');
    locks = await Promise.all(commands.map(async command => {
      const filename = command.ref === 'HEAD' ? path.join(gitDir, 'HEAD.lock') : path.join(repo.commonDir, `${command.ref}.lock`);
      const info = await lstat(filename);
      return { filename, ino: info.ino, dev: info.dev };
    }));
  }
  catch (error) {
    child.end(); const result = await child.result;
    if (result.timedOut || result.limited) throw new GitOperationError('failed');
    if (error instanceof GitOperationError && error.code === 'unknown') throw error;
    throw new GitOperationError('stale', 'The native reference locks or expected references changed.');
  }
  return {
    async assertPrepared(minimumMs = 0) {
      if (done) throw new GitOperationError('stale');
      await child.assertRunning(minimumMs);
      for (const lock of locks) {
        const current = await lstat(lock.filename).catch(() => null);
        if (!current?.isFile() || current.isSymbolicLink() || current.ino !== lock.ino || current.dev !== lock.dev) throw new GitOperationError('stale');
      }
    },
    async commit() {
      if (done) throw new GitOperationError('invalid'); done = true;
      let sent = true; try { child.end('commit\0'); } catch { sent = false; }
      const result = await child.result;
      if (!sent || result.code || result.timedOut || result.limited || !result.stdout.includes(Buffer.from('commit: ok\n'))) throw new GitOperationError('unknown');
    },
    async abort() {
      if (done) { await child.result; return; } done = true;
      let sent = true; try { child.end('abort\0'); } catch { sent = false; }
      const result = await child.result;
      if (!sent || result.code || result.timedOut || result.limited || !result.stdout.includes(Buffer.from('abort: ok\n'))) throw new GitOperationError('unknown');
    },
  };
}
export async function prepareRefTransaction(repo: Repository, commands: RefCommand[]): Promise<RefTransaction> {
  // A branch transaction would implicitly add HEAD's reflog, conflicting with
  // an explicit symref CAS. Hold HEAD separately; the private HEAD cannot alias
  // any approved branch, while GIT_COMMON_DIR keeps native branch locks real.
  const scratch = await mkdtemp(path.join(tmpdir(), 'hub-git-refs-'));
  let head: RefTransaction | undefined, refs: RefTransaction | undefined;
  let unverified = false;
  const clean = async () => { if (!unverified) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); };
  const abortAll = async () => {
    let failure: unknown;
    for (const transaction of [refs, head]) {
      try { await transaction?.abort(); }
      catch (error) {
        if (error instanceof GitOperationError && error.processExitUnverified) unverified = true;
        if (!failure || error instanceof GitOperationError && error.processExitUnverified) failure = error;
      }
    }
    refs = undefined; head = undefined;
    if (failure) throw failure;
  };
  try {
    await mkdir(path.join(scratch, 'objects')); await mkdir(path.join(scratch, 'refs'));
    await writeFile(path.join(scratch, 'HEAD'), `ref: refs/heads/hub-private-${randomBytes(24).toString('hex')}\n`);
    await writeFile(path.join(scratch, 'commondir'), `${repo.commonDir.replaceAll('\\', '/')}\n`);
    await writeFile(path.join(scratch, 'config'), '[core]\nrepositoryformatversion=0\nbare=false\n');
    const headCommands = commands.filter(command => command.ref === 'HEAD');
    const refCommands = commands.filter(command => command.ref !== 'HEAD');
    if (headCommands.length) head = await nativeTransaction(repo, headCommands, repo.gitDir, isolatedGitEnvironment(repo.tools));
    if (refCommands.length) refs = await nativeTransaction(repo, refCommands, scratch, { ...isolatedGitEnvironment(repo.tools), GIT_COMMON_DIR: repo.commonDir, GIT_OBJECT_DIRECTORY: repo.objectDir });
  } catch (error) {
    try { await abortAll(); }
    catch (abortError) { if (!(error instanceof GitOperationError && error.processExitUnverified)) throw abortError; }
    if (!(error instanceof GitOperationError && error.processExitUnverified)) await clean();
    throw error;
  }
  return {
    async assertPrepared(minimumMs = 0) { await head?.assertPrepared(minimumMs); await refs?.assertPrepared(minimumMs); },
    async commit() {
      await head?.assertPrepared(5_000); await refs?.assertPrepared(5_000);
      if (commands.some(command => command.ref === 'HEAD' && command.kind === 'symref-update')) {
        await head?.commit(); head = undefined;
        await refs?.commit(); refs = undefined;
      } else {
        await refs?.commit(); refs = undefined;
        await head?.commit(); head = undefined;
      }
      await clean();
    },
    async abort() { await abortAll(); await clean(); },
  };
}
const symrefs = new Map<string, Promise<boolean>>();
export async function hasNativeSymrefs(repo: Repository, view: GitView): Promise<boolean> {
  let probe = symrefs.get(repo.tools.git);
  if (!probe) {
    probe = (async () => {
      if (!repo.tools.host && process.platform === 'win32') return false;
      const env = { ...view.env };
      const expected = repo.symbolicHead ?? 'refs/heads/hub-probe';
      const head = path.join(view.gitDir, 'HEAD');
      const saved = await readFile(head);
      try {
        await writeFile(head, `ref: ${expected}\n`);
        for (const commands of [
          [{ kind: 'symref-verify' as const, ref: 'HEAD', old: expected }],
          [{ kind: 'symref-update' as const, ref: 'HEAD', old: expected, next: 'refs/heads/hub-probe-target' }],
        ]) {
          const result = await runGitProcess(repo.tools, [...view.args, 'update-ref', '--stdin', '-z'], { cwd: view.root, env, readOnly: true }, `start\0${commandInput(commands)}prepare\0abort\0`);
          if (result.code || !result.stdout.includes(Buffer.from('abort: ok\n'))) return false;
        }
        return true;
      } finally { await writeFile(head, saved); }
    })().catch(() => false);
    symrefs.set(repo.tools.git, probe);
  }
  return await probe;
}
