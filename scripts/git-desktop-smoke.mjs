// Run with host Node: node --import tsx scripts/git-desktop-smoke.mjs --executable C:/absolute/new-package/AI\ Project\ Hub.exe
// All transport substitution and observation below exist only in test automation, never in the packaged app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.ts';
import { resolveGitTools } from '../server/git-tools.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableFlag = process.argv.indexOf('--executable');
const selected = executableFlag < 0 ? undefined : process.argv[executableFlag + 1];
if (!selected || !isAbsolute(selected) || !existsSync(selected)) throw new Error('Pass --executable with the absolute path of the freshly packaged Windows executable. No old-artifact default is used.');
if (process.platform !== 'win32') throw new Error('This packaging smoke requires Windows and the native packaged Git tools.');
const executable = await realpath(selected);
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'git-desktop-smoke-'));
const repository = join(work, 'disposable-repository');
const installRelative = relative(dirname(executable), repository);
assert.ok(installRelative === '..' || installRelative.startsWith(`..${sep}`) || isAbsolute(installRelative), 'The disposable repository must be outside the application installation subtree.');
await mkdir(repository);
const home = join(work, 'git-home'), emptyHooks = join(work, 'empty-hooks');
await mkdir(home); await mkdir(emptyHooks);
const tools = await resolveGitTools();
const windows = process.env.SystemRoot || 'C:\\Windows';
const env = { ...process.env, HOME: home };
for (const key of Object.keys(env)) if (['path', 'node_options', 'node_use_env_proxy', 'electron_run_as_node', 'hub_data_dir'].includes(key.toLowerCase()) || /^(?:GIT_|GCM_)|_PROXY$/i.test(key)) delete env[key];
env.PATH = [...new Set([...tools.binPaths, windows])].join(';');
const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '' };
const whereNode = spawnSync(join(windows, 'System32', 'where.exe'), ['node'], { env, encoding: 'utf8', windowsHide: true });
assert.equal(whereNode.status, 1, 'System Node must not be discoverable on the Electron/Git PATH.');
function git(args) {
  const result = spawnSync(tools.git, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${emptyHooks}`, '-c', 'user.name=Native Git Smoke', '-c', 'user.email=native-smoke@example.invalid', ...args], {
    cwd: repository, env: gitEnv, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Isolated Git ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
git(['init', '--initial-branch=main']);
git(['config', 'core.autocrlf', 'false']);
await writeFile(join(repository, 'stage.txt'), 'baseline stage content\n');
await writeFile(join(repository, 'stale.txt'), 'baseline stale content\n');
git(['add', '--', 'stage.txt', 'stale.txt']); git(['commit', '-m', 'Disposable baseline']);
const originalHead = git(['rev-parse', 'HEAD']).trim();
const originalIndex = await readFile(join(repository, '.git', 'index'));
await writeFile(join(repository, 'stage.txt'), 'explicitly approved stage content\n');
await writeFile(join(repository, 'stale.txt'), 'reviewed stale candidate\n');

const report = { result: 'running', executable, work, repository, checks: [], limitations: ['The relay is actual PGlite SQL with anon roles, not a live Supabase gateway or multi-connection PostgreSQL.', 'The packaged native pre-push guard is exercised directly; no remote Git push or installed NSIS update is performed.'] };
const checked = message => { report.checks.push(message); console.log('PASS:', message); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function bounded(promise, message, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(check, message, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(200); }
  throw new Error(message);
}
const peers = [], relayCalls = [], rendererErrors = [];
const relayKey = randomBytes(32).toString('hex');
let fixture, relayServer;

async function apiRaw(peer, path, method = 'GET', body) {
  const pathname = path.split('?')[0];
  // This smoke owns exactly one group per peer. Capture it from pairing, never from a
  // mutable management-group fallback; even optional governance/Git reads bind it.
  const scoped = pathname !== '/api/devices/pair' && (/^\/api\/(?:devices|messages|governance|git)(?:\/|$)/.test(pathname)
    || /^\/api\/projects\/[^/]+\/git(?:\/|$)/.test(pathname));
  if (scoped) assert.ok(peer.profileId, `${peer.name} must have a captured profile before ${method} ${path}`);
  const response = await peer.page.evaluate(async ({ path, method, body, token, profileId }) => {
    const headers = { 'content-type': 'application/json', 'X-Hub-Token': token, ...(profileId ? { 'X-Hub-Profile-Id': profileId } : {}) };
    const response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  }, { path, method, body, token: peer.csrfToken, profileId: scoped ? peer.profileId : null });
  if (pathname === '/api/devices/pair' && method === 'POST' && response.status >= 200 && response.status < 300) {
    assert.equal(response.data.groups.length, 1, 'Each isolated Git smoke peer must have exactly one joined group.');
    assert.ok(response.data.profileId);
    assert.equal(response.data.profileId, response.data.groups[0].id);
    peer.profileId = response.data.profileId;
  }
  return response;
}
async function api(peer, path, method = 'GET', body) {
  const response = await apiRaw(peer, path, method, body);
  assert.ok(response.status >= 200 && response.status < 300, `${peer.name} ${method} ${path}: ${response.status} ${JSON.stringify(response.data)}`);
  return response.data;
}
async function launch(name, relayOrigin) {
  const dataDir = join(work, `${name}-data`);
  const desktop = await _electron.launch({ executablePath: executable, args: ['--data-dir', dataDir], env, timeout: 45000 });
  const evaluateMain = desktop.evaluate.bind(desktop);
  desktop.evaluate = (...args) => bounded(evaluateMain(...args), `${name} main-process inspector did not answer within 15 seconds.`);
  const peer = { name, dataDir, desktop, page: null, csrfToken: null, profileId: null, origin: null, closed: false }; peers.push(peer);
  peer.page = await desktop.firstWindow({ timeout: 30000 }); peer.page.setDefaultTimeout(30000);
  const evaluatePage = peer.page.evaluate.bind(peer.page);
  peer.page.evaluate = (...args) => bounded(evaluatePage(...args), `${name} renderer/API stage exceeded 60 seconds.`, 60000);
  peer.page.on('pageerror', error => rendererErrors.push({ peer: name, message: error.message }));
  await peer.page.getByRole('heading', { name: 'Pick up your work', exact: true }).waitFor();
  await peer.page.waitForFunction(() => document.documentElement.lang === 'en' && !document.querySelector('.language-toggle button')?.disabled);
  const workspace = await peer.page.evaluate(async () => (await fetch('/api/workspace')).json());
  peer.csrfToken = workspace.csrfToken; peer.origin = new URL(peer.page.url()).origin;
  assert.equal(workspace.environment.mode, 'desktop'); assert.equal(workspace.projects.length, 0);
  assert.equal(resolve(workspace.environment.dataDir), resolve(dataDir));
  assert.equal((await fetch(peer.origin)).status, 401);
  peer.native = await desktop.evaluate(({ app, BrowserWindow, safeStorage }, transport) => {
    const cp = process.getBuiltinModule('node:child_process'), fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
    const originalFetch = globalThis.fetch;
    globalThis.__gitSmoke = { denied: [], forwarded: 0, launches: [] };
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.origin !== transport.fixtureUrl || !/^\/rest\/v1\/rpc\/hub_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password || init?.method !== 'POST' || init.redirect !== 'error') {
        globalThis.__gitSmoke.denied.push(`${url.origin}${url.pathname}`);
        throw new Error('Unexpected external request denied by isolated Git smoke automation.');
      }
      globalThis.__gitSmoke.forwarded++;
      const headers = new Headers(init.headers);
      headers.set('x-hub-smoke-key', transport.key); headers.set('x-hub-smoke-peer', transport.peer);
      return originalFetch(`${transport.relayOrigin}/rpc/${url.pathname.split('/').at(-1)}`, { ...init, headers });
    };
    // Transparent observation only: the production resolver and supervisor arguments are untouched.
    const originalSpawn = cp.spawn;
    cp.spawn = function (filename, args, options) {
      if (typeof filename === 'string' && path.basename(filename).toLowerCase() === 'git-host.exe' && args?.[0] === '--supervise') {
        const manifest = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        globalThis.__gitSmoke.launches.push({ host: filename, executable: manifest.executable, cwd: manifest.cwd, args: manifest.args });
      }
      return originalSpawn.apply(this, arguments);
    };
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    const node = cp.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['node'], { env: process.env, encoding: 'utf8', windowsHide: true });
    const value = `Disposable ${transport.peer} safeStorage test`, cipher = safeStorage.encryptString(value);
    return { packaged: app.isPackaged, executable: app.getPath('exe'), resources: process.resourcesPath, nodeOnPath: node.status === 0, nodeLookupStatus: node.status,
      safeStorage: safeStorage.isEncryptionAvailable() && safeStorage.decryptString(cipher) === value && !cipher.includes(Buffer.from(value)),
      sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  }, { fixtureUrl: fixture.configuration.url, relayOrigin, key: relayKey, peer: name });
  assert.equal(peer.native.packaged, true); assert.equal(peer.native.nodeOnPath, false); assert.equal(peer.native.nodeLookupStatus, 1);
  assert.equal(peer.native.safeStorage, true); assert.equal(peer.native.sandbox, true); assert.equal(peer.native.contextIsolation, true); assert.equal(peer.native.nodeIntegration, false);
  assert.equal(resolve(peer.native.executable).toLowerCase(), resolve(executable).toLowerCase());
  return peer;
}
async function quit(peer) {
  if (peer.closed) return;
  const closed = peer.desktop.waitForEvent('close', { timeout: 30000 }); void closed.catch(() => {});
  await peer.desktop.evaluate(({ Menu, dialog }) => {
    // The fixture owns all drafts; this is only a native dialog response, not a shutdown bypass.
    dialog.showMessageBoxSync = () => 1;
    const item = Menu.getApplicationMenu()?.getMenuItemById('quit');
    if (!item) throw new Error('Native File / Quit is missing.');
    item.click();
  });
  await closed; peer.closed = true;
  if (peer.origin) await assert.rejects(fetch(peer.origin));
}
async function approve(admin, preview) {
  await until(async () => {
    await api(admin, '/api/governance/refresh', 'POST', { confirm: true });
    const pending = await api(admin, '/api/git/approvals');
    return pending.some(request => request.id === preview.id && request.digest === preview.digest && request.state === 'pending');
  }, 'The administrator did not receive the submitted Git request');
  const decision = await api(admin, `/api/git/approvals/${preview.id}/decision`, 'POST', { digest: preview.digest, confirm: true, decision: 'approved', reason: 'Reviewed disposable native packaging test' });
  assert.equal(decision.state, 'approved');
}
async function checkEncryptedProfile(peer) {
  const state = await peer.desktop.evaluate(({ safeStorage }, { dataDir, profileId }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite'), path = process.getBuiltinModule('node:path');
    const db = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT credentials FROM relay_profiles WHERE id=? AND enabled=1 AND pairing_pending=0').get(profileId);
      if (!row) throw new Error('The captured smoke profile has no active encrypted credential.');
      const cipher = Buffer.from(row.credentials), plain = safeStorage.decryptString(cipher);
      return { decryptable: !!JSON.parse(plain), opaque: !cipher.includes(Buffer.from(plain)), bytes: cipher.length };
    } finally { db.close(); }
  }, { dataDir: peer.dataDir, profileId: peer.profileId });
  assert.equal(state.decryptable, true); assert.equal(state.opaque, true); assert.ok(state.bytes > 0);
}
async function checkPackagedGuard(resources) {
  const host = await realpath(join(resources, 'git-tools', 'git-host.exe'));
  const guard = await realpath(join(resources, 'git-tools', 'hooks', 'pre-push.exe'));
  const source = 'a'.repeat(40), old = 'b'.repeat(40), url = 'https://example.invalid/disposable.git', targetRef = 'refs/heads/main';
  for (const valid of [true, false]) {
    const nonce = randomBytes(32).toString('hex'), receipt = join(work, `guard-${valid}.receipt`), manifest = join(work, `guard-${valid}.json`);
    await writeFile(manifest, JSON.stringify({ url, source, targetRef, old, nonce, receipt }));
    const input = `${source} ${source} ${targetRef} ${valid ? old : 'c'.repeat(40)}\n`;
    const result = spawnSync(guard, [url, url], { cwd: repository, env: { ...gitEnv, HUB_GIT_PUSH_GUARD: manifest }, input, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (valid) { assert.equal(result.status, 0, result.error?.message || result.stderr); assert.equal(await readFile(receipt, 'utf8'), nonce); }
    else { assert.notEqual(result.status, 0); assert.equal(existsSync(receipt), false); }
  }
  return { host, guard };
}

try {
  fixture = await createSqlRelayFixture();
  relayServer = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers['x-hub-smoke-key'] !== relayKey || !['admin', 'origin'].includes(req.headers['x-hub-smoke-peer']) || req.headers.apikey !== fixture.configuration.publishableKey || !/^\/rpc\/hub_[a-z0-9_]+$/.test(req.url || '')) { send(403, { code: 'HU403' }); return; }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) throw new Error('Fixture request too large'); chunks.push(chunk); }
      const args = JSON.parse(Buffer.concat(chunks).toString('utf8')), name = req.url.slice('/rpc/'.length);
      const entry = { peer: req.headers['x-hub-smoke-peer'], name, at: Date.now(), requestId: args.p_id ?? args.p_request?.id ?? null };
      if (name === 'hub_v2_publish_status') entry.mode = JSON.parse(args.p_status).activity?.mode ?? null;
      relayCalls.push(entry);
      try { send(200, await fixture.rpc(name, args)); }
      catch (error) { entry.errorCode = typeof error?.code === 'string' ? error.code : 'XX000'; send(400, { code: entry.errorCode, message: 'SQL fixture request refused' }); }
    } catch { send(400, { code: 'HU400', message: 'Invalid isolated fixture request' }); }
  });
  await new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve));
  const relayOrigin = `http://127.0.0.1:${relayServer.address().port}`;
  const admin = await launch('admin', relayOrigin), origin = await launch('origin', relayOrigin);
  report.native = { admin: admin.native, origin: origin.native };
  checked('Two actual packaged sandboxed Electron instances use isolated data, actual safeStorage, and no system Node on PATH');
  const bootstrap = await fixture.bootstrap('Disposable packaged Git approval');
  await api(admin, '/api/devices/pair', 'POST', { ...fixture.configuration, code: bootstrap.code, name: 'Native smoke administrator', confirm: true });
  const invitation = await api(admin, '/api/devices/invitation', 'POST', {});
  await api(origin, '/api/devices/pair', 'POST', { ...fixture.configuration, code: invitation.code, name: 'Native smoke origin', confirm: true });
  for (const peer of [admin, origin]) {
    const devices = await api(peer, '/api/devices');
    assert.equal(devices.profileId, peer.profileId); assert.equal(devices.groups.length, 1);
    assert.equal(devices.localDevice.id, devices.groups[0].deviceId);
    assert.notEqual(devices.installationId, devices.localDevice.id, 'The installation and group membership must have distinct identities.');
    await api(peer, '/api/devices/sync', 'POST', {}); await api(peer, '/api/governance/refresh', 'POST', { confirm: true }); await checkEncryptedProfile(peer);
  }
  const adminState = await api(admin, '/api/governance'), originState = await api(origin, '/api/governance');
  assert.equal(adminState.policy.role, 'admin'); assert.equal(originState.policy.role, 'member'); assert.equal(originState.available, true);
  const adminId = adminState.policy.deviceId, originId = originState.policy.deviceId;
  checked('Real CSRF-protected pairing captures each peer’s group separately from its installation; scoped device/governance/Git calls and encrypted-credential checks bind that group, with admin/member roles enforced');
  const project = await api(origin, '/api/projects', 'POST', { path: repository, name: 'Native approved Git' });
  const sharing = await api(origin, '/api/governance/sharing/preview', 'POST', { policy: { activity: true, projects: [] } });
  await api(origin, '/api/governance/sharing', 'POST', { policy: sharing.policy, digest: sharing.digest, confirm: true });
  const preview = await api(origin, `/api/projects/${project.id}/git/preview`, 'POST', { operation: { kind: 'stage', paths: ['stage.txt'] } });
  assert.deepEqual(await readFile(join(repository, '.git', 'index')), originalIndex);
  await api(origin, '/api/git/requests', 'POST', { previewId: preview.id, digest: preview.digest, reviewerDeviceId: adminId, confirm: true });
  const memberDecision = await apiRaw(origin, `/api/git/approvals/${preview.id}/decision`, 'POST', { digest: preview.digest, confirm: true, decision: 'approved', reason: 'Must be refused' });
  assert.ok(memberDecision.status >= 400);
  await approve(admin, preview);
  assert.deepEqual(await readFile(join(repository, '.git', 'index')), originalIndex);
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), '');
  checked('Preview, submit, and administrator approval do not stage anything; a member cannot approve');

  const windowIdentity = await origin.desktop.evaluate(({ BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id, renderer: BrowserWindow.getAllWindows()[0].webContents.id }));
  const ticksBefore = relayCalls.filter(call => call.peer === 'origin' && call.name === 'hub_devices').length;
  const hiddenAt = Date.now();
  await origin.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await origin.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await delay(16000);
  await until(() => relayCalls.some(call => call.peer === 'origin' && call.name === 'hub_v2_publish_status' && call.mode === 'background' && call.at >= hiddenAt)
    && relayCalls.filter(call => call.peer === 'origin' && call.name === 'hub_devices').length > ticksBefore, 'Background backend did not publish status on its automatic sync tick');
  const requests = await api(origin, `/api/projects/${project.id}/git/requests`);
  assert.equal(requests.find(request => request.preview.id === preview.id).state, 'approved');
  const remote = await api(admin, '/api/governance/refresh', 'POST', { confirm: true });
  assert.equal(remote.statuses.find(status => status.deviceId === originId).activity.mode, 'background');
  assert.deepEqual(await readFile(join(repository, '.git', 'index')), originalIndex);
  assert.equal(relayCalls.some(call => call.name === 'hub_v2_consume_git'), false);
  assert.deepEqual(await origin.desktop.evaluate(({ BrowserWindow }) => ({ id: BrowserWindow.getAllWindows()[0].id, renderer: BrowserWindow.getAllWindows()[0].webContents.id })), windowIdentity);
  report.backgroundTickMilliseconds = Date.now() - hiddenAt;
  checked('X preserves the original renderer and automatic backend sync publishes background status/delivers approval after a 15-second tick, without execution');
  await origin.desktop.evaluate(({ app }) => app.emit('second-instance'));
  assert.equal(await origin.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);

  const execution = await api(origin, `/api/git/requests/${preview.id}/execute`, 'POST', { digest: preview.digest, confirm: true });
  assert.equal(execution.state, 'succeeded'); assert.equal(execution.result.status, 'succeeded');
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), 'stage.txt');
  assert.equal(git(['show', ':stage.txt']), 'explicitly approved stage content\n');
  assert.equal(git(['rev-parse', 'HEAD']).trim(), originalHead);
  const stagedIndex = await readFile(join(repository, '.git', 'index'));
  const replay = await apiRaw(origin, `/api/git/requests/${preview.id}/execute`, 'POST', { digest: preview.digest, confirm: true });
  assert.equal(replay.status, 409); assert.deepEqual(await readFile(join(repository, '.git', 'index')), stagedIndex);
  const audit = await api(origin, `/api/git/requests/${preview.id}/audit`);
  assert.equal(audit.filter(entry => entry.state === 'executing').length, 1);
  assert.equal(relayCalls.filter(call => call.name === 'hub_v2_consume_git' && call.requestId === preview.id).length, 1);
  checked('Origin-local confirmation stages exactly the approved file once; replay is refused, HEAD is unchanged, and audit/SQL consume occur once');

  const stale = await api(origin, `/api/projects/${project.id}/git/preview`, 'POST', { operation: { kind: 'stage', paths: ['stale.txt'] } });
  await api(origin, '/api/git/requests', 'POST', { previewId: stale.id, digest: stale.digest, reviewerDeviceId: adminId, confirm: true });
  await approve(admin, stale);
  await until(async () => {
    await api(origin, '/api/governance/refresh', 'POST', { confirm: true });
    return (await api(origin, `/api/projects/${project.id}/git/requests`)).some(request => request.preview.id === stale.id && request.state === 'approved');
  }, 'The origin did not receive the second approval');
  await writeFile(join(repository, 'stale.txt'), 'new unreviewed content after approval\n');
  const refused = await api(origin, `/api/git/requests/${stale.id}/execute`, 'POST', { digest: stale.digest, confirm: true });
  assert.equal(refused.state, 'stale'); assert.deepEqual(await readFile(join(repository, '.git', 'index')), stagedIndex);
  assert.equal(relayCalls.some(call => call.name === 'hub_v2_consume_git' && call.requestId === stale.id), false);
  assert.equal(git(['show', ':stale.txt']), 'baseline stale content\n');
  checked('Changing a reviewed file after approval fails stale before consume and preserves the existing real index');

  const observations = await origin.desktop.evaluate(() => globalThis.__gitSmoke);
  assert.ok(observations.launches.length > 0, 'Real packaged Git operations must use the native supervisor.');
  const packaged = await checkPackagedGuard(origin.native.resources);
  for (const launch of observations.launches) {
    assert.equal(resolve(launch.host).toLowerCase(), resolve(packaged.host).toLowerCase(), 'Packaged resolveGitTools must select resources/git-tools, not development helpers.');
    assert.equal(resolve(launch.executable).toLowerCase(), resolve(tools.git).toLowerCase(), 'The supervisor must launch the trusted Git installation.');
  }
  report.packagedTools = { ...packaged, supervisedLaunches: observations.launches.length, trustedGit: tools.git };
  checked('Actual packaged Git execution selects resources/git-tools/git-host.exe; the shipped pre-push guard accepts the exact contract and rejects old-OID drift without Node on PATH');

  await origin.page.reload();
  await origin.page.locator('.main-nav').getByRole('button', { name: /^Project overview/ }).click();
  await origin.page.getByRole('button', { name: 'Open project: Native approved Git', exact: true }).click();
  await origin.page.locator('.detail-tabs').getByRole('button', { name: 'Git status', exact: true }).click();
  await origin.page.getByRole('heading', { name: 'Git status and approved actions', exact: true }).waitFor();
  await origin.page.getByRole('button', { name: 'View diff for stage.txt', exact: true }).click();
  await origin.page.locator('.git-diff-text').waitFor();
  assert.match(await origin.page.locator('.git-diff-text').textContent(), /explicitly approved stage content/);
  await origin.page.screenshot({ path: join(work, 'native-git-window.png') });
  await origin.page.locator('.git-panel').screenshot({ path: join(work, 'native-git-panel.png') });
  checked('Actual packaged GitPanel renders the real staged diff and approval request history');
  for (const peer of peers) {
    const network = await peer.desktop.evaluate(() => ({ denied: globalThis.__gitSmoke.denied, forwarded: globalThis.__gitSmoke.forwarded }));
    assert.deepEqual(network.denied, []); assert.ok(network.forwarded > 0);
  }
  assert.deepEqual(rendererErrors, []);
  for (const peer of [...peers].reverse()) await quit(peer);
  checked('Both instances exit through the genuine native File/Quit callback and release their secured listeners');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  for (const peer of peers) if (!peer.closed && peer.page && !peer.page.isClosed()) await peer.page.screenshot({ path: join(work, `failure-${peer.name}.png`) }).catch(() => {});
  throw error;
} finally {
  for (const peer of [...peers].reverse()) if (!peer.closed) await quit(peer).catch(async error => {
    report.cleanupError = error instanceof Error ? error.message : String(error);
    await peer.desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await bounded(peer.desktop.close(), 'Native quit cleanup exceeded 15 seconds.').catch(() => {
      report.forcedCleanup = true;
      const pid = peer.desktop.process()?.pid;
      if (pid) spawnSync(join(windows, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    });
  });
  if (relayServer) { relayServer.closeAllConnections(); await bounded(new Promise(resolve => relayServer.close(resolve)), 'Fixture server cleanup exceeded 15 seconds.'); }
  await fixture?.close();
  report.rpcCounts = Object.fromEntries([...new Set(relayCalls.map(call => `${call.peer}:${call.name}`))].map(key => [key, relayCalls.filter(call => `${call.peer}:${call.name}` === key).length]));
  report.rendererErrors = rendererErrors;
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Packaged Git smoke artifacts:', work);
}
