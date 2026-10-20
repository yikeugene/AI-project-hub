/** Isolated developer preview: two disposable desktop runtimes and a local SQL relay.
 * Never imported or packaged by the application. No external relay or real workspace is used.
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { findTrustedExecutable } from '../server/commands.js';
import { gitEnvironment } from '../server/git.js';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.js';
import { testCredentialCodec } from '../tests/helpers/credentials.js';

const port = 4319;
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'git-ui-'));
const projectPath = join(work, 'review-project'); await mkdir(projectPath);
const gitPath = await findTrustedExecutable(process.platform === 'win32' ? ['git.exe'] : ['git'], { excludeDirectory: projectPath });
if (!gitPath) throw new Error('Trusted Git is required for this disposable preview.');
const execute = promisify(execFile);
async function git(...args: string[]) {
  await execute(gitPath!, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], {
    cwd: projectPath, env: gitEnvironment(), windowsHide: true, timeout: 15000,
  });
}
await git('init', '-b', 'main');
await git('config', 'user.name', 'Preview Developer'); await git('config', 'user.email', 'preview@example.invalid');
await writeFile(join(projectPath, 'README.md'), '# Device workspace\n\nChanges are reviewed before execution.\n');
await git('add', '--', 'README.md'); await git('commit', '-m', 'Initial disposable fixture');
await git('branch', 'review-demo');
await writeFile(join(projectPath, 'README.md'), '# Device workspace\n\nChanges are reviewed before execution.\n\nBackground work continues while the window is hidden.\n');
await writeFile(join(projectPath, 'notes.txt'), 'Only selected files are staged.\n');
const relay = await createSqlRelayFixture();
const peers = new Map<string, { runtime: HubRuntime; secret: string }>();
for (const name of ['admin', 'origin']) {
  const secret = randomBytes(32).toString('hex');
  const runtime = await createHubRuntime({ mode: 'desktop', desktopSecret: secret, port: 0,
    assetDirectory: join(root, 'dist'), dataDir: join(work, name), enablePolling: false,
    deviceOptions: { codec: testCredentialCodec(), relayFactory: () => relay.relay },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }),
      desktopCapabilities: async () => ({ claude: false, chatgpt: false }) },
  });
  runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
  peers.set(name, { runtime, secret });
}
const admin = peers.get('admin')!.runtime, origin = peers.get('origin')!.runtime;
const invitation = await relay.bootstrap('Disposable review network');
await admin.devices.pair({ ...relay.configuration, code: invitation.code, name: '管理員電腦（隔離測試）', confirm: true });
const memberInvite = await admin.devices.invitation();
await origin.devices.pair({ ...relay.configuration, code: memberInvite.code, name: '開發電腦（隔離測試）', confirm: true });
const project = origin.store.createProject({ path: projectPath, name: '安全 Git 操作示範', description: '隔離的測試儲存庫；不會改動你的專案。', nextAction: '送交管理員審批，再在本機確認執行。' });
origin.store.createTask(project.id, { title: '驗證審批與背景狀態', status: 'doing' });
await origin.refreshAll();
origin.devices.share(project.id, { enabled: true, memoryFields: [] });
await admin.devices.worker.syncNow(); await origin.devices.worker.syncNow(); await admin.devices.worker.syncNow();
const sharing = origin.governance.previewSharing({ activity: true, projects: [{ projectId: project.id, git: true, tasks: true }] });
origin.governance.saveSharing(sharing.policy, sharing.digest); origin.setActivityMode('background');
await origin.governance.refresh(); await admin.governance.refresh();

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__fixture/switch') {
      const target = url.searchParams.get('device');
      if (!peers.has(target ?? '')) { res.writeHead(400).end(); return; }
      res.writeHead(303, { location: '/', 'set-cookie': `hub-fixture-device=${target}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' }).end(); return;
    }
    if (url.pathname === '/__fixture/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        projectId: project.id, originId: origin.devices.state().localDevice.id, adminId: admin.devices.state().localDevice.id,
        requests: origin.git.list(project.id), readme: await readFile(join(projectPath, 'README.md'), 'utf8'),
      })); return;
    }
    if (url.pathname === '/__fixture/edit' && req.method === 'POST') {
      await writeFile(join(projectPath, 'README.md'), '# Externally edited disposable fixture\nThis change must invalidate the previous approval.\n');
      await origin.refreshAll(); res.writeHead(200, { 'content-type': 'application/json' }).end('{"edited":true}'); return;
    }
    const name = /(?:^|;\s*)hub-fixture-device=(admin|origin)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? 'origin';
    const peer = peers.get(name)!;
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const key of ['content-type', 'x-hub-token', 'accept']) if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key] as string);
    headers.set(DESKTOP_KEY_HEADER, peer.secret); headers.set('origin', peer.runtime.origin);
    const response = await fetch(peer.runtime.origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
    const outgoing: Record<string, string> = {};
    for (const key of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options']) {
      const value = response.headers.get(key); if (value) outgoing[key] = value;
    }
    res.writeHead(response.status, outgoing).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Disposable preview request failed:', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Disposable fixture request failed"}');
  }
});
await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
console.log(`Isolated Git approval preview: http://127.0.0.1:${port}`);
console.log('Switch device: /__fixture/switch?device=admin or /__fixture/switch?device=origin');
console.log(`Disposable data: ${work}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.close(); await Promise.all([...peers.values()].map(peer => peer.runtime.stop())); await relay.close(); process.exit(0);
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
