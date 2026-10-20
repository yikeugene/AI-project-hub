import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../server/commands.ts';
import { gitEnvironment } from '../server/git.ts';
import { executeGitOperation as executePrepared, prepareGitOperation } from '../server/git-operations.ts';
const executeGitOperation = (plan: Parameters<typeof executePrepared>[0], callbacks: Parameters<typeof executePrepared>[1]) => executePrepared(JSON.parse(JSON.stringify(plan)), callbacks);
import { resolveGitTools } from '../server/git-tools.ts';

const fixture = vi.hoisted(() => ({ tools: '', url: '' }));
vi.mock('../server/git-tools.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git-tools.ts')>();
  return { ...actual, resolveGitTools: async () => ({ ...await actual.resolveGitTools(), host: path.join(fixture.tools, 'git-host.exe'), hooks: path.join(fixture.tools, 'hooks') }) };
});
// Local transport exists only in this test module. Production exports have no
// flags, environment switches or request parameters that enable this path.
vi.mock('../server/git-network.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git-network.ts')>();
  return { ...actual, remoteFor: (...args: Parameters<typeof actual.remoteFor>) => ({ ...actual.remoteFor(...args), url: fixture.url }) };
});
vi.mock('../server/git-process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/git-process.ts')>();
  const rewrite = (args: string[], options: import('../server/git-process.ts').GitProcessOptions) => ({
    args: args.map(arg => arg === 'protocol.https.allow=always' ? 'protocol.file.allow=always' : arg),
    options: { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: options.env.GIT_ALLOW_PROTOCOL === 'https' ? 'file' : options.env.GIT_ALLOW_PROTOCOL } },
  });
  return { ...actual, runGitProcess: (tools: import('../server/git-tools.ts').GitTools, args: string[], options: import('../server/git-process.ts').GitProcessOptions, input?: string | Buffer) => {
    const changed = rewrite(args, options); return actual.runGitProcess(tools, changed.args, changed.options, input);
  } };
});
let root: string, executable: string, local: string, origin: string, seed: string;
const context = { projectId: 'ba3d8fdd-fc1c-459e-ac0a-8b1ec732f40b', projectName: 'Temporary remote test' };
const options = () => ({ authorize: vi.fn(async () => undefined), onStarting: vi.fn(() => undefined) });
beforeAll(async () => {
  fixture.tools = await mkdtemp(path.join(tmpdir(), 'hub-network-git-host-'));
  const result = await runCommand(process.execPath, [fileURLToPath(new URL('../scripts/build-git-tools.mjs', import.meta.url)), fixture.tools], { cwd: fixture.tools, timeoutMs: 20_000 });
  if (result.code) throw new Error(result.stderr);
  executable = (await resolveGitTools()).git;
});
afterAll(async () => { await rm(fixture.tools, { recursive: true, force: true, maxRetries: 5 }); });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hub-approved-network-')); vi.stubEnv('HOME', root); vi.stubEnv('XDG_CONFIG_HOME', path.join(root, '.config'));
  origin = path.join(root, 'origin.git'); seed = path.join(root, 'seed'); local = path.join(root, 'local');
  await mkdir(origin); await mkdir(seed);
  await git(origin, ['init', '--bare', '--initial-branch=main']);
  await git(seed, ['init', '--initial-branch=main']); await checkpoint(seed, 'A');
  await git(seed, ['-c', 'protocol.file.allow=always', 'push', origin, 'HEAD:refs/heads/main']);
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', origin, local]);
  await git(local, ['config', 'remote.origin.url', 'https://example.invalid/approved/repo.git']);
  await git(local, ['config', 'core.autocrlf', 'false']);
  fixture.url = pathToFileURL(origin).href;
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function git(directory: string, args: string[]): Promise<string> {
  const result = await runCommand(executable, ['-c', 'user.name=Remote Test', '-c', 'user.email=remote@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: directory, env: { ...gitEnvironment(), GIT_ALLOW_PROTOCOL: 'file' }, timeoutMs: 15_000,
  });
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function checkpoint(directory: string, contents: string): Promise<string> {
  await writeFile(path.join(directory, 'file.txt'), `${contents}\n`); await git(directory, ['add', '--all']); await git(directory, ['commit', '-m', contents]);
  return await git(directory, ['rev-parse', 'HEAD']);
}

describe.skipIf(process.platform !== 'win32')('pinned network operations with a test-only local transport', () => {
  it('fetches a pinned object without FETCH_HEAD or incidental refs, then pulls only that reviewed fast-forward', async () => {
    const old = await git(local, ['rev-parse', 'HEAD']); const target = await checkpoint(seed, 'B');
    await git(seed, ['push', origin, 'HEAD:refs/heads/main']);
    const index = await readFile(path.join(local, '.git/index'));
    const fetch = await prepareGitOperation(local, { kind: 'fetch', remote: 'origin', branch: 'main' }, context);
    expect(fetch.target).toBe(target); expect(await readFile(path.join(local, '.git/index'))).toEqual(index);
    const absent = await runCommand(executable, ['cat-file', '-e', target], { cwd: local, env: gitEnvironment() }); expect(absent.code).not.toBe(0);
    await expect(access(path.join(local, '.git/FETCH_HEAD'))).rejects.toThrow();
    expect((await executeGitOperation(fetch, options())).status).toBe('succeeded');
    expect(await git(local, ['rev-parse', 'refs/remotes/origin/main'])).toBe(target); expect(await git(local, ['rev-parse', 'HEAD'])).toBe(old);
    await expect(access(path.join(local, '.git/FETCH_HEAD'))).rejects.toThrow();
    const pull = await prepareGitOperation(local, { kind: 'pull', remote: 'origin', branch: 'main' }, context);
    expect((await executeGitOperation(pull, options())).status).toBe('succeeded');
    expect(await git(local, ['rev-parse', 'HEAD'])).toBe(target); expect(await readFile(path.join(local, 'file.txt'), 'utf8')).toBe('B\n');
  }, 120_000);
  it('pushes the exact approved source with the packaged guard and no Node on PATH', async () => {
    const head = await checkpoint(local, 'B');
    const plan = await prepareGitOperation(local, { kind: 'push', remote: 'origin', branch: 'main' }, context);
    const callbacks = options(); expect((await executeGitOperation(plan, callbacks)).status).toBe('succeeded');
    expect(callbacks.authorize).toHaveBeenCalledTimes(1); expect(callbacks.onStarting).toHaveBeenCalledTimes(1);
    expect(await git(origin, ['rev-parse', 'refs/heads/main'])).toBe(head);
  }, 90_000);
  it('rejects an actual negotiated-old-OID race even when ordinary push would still be fast-forward', async () => {
    const old = await git(local, ['rev-parse', 'HEAD']);
    const middle = await checkpoint(local, 'B'); const head = await checkpoint(local, 'C');
    // Seed objects on the disposable server, then advertise the approved old ref.
    await git(local, ['push', origin, 'HEAD:refs/heads/main']); await git(origin, ['update-ref', 'refs/heads/main', old, head]);
    const plan = await prepareGitOperation(local, { kind: 'push', remote: 'origin', branch: 'main' }, context);
    const result = await executeGitOperation(plan, { authorize: async () => undefined, onStarting: async () => { await git(origin, ['update-ref', 'refs/heads/main', middle, old]); } });
    expect(result.status).not.toBe('succeeded'); expect(await git(origin, ['rev-parse', 'refs/heads/main'])).toBe(middle);
  }, 90_000);
  it('lets receive-pack reject a server ref race after the pre-push guard has accepted', async () => {
    const old = await git(local, ['rev-parse', 'HEAD']);
    const middle = await checkpoint(local, 'B'); const head = await checkpoint(local, 'C');
    await git(local, ['push', origin, 'HEAD:refs/heads/main']); await git(origin, ['update-ref', 'refs/heads/main', old, head]);
    await writeFile(path.join(origin, 'hooks/pre-receive'), `#!/bin/sh\nunset GIT_QUARANTINE_PATH\ngit update-ref refs/heads/main ${middle} ${old}\n`, { mode: 0o755 });
    const plan = await prepareGitOperation(local, { kind: 'push', remote: 'origin', branch: 'main' }, context);
    const result = await executeGitOperation(plan, options());
    expect(result.status).toBe('unknown'); expect(await git(origin, ['rev-parse', 'refs/heads/main'])).toBe(middle);
    await expect(executeGitOperation(plan, options())).rejects.toMatchObject({ code: 'unknown' });
  }, 90_000);
  it('invalidates a changed advertisement before consume and never rewinds a tracking ref', async () => {
    const target = await checkpoint(seed, 'B'); await git(seed, ['push', origin, 'HEAD:refs/heads/main']);
    const plan = await prepareGitOperation(local, { kind: 'fetch', remote: 'origin', branch: 'main' }, context);
    const next = await checkpoint(seed, 'C'); await git(seed, ['push', origin, 'HEAD:refs/heads/main']);
    const callbacks = options(); await expect(executeGitOperation(plan, callbacks)).rejects.toMatchObject({ code: 'stale' }); expect(callbacks.authorize).not.toHaveBeenCalled();
    expect(await git(local, ['rev-parse', 'refs/remotes/origin/main'])).not.toBe(target); expect(await git(origin, ['rev-parse', 'HEAD'])).toBe(next);
  }, 90_000);
  it.each(['https://user:secret@example.invalid/repo', 'ssh://example.invalid/repo', 'ext::arbitrary-command'])('rejects an unsafe remote endpoint %s before contacting it', async url => {
    await git(local, ['config', 'remote.origin.url', url]);
    await expect(prepareGitOperation(local, { kind: 'fetch', remote: 'origin', branch: 'main' }, context)).rejects.toMatchObject({ code: 'unsupported' });
  }, 60_000);
});
