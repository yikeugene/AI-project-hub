import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../server/commands.ts';
import { gitEnvironment } from '../server/git.ts';
import { acknowledgeGitOperation, executeGitOperation as executePrepared, prepareGitOperation, readGitDetails, readGitDiff } from '../server/git-operations.ts';
import { openRepository } from '../server/git-repository.ts';
import { withRepositoryLock } from '../server/git-locks.ts';
const executeGitOperation = (plan: Parameters<typeof executePrepared>[0], callbacks: Parameters<typeof executePrepared>[1]) => executePrepared(JSON.parse(JSON.stringify(plan)), callbacks);
import { resolveGitTools } from '../server/git-tools.ts';

const native = vi.hoisted(() => ({ directory: '', transactionTimeout: 0 }));
vi.mock('../server/git-process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git-process.ts')>();
  return { ...actual, startGitProcess: (tools: import('../server/git-tools.ts').GitTools, args: string[], options: import('../server/git-process.ts').GitProcessOptions) =>
    actual.startGitProcess(tools, args, native.transactionTimeout && args.includes('update-ref') ? { ...options, timeoutMs: native.transactionTimeout } : options) };
});
vi.mock('../server/git-tools.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git-tools.ts')>();
  return { ...actual, resolveGitTools: async () => {
    const tools = await actual.resolveGitTools();
    return process.platform === 'win32' ? { ...tools, host: path.join(native.directory, 'git-host.exe'), hooks: path.join(native.directory, 'hooks') } : tools;
  } };
});
let root: string, gitExe: string;
const context = { projectId: 'b3a7f567-6583-4a9e-9e47-24286ef881fe', projectName: 'Isolated test' };
beforeAll(async () => {
  native.directory = await mkdtemp(path.join(tmpdir(), 'hub-native-git-test-'));
  if (process.platform === 'win32') {
    const result = await runCommand(process.execPath, [fileURLToPath(new URL('../scripts/build-git-tools.mjs', import.meta.url)), native.directory], { cwd: native.directory, timeoutMs: 20_000 });
    if (result.code) throw new Error(result.stderr);
  }
  gitExe = (await resolveGitTools()).git;
});
afterAll(async () => { await rm(native.directory, { recursive: true, force: true, maxRetries: 5 }); });
beforeEach(async () => {
  native.transactionTimeout = 0;
  root = await mkdtemp(path.join(tmpdir(), 'hub-safe-git-test-'));
  vi.stubEnv('HOME', root); vi.stubEnv('XDG_CONFIG_HOME', path.join(root, '.config'));
  // GCM still uses the real OS store in production. These isolated tests never
  // invoke it and do not borrow the developer's global Git configuration.
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function git(directory: string, args: string[]): Promise<string> {
  const result = await runCommand(gitExe, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], { cwd: directory, env: gitEnvironment(), timeoutMs: 15_000 });
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function repo(unborn = false): Promise<string> {
  const directory = path.join(root, 'repo'); await mkdir(directory);
  await git(directory, ['init', '--initial-branch=main']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
  await git(directory, ['config', 'user.name', 'Test User']);
  await git(directory, ['config', 'user.email', 'test@example.invalid']);
  if (!unborn) {
    await writeFile(path.join(directory, 'a.txt'), 'base a\n');
    await writeFile(path.join(directory, 'b.txt'), 'base b\n');
    await git(directory, ['add', '--all']); await git(directory, ['commit', '-m', 'Base']);
  }
  return directory;
}
const options = () => ({ authorize: vi.fn(async () => undefined), onStarting: vi.fn(() => undefined) });

describe('approved safe Git operations in temporary repositories', () => {
  it('reads separate staged and unstaged diffs and stages only approved bytes', async () => {
    const directory = await repo();
    expect((await readGitDetails(directory)).unsupportedReasons).toEqual([]);
    await writeFile(path.join(directory, 'a.txt'), 'staged a\n'); await git(directory, ['add', 'a.txt']);
    await writeFile(path.join(directory, 'a.txt'), 'working a\n');
    await writeFile(path.join(directory, 'b.txt'), 'working b\n');
    expect((await readGitDiff(directory, { path: 'a.txt', source: 'index' })).text).toContain('+staged a');
    expect((await readGitDiff(directory, { path: 'a.txt', source: 'worktree' })).text).toContain('+working a');
    const beforeIndex = await readFile(path.join(directory, '.git/index'));
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['b.txt'] }, context);
    expect(await readFile(path.join(directory, '.git/index'))).toEqual(beforeIndex);
    const callbacks = options();
    expect(await executeGitOperation(JSON.parse(JSON.stringify(plan)), callbacks)).toMatchObject({ status: 'succeeded' });
    expect(callbacks.authorize).toHaveBeenCalledTimes(1); expect(callbacks.onStarting).toHaveBeenCalledTimes(1);
    expect(await git(directory, ['show', ':a.txt'])).toBe('staged a');
    expect(await git(directory, ['show', ':b.txt'])).toBe('working b');
    await expect(executeGitOperation(plan, options())).rejects.toMatchObject({ code: 'stale' });
  }, 60_000);
  it('invalidates changed selected bytes, an unrelated index edit, and HEAD drift before authorization', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await writeFile(path.join(directory, 'a.txt'), 'different\n'); const first = options();
    await expect(executeGitOperation(plan, first)).rejects.toMatchObject({ code: 'stale' }); expect(first.authorize).not.toHaveBeenCalled();
    await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    await writeFile(path.join(directory, 'b.txt'), 'unrelated staged\n'); await git(directory, ['add', 'b.txt']);
    const second = options(); await expect(executeGitOperation(plan, second)).rejects.toMatchObject({ code: 'stale' }); expect(second.authorize).not.toHaveBeenCalled();
    const newer = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await git(directory, ['checkout', '-b', 'different-head']);
    const third = options(); await expect(executeGitOperation(newer, third)).rejects.toMatchObject({ code: 'stale' }); expect(third.authorize).not.toHaveBeenCalled();
  }, 60_000);
  it('does not mutate when authorize or durable-start callbacks fail', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const index = await readFile(path.join(directory, '.git/index'));
    const first = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    const start = vi.fn();
    await expect(executeGitOperation(first, { authorize: async () => { throw new Error('offline'); }, onStarting: start })).rejects.toThrow('offline');
    expect(start).not.toHaveBeenCalled(); expect(await readFile(path.join(directory, '.git/index'))).toEqual(index);
    const second = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await expect(executeGitOperation(second, { authorize: async () => undefined, onStarting: () => { throw new Error('journal'); } })).rejects.toThrow('journal');
    expect(await readFile(path.join(directory, '.git/index'))).toEqual(index);
    await expect(access(path.join(directory, '.git/index.lock'))).rejects.toThrow();
    await expect(access(path.join(directory, '.git/HEAD.lock'))).rejects.toThrow();
  }, 60_000);
  it('revalidates under native locks after one-time authorization', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    const start = vi.fn();
    await expect(executeGitOperation(plan, { authorize: async () => { await writeFile(path.join(directory, 'a.txt'), 'changed during consume\n'); }, onStarting: start })).rejects.toMatchObject({ code: 'stale' });
    expect(start).not.toHaveBeenCalled(); expect(await git(directory, ['show', ':a.txt'])).toBe('base a');
  }, 60_000);
  it('unstages only selected rename endpoints and handles an unborn index', async () => {
    const directory = await repo(); await rename(path.join(directory, 'a.txt'), path.join(directory, 'renamed 測試.txt'));
    await writeFile(path.join(directory, 'b.txt'), 'staged b\n'); await git(directory, ['add', '--all']);
    const details = await readGitDetails(directory);
    expect(details.snapshot.changes.find(change => change.path === 'renamed 測試.txt')?.originalPath).toBe('a.txt');
    const plan = await prepareGitOperation(directory, { kind: 'unstage', paths: ['renamed 測試.txt'] }, context);
    expect(plan.summary.paths).toEqual(['a.txt', 'renamed 測試.txt']);
    expect((await executeGitOperation(plan, options())).status).toBe('succeeded');
    expect(await git(directory, ['show', ':a.txt'])).toBe('base a'); expect(await git(directory, ['show', ':b.txt'])).toBe('staged b');
    const unborn = path.join(root, 'unborn'); await mkdir(unborn); await git(unborn, ['init', '--initial-branch=main']);
    await writeFile(path.join(unborn, 'new [literal].txt'), 'new\n'); await git(unborn, ['add', '--all']);
    const unstage = await prepareGitOperation(unborn, { kind: 'unstage', paths: ['new [literal].txt'] }, context);
    expect((await executeGitOperation(unstage, options())).status).toBe('succeeded');
    expect(await git(unborn, ['ls-files'])).toBe(''); expect(await readFile(path.join(unborn, 'new [literal].txt'), 'utf8')).toBe('new\n');
  }, 90_000);
  it('commits the approved index, parent, exact message and identity without adding worktree changes', async () => {
    const directory = await repo(); const parent = await git(directory, ['rev-parse', 'HEAD']);
    await writeFile(path.join(directory, 'a.txt'), 'staged\n'); await git(directory, ['add', 'a.txt']);
    await writeFile(path.join(directory, 'a.txt'), 'not staged\n');
    const plan = await prepareGitOperation(directory, { kind: 'commit', message: 'Approved commit\n\nBody 測試', authorName: 'Approved Author', authorEmail: 'author@example.invalid' }, context);
    const callbacks = options(); const result = await executeGitOperation(plan, callbacks);
    expect(result).toMatchObject({ status: 'succeeded', head: plan.commit });
    expect(await git(directory, ['rev-parse', 'HEAD^'])).toBe(parent);
    expect(await git(directory, ['show', 'HEAD:a.txt'])).toBe('staged');
    expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('not staged\n');
    expect(await git(directory, ['cat-file', 'commit', plan.commit!])).toBe(plan.commitContent!.trim());
  }, 60_000);
  it('creates only an absent branch and switches clean trees without overwriting dirty files', async () => {
    const directory = await repo();
    const create = await prepareGitOperation(directory, { kind: 'createBranch', branch: 'feature/測試' }, context);
    expect((await executeGitOperation(create, options())).status).toBe('succeeded');
    await git(directory, ['checkout', 'feature/測試']); await writeFile(path.join(directory, 'a.txt'), 'feature\n'); await git(directory, ['add', 'a.txt']); await git(directory, ['commit', '-m', 'Feature']); await git(directory, ['checkout', 'main']);
    const switchPlan = await prepareGitOperation(directory, { kind: 'switchBranch', branch: 'feature/測試' }, context);
    expect((await executeGitOperation(switchPlan, options())).status).toBe('succeeded');
    expect(await git(directory, ['branch', '--show-current'])).toBe('feature/測試'); expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('feature\n');
    await writeFile(path.join(directory, 'a.txt'), 'dirty\n');
    await expect(prepareGitOperation(directory, { kind: 'switchBranch', branch: 'main' }, context)).rejects.toMatchObject({ code: 'unsafe' });
  }, 90_000);
  it('honors native index locks without deleting another process lock', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await writeFile(path.join(directory, '.git/index.lock'), 'external lock');
    await expect(executeGitOperation(plan, options())).rejects.toMatchObject({ code: 'busy' });
    expect(await readFile(path.join(directory, '.git/index.lock'), 'utf8')).toBe('external lock');
  }, 60_000);
  it('rejects malicious hooks and filters while retaining safe diff views', async () => {
    const directory = await repo(); const sentinel = path.join(root, 'executed');
    const script = `!echo bad > "${sentinel.replaceAll('\\', '/')}"`;
    await git(directory, ['config', 'filter.bad.clean', script]); await git(directory, ['config', 'filter.bad.required', 'true']);
    await writeFile(path.join(directory, '.gitattributes'), '*.txt filter=bad\n'); await writeFile(path.join(directory, 'a.txt'), 'changed\n');
    expect((await readGitDetails(directory)).unsupportedReasons).toContain('customHelpers');
    expect((await readGitDiff(directory, { path: 'a.txt', source: 'worktree' })).text).toContain('+changed');
    await expect(prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(access(sentinel)).rejects.toThrow();
  }, 60_000);
  it('uses native safe CRLF conversion on the frozen bytes', async () => {
    const directory = await repo(); await git(directory, ['config', 'core.autocrlf', 'true']);
    await writeFile(path.join(directory, 'a.txt'), 'first\r\nsecond\r\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    expect((await executeGitOperation(plan, options())).status).toBe('succeeded');
    expect(await git(directory, ['show', ':a.txt'])).toBe('first\nsecond');
    expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
  }, 60_000);
  it('freezes approved bytes instead of staging edits made after the durable-start callback', async () => {
    const directory = await repo(true); const name = 'new [literal] 測試.txt';
    await writeFile(path.join(directory, name), 'approved\n'); await writeFile(path.join(directory, 'new other.txt'), 'unselected\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: [name] }, context);
    expect((await executeGitOperation(plan, { authorize: async () => undefined, onStarting: async () => { await writeFile(path.join(directory, name), 'newer edit\n'); } })).status).toBe('succeeded');
    expect(await git(directory, ['show', `:${name}`])).toBe('approved');
    expect(await readFile(path.join(directory, name), 'utf8')).toBe('newer edit\n');
    expect(await git(directory, ['ls-files', '-z'])).toBe(`${name}\0`);
  }, 60_000);
  it('invalidates attributes and relevant configuration rather than trusting status counts', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const attributes = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await writeFile(path.join(directory, '.gitattributes'), '*.txt text eol=lf\n');
    const first = options(); await expect(executeGitOperation(attributes, first)).rejects.toMatchObject({ code: 'stale' }); expect(first.authorize).not.toHaveBeenCalled();
    const config = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await git(directory, ['config', 'core.autocrlf', 'true']);
    const second = options(); await expect(executeGitOperation(config, second)).rejects.toMatchObject({ code: 'stale' }); expect(second.authorize).not.toHaveBeenCalled();
  }, 60_000);
  it('does not create tree or commit objects while preparing an exact commit', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'staged content\n'); await git(directory, ['add', 'a.txt']);
    const before = await git(directory, ['count-objects', '-v']);
    const plan = await prepareGitOperation(directory, { kind: 'commit', message: 'No preview writes', authorName: 'Test User', authorEmail: 'test@example.invalid' }, context);
    expect(await git(directory, ['count-objects', '-v'])).toBe(before);
    for (const oid of [plan.tree!, plan.commit!]) {
      const result = await runCommand(gitExe, ['cat-file', '-e', oid], { cwd: directory, env: gitEnvironment() }); expect(result.code).not.toBe(0);
    }
  }, 60_000);
  it('holds the symbolic HEAD lock while committing and refuses an expected-absent branch race', async () => {
    const directory = await repo(); await git(directory, ['branch', 'other']); await writeFile(path.join(directory, 'a.txt'), 'staged\n'); await git(directory, ['add', 'a.txt']);
    const plan = await prepareGitOperation(directory, { kind: 'commit', message: 'Head lock', authorName: 'Test User', authorEmail: 'test@example.invalid' }, context);
    expect((await executeGitOperation(plan, { authorize: async () => undefined, onStarting: async () => {
      const race = await runCommand(gitExe, ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: directory, env: gitEnvironment() }); expect(race.code).not.toBe(0);
    } })).status).toBe('succeeded');
    expect(await git(directory, ['branch', '--show-current'])).toBe('main');
    const create = await prepareGitOperation(directory, { kind: 'createBranch', branch: 'raced' }, context); const start = vi.fn();
    await expect(executeGitOperation(create, { authorize: async () => { await git(directory, ['branch', 'raced']); }, onStarting: start })).rejects.toMatchObject({ code: 'stale' });
    expect(start).not.toHaveBeenCalled();
  }, 90_000);
  it('uses one canonical common-directory queue for linked worktrees', async () => {
    const directory = await repo(), linked = path.join(root, 'linked'); await git(directory, ['worktree', 'add', '-b', 'linked-branch', linked]);
    await writeFile(path.join(directory, 'a.txt'), 'first worktree\n'); await writeFile(path.join(linked, 'b.txt'), 'second worktree\n');
    const first = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    const second = await prepareGitOperation(linked, { kind: 'stage', paths: ['b.txt'] }, context);
    expect(first.repositoryKey).toBe(second.repositoryKey);
    let admit!: () => void, entered!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; }), entering = new Promise<void>(resolve => { entered = resolve; });
    const running = executeGitOperation(first, { authorize: async () => { entered(); await admitted; }, onStarting: () => undefined });
    await entering; const callbacks = options(); const waiting = executeGitOperation(second, callbacks);
    await new Promise(resolve => setTimeout(resolve, 250)); expect(callbacks.authorize).not.toHaveBeenCalled(); admit();
    expect((await running).status).toBe('succeeded'); expect((await waiting).status).toBe('succeeded');
    expect(await git(directory, ['show', ':a.txt'])).toBe('first worktree'); expect(await git(linked, ['show', ':b.txt'])).toBe('second worktree');
  }, 120_000);
  it('never overwrites an untracked checkout collision, and fences a partially attempted checkout', async () => {
    const directory = await repo(); await git(directory, ['checkout', '-b', 'target']); await writeFile(path.join(directory, 'new.txt'), 'target\n'); await git(directory, ['add', 'new.txt']); await git(directory, ['commit', '-m', 'Target']); await git(directory, ['checkout', 'main']);
    const plan = await prepareGitOperation(directory, { kind: 'switchBranch', branch: 'target' }, context);
    const result = await executeGitOperation(plan, { authorize: async () => undefined, onStarting: async () => { await writeFile(path.join(directory, 'new.txt'), 'untracked user bytes\n'); } });
    expect(result.status).toBe('partial'); expect(await readFile(path.join(directory, 'new.txt'), 'utf8')).toBe('untracked user bytes\n');
    expect(await git(directory, ['branch', '--show-current'])).toBe('main');
    await expect(executeGitOperation(plan, options())).rejects.toMatchObject({ code: 'unknown' });
    const fencePath = path.join(directory, '.git/ai-project-hub.operation.fence');
    expect(JSON.parse(await readFile(fencePath, 'utf8'))).toMatchObject({ planId: plan.id, processesExited: true });
    await expect(acknowledgeGitOperation({ ...plan, id: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'unknown' });
    await writeFile(path.join(directory, '.git/index.lock'), 'another process');
    await expect(acknowledgeGitOperation(plan)).rejects.toMatchObject({ code: 'busy' });
    expect(await readFile(path.join(directory, '.git/index.lock'), 'utf8')).toBe('another process');
    await rm(path.join(directory, '.git/index.lock'));
    await acknowledgeGitOperation(JSON.parse(JSON.stringify(plan)));
    await expect(access(fencePath)).rejects.toThrow();
    await expect(executeGitOperation(plan, options())).rejects.toMatchObject({ code: 'stale' });
  }, 90_000);
  it('never removes a retained operation lock when process exit was unverified', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    await withRepositoryLock(await openRepository(directory), plan.id, async lock => { await lock.fence(false); });
    const filename = path.join(directory, '.git/ai-project-hub.operation.lock'); const lock = await readFile(filename);
    await expect(acknowledgeGitOperation(plan)).rejects.toMatchObject({ code: 'busy' });
    expect(await readFile(filename)).toEqual(lock);
  }, 60_000);
  it('bounds coordination-lock cleanup and fences an oversized replacement without deleting it', async () => {
    const directory = await repo(); const repository = await openRepository(directory);
    const filename = path.join(directory, '.git/ai-project-hub.operation.lock');
    await expect(withRepositoryLock(repository, context.projectId, async () => { await writeFile(filename, Buffer.alloc(1024 * 1024, 120)); })).rejects.toMatchObject({ code: 'unknown' });
    expect((await stat(filename)).size).toBe(1024 * 1024);
    expect(JSON.parse(await readFile(path.join(directory, '.git/ai-project-hub.operation.fence'), 'utf8'))).toMatchObject({ planId: context.projectId, processesExited: false });
  }, 60_000);
  it('allows explicit recovery without a native fence only when no native or app lock exists', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    const index = await readFile(path.join(directory, '.git/index'));
    const filename = path.join(directory, '.git/ai-project-hub.operation.lock'); await writeFile(filename, 'stale lock must remain');
    await expect(acknowledgeGitOperation(plan)).rejects.toMatchObject({ code: 'busy' });
    expect(await readFile(filename, 'utf8')).toBe('stale lock must remain'); await rm(filename);
    await acknowledgeGitOperation(plan); expect(await readFile(path.join(directory, '.git/index'))).toEqual(index);
  }, 60_000);
  it('bounds textual diffs and labels binary content without invoking external diff commands', async () => {
    const directory = await repo(); await git(directory, ['config', 'diff.external', 'this-command-must-not-run']);
    await writeFile(path.join(directory, 'a.txt'), '\0binary bytes');
    expect((await readGitDiff(directory, { path: 'a.txt', source: 'worktree' })).binary).toBe(true);
    await writeFile(path.join(directory, 'a.txt'), 'a long diff line\n'.repeat(30000));
    const diff = await readGitDiff(directory, { path: 'a.txt', source: 'worktree' });
    expect(diff.truncated).toBe(true); expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(256 * 1024);
  }, 60_000);
  it('commits an unborn SHA-256 repository with the exact approved object identity', async () => {
    const directory = path.join(root, 'sha256'); await mkdir(directory); await git(directory, ['init', '--initial-branch=main', '--object-format=sha256']);
    await writeFile(path.join(directory, 'first.txt'), 'initial\n'); await git(directory, ['add', 'first.txt']);
    const plan = await prepareGitOperation(directory, { kind: 'commit', message: 'Initial approved commit', authorName: 'First Author', authorEmail: 'first@example.invalid' }, context);
    expect(plan.state.head).toBeNull(); expect(plan.commit).toHaveLength(64);
    expect((await executeGitOperation(plan, options())).status).toBe('succeeded');
    expect(await git(directory, ['cat-file', 'commit', plan.commit!])).toBe(plan.commitContent!.trim());
  }, 60_000);
  it('permits approved staging on detached HEAD but does not silently create a detached commit', async () => {
    const directory = await repo(); await git(directory, ['checkout', '--detach']); await writeFile(path.join(directory, 'a.txt'), 'detached stage\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context); expect(plan.summary.branch).toBeNull();
    expect((await executeGitOperation(plan, options())).status).toBe('succeeded');
    await expect(prepareGitOperation(directory, { kind: 'commit', message: 'Not allowed detached', authorName: 'Test User', authorEmail: 'test@example.invalid' }, context)).rejects.toMatchObject({ code: 'unsupported' });
  }, 60_000);
  it('does not start a mutation after a prepared native lock transaction expires during validation', async () => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'approved\n');
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context), callbacks = options();
    const index = await readFile(path.join(directory, '.git/index'));
    native.transactionTimeout = 1_000;
    await expect(executeGitOperation(plan, callbacks)).rejects.toMatchObject({ code: 'unknown' });
    expect(callbacks.authorize).toHaveBeenCalledTimes(1); expect(callbacks.onStarting).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, '.git/index'))).toEqual(index);
    expect(await git(directory, ['show', ':a.txt'])).toBe('base a');
  }, 60_000);
  it('retains read-only details and diff for a shallow local clone while refusing writes', async () => {
    const source = await repo(); await writeFile(path.join(source, 'a.txt'), 'second commit\n'); await git(source, ['add', 'a.txt']); await git(source, ['commit', '-m', 'Second']);
    const directory = path.join(root, 'shallow');
    const clone = await runCommand(gitExe, ['-c', 'protocol.file.allow=always', 'clone', '--depth=1', pathToFileURL(source).href, directory], { cwd: root, env: { ...gitEnvironment(), GIT_ALLOW_PROTOCOL: 'file' }, timeoutMs: 15_000 });
    expect(clone.code).toBe(0);
    const details = await readGitDetails(directory);
    expect(details.snapshot.isRepo).toBe(true); expect(details.snapshot.commits).toHaveLength(1); expect(details.unsupportedReasons).toContain('objectLayout');
    await writeFile(path.join(directory, 'a.txt'), 'readable shallow diff\n');
    expect((await readGitDiff(directory, { path: 'a.txt', source: 'worktree' })).text).toContain('+readable shallow diff');
    await expect(prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context)).rejects.toMatchObject({ code: 'unsupported' });
  }, 60_000);
  it('applies bounded configured excludes files to status, selection and the immutable fingerprint', async () => {
    const directory = await repo(), rules = path.join(root, 'configured ignore rules');
    await writeFile(rules, 'secret*.txt\n'); await git(directory, ['config', 'core.excludesFile', rules]);
    await writeFile(path.join(directory, 'secret-not-staged.txt'), 'ignored secret\n'); await writeFile(path.join(directory, 'visible.txt'), 'visible\n');
    const details = await readGitDetails(directory);
    expect(details.snapshot.changes.map(change => change.path)).toEqual(['visible.txt']);
    await expect(prepareGitOperation(directory, { kind: 'stage', paths: ['secret-not-staged.txt'] }, context)).rejects.toMatchObject({ code: 'invalid' });
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['visible.txt'] }, context);
    expect(plan.attributes.globalExclude).toBe(Buffer.from('secret*.txt\n').toString('base64'));
    await writeFile(rules, 'secret*.txt\nvisible.txt\n'); const callbacks = options();
    await expect(executeGitOperation(plan, callbacks)).rejects.toMatchObject({ code: 'stale' }); expect(callbacks.authorize).not.toHaveBeenCalled();
  }, 60_000);
  it('captures default global attributes and ignore rules in an isolated HOME', async () => {
    const directory = await repo(), config = path.join(root, '.config/git'); await mkdir(config, { recursive: true });
    const attributes = path.join(config, 'attributes'); await writeFile(attributes, '*.txt text eol=lf\n'); await writeFile(path.join(config, 'ignore'), 'default-ignored.txt\n');
    await writeFile(path.join(directory, 'default-ignored.txt'), 'not staged\n'); await writeFile(path.join(directory, 'a.txt'), 'default CRLF\r\nsecond\r\n');
    expect((await readGitDetails(directory)).snapshot.changes.map(change => change.path)).toEqual(['a.txt']);
    const plan = await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context);
    expect(plan.attributes.global).toBe(Buffer.from('*.txt text eol=lf\n').toString('base64'));
    await writeFile(attributes, '*.txt filter=unapproved\n'); const callbacks = options();
    await expect(executeGitOperation(plan, callbacks)).rejects.toMatchObject({ code: 'stale' }); expect(callbacks.authorize).not.toHaveBeenCalled();
    await writeFile(attributes, '*.txt text eol=lf\n');
    expect((await executeGitOperation(await prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context), options())).status).toBe('succeeded');
    expect(await git(directory, ['show', ':a.txt'])).toBe('default CRLF\nsecond');
  }, 90_000);
  it.each(['commit.gpgSign', 'core.sparseCheckout', 'core.splitIndex'])('keeps %s repositories read-only', async key => {
    const directory = await repo(); await writeFile(path.join(directory, 'a.txt'), 'changed\n'); await git(directory, ['config', key, 'true']);
    await expect(prepareGitOperation(directory, { kind: 'stage', paths: ['a.txt'] }, context)).rejects.toMatchObject({ code: 'unsupported' });
  }, 60_000);
});
