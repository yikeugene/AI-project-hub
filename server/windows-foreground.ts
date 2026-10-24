import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { appObservationSchema, type AppObservation } from '../shared/app-observation.js';
import type { AppObservationSource } from './app-observation-source.js';

// Do not inherit PATH, CLR profiler/startup hooks, user configuration directories or
// Node/Electron options. Explicit empty values also block libuv's Windows defaults.
const HELPER_ENV = Object.freeze({
  SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:', PATH: '',
  HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', TEMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '',
});

interface ForegroundChild {
  stdout: Readable | null;
  stderr: Readable | null;
  once: EventEmitter['once'];
  kill(signal: NodeJS.Signals): boolean;
}
interface ForegroundSourceOptions {
  /** Supplied by the desktop composition root, never from a request or PATH lookup. */
  executable: string;
  platform?: NodeJS.Platform;
  clock?: () => Date;
  // OS boundaries only: deterministic tests must never sample the developer's desktop.
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ForegroundChild;
  files?: {
    lstat(target: string): Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>;
    realpath(target: string): string;
  };
}

export function createWindowsForegroundSource(options: ForegroundSourceOptions): AppObservationSource {
  const { executable, platform = process.platform, clock = () => new Date() } = options;
  const files = options.files ?? { lstat: lstatSync, realpath: (target: string) => realpathSync(target) };
  const injectedSpawn = options.spawn;
  const directory = path.win32.dirname(executable);
  const available = () => {
    // Accept only an explicit, normalized local-drive path to our one packaged helper.
    // Resolving aliases is not permission to run their target: links/junctions fail closed.
    if (platform !== 'win32' || !/^[a-z]:\\/i.test(executable)
      || path.win32.normalize(executable) !== executable
      || executable.slice(3).split('\\').some(part => !part || /[<>:"/|?*\x00-\x1f]|[. ]$/.test(part))
      || path.win32.basename(executable).toLowerCase() !== 'foreground-app.exe'
      || path.win32.basename(directory).toLowerCase() !== 'app-observation') return false;
    try {
      const folder = files.lstat(directory), file = files.lstat(executable);
      return folder.isDirectory() && !folder.isSymbolicLink() && file.isFile() && !file.isSymbolicLink()
        && files.realpath(directory).toLowerCase() === directory.toLowerCase()
        && files.realpath(executable).toLowerCase() === executable.toLowerCase();
    } catch { return false; }
  };
  const unavailable = (): AppObservation => ({ name: null, observedAt: clock().toISOString() });
  return {
    available,
    async sample(signal) {
      const cancelled = () => Object.assign(new Error('Application observation cancelled.'), { name: 'AbortError' });
      if (signal.aborted) throw cancelled();
      const supported = available();
      if (signal.aborted) throw cancelled();
      if (!supported) return unavailable();
      const result = await new Promise<AppObservation>((resolve, reject) => {
        let child: ForegroundChild;
        try {
          child = (injectedSpawn ?? spawnProcess)(executable, [], {
            cwd: directory, env: { ...HELPER_ENV }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { if (signal.aborted) reject(cancelled()); else resolve(unavailable()); return; }
        const stdout: Buffer[] = [];
        let failed = false, closed = false, hasStderr = false, bytes = 0;
        const stop = () => {
          if (failed || closed) return;
          failed = true;
          stdout.length = 0;
          try { child.kill('SIGKILL'); } catch { /* Still await this child's close, never publish early. */ }
        };
        const timer = setTimeout(stop, 2_000);
        const collect = (isStdout: boolean) => (data: Buffer) => {
          if (failed || closed) return; // Keep draining, never retain output after failure.
          if (data.length > 4096 - bytes) { stop(); return; }
          bytes += data.length;
          if (isStdout) stdout.push(data);
          else if (data.length) hasStderr = true; // Stderr is counted, never retained or exposed.
        };
        child.stdout?.on('data', collect(true));
        child.stderr?.on('data', collect(false));
        child.stdout?.once('error', stop);
        child.stderr?.once('error', stop);
        child.once('error', stop);
        child.once('close', code => {
          closed = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          if (signal.aborted) { reject(cancelled()); return; }
          try {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(stdout));
            const parsed = appObservationSchema.safeParse(JSON.parse(text));
            resolve(!failed && !hasStderr && code === 0 && parsed.success ? parsed.data : unavailable());
          } catch { resolve(unavailable()); }
          finally { stdout.length = 0; }
        });
        signal.addEventListener('abort', stop, { once: true });
        // Covers cancellation during synchronous spawn without relying on Node's
        // built-in signal option (which rejects before child/pipe drainage).
        if (signal.aborted) stop();
      });
      if (signal.aborted) throw cancelled();
      return result;
    },
  };
}
