// Run only after a fresh package build:
// node --import tsx scripts/app-observation-desktop-smoke.mjs --executable C:/absolute/win-unpacked/AI\ Project\ Hub.exe
// This proves the packaged consent -> bounded source -> actual SQL -> receiver/UI
// pipeline with CONTROLLED PROCESS OUTPUT. It is NOT a real OS-capture test. The
// separate foreground-app-smoke.mjs owns that proof. Never launch the native collector here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.ts';
import { appObservationPublicationSchema, remoteAppObservationSchema } from '../shared/app-observation.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--executable');
const selected = flag < 0 ? undefined : process.argv[flag + 1];
if (process.platform !== 'win32') throw new Error('This packaged smoke requires Windows and actual DPAPI safeStorage.');
if (!selected || !isAbsolute(selected)) throw new Error('Pass --executable with an explicit absolute freshly packaged, unpacked application path. No old-artifact default is used.');
if (!(await lstat(selected)).isFile() || (await lstat(selected)).isSymbolicLink()) throw new Error('The selected executable must be an ordinary packaged file.');
const executable = await realpath(selected);
const resources = join(dirname(executable), 'resources');
const archive = join(resources, 'app.asar');
const helper = join(resources, 'app-observation', 'foreground-app.exe');
const relevantSources = [
  'desktop/main.ts', 'desktop/foreground-app.cs', 'server/windows-foreground.ts',
  'server/app-observation.ts', 'server/app-observation-relay.ts', 'server/app-observation-store.ts',
  'server/runtime.ts', 'shared/app-observation.ts', 'src/components/RemoteAppObservation.tsx',
  'src/panels/RemoteProjectsPanel.tsx', 'scripts/build-desktop.mjs', 'electron-builder.config.cjs',
];
async function assertFreshPackage() {
  const packageFile = await lstat(archive), nativeFile = await lstat(helper);
  assert.ok(packageFile.isFile() && !packageFile.isSymbolicLink(), 'An adjacent real resources/app.asar is required; installer/self-extracting EXEs are not accepted.');
  assert.ok(nativeFile.isFile() && !nativeFile.isSymbolicLink(), 'The packaged native helper must exist as a real file.');
  assert.equal((await realpath(helper)).toLowerCase(), helper.toLowerCase(), 'The packaged helper must not redirect outside its exact owned resource path.');
  const newestSource = Math.max(...await Promise.all(relevantSources.map(async name => (await stat(join(root, name))).mtimeMs)));
  assert.ok(packageFile.mtimeMs >= newestSource, 'app.asar/main.cjs is older than relevant source. Build a fresh package before this test; do not relax this privacy gate.');
  assert.ok(nativeFile.mtimeMs >= (await stat(join(root, 'desktop/foreground-app.cs'))).mtimeMs, 'The native helper is older than its source.');
  return { archiveModifiedAt: new Date(packageFile.mtimeMs).toISOString(), newestSourceAt: new Date(newestSource).toISOString() };
}
const freshness = await assertFreshPackage();
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'app-observation-desktop-'));
const outside = relative(dirname(executable), work);
assert.ok(outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside), 'Disposable data must be outside the application installation subtree.');
const home = join(work, 'home'); await mkdir(home);
const windows = process.env.SystemRoot || 'C:\\Windows';
const env = { ...process.env, HOME: home };
for (const key of Object.keys(env))
  if (['path', 'node_options', 'node_use_env_proxy', 'electron_run_as_node', 'hub_data_dir'].includes(key.toLowerCase()) || /^(?:GIT_|GCM_)|_PROXY$/i.test(key)) delete env[key];
