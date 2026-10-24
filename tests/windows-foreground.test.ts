import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsForegroundSource } from '../server/windows-foreground.js';

const executable = 'C:\\Hub\\resources\\app-observation\\foreground-app.exe';
const directory = 'C:\\Hub\\resources\\app-observation';
const now = '2026-10-24T12:00:00.000Z';
const observation = { name: 'Visual Studio Code', observedAt: '2026-10-24T11:59:59.000Z' };

class FixtureChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  close(code: number | null = 0) { this.stdout.end(); this.stderr.end(); this.emit('close', code, null); }
}
function harness(overrides: Partial<Parameters<typeof createWindowsForegroundSource>[0]> = {}) {
  const child = new FixtureChild();
  const spawn = vi.fn((_target: string, _args: string[], _options: SpawnOptions) => child);
  const files = {
    lstat: vi.fn((target: string) => ({
      isFile: () => target === executable,
      isDirectory: () => target === directory,
      isSymbolicLink: (): boolean => false,
    })),
    realpath: vi.fn((target: string) => target),
  };
  const clock = vi.fn(() => new Date(now));
  return { child, spawn, files, clock, source: createWindowsForegroundSource({ executable, platform: 'win32', spawn, files, clock, ...overrides }) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Windows foreground source', () => {
  it('inspects only the exact owned helper file without launching or observing on construction/available', () => {
    const { source, spawn, files, clock } = harness();
    expect(files.lstat).not.toHaveBeenCalled();
    expect(source.available()).toBe(true);
    expect(files.lstat.mock.calls.flat()).toEqual(expect.arrayContaining([directory, executable]));
    expect(spawn).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });

  it('launches only the absolute owned target, with empty arguments, trusted cwd and an isolated non-shell environment', async () => {
    vi.stubEnv('PATH', 'C:\\untrusted');
    vi.stubEnv('NODE_OPTIONS', '--require C:\\untrusted\\injection.js');
    vi.stubEnv('COR_ENABLE_PROFILING', '1');
    vi.stubEnv('COR_PROFILER_PATH', 'C:\\untrusted\\profiler.dll');
    vi.stubEnv('COMPLUS_Version', 'untrusted');
    const { source, child, spawn } = harness();
    const pending = source.sample(new AbortController().signal);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, [], expect.objectContaining({
      cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const env = spawn.mock.calls[0][2].env!;
    expect(env.PATH).toBe('');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('COR_ENABLE_PROFILING');
    expect(env).not.toHaveProperty('COR_PROFILER_PATH');
    expect(env).not.toHaveProperty('COMPLUS_Version');
    expect(Object.values(env)).not.toContain('C:\\untrusted');
    child.stdout.write(JSON.stringify(observation));
    child.close();
    expect(await pending).toEqual(observation);
  });

  it('kills on cancellation and rejects only after the owned child closes, never returning a fresh sample', async () => {
    const { source, child, clock } = harness();
    const controller = new AbortController();
    let settled = false;
    const pending = source.sample(controller.signal);
    const rejected = pending.catch(error => { settled = true; return error; });
    child.stdout.write(JSON.stringify(observation));
    controller.abort(new Error('PRIVATE_PATH_OR_REASON'));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(clock).not.toHaveBeenCalled();
    child.close();
    const error = await rejected;
    expect(error).toMatchObject({ name: 'AbortError', message: 'Application observation cancelled.' });
    expect(clock).not.toHaveBeenCalled();
  });

  it('discards a just-closed result if cancelled before the asynchronous sample returns', async () => {
    const { source, child } = harness();
    const controller = new AbortController();
    const pending = source.sample(controller.signal);
    child.stdout.write(JSON.stringify(observation)); child.close();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('enforces a two-second deadline but waits for close before reporting unavailable', async () => {
    vi.useFakeTimers();
    const { source, child } = harness();
    let settled = false;
    const pending = source.sample(new AbortController().signal).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(settled).toBe(false);
    child.stdout.write(JSON.stringify(observation));
    child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps combined raw stdout/stderr at 4 KiB and drains an over-limit child before clearing the name', async () => {
    const { source, child } = harness();
    let settled = false;
    const pending = source.sample(new AbortController().signal).then(value => { settled = true; return value; });
    child.stdout.write(' '.repeat(2048));
    child.stderr.write('x'.repeat(2048));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.write('x');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.write(JSON.stringify(observation));
    child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
  });

  it.each([
    'foreground-app.exe', '.\\app-observation\\foreground-app.exe',
    'C:app-observation\\foreground-app.exe', '\\\\host\\share\\app-observation\\foreground-app.exe',
    '\\\\?\\C:\\Hub\\app-observation\\foreground-app.exe',
    'C:\\Hub\\untrusted\\foreground-app.exe', 'C:\\Hub\\app-observation\\other.exe',
    'C:\\Hub\\app-observation\\..\\app-observation\\foreground-app.exe',
    'C:\\Hub.\\app-observation\\foreground-app.exe', 'C:\\Hub\\app-observation\\foreground-app.exe:stream',
  ])('rejects a non-owned or ambiguous target without PATH lookup: %s', async target => {
    const { source, spawn, files } = harness({ executable: target });
    expect(source.available()).toBe(false);
    expect(await source.sample(new AbortController().signal)).toEqual({ name: null, observedAt: now });
    expect(files.lstat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('never inspects files or spawns on unsupported platforms', async () => {
    const { source, files, spawn } = harness({ platform: 'linux' });
    expect(source.available()).toBe(false);
    expect(await source.sample(new AbortController().signal)).toEqual({ name: null, observedAt: now });
    expect(files.lstat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory', 'link', 'junction'] as const)('fails closed for a %s target', async failure => {
    const { source, files, spawn } = harness();
    if (failure === 'missing') files.lstat.mockImplementation(() => { throw new Error('PRIVATE_FILE_PATH'); });
    if (failure === 'directory') files.lstat.mockReturnValue({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false });
    if (failure === 'link') files.lstat.mockReturnValue({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => true });
    if (failure === 'junction') files.realpath.mockReturnValue('C:\\elsewhere\\foreground-app.exe');
    expect(source.available()).toBe(false);
    expect(await source.sample(new AbortController().signal)).toEqual({ name: null, observedAt: now });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rechecks the fixed file on each sample rather than caching a past capability', async () => {
    const { source, files, spawn } = harness();
    expect(source.available()).toBe(true);
    files.lstat.mockImplementation(() => { throw new Error('gone'); });
    expect(await source.sample(new AbortController().signal)).toEqual({ name: null, observedAt: now });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects already-cancelled calls without file reads, a process, or a fresh timestamp', async () => {
    const { source, spawn, files, clock } = harness();
    const controller = new AbortController(); controller.abort('PRIVATE_REASON');
    await expect(source.sample(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled(); expect(files.lstat).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  });

  it('does not return a fresh unavailable sample if cancellation occurs during capability inspection', async () => {
    const { source, files, spawn, clock } = harness();
    const controller = new AbortController();
    files.lstat.mockImplementation(() => { controller.abort(); throw new Error('missing'); });
    await expect(source.sample(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  });

  it('handles cancellation during spawn and still waits for the known child to close', async () => {
    const { source, spawn, child } = harness();
    const controller = new AbortController();
    spawn.mockImplementation(() => { controller.abort(); return child; });
    const pending = source.sample(controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    child.close();
    await assertion;
  });

  it('does not expose process start errors or stderr', async () => {
    const { source, spawn, child } = harness();
    spawn.mockImplementationOnce(() => { throw new Error('PRIVATE_PROCESS_PATH'); });
    expect(await source.sample(new AbortController().signal)).toEqual({ name: null, observedAt: now });
    const pending = source.sample(new AbortController().signal);
    child.stdout.write(JSON.stringify(observation)); child.stderr.write('PRIVATE_STDERR'); child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
  });

  it.each(['error', 'stdout', 'stderr'] as const)('drains %s failures without leaking their details', async kind => {
    const { source, child } = harness();
    let settled = false;
    const pending = source.sample(new AbortController().signal).then(value => { settled = true; return value; });
    const emitter = kind === 'error' ? child : child[kind];
    emitter.emit('error', new Error('PRIVATE_PROCESS_PATH_OR_PID'));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await Promise.resolve(); expect(settled).toBe(false);
    child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
  });

  it.each([1, null])('treats abnormal exit %s as unavailable', async code => {
    const { source, child } = harness();
    const pending = source.sample(new AbortController().signal);
    child.stdout.write(JSON.stringify(observation)); child.close(code);
    expect(await pending).toEqual({ name: null, observedAt: now });
  });

  it.each([
    { ...observation, title: 'PRIVATE_TITLE' }, { ...observation, pid: 123 },
    { ...observation, path: 'C:\\PRIVATE.exe' }, { name: 'Code' },
    { ...observation, observedAt: 'not-a-time' }, {}, ['Code'],
    ...['', '.', '..', ' A', 'A ', 'C:\\Code', 'foo/bar', 'Code\u0000', 'Co\u202ede', 'A'.repeat(97), '\u{1f9ea}'.repeat(97), '\ud800', '\udfff'].map(name => ({ ...observation, name })),
    ...[0x1f, 0x7f, 0x9f, 0xad, 0x61c, 0x180e, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0xfeff].map(code => ({ ...observation, name: `A${String.fromCodePoint(code)}B` })),
  ])('accepts no malformed or privacy-expanding observation (%#)', async value => {
    const { source, child } = harness();
    const pending = source.sample(new AbortController().signal);
    child.stdout.write(JSON.stringify(value)); child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
  });

  it.each(['A'.repeat(96), '\u{1f9ea}'.repeat(96)])('counts Unicode code points rather than UTF-16 units (%#)', async name => {
    const { source, child } = harness();
    const pending = source.sample(new AbortController().signal);
    child.stdout.write(JSON.stringify({ name, observedAt: observation.observedAt })); child.close();
    expect(await pending).toEqual({ name, observedAt: observation.observedAt });
  });

  it('preserves null observations and never reuses an earlier known name or timestamp', async () => {
    const { source, child, spawn } = harness();
    const first = source.sample(new AbortController().signal);
    child.stdout.write(JSON.stringify(observation)); child.close();
    expect(await first).toEqual(observation);
    const nextChild = new FixtureChild(); spawn.mockReturnValueOnce(nextChild);
    const second = source.sample(new AbortController().signal);
    const unknown = { name: null, observedAt: '2026-10-24T12:00:01.000Z' };
    nextChild.stdout.write(JSON.stringify(unknown)); nextChild.close();
    expect(await second).toEqual(unknown);
  });

  it('accepts exactly 4 KiB and correctly joins split multibyte output', async () => {
    const { source, child } = harness();
    const pending = source.sample(new AbortController().signal);
    const value = { ...observation, name: 'Test \u{1f9ea}' };
    const payload = Buffer.from(JSON.stringify(value));
    const padded = Buffer.concat([payload, Buffer.alloc(4096 - payload.length, 0x20)]);
    for (let index = 0; index < padded.length; index++) child.stdout.write(padded.subarray(index, index + 1));
    child.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(await pending).toEqual(value);
  });

  it('rejects malformed UTF-8 rather than replacing invalid bytes with a valid-looking label', async () => {
    const { source, child } = harness();
    const pending = source.sample(new AbortController().signal);
    child.stdout.write(Buffer.concat([
      Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from(`","observedAt":"${now}"}`),
    ]));
    child.close();
    expect(await pending).toEqual({ name: null, observedAt: now });
  });
});
