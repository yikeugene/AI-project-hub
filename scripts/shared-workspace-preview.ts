/** Disposable desktop-mode preview with two devices and a local SQL relay.
 * Never packaged; no real credentials, user database or external cloud connection.
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.js';
import { testCredentialCodec } from '../tests/helpers/credentials.js';

const port = 4320;
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'shared-workspace-'));
const relay = await createSqlRelayFixture();
const peers = new Map<string, { runtime: HubRuntime; secret: string }>();
for (const name of ['viewer', 'author']) {
  const secret = randomBytes(32).toString('hex');
  const runtime = await createHubRuntime({ mode: 'desktop', desktopSecret: secret, port: 0,
    assetDirectory: join(root, 'dist'), dataDir: join(work, name), enablePolling: false,
    deviceOptions: { enablePolling: false, codec: testCredentialCodec(), relayFactory: () => relay.relay },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }),
      desktopCapabilities: async () => ({ claude: false, chatgpt: false }) },
  });
  runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
  peers.set(name, { runtime, secret });
}
const viewer = peers.get('viewer')!.runtime, author = peers.get('author')!.runtime;
const networks: { label: string; networkId: string; viewerProfile: string; authorProfile: string }[] = [];
for (const label of ['產品開發', '營運協作']) {
  const invite = await relay.bootstrap(label);
  await viewer.devices.pair({ ...relay.configuration, code: invite.code, name: '我的電腦', label, confirm: true });
  const viewerProfile = viewer.devices.state().groups.find(group => group.networkId === invite.networkId)!.id;
  const memberInvite = await viewer.devices.invitation(viewerProfile);
  await author.devices.pair({ ...relay.configuration, code: memberInvite.code, name: '協作電腦', label, confirm: true });
  const authorProfile = author.devices.state().groups.find(group => group.networkId === invite.networkId)!.id;
  networks.push({ label, networkId: invite.networkId, viewerProfile, authorProfile });
}
const third = await relay.bootstrap('第三群組');
await author.devices.pair({ ...relay.configuration, code: third.code, name: '協作電腦', label: '第三群組', confirm: true });
const thirdProfile = author.devices.state().groups.find(group => group.networkId === third.networkId)!.id;
const joinInvitation = await author.devices.invitation(thirdProfile);

async function project(runtime: HubRuntime, directory: string, name: string) {
  const path = join(work, directory); await mkdir(path);
  return runtime.store.createProject({ path, name, stage: '驗證階段', nextAction: '檢查目前群組內已分享的摘要。' });
}
const shared = await project(author, 'release', '產品發版檢查');
author.store.saveMemory(shared.id, shared.revision, { ...shared.memory,
  status: '產品開發群組：功能測試已完成，等待發版確認。',
  decisions: '營運協作群組：發版公告排定於週五。',
  notes: 'PRIVATE_NOT_SHARED_DO_NOT_EXPORT',
});
author.devices.share(networks[0].authorProfile, shared.id, { enabled: true, memoryFields: ['status'] });
author.devices.share(networks[1].authorProfile, shared.id, { enabled: true, memoryFields: ['decisions'] });
const own = await project(viewer, 'handoff', '我的交接筆記');
viewer.store.saveMemory(own.id, own.revision, { ...own.memory, overview: '這份摘要只分享給產品開發群組。', notes: 'PRIVATE_LOCAL_NOT_SHARED' });
viewer.devices.share(networks[0].viewerProfile, own.id, { enabled: true, memoryFields: ['overview'] });
const privateProject = await project(viewer, 'private', '尚未共享的私人專案');
await author.devices.syncAll(); await viewer.devices.syncAll(); await author.devices.syncAll(); await viewer.devices.syncAll();
await viewer.devices.enable(networks[1].viewerProfile, false);

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__fixture/switch' && req.method === 'GET') {
      const target = url.searchParams.get('device');
      if (!peers.has(target ?? '')) { res.writeHead(400).end(); return; }
      res.writeHead(303, { location: '/', 'set-cookie': `hub-fixture-device=${target}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' }).end(); return;
    }
    if (url.pathname === '/__fixture/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        networks, sharedProjectId: shared.id, ownProjectId: own.id, privateProjectId: privateProject.id,
        joinInvitation, thirdNetworkId: third.networkId,
      })); return;
    }
    const name = /(?:^|;\s*)hub-fixture-device=(viewer|author)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? 'viewer';
    const peer = peers.get(name)!;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const key of ['content-type', 'x-hub-token', 'x-hub-profile-id', 'accept']) if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key] as string);
    headers.set(DESKTOP_KEY_HEADER, peer.secret); headers.set('origin', peer.runtime.origin);
    const response = await fetch(peer.runtime.origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
    const outgoing: Record<string, string> = {};
    for (const key of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options']) {
      const value = response.headers.get(key); if (value) outgoing[key] = value;
    }
    res.writeHead(response.status, outgoing).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Shared workspace preview request failed:', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"Disposable preview request failed"}');
  }
});
await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
console.log(`Isolated shared workspace preview: http://127.0.0.1:${port}`);
console.log(`Disposable data: ${work}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.close(); await Promise.all([...peers.values()].map(peer => peer.runtime.stop())); await relay.close(); process.exit(0);
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