env.PATH = `${join(windows, 'System32')};${windows}`;
const rpcNames = [
  'hub_pair', 'hub_invite', 'hub_devices', 'hub_manifest', 'hub_snapshots', 'hub_publish',
  'hub_pull', 'hub_ack', 'hub_statuses', 'hub_v2_policy', 'hub_v2_list_git',
  'hub_v2_publish_status', 'hub_v2_statuses', 'hub_app_v1_capability', 'hub_app_v1_publish', 'hub_app_v1_statuses',
];
const relayKey = randomBytes(32).toString('hex');
const peers = [], relayCalls = [], rendererErrors = [];
const report = {
  result: 'running', executable, work, freshness, checks: [],
  substitution: 'Only the exact packaged foreground helper spawn is replaced with controlled name/time output; every other process remains real.',
  limitations: ['Not real OS capture: use the separate owned-window native smoke for that proof.', 'Controlled powerMonitor events, not real workstation locks or restart coverage.', 'Actual delivered PGlite SQL and anon role, not live Supabase or two physical computers.'],
};
let fixture, relayServer;
const checked = text => { report.checks.push(text); console.log('PASS:', text); };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function bounded(promise, message, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, message, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(message);
}
async function api(peer, pathname, method = 'GET', body) {
  const scoped = pathname !== '/api/devices/pair' && /^\/api\/(?:devices|governance|app-observation)(?:\/|$)/.test(pathname);
  if (scoped) assert.ok(peer.profileId, 'Every group API must use the peer\'s captured profile, never an implicit UI selection.');
  const response = await peer.page.evaluate(async ({ pathname, method, body, token, profileId }) => {
    const headers = { 'content-type': 'application/json', 'X-Hub-Token': token, ...(profileId ? { 'X-Hub-Profile-Id': profileId } : {}) };
    const result = await fetch(pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  }, { pathname, method, body, token: peer.csrfToken, profileId: scoped ? peer.profileId : null });
  assert.ok(response.status >= 200 && response.status < 300, `${peer.name} ${method} ${pathname} returned HTTP ${response.status}.`);
  if (pathname === '/api/devices/pair') {
    assert.equal(response.data.groups.length, 1); assert.ok(response.data.profileId);
    assert.equal(response.data.profileId, response.data.groups[0].id); peer.profileId = response.data.profileId;
  }
  return response.data;
}
async function trace(peer) {
  return peer.desktop.evaluate(() => {
    const state = globalThis.__appObservationSmoke;
    return { launches: state.launches, samples: state.samples, kills: state.kills, denied: state.denied, violations: state.violations, forwarded: state.forwarded, patched: state.patched };
  });
}
async function launch(name, relayOrigin) {
  const dataDir = join(work, `${name}-data`); await mkdir(dataDir);
  const desktop = await _electron.launch({ executablePath: executable, args: ['--data-dir', dataDir], env, timeout: 45000 });
  const evaluateMain = desktop.evaluate.bind(desktop);
  desktop.evaluate = (...args) => bounded(evaluateMain(...args), `${name} main-process inspector did not respond.`);
  const peer = { name, dataDir, desktop, page: null, csrfToken: null, profileId: null, origin: null, closed: false };
  peers.push(peer);
  await desktop.evaluate(async ({ app }) => { await app.whenReady(); });
  // Fresh empty data has no consent. Install the privacy guard BEFORE pairing,
  // saved consent, session-unlock events or any app-observation refresh.
  peer.native = await desktop.evaluate(({ app, BrowserWindow, safeStorage, powerMonitor }, config) => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
    const cp = process.getBuiltinModule('node:child_process'), modules = process.getBuiltinModule('node:module');
    const { EventEmitter } = process.getBuiltinModule('node:events'), { PassThrough } = process.getBuiltinModule('node:stream');
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    if (!app.isPackaged || !same(app.getPath('exe'), config.executable) || !same(process.resourcesPath, config.resources)
      || !same(app.getAppPath(), path.join(config.resources, 'app.asar'))) throw new Error('Unexpected packaged application location. Consent remains off.');
    const mainPath = path.join(app.getAppPath(), 'main.cjs');
    if (JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).main !== 'main.cjs') throw new Error('Unexpected package entrypoint. Consent remains off.');
    const code = fs.readFileSync(mainPath, 'utf8');
    const start = code.indexOf('function createWindowsForegroundSource(');
    const end = code.indexOf('\n// ', start + 1);
    const collector = start < 0 ? '' : code.slice(start, end < 0 ? start + 20000 : end);
    const liveCall = collector.match(/\bchild\s*=\s*\(\s*injectedSpawn\s*\?\?\s*([A-Za-z_$][\w$]*)\.spawn\s*\)\s*\(\s*executable\s*,\s*\[\s*\]\s*,/);
    const moduleAssignment = liveCall && new RegExp(`\\b(?:var|let|const)\\s+${liveCall[1]}\\s*=\\s*require\\(["']node:child_process["']\\)`).test(code);
    const parameter = collector.match(/^function\s+createWindowsForegroundSource\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1];
    const injected = collector.match(/\bconst\s+injectedSpawn\s*=\s*([A-Za-z_$][\w$]*)\.spawn\s*;/)?.[1];
    if (!parameter || injected !== parameter || !liveCall || !moduleAssignment
      || /\bconst\s+spawn\s*=\s*[A-Za-z_$][\w$]*\.spawn/.test(collector))
      throw new Error('Package lacks the verified live injectedSpawn ?? child_process.spawn boundary. Rebuild; never enable consent on a captured-spawn package.');
    const expected = path.join(process.resourcesPath, 'app-observation', 'foreground-app.exe');
    if (!same(expected, config.helper) || !fs.lstatSync(expected).isFile() || fs.lstatSync(expected).isSymbolicLink()
      || !same(fs.realpathSync(expected), expected)) throw new Error('The real packaged helper is missing or redirected.');
    const state = globalThis.__appObservationSmoke = { launches: [], samples: [], kills: 0, denied: [], violations: [], forwarded: 0, patched: false };
    const originalSpawn = cp.spawn;
    const wrappedSpawn = function (filename, args, options) {
      // Other processes are real. A differently located foreground helper is a
      // privacy failure, not permission to launch it and discover the mistake later.
      if (typeof filename !== 'string' || path.basename(filename).toLowerCase() !== 'foreground-app.exe') return originalSpawn.apply(this, arguments);
      const valid = path.isAbsolute(filename) && path.normalize(filename) === filename && same(filename, expected)
        && Array.isArray(args) && args.length === 0 && options?.cwd && same(options.cwd, path.dirname(expected))
        && options.shell === false && options.windowsHide === true
        && JSON.stringify(options.stdio) === JSON.stringify(['ignore', 'pipe', 'pipe'])
        && options.env?.PATH === '' && !Object.keys(options.env).some(key => /^(NODE_OPTIONS|COR_|CORECLR_|COMPLUS_)/i.test(key));
      if (!valid) { state.violations.push('Unexpected helper target, arguments, cwd, shell, visibility or environment.'); throw new Error('Packaged collector boundary rejected by smoke privacy guard.'); }
      state.launches.push({ executable: filename, cwd: options.cwd, arguments: [...args], shell: options.shell, windowsHide: options.windowsHide });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = (code, signal = null) => {
        if (closed) return; closed = true; child.stdout.end(); child.stderr.end();
        queueMicrotask(() => child.emit('close', code, signal));
      };
      child.kill = signal => { state.kills++; close(null, signal); return true; };
      setImmediate(() => {
        if (closed) return;
        const observation = { name: 'Visual Studio Code', observedAt: new Date().toISOString() };
        state.samples.push(observation); child.stdout.write(JSON.stringify(observation)); close(0);
      });
      return child; // Never delegate this executable to the real spawn.
    };
    cp.spawn = wrappedSpawn;
    modules.syncBuiltinESMExports();
    const require = modules.createRequire(mainPath);
    state.patched = cp.spawn === wrappedSpawn && require('node:child_process').spawn === wrappedSpawn;
    if (!state.patched) throw new Error('Failed to install the collector process-boundary guard. Consent remains off.');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      const rpc = url.pathname.split('/').at(-1);
      if (url.origin !== config.fixtureUrl || url.pathname !== `/rest/v1/rpc/${rpc}` || !config.rpcNames.includes(rpc)
        || url.search || url.hash || url.username || url.password || init?.method !== 'POST' || init.redirect !== 'error') {
        state.denied.push('Unexpected external request blocked.');
        throw new Error('Unexpected external request denied by isolated application-sharing smoke.');
      }
      state.forwarded++;
      const headers = new Headers(init.headers); headers.set('x-hub-smoke-key', config.key); headers.set('x-hub-smoke-peer', config.peer);
      return originalFetch(`${config.relayOrigin}/rpc/${rpc}`, { ...init, headers });
    };
    powerMonitor.emit('lock-screen'); // Test-only app event. Does not lock the actual workstation.
    const prefs = BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences();
    const lookup = cp.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['node'], { env: process.env, encoding: 'utf8', windowsHide: true });
    const plain = 'Disposable app-sharing safeStorage proof', encrypted = safeStorage.encryptString(plain);
    return { packaged: app.isPackaged, executable: app.getPath('exe'), resources: process.resourcesPath, helper: expected,
      dynamicSpawnVerified: true, guardInstalled: state.patched, nodeLookupStatus: lookup.status,
      safeStorage: safeStorage.isEncryptionAvailable() && safeStorage.decryptString(encrypted) === plain && !encrypted.includes(Buffer.from(plain)),
      sandbox: prefs?.sandbox, contextIsolation: prefs?.contextIsolation, nodeIntegration: prefs?.nodeIntegration };
  }, { executable, resources, helper, fixtureUrl: fixture.configuration.url, relayOrigin, key: relayKey, peer: name, rpcNames });
  assert.equal(peer.native.packaged, true); assert.equal(peer.native.guardInstalled, true); assert.equal(peer.native.dynamicSpawnVerified, true);
  assert.equal(peer.native.nodeLookupStatus, 1); assert.equal(peer.native.safeStorage, true);
  // The first window can still be opening when the main-process guard is installed.
  peer.page = await desktop.firstWindow({ timeout: 30000 }); peer.page.setDefaultTimeout(30000);
  const evaluatePage = peer.page.evaluate.bind(peer.page);
  peer.page.evaluate = (...args) => bounded(evaluatePage(...args), `${name} renderer/API stage exceeded its deadline.`, 60000);
  peer.page.on('pageerror', error => rendererErrors.push({ peer: name, message: error.message }));
  await peer.page.getByRole('heading', { name: 'Development workspace', exact: true }).waitFor();
  await peer.page.waitForFunction(() => document.documentElement.lang === 'en' && !document.querySelector('.language-toggle button')?.disabled);
  const actualPreferences = await desktop.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.equal(actualPreferences.sandbox, true); assert.equal(actualPreferences.contextIsolation, true); assert.equal(actualPreferences.nodeIntegration, false);
  Object.assign(peer.native, actualPreferences);
  const workspace = await peer.page.evaluate(async () => (await fetch('/api/workspace')).json());
  peer.csrfToken = workspace.csrfToken; peer.origin = new URL(peer.page.url()).origin;
  assert.equal(workspace.environment.mode, 'desktop'); assert.equal(workspace.projects.length, 0);
  assert.equal(resolve(workspace.environment.dataDir), resolve(dataDir)); assert.equal((await fetch(peer.origin)).status, 401);
  const updates = await peer.page.evaluate(() => window.hubDesktop.getUpdateState());
  assert.equal(updates.status, 'unavailable', 'The isolated run must never activate an updater adapter.');
  return peer;
}
async function checkEncryptedProfile(peer) {
  const result = await peer.desktop.evaluate(({ safeStorage }, { dataDir, profileId }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), path = process.getBuiltinModule('node:path');
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT credentials FROM relay_profiles WHERE id=? AND enabled=1 AND pairing_pending=0').get(profileId);
      if (!row) throw new Error('The smoke group has no active encrypted credential.');
      const cipher = Buffer.from(row.credentials), plain = safeStorage.decryptString(cipher);
      return { decryptable: !!JSON.parse(plain), opaque: !cipher.includes(Buffer.from(plain)) };
    } finally { db.close(); }
  }, { dataDir: peer.dataDir, profileId: peer.profileId });
  assert.equal(result.decryptable, true); assert.equal(result.opaque, true);
}
async function quit(peer) {
  if (peer.closed) return;
  const closing = peer.desktop.waitForEvent('close', { timeout: 30000 }); void closing.catch(() => {});
  await peer.desktop.evaluate(({ Menu, dialog }) => {
    dialog.showMessageBoxSync = () => 1; // Fixture-owned drafts only; normal unsaved-content guard remains in place.
    const item = Menu.getApplicationMenu()?.getMenuItemById('quit');
    if (!item) throw new Error('Native File / Quit is missing.');
    item.click(); // X/close alone would leave a tray-resident process.
  });
  await closing; peer.closed = true;
  if (peer.origin) await assert.rejects(fetch(peer.origin));
}

