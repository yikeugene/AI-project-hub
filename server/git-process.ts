import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitTools } from './git-tools.ts';
import { GitOperationError } from './git-errors.ts';

export interface GitProcessResult { stdout: Buffer; stderr: Buffer; code: number; timedOut: boolean; limited: boolean }
export interface GitProcessOptions {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number; maxInputBytes?: number; readOnly?: boolean;
}
export interface GitProcess {
  result: Promise<GitProcessResult>;
  write(input: string | Buffer): void;
  end(input?: string | Buffer): void;
  waitFor(text: string): Promise<void>;
  assertRunning(minimumMs?: number): Promise<void>;
  stop(): Promise<void>;
}
const MAX = 32 * 1024 * 1024;

export async function startGitProcess(tools: GitTools, args: string[], options: GitProcessOptions): Promise<GitProcess> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const maxInputBytes = options.maxInputBytes ?? 16 * 1024 * 1024;
  if (timeoutMs <= 0 || timeoutMs > 120_000 || maxOutputBytes <= 0 || maxOutputBytes > MAX || maxInputBytes <= 0 || maxInputBytes > MAX) throw new GitOperationError('invalid');
  if (process.platform === 'win32' && !tools.host && !options.readOnly) throw new GitOperationError('unavailable', 'The packaged Git supervisor is unavailable.');
  const scratch = tools.host && process.platform === 'win32' ? await mkdtemp(path.join(tmpdir(), 'hub-git-child-')) : null;
  const receipt = scratch && path.join(scratch, 'result.json');
  const nonce = randomBytes(32).toString('hex');
  let child: ChildProcessWithoutNullStreams;
  try {
    if (scratch) {
      const manifest = path.join(scratch, 'command.json');
      await writeFile(manifest, JSON.stringify({ executable: tools.git, args, cwd: options.cwd, result: receipt, nonce, timeoutMs, maxOutputBytes, maxInputBytes }), { flag: 'wx', mode: 0o600 });
      child = spawn(tools.host!, ['--supervise', manifest], { cwd: scratch, env: options.env, shell: false, windowsHide: true, stdio: 'pipe' });
    } else {
      child = spawn(tools.git, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' });
    }
  } catch {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    throw new GitOperationError('failed');
  }
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const deadline = Date.now() + timeoutMs;
  let outputSize = 0, inputSize = 0, finished = false, stopped = false, timedOut = false, limited = false;
  const waiters = new Set<{ text: string; resolve: () => void; reject: (error: Error) => void }>();
  let outputText = '';
  const kill = () => {
    stopped = true;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* The close handler still has to verify completion. */ }
  };
  let resolveResult: (value: GitProcessResult) => void, rejectResult: (error: Error) => void;
  const result = new Promise<GitProcessResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // A transaction can finish while its caller is validating the repository.
  void result.catch(() => undefined);
  const finish = async (code: number | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearTimeout(hardTimer);
    let error: Error | null = null;
    try {
      if (scratch) {
        const raw = await readFile(receipt!);
        if (raw.length > 4096 || code !== 0 || stopped) throw new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true);
        const verification = JSON.parse(raw.toString('utf8'));
        if (verification.nonce !== nonce || verification.exited !== true || !Number.isInteger(verification.code)) throw new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true);
        code = verification.code;
        timedOut = verification.timedOut === true;
        limited = verification.outputExceeded === true || verification.inputExceeded === true;
      } else if (process.platform !== 'win32' && child.pid) {
        const alive = () => { try { process.kill(-child.pid!, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
        while (alive() && !stopped && !limited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (alive()) {
          if (!limited) timedOut = true;
          kill();
          const until = Date.now() + 5_000;
          while (alive() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
          if (alive()) throw new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true);
        }
      } else if (stopped && !options.readOnly) throw new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true);
      if (code === null && !timedOut && !limited) throw new GitOperationError('failed');
    } catch (caught) { error = caught instanceof GitOperationError ? caught : new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true); }
    for (const waiter of waiters) waiter.reject(error ?? new GitOperationError('failed'));
    waiters.clear();
    if (scratch && !error) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    if (error) rejectResult(error);
    else resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 124, timedOut, limited });
  };
  const collect = (target: Buffer[], isOutput: boolean) => (data: Buffer) => {
    if (finished) return;
    outputSize += data.length;
    if (outputSize > maxOutputBytes) {
      limited = true;
      // The native host normally enforces this first. A broken host cannot be
      // trusted to have contained its child, so killing it yields unknown.
      kill(); return;
    }
    target.push(data);
    if (isOutput && waiters.size) {
      outputText = Buffer.concat(stdout).toString('utf8');
      for (const waiter of waiters) if (outputText.includes(waiter.text)) { waiters.delete(waiter); waiter.resolve(); }
    }
  };
  child.stdout.on('data', collect(stdout, true)); child.stderr.on('data', collect(stderr, false));
  child.stdin.on('error', () => undefined);
  child.once('error', () => { void finish(null); });
  child.once('close', code => { void finish(code); });
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs + (scratch ? 16_000 : 0));
  const hardTimer = setTimeout(() => {
    if (finished) return;
    finished = true; kill(); clearTimeout(timer);
    for (const waiter of waiters) waiter.reject(new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true));
    waiters.clear(); rejectResult(new GitOperationError('unknown', 'The Git process tree exit could not be verified.', true));
  }, timeoutMs + 25_000);
  const write = (input: string | Buffer) => {
    inputSize += Buffer.byteLength(input);
    if (inputSize > maxInputBytes || finished || child.stdin.destroyed) throw new GitOperationError('failed');
    child.stdin.write(input);
  };
  return {
    result, write,
    end(input) { if (input !== undefined) write(input); child.stdin.end(); },
    async waitFor(text) {
      if (Buffer.concat(stdout).toString('utf8').includes(text)) return;
      if (finished) throw new GitOperationError('failed');
      await new Promise<void>((resolve, reject) => waiters.add({ text, resolve, reject }));
    },
    async assertRunning(minimumMs = 0) {
      if (finished || stopped || child.exitCode !== null || child.signalCode !== null) { await result; throw new GitOperationError('stale', 'The native Git lock session ended.'); }
      if (deadline - Date.now() < minimumMs) throw new GitOperationError('busy', 'The native Git lock session is expiring.');
    },
    async stop() { if (!finished) child.stdin.end(); await result.then(() => undefined); },
  };
}

export async function runGitProcess(tools: GitTools, args: string[], options: GitProcessOptions, input?: string | Buffer): Promise<GitProcessResult> {
  const child = await startGitProcess(tools, args, options);
  child.end(input);
  const result = await child.result;
  if (result.timedOut || result.limited) throw new GitOperationError('failed', result.limited ? 'Git exceeded its data limit.' : 'Git exceeded its time limit.');
  return result;
}
