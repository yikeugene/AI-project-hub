/** Disposable preview only: actual local APIs/SQL, controlled application names, no native sampling. */
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.js';
import { testCredentialCodec } from '../tests/helpers/credentials.js';

const port = 4323, root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'app-observation-ui-'));
const relay = await createSqlRelayFixture();
const peers = new Map<string, { runtime: HubRuntime; secret: string }>();
let sourceName: string | null = 'Visual Studio Code', sourceTime = Date.now(), sourceCalls = 0;
for (const name of ['admin', 'origin']) {
  const secret = randomBytes(32).toString('hex');
  const runtime = await createHubRuntime({ mode: 'desktop', desktopSecret: secret, port: 0,
    assetDirectory: join(root, 'dist'), dataDir: join(work, name), enablePolling: false,
    deviceOptions: { codec: testCredentialCodec(), relayFactory: () => relay.relay, enablePolling: false, clock: () => name === 'origin' ? sourceTime : Date.now() },
    appObservationOptions: { autoRefresh: false, source: { available: () => true, sample: async () => {
      if (name === 'origin') sourceCalls++;
      return { name: name === 'origin' ? sourceName : 'Microsoft Edge', observedAt: new Date(name === 'origin' ? sourceTime : Date.now()).toISOString() };
    } } },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) },
  });
  runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
  runtime.setAppObservationSessionAvailable(true);
  peers.set(name, { runtime, secret });
}
const admin = peers.get('admin')!.runtime, origin = peers.get('origin')!.runtime;
const bootstrap = await relay.bootstrap('Disposable current-app network');
await admin.devices.pair({ ...relay.configuration, code: bootstrap.code, name: '查看電腦（隔離測試）', confirm: true });
const adminProfile = admin.devices.state().profileId!;
const invite = await admin.devices.invitation(adminProfile);
await origin.devices.pair({ ...relay.configuration, code: invite.code, name: '來源電腦（隔離測試）', confirm: true });
const originProfile = origin.devices.state().profileId!;
await admin.devices.syncNow(adminProfile); await origin.devices.syncNow(originProfile); await admin.devices.syncNow(adminProfile);
await origin.appObservation.refresh(originProfile, true); await admin.appObservation.refresh(adminProfile, true);
if (sourceCalls) throw new Error('Unconfirmed source collection is forbidden even in a fixture.');
const own = origin.governance.previewSharing(originProfile, { activity: true, projects: [] });
origin.governance.saveSharing(originProfile, own.policy, own.digest); origin.setActivityMode('background');
await origin.governance.refresh(originProfile); await admin.governance.refresh(adminProfile);
const consent = origin.appObservation.previewSharing(originProfile, { enabled: true });
origin.appObservation.saveSharing(originProfile, consent.policy, consent.digest);
await origin.appObservation.refresh(originProfile, true); await admin.appObservation.refresh(adminProfile, true);

const server = createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')
      || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__fixture/switch' && req.method === 'GET') {
      const target = url.searchParams.get('device');
      if (!peers.has(target ?? '')) { res.writeHead(400).end(); return; }
      res.writeHead(303, { location: '/', 'set-cookie': `hub-app-fixture=${target}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' }).end(); return;
    }
    if (url.pathname === '/__fixture/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ sourceCalls, originId: origin.devices.state().localDevice.id, originProfile, adminProfile })); return;
    }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    if (url.pathname === '/__fixture/source' && req.method === 'POST') {
      const { mode } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!['code', 'browser', 'unavailable', 'stale'].includes(mode)) { res.writeHead(400).end(); return; }
      sourceName = mode === 'unavailable' ? null : mode === 'browser' ? 'Google Chrome' : 'Visual Studio Code';
      sourceTime = Date.now() - (mode === 'stale' ? 600000 : 0);
      origin.setAppObservationSessionAvailable(false); origin.setAppObservationSessionAvailable(true);
      await origin.devices.syncNow(originProfile); await admin.devices.syncNow(adminProfile);
      await origin.appObservation.refresh(originProfile, true); await admin.appObservation.refresh(adminProfile, true);
      // Drain any already-running receiver read, then read the just-published fixture value.
      await admin.appObservation.refresh(adminProfile, true);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ mode, sourceCalls })); return;
    }
    const name = /(?:^|;\s*)hub-app-fixture=(admin|origin)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? 'admin';
    const peer = peers.get(name)!;
    const headers = new Headers();
    for (const key of ['content-type', 'x-hub-token', 'x-hub-profile-id', 'accept']) if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key] as string);
    headers.set(DESKTOP_KEY_HEADER, peer.secret); headers.set('origin', peer.runtime.origin);
    const response = await fetch(peer.runtime.origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
    const outgoing: Record<string, string> = {};
    for (const key of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options']) { const value = response.headers.get(key); if (value) outgoing[key] = value; }
    res.writeHead(response.status, outgoing).end(Buffer.from(await response.arrayBuffer()));
  } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Disposable preview request failed"}'); }
});
await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
console.log(`Isolated current-app preview: http://127.0.0.1:${port}`);
console.log('Controlled test names only. No native collector or external relay is used.');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.close(); await Promise.all([...peers.values()].map(peer => peer.runtime.stop())); await relay.close(); process.exit(0);
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