try {
  fixture = await createSqlRelayFixture({ includeAppObservation: true });
  relayServer = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const rpc = (req.url || '').slice('/rpc/'.length);
    if (req.method !== 'POST' || req.url !== `/rpc/${rpc}` || !rpcNames.includes(rpc)
      || req.headers['x-hub-smoke-key'] !== relayKey || !['sender', 'receiver'].includes(req.headers['x-hub-smoke-peer'])
      || req.headers.apikey !== fixture.configuration.publishableKey) { send(403, { code: 'HU403' }); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Request too large.'); chunks.push(chunk); }
      const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const entry = { peer: req.headers['x-hub-smoke-peer'], name: rpc, at: Date.now(), accepted: false };
      if (rpc === 'hub_app_v1_publish') entry.publication = appObservationPublicationSchema.parse(JSON.parse(args.p_payload));
      if (rpc === 'hub_v2_publish_status') entry.activityMode = JSON.parse(args.p_status).activity?.mode ?? null;
      relayCalls.push(entry); // Never retain device tokens or arbitrary RPC arguments.
      try { const value = await fixture.rpc(rpc, args); entry.accepted = true; send(200, value); }
      catch (error) { entry.errorCode = typeof error?.code === 'string' ? error.code : 'XX000'; send(400, { code: entry.errorCode, message: 'SQL fixture request refused' }); }
    } catch { send(400, { code: 'HU400', message: 'Invalid isolated fixture request' }); }
  });
  await new Promise(done => relayServer.listen(0, '127.0.0.1', done));
  const relayOrigin = `http://127.0.0.1:${relayServer.address().port}`;
  const receiver = await launch('receiver', relayOrigin), sender = await launch('sender', relayOrigin);
  report.native = { receiver: receiver.native, sender: sender.native };
  checked('Two fresh packaged sandboxed peers use DPAPI, isolated data, no system Node on PATH, and verified dynamic helper interception before consent');
  const bootstrap = await fixture.bootstrap('Disposable packaged application sharing');
  await api(receiver, '/api/devices/pair', 'POST', { ...fixture.configuration, code: bootstrap.code, name: 'Packaged app receiver', confirm: true });
  const invitation = await api(receiver, '/api/devices/invitation', 'POST', {});
  await api(sender, '/api/devices/pair', 'POST', { ...fixture.configuration, code: invitation.code, name: 'Packaged app sender', confirm: true });
  for (const peer of peers) {
    const devices = await api(peer, '/api/devices'); peer.deviceId = devices.localDevice.id;
    assert.equal(devices.profileId, peer.profileId); assert.equal(devices.groups.length, 1);
    assert.equal(devices.localDevice.id, devices.groups[0].deviceId); assert.notEqual(devices.installationId, peer.deviceId);
    await api(peer, '/api/devices/sync', 'POST', {}); await checkEncryptedProfile(peer);
    const state = await api(peer, '/api/app-observation/refresh', 'POST', { confirm: true });
    assert.equal(state.policy.enabled, false); assert.equal(state.collectorAvailable, true); assert.equal(state.capability, 'supported');
    assert.equal(state.local, null); assert.equal((await trace(peer)).launches.length, 0);
  }
  checked('Captured profile-scoped pairing and real SQL capability discovery leave independent application consent off with zero helper launches');

  const activityPreview = await api(sender, '/api/governance/sharing/preview', 'POST', { policy: { activity: true, projects: [] } });
  await api(sender, '/api/governance/sharing', 'POST', { policy: activityPreview.policy, digest: activityPreview.digest, confirm: true });
  await api(sender, '/api/governance/refresh', 'POST', { confirm: true });
  const legacyBefore = await api(receiver, '/api/governance/refresh', 'POST', { confirm: true });
  assert.ok(legacyBefore.statuses.find(value => value.deviceId === sender.deviceId)?.activity);
  assert.equal((await trace(sender)).launches.length, 0, 'Existing HelpTool activity consent must not start the application collector.');
  const enable = await api(sender, '/api/app-observation/sharing/preview', 'POST', { policy: { enabled: true } });
  assert.deepEqual(enable.fields, ['name', 'observedAt']);
  await api(sender, '/api/app-observation/refresh', 'POST', { confirm: true });
  assert.equal((await api(sender, '/api/app-observation')).policy.enabled, false);
  assert.equal((await trace(sender)).launches.length, 0);
  checked('Existing v2 HelpTool activity remains usable; an unsaved application-sharing preview and explicit refresh collect nothing');

  // Repeat the package freshness gate immediately before the only positive consent save.
  await assertFreshPackage();
  assert.equal((await trace(sender)).patched, true); assert.equal((await trace(receiver)).patched, true);
  await sender.desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  const saved = await api(sender, '/api/app-observation/sharing', 'POST', { policy: enable.policy, digest: enable.digest, confirm: true });
  assert.equal(saved.policy.enabled, true);
  await api(sender, '/api/app-observation/refresh', 'POST', { confirm: true });
  assert.equal((await trace(sender)).launches.length, 0, 'Saved consent while the controlled session is unavailable must not start the helper.');
  await sender.desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  const received = await until(async () => {
    await api(sender, '/api/app-observation/refresh', 'POST', { confirm: true });
    const state = await api(receiver, '/api/app-observation/refresh', 'POST', { confirm: true });
    assert.equal(state.policy.enabled, false);
    return state.statuses.find(value => value.deviceId === sender.deviceId && value.observation?.name === 'Visual Studio Code');
  }, 'Controlled helper output did not reach the receiver through the actual application SQL channel.');
  remoteAppObservationSchema.parse(received);
  assert.deepEqual(Object.keys(received.observation).sort(), ['name', 'observedAt']);
  assert.ok(Math.abs(Date.now() - Date.parse(received.observation.observedAt)) < 60000);
  assert.ok(Math.abs(Date.now() - Date.parse(received.receivedAt)) < 60000);
  const sourceTrace = await trace(sender);
  assert.ok(sourceTrace.launches.length > 0 && sourceTrace.samples.length > 0, 'The process-output substitution MUST actually intercept; cached/mock service state is not proof.');
  assert.equal((await trace(receiver)).launches.length, 0);
  assert.ok(sourceTrace.samples.some(value => value.observedAt === received.observation.observedAt));
  assert.deepEqual(sourceTrace.violations, []);
  assert.ok(relayCalls.some(call => call.peer === 'sender' && call.name === 'hub_app_v1_publish' && call.accepted && call.publication?.observation?.name === 'Visual Studio Code'));
  checked('Explicit saved consent plus a controlled unlock invokes the exact packaged bounded source; fresh name/time reaches an off-policy receiver through real anon-role SQL with no title/PID/path fields');

  await receiver.page.reload();
  await receiver.page.getByRole('heading', { name: 'Development workspace', exact: true }).waitFor();
  await receiver.page.locator('.device-nav-item').filter({ hasText: 'Packaged app sender' }).click();
  const remoteApp = receiver.page.locator('.remote-app-observation');
  await remoteApp.getByText('Visual Studio Code', { exact: true }).waitFor();
  await remoteApp.getByText('Recent observation and receipt — not live', { exact: true }).waitFor();
  assert.equal(await remoteApp.locator('time').count(), 2);
  await receiver.page.locator('.remote-device-heading').screenshot({ path: join(work, 'packaged-remote-app.png') });
  checked('The actual packaged remote-device UI renders the controlled application name and both timestamps beside separate HelpTool status');

  const disable = await api(sender, '/api/app-observation/sharing/preview', 'POST', { policy: { enabled: false } });
  const off = await api(sender, '/api/app-observation/sharing', 'POST', { policy: disable.policy, digest: disable.digest, confirm: true });
  assert.equal(off.policy.enabled, false); assert.equal(off.local, null);
  const countAtOptOut = (await trace(sender)).launches.length;
  const withdrawn = await until(async () => {
    await api(sender, '/api/app-observation/refresh', 'POST', { confirm: true });
    const state = await api(receiver, '/api/app-observation/refresh', 'POST', { confirm: true });
    const positive = relayCalls.filter(call => call.peer === 'sender' && call.accepted && call.publication?.observation?.name === 'Visual Studio Code');
    const largestPositive = Math.max(...positive.map(call => call.publication.sequence));
    return state.statuses.find(value => value.deviceId === sender.deviceId && value.observation === null && value.sequence > largestPositive);
  }, 'Opt-out did not deliver a higher-sequence null withdrawal through real SQL.');
  remoteAppObservationSchema.parse(withdrawn);
  assert.ok(relayCalls.some(call => call.peer === 'sender' && call.accepted && call.publication?.observation === null && call.publication.sequence === withdrawn.sequence));
  for (let attempt = 0; attempt < 2; attempt++) await api(sender, '/api/app-observation/refresh', 'POST', { confirm: true });
  await api(sender, '/api/devices/sync', 'POST', {});
  assert.equal((await trace(sender)).launches.length, countAtOptOut);
  assert.equal((await trace(receiver)).launches.length, 0);
  const legacySender = await api(sender, '/api/governance/refresh', 'POST', { confirm: true });
  assert.deepEqual(legacySender.sharing, { activity: true, projects: [] }); assert.equal(legacySender.error, null);
  const legacyAfter = await api(receiver, '/api/governance/refresh', 'POST', { confirm: true });
  assert.equal(legacyAfter.error, null);
  const legacyStatus = legacyAfter.statuses.find(value => value.deviceId === sender.deviceId);
  assert.ok(legacyStatus?.activity); assert.equal(Object.hasOwn(legacyStatus, 'appObservation'), false);
  checked('Opt-out publishes a higher-sequence null withdrawal, clears the name, and prevents new helper launches during explicit refresh/sync; v2 activity still works');

  report.publication = { observedAt: received.observation.observedAt, receivedAt: received.receivedAt, positiveSequence: received.sequence, withdrawalSequence: withdrawn.sequence };
  report.processBoundary = {};
  for (const peer of peers) {
    const state = await trace(peer);
    assert.deepEqual(state.denied, []); assert.deepEqual(state.violations, []); assert.ok(state.forwarded > 0);
    report.processBoundary[peer.name] = { substitutedLaunches: state.launches.length, outputs: state.samples.length, forwarded: state.forwarded };
  }
  assert.deepEqual(rendererErrors, []);
  for (const peer of [...peers].reverse()) await quit(peer);
  checked('Both peers quit through the genuine native File/Quit callback and release their secured local listeners');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  // Keep the spawn guard installed through shutdown; never restore native collection
  // while a saved consent or asynchronous refresh could still exist.
  for (const peer of [...peers].reverse()) if (!peer.closed) await quit(peer).catch(async error => {
    report.cleanupError = error instanceof Error ? error.message : String(error);
    await peer.desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await bounded(peer.desktop.close(), 'Packaged peer cleanup exceeded its deadline.').catch(() => {
      report.forcedCleanup = true;
      const pid = peer.desktop.process()?.pid;
      if (pid) spawnSync(join(windows, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    });
  });
  if (relayServer) { relayServer.closeAllConnections(); await bounded(new Promise(done => relayServer.close(done)), 'Fixture server cleanup exceeded its deadline.'); }
  await fixture?.close();
  report.rpcCounts = Object.fromEntries([...new Set(relayCalls.map(call => `${call.peer}:${call.name}`))].map(key => [key, relayCalls.filter(call => `${call.peer}:${call.name}` === key).length]));
  report.rendererErrors = rendererErrors;
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Controlled-output packaged application-sharing smoke artifacts:', work);
}
