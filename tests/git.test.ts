import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findTrustedExecutable, runCommand } from '../server/commands.ts';
import { GIT_READ_ONLY_ARGS, gitEnvironment, parseGitLog, parseGitStatus, readGitSnapshot } from '../server/git.ts';

let temporary: string;
let executable: string;
beforeAll(async () => {
  const found = await findTrustedExecutable(process.platform === 'win32' ? ['git.exe'] : ['git']);
  if (!found) throw new Error('Git is required for the isolated repository tests.');
  executable = found;
});
beforeEach(async () => { temporary = await mkdtemp(path.join(tmpdir(), 'ai-project-hub-git-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  // Windows may release a killed child process's working-directory handle shortly after its timeout.
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
async function git(directory: string, args: string[]): Promise<string> {
  const result = await runCommand(executable, [
    '-c', 'user.name=IO Test', '-c', 'user.email=io-test@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.autocrlf=false', ...args,
  ], { cwd: directory, env: gitEnvironment(), timeoutMs: 10_000 });
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function repo(name = 'repo'): Promise<string> {
  const directory = path.join(temporary, name);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--initial-branch=main']);
  return directory;
}
async function commit(directory: string, subject = 'Initial checkpoint 測試'): Promise<void> {
  await git(directory, ['add', '--all']);
  await git(directory, ['commit', '-m', subject]);
}
async function committedRepo(): Promise<string> {
  const directory = await repo();
  await writeFile(path.join(directory, 'tracked.txt'), 'initial\n');
  await writeFile(path.join(directory, 'rename before.txt'), 'rename content\n');
  await writeFile(path.join(directory, 'delete.txt'), 'delete content\n');
  await commit(directory);
  return directory;
}
const hash = 'a'.repeat(40);
const headers = `# branch.oid ${hash}\0# branch.head main\0`;

describe('NUL-safe Git parsers', () => {
  it('keeps unicode, spaces, newlines, quotes and literal backslashes in rename destinations and untracked paths', () => {
    const destination = '新 name\n"quote"\\literal.txt';
    const output = `${headers}2 R. N... 100644 100644 100644 ${hash} ${hash} R100 ${destination}\0old name\0? other\nfile.txt\0`;
    const parsed = parseGitStatus(output);
    expect(parsed.changes).toEqual([
      { path: destination, index: 'R', worktree: ' ' },
      { path: 'other\nfile.txt', index: '?', worktree: '?' },
    ]);
    expect(parsed).toMatchObject({ branch: 'main', head: hash, changedCount: 2, stagedCount: 1, untrackedCount: 1, conflictCount: 0 });
  });
  it('counts mixed staged/unstaged files once and separates all conflict combinations from staged changes', () => {
    const ordinary = `1 MM N... 100644 100644 100644 ${hash} ${hash} mixed.txt\0`;
    const statuses = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
    const conflicts = statuses.map((xy) => `u ${xy} N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} ${xy}.txt\0`).join('');
    expect(parseGitStatus(headers + ordinary + conflicts)).toMatchObject({ changedCount: 8, stagedCount: 1, conflictCount: 7 });
  });
  it('represents detached HEAD and unborn branches without inventing commits', () => {
    expect(parseGitStatus(`# branch.oid ${hash}\0# branch.head (detached)\0`)).toMatchObject({ head: hash, branch: null });
    expect(parseGitStatus('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ head: null, branch: 'main' });
  });
  it('parses commit fields independently of subject punctuation and record newlines', () => {
    const date = '2026-01-02T03:04:05+00:00';
    const output = `${hash}\0aaaaaaa\0subject | 測試\0${date}\0\n${hash}\0aaaaaaa\0second\0${date}\0\n`;
    expect(parseGitLog(output)).toEqual([
      { hash, shortHash: 'aaaaaaa', subject: 'subject | 測試', date },
      { hash, shortHash: 'aaaaaaa', subject: 'second', date },
    ]);
  });
  it('fails explicitly on malformed records rather than showing a falsely clean status', () => {
    expect(() => parseGitStatus('')).toThrow(/branch information/);
    expect(() => parseGitStatus(headers + '2 R. missing fields\0')).toThrow(/malformed/);
    expect(() => parseGitStatus(headers + `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 new\0`)).toThrow(/incomplete rename/);
    expect(() => parseGitLog(`${hash}\0abc\0subject\0bad date\0`)).toThrow(/malformed commit/);
  });
});

describe('readGitSnapshot with isolated repositories', () => {
  it('returns false for a plain folder and a repository descendant, but errors on missing or invalid roots', async () => {
    expect(await readGitSnapshot(temporary)).toMatchObject({ isRepo: false, changedCount: 0, commits: [] });
    const directory = await committedRepo();
    const child = path.join(directory, 'child');
    await mkdir(child);
    expect((await readGitSnapshot(child)).isRepo).toBe(false);
    await expect(readGitSnapshot(path.join(temporary, 'missing'))).rejects.toThrow(/does not exist/);
    const invalid = path.join(temporary, 'invalid');
    await mkdir(path.join(invalid, '.git'), { recursive: true });
    await expect(readGitSnapshot(invalid)).rejects.toThrow(/Cannot read Git repository/);
  });
  it('reads commits, local branches and a clean head without modifying the index', async () => {
    const directory = await committedRepo();
    await git(directory, ['branch', 'feature/測試']);
    const indexPath = path.join(directory, '.git', 'index');
    const before = await readFile(indexPath);
    const beforeStat = await stat(indexPath);
    const snapshot = await readGitSnapshot(directory);
    expect(snapshot).toMatchObject({ isRepo: true, branch: 'main', branches: ['feature/測試', 'main'], changedCount: 0, changes: [] });
    expect(snapshot.head).toMatch(/^[a-f0-9]{40}$/);
    expect(snapshot.commits[0]).toMatchObject({ hash: snapshot.head, subject: 'Initial checkpoint 測試' });
    expect(snapshot.lastCommitAt).toBe(snapshot.commits[0].date);
    expect(Date.parse(snapshot.observedAt)).not.toBeNaN();
    expect(await readFile(indexPath)).toEqual(before);
    expect((await stat(indexPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });
  it('reads staged, unstaged, renamed, deleted and unicode untracked files from actual NUL status', async () => {
    const directory = await committedRepo();
    await writeFile(path.join(directory, 'tracked.txt'), 'staged\n');
    await git(directory, ['add', 'tracked.txt']);
    await writeFile(path.join(directory, 'tracked.txt'), 'unstaged after staging\n');
    await rename(path.join(directory, 'rename before.txt'), path.join(directory, '改名 after.txt'));
    await git(directory, ['add', 'rename before.txt', '改名 after.txt']);
    await rm(path.join(directory, 'delete.txt'));
    await mkdir(path.join(directory, 'new dir'));
    await writeFile(path.join(directory, 'new dir', '未追蹤 & file.txt'), 'new\n');
    const snapshot = await readGitSnapshot(directory);
    expect(snapshot.changes).toEqual(expect.arrayContaining([
      { path: 'tracked.txt', index: 'M', worktree: 'M' },
      { path: '改名 after.txt', index: 'R', worktree: ' ' },
      { path: 'delete.txt', index: ' ', worktree: 'D' },
      { path: 'new dir/未追蹤 & file.txt', index: '?', worktree: '?' },
    ]));
    expect(snapshot).toMatchObject({ changedCount: 4, stagedCount: 2, untrackedCount: 1, conflictCount: 0 });
  });
  it('handles an unborn branch with untracked files and detached HEAD', async () => {
    const directory = await repo();
    await writeFile(path.join(directory, 'first.txt'), 'first');
    expect(await readGitSnapshot(directory)).toMatchObject({ isRepo: true, branch: 'main', head: null, commits: [], branches: [], lastCommitAt: null, untrackedCount: 1 });
    await commit(directory);
    await git(directory, ['checkout', '--detach']);
    expect(await readGitSnapshot(directory)).toMatchObject({ isRepo: true, branch: null, branches: ['main'] });
  });
  it('recognizes linked worktrees (.git files) as distinct roots', async () => {
    const directory = await committedRepo();
    const worktree = path.join(temporary, 'linked worktree');
    await git(directory, ['worktree', 'add', '-b', 'worktree-branch', worktree]);
    expect((await stat(path.join(worktree, '.git'))).isFile()).toBe(true);
    expect(await readGitSnapshot(worktree)).toMatchObject({ isRepo: true, branch: 'worktree-branch', changedCount: 0 });
  });
  it('reports real merge conflicts separately from staged files', async () => {
    const directory = await committedRepo();
    await git(directory, ['checkout', '-b', 'other']);
    await writeFile(path.join(directory, 'tracked.txt'), 'other change\n');
    await commit(directory, 'Other branch');
    await git(directory, ['checkout', 'main']);
    await writeFile(path.join(directory, 'tracked.txt'), 'main change\n');
    await commit(directory, 'Main branch');
    const merge = await runCommand(executable, ['-c', 'user.name=IO Test', '-c', 'user.email=io-test@example.invalid', '-c', 'commit.gpgSign=false', 'merge', '--no-edit', 'other'], { cwd: directory, env: gitEnvironment() });
    expect(merge.code).toBe(1);
    expect(await readGitSnapshot(directory)).toMatchObject({ conflictCount: 1, stagedCount: 0, changedCount: 1, changes: [{ path: 'tracked.txt', index: 'U', worktree: 'U' }] });
  });
  it('does not invoke a repository fsmonitor helper or obey inherited Git redirection and trace variables', async () => {
    const directory = await committedRepo();
    const sentinel = path.join(directory, '.git', 'helper-ran');
    const helper = path.join(directory, '.git', 'fsmonitor.cjs');
    await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`;
    await git(directory, ['config', 'core.fsmonitor', command]);
    await git(directory, ['config', 'log.showSignature', 'true']);
    await writeFile(path.join(directory, 'tracked.txt'), 'modified\n');
    const trace = path.join(temporary, 'inherited-trace');
    vi.stubEnv('GIT_DIR', path.join(temporary, 'not-a-repo'));
    vi.stubEnv('GIT_WORK_TREE', temporary);
    vi.stubEnv('GIT_TRACE', trace);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor');
    vi.stubEnv('GIT_CONFIG_VALUE_0', command);
    expect(await readGitSnapshot(directory)).toMatchObject({ isRepo: true, branch: 'main', changedCount: 1 });
    await expect(access(sentinel)).rejects.toThrow();
    await expect(access(trace)).rejects.toThrow();
  });
  it.each(['clean', 'process'])('does not execute an included %s filter while hashing tracked files', async (kind) => {
    const directory = await committedRepo();
    await writeFile(path.join(directory, '.gitattributes'), 'tracked.txt filter=unsafe\n');
    await commit(directory, 'Add attributes');
    const sentinel = path.join(directory, '.git', 'filter-ran');
    const helper = path.join(directory, '.git', 'filter.cjs');
    await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe'); process.stdin.pipe(process.stdout);`);
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`;
    const config = path.join(directory, '.git', 'filters.config');
    await git(directory, ['config', '--file', config, `filter.unsafe.${kind}`, command]);
    await git(directory, ['config', '--file', config, 'filter.unsafe.required', 'true']);
    await git(directory, ['config', 'include.path', config]);
    await writeFile(path.join(directory, 'tracked.txt'), 'initial\n');
    await utimes(path.join(directory, 'tracked.txt'), new Date(), new Date(Date.now() + 5_000));
    expect((await readGitSnapshot(directory)).isRepo).toBe(true);
    await expect(access(sentinel)).rejects.toThrow();
  });
  it('does not interpolate shell metacharacters in repository paths', async () => {
    const directory = await repo("spaces & 'quotes' $(noop) 專案");
    await writeFile(path.join(directory, 'file.txt'), 'hello');
    await commit(directory, 'Safe path');
    expect((await readGitSnapshot(directory)).commits[0].subject).toBe('Safe path');
  });
});

describe('read-only execution guardrails', () => {
  it('removes every inherited GIT_* knob, disables fetch/locks and isolates global config', () => {
    const env = gitEnvironment({ PATH: 'trusted', Git_Dir: 'bad', GIT_EXEC_PATH: 'bad', GIT_CONFIG_PARAMETERS: 'bad', GIT_CONFIG_KEY_0: 'bad', GIT_CONFIG_COUNT: '1', GIT_TRACE2_EVENT: 'bad' });
    expect(env).toMatchObject({ PATH: 'trusted', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' });
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.Git_Dir).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_TRACE2_EVENT).toBeUndefined();
    expect(GIT_READ_ONLY_ARGS).toContain('core.fsmonitor=false');
    expect(GIT_READ_ONLY_ARGS).toContain('log.showSignature=false');
    expect(GIT_READ_ONLY_ARGS).toContain('protocol.allow=never');
  });
  it('bounds output and execution duration and reports missing commands', async () => {
    await expect(runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], { cwd: temporary, maxOutputBytes: 64 })).rejects.toThrow(/output limit/);
    await expect(runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: temporary, timeoutMs: 50 })).rejects.toThrow(/timed out/);
    await expect(runCommand(path.join(temporary, 'missing-executable'), [], { cwd: temporary })).rejects.toThrow(/Cannot start command/);
  });
});
