// node --import tsx scripts/foreground-app-smoke.mjs
// Native evidence, not a mock: the production collector is compiled with a test
// entrypoint that owns a real window. Its extra HWND guard prevents sampling any
// other foreground application if focus changes. No full Electron/package build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildForegroundApp } from './build-foreground-app.mjs';
import { APP_NAME_FORBIDDEN_RANGES, appObservationSchema, isAppObservationName } from '../shared/app-observation.ts';
import { createWindowsForegroundSource } from '../server/windows-foreground.ts';

if (process.platform !== 'win32') throw new Error('The native foreground smoke requires Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.local'), { recursive: true });
const work = await mkdtemp(path.join(root, '.local', 'foreground-smoke-'));
const executable = await buildForegroundApp(path.join(work, 'app-observation'));
assert.equal(createWindowsForegroundSource({ executable }).available(), true, 'Fresh helper must be available without collecting.');
const windows = 'C:\\Windows';
const compiler = await realpath(path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
const env = {
  SystemRoot: windows, WINDIR: windows, SYSTEMDRIVE: 'C:', PATH: '',
  HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', TEMP: work, TMP: work,
  USERDOMAIN: '', USERNAME: '', USERPROFILE: '',
};

function run(target, args, { input = '', timeout = 10000, maxOutput = 4096, windowsHide = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(target, args, { cwd: work, env, shell: false, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; let bytes = 0, failed = false, hasStderr = false;
    const fail = () => { if (!failed) { failed = true; try { child.kill('SIGKILL'); } catch {} } };
    const timer = setTimeout(fail, timeout);
    const collect = isStdout => data => {
      if (failed) return;
      bytes += data.length;
      if (bytes > maxOutput) { fail(); return; }
      if (isStdout) stdout.push(data); else hasStderr = true;
    };
    child.stdout.on('data', collect(true)); child.stderr.on('data', collect(false));
    child.once('error', fail); child.stdin.once('error', fail);
    child.stdout.once('error', fail); child.stderr.once('error', fail);
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || hasStderr) reject(new Error('Native smoke process failed; raw process output is intentionally suppressed.'));
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), pid: child.pid });
    });
    child.stdin.end(input);
  });
}

const fixture = path.join(work, 'HubForegroundFixture.exe');
const built = await run(compiler, [
  '/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/main:ForegroundWindowFixture',
  '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
  `/out:${fixture}`, path.join(root, 'desktop', 'foreground-app.cs'), path.join(root, 'tests', 'fixtures', 'foreground-window.cs'),
], { timeout: 30000, maxOutput: 65536 });
assert.equal(built.code, 0, 'Native fixture compilation failed (compiler output suppressed).');

const names = new Set([
  '', '.', '..', 'Code', 'AI Project Hub', 'C:\\Private', 'folder/name', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b',
  'x'.repeat(96), 'x'.repeat(97), '\u{1f9ea}'.repeat(96), '\u{1f9ea}'.repeat(97), 'A\u{1f9ea}B',
]);
for (const [first, last] of APP_NAME_FORBIDDEN_RANGES)
  for (let code = first; code <= last; code++) names.add(`A${String.fromCodePoint(code)}B`);
for (const code of [0x20, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])
  for (const value of [`${String.fromCodePoint(code)}A`, `A${String.fromCodePoint(code)}`, `A${String.fromCodePoint(code)}B`]) names.add(value);
const cases = [...names].map(name => ({ units: name.split('').map(unit => unit.charCodeAt(0)), valid: isAppObservationName(name) }));
const before = Date.now();
const interactive = process.argv.includes('--interactive');
if (interactive) console.log('Click the owned window titled "HelpTool foreground test" once. It closes automatically; no other window can be sampled.');
const result = await run(fixture, interactive ? ['--interactive'] : [], { input: JSON.stringify(cases), windowsHide: false, timeout: interactive ? 55000 : 10000 });
if ([0, 2, 4].includes(result.code))
  console.log(`PASS: standalone helper build, no-launch availability, and ${cases.length} shared/native Unicode validation cases.`);
if (result.code === 2 || result.code === 4) {
  console.error(result.code === 2
    ? `UNPROVEN: Windows did not grant foreground focus to the owned fixture within ${interactive ? 45 : 4} seconds. No application name was sampled.`
    : 'UNPROVEN: The owned fixture had foreground focus, but the native collector returned unavailable. No other application was sampled.');
  process.exitCode = 2;
} else {
  assert.equal(result.code, 0, result.code === 3 && /^\d+$/.test(result.stdout)
    ? `Shared/native name validation differs at controlled case #${result.stdout}.` : 'Owned foreground fixture failed its assertions.');
  const observation = appObservationSchema.parse(JSON.parse(result.stdout));
  assert.equal(observation.name, 'HubForegroundFixture');
  assert.match(observation.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(observation.observedAt) >= before && Date.parse(observation.observedAt) <= Date.now());
  assert.deepEqual(Object.keys(observation).sort(), ['name', 'observedAt']);
  assert.ok(!result.stdout.includes('HUB_FOREGROUND_PRIVATE_TITLE_SENTINEL'));
  assert.ok(!result.stdout.includes(work) && !result.stdout.includes(fixture));
  assert.ok(!Object.hasOwn(observation, 'pid') && !String(observation.name).includes(String(result.pid)));
  console.log(`PASS: real owned foreground name and UTC timestamp; no title/PID/path fields; unknown clears; ${cases.length} shared/native name cases; standalone helper build and no-launch availability.`);
  console.log('LIMIT: guarded native collector-code proof, not a packaged Electron lifecycle or locked-desktop test.');
}
