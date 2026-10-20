import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runCommand } from '../server/commands.ts';
import { startGitProcess } from '../server/git-process.ts';
import { isolatedGitEnvironment, resolveGitTools, type GitTools } from '../server/git-tools.ts';

let tools: GitTools, built: string, root: string;
beforeAll(async () => {
  built = await mkdtemp(path.join(tmpdir(), 'hub-supervisor-build-'));
  if (process.platform === 'win32') {
    const result = await runCommand(process.execPath, [fileURLToPath(new URL('../scripts/build-git-tools.mjs', import.meta.url)), built], { cwd: built, timeoutMs: 20_000 });
    if (result.code) throw new Error(result.stderr);
  }
  tools = { ...await resolveGitTools(), git: process.execPath, host: process.platform === 'win32' ? path.join(built, 'git-host.exe') : null };
});
afterAll(async () => { await rm(built, { recursive: true, force: true, maxRetries: 5 }); });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'hub-supervisor-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe('bounded supervised Git process tree', () => {
  it('passes bounded binary stdin unchanged and drains both output streams', async () => {
    const input = randomBytes(256 * 1024);
    const child = await startGitProcess(tools, ['-e', 'const chunks=[]; process.stdin.on("data", x=>chunks.push(x)); process.stdin.on("end",()=>{process.stdout.write(Buffer.concat(chunks));process.stderr.write("done");});'], { cwd: root, env: isolatedGitEnvironment(tools), maxOutputBytes: 512 * 1024 });
    child.end(input); const result = await child.result;
    expect(result.code).toBe(0); expect(result.stdout).toEqual(input); expect(result.stderr.toString()).toBe('done');
  });
  it('waits for a descendant that outlives the original child before completion', async () => {
    const marker = path.join(root, 'helper-finished');
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'done'),350)`)}],{stdio:['ignore','inherit','inherit'],detached:true}).unref();`;
    const started = Date.now(); const child = await startGitProcess(tools, ['-e', script], { cwd: root, env: isolatedGitEnvironment(tools), timeoutMs: 5_000 });
    child.end(); const result = await child.result;
    expect(result.stderr.toString()).toBe('');
    expect(result.code).toBe(0); expect(result.timedOut).toBe(false); expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(await readFile(marker, 'utf8')).toBe('done');
  });
  it('kills and verifies the entire job on timeout, not just the original child', async () => {
    const marker = path.join(root, 'must-not-run');
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1500)`)}],{stdio:['ignore','inherit','inherit'],detached:true}).unref();`;
    const child = await startGitProcess(tools, ['-e', script], { cwd: root, env: isolatedGitEnvironment(tools), timeoutMs: 200 });
    child.end(); const result = await child.result;
    expect(result.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1600)); await expect(access(marker)).rejects.toThrow();
  });
  it('bounds output and still waits for verified exit', async () => {
    const child = await startGitProcess(tools, ['-e', 'setInterval(()=>process.stdout.write("x".repeat(1024)),1);'], { cwd: root, env: isolatedGitEnvironment(tools), maxOutputBytes: 4096 });
    child.end(); const result = await child.result;
    expect(result.limited).toBe(true); expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });
  it.skipIf(process.platform !== 'win32')('fails closed when the host does not provide a verified job-exit receipt', async () => {
    const child = await startGitProcess({ ...tools, host: process.execPath }, ['-e', 'process.exit(0)'], { cwd: root, env: isolatedGitEnvironment(tools) });
    child.end(); await expect(child.result).rejects.toMatchObject({ code: 'unknown' });
  });
  it.skipIf(process.platform !== 'win32')('rejects extra updates, wrong old OIDs, wrong targets and deletes in the app-owned guard', async () => {
    const source = 'a'.repeat(40), old = 'b'.repeat(40), url = 'https://example.invalid/repo.git', ref = 'refs/heads/main';
    const valid = `${source} ${source} ${ref} ${old}\n`;
    for (const input of [valid + valid, valid.replace(old, 'c'.repeat(40)), valid.replace(ref, 'refs/heads/other'), valid.replace(`${source} ${source}`, `(delete) ${'0'.repeat(40)}`), '', valid]) {
      const nonce = randomBytes(32).toString('hex'), manifest = path.join(root, `${nonce}.json`), receipt = path.join(root, `${nonce}.receipt`);
      await writeFile(manifest, JSON.stringify({ url, source, targetRef: ref, old, nonce, receipt }));
      const child = await startGitProcess({ ...tools, git: path.join(built, 'hooks/pre-push.exe') }, [url, url], { cwd: root, env: { ...isolatedGitEnvironment(tools), HUB_GIT_PUSH_GUARD: manifest } });
      child.end(input); const result = await child.result;
      if (input === valid) { expect(result.code).toBe(0); expect(await readFile(receipt, 'utf8')).toBe(nonce); }
      else { expect(result.code).not.toBe(0); await expect(access(receipt)).rejects.toThrow(); }
    }
  });
});
