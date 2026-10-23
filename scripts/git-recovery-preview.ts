/** Disposable recovery UI fixture: real local API/journal, simulated Git engine and local SQL relay.
 * Never packaged. No real Git command, user database, credential or external relay is used.
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER } from '../server/runtime.js';
import type { GitEngine } from '../server/git-approvals.js';
import type { PreparedGitOperation } from '../server/git-operations.js';
import { appError } from '../server/validation.js';
import type { GitDetails } from '../shared/git.js';
import { createSqlRelayFixture } from '../tests/helpers/sql-relay.js';
import { testCredentialCodec } from '../tests/helpers/credentials.js';

const root = resolve(import.meta.dirname, '..'), port = 4322;
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'git-recovery-ui-'));
const projectPath = join(work, 'disposable-project'); await mkdir(projectPath);
const relay = await createSqlRelayFixture();
const counters = { details: 0, executions: 0, recoveries: 0 };
let failReads = false;
const oid = 'a'.repeat(40);
const details: GitDetails = {
  snapshot: { isRepo: true, branch: 'main', head: oid, branches: ['main'], commits: [], changes: [], changedCount: 0, stagedCount: 0, untrackedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() },
  remotes: [], upstream: null, ahead: null, behind: null, operationState: null, unsupportedReasons: [], identity: { name: 'Recovery fixture', email: 'fixture@example.invalid' },
};
const engine: GitEngine = {
  details: async () => { counters.details++; if (failReads) throw appError(400, 'git.read', { detail: 'Simulated recovery read failure' }); return { ...details, snapshot: { ...details.snapshot, observedAt: new Date().toISOString() } }; },
  diff: async (_path, input) => ({ ...input, text: '', binary: false, truncated: false }),
  prepare: async (directory, operation, context) => ({ directory, operation, repositoryKey: directory, fingerprint: 'fixture',
    summary: { projectName: context.projectName, kind: operation.kind, paths: 'paths' in operation ? operation.paths : [], branch: 'main', head: oid, target: null, remoteUrl: null, targetRef: null, changedCount: 0, stagedCount: 0, message: null, authorName: null, authorEmail: null },
  }) as PreparedGitOperation,
  execute: async () => { counters.executions++; throw new Error('Recovery must never execute a Git operation.'); },
  recover: async () => { counters.recoveries++; },
};
const secret = randomBytes(32).toString('hex');
const runtime = await createHubRuntime({ mode: 'desktop', desktopSecret: secret, port: 0, dataDir: join(work, 'data'), assetDirectory: join(root, 'dist'), enablePolling: false, gitEngine: engine,
  deviceOptions: { codec: testCredentialCodec(), relayFactory: () => relay.relay, enablePolling: false },
  appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) },
});
runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
const invitation = await relay.bootstrap('Local recovery fixture');
const profileId = (await runtime.devices.pair({ ...relay.configuration, code: invitation.code, name: '恢復測試電腦', confirm: true })).profileId!;
const project = runtime.store.createProject({ path: projectPath, name: 'Git 本機恢復驗證', description: '模擬 unknown／partial 日誌；不執行真正 Git 命令。' });
const previews = await Promise.all(['unknown', 'partial', 'prepared'].map(() => runtime.git.preview(profileId, project.id, { kind: 'stage', paths: ['fixture.txt'] })));
for (const [index, state] of (['unknown', 'partial'] as const).entries()) runtime.git.repository.transition(previews[index].id, state, { result: { status: state, code: 'fixture-interruption', head: null } });
await runtime.devices.enable(profileId, false);

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__fixture/state' && req.method === 'GET') {
      const device = runtime.devices.state();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        projectId: project.id, counters, failReads, paired: device.paired, profileId: device.profileId, enabled: device.enabled,
        records: previews.map(preview => { const row = runtime.git.repository.get(preview.id); return { id: preview.id, state: row.state, acknowledged: row.fenceAcknowledged }; }),
      })); return;
    }
    if (url.pathname.startsWith('/__fixture/')) {
      if (req.method !== 'POST' || req.headers['x-hub-fixture'] !== 'recovery' || req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
      if (url.pathname === '/__fixture/read-failure') failReads = url.searchParams.get('enabled') === 'true';
      else if (url.pathname === '/__fixture/detach') await runtime.devices.disconnect(profileId);
      else { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return;
    }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const key of ['content-type', 'x-hub-token', 'x-hub-profile-id', 'accept']) if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key] as string);
    headers.set(DESKTOP_KEY_HEADER, secret); headers.set('origin', runtime.origin);
    const response = await fetch(runtime.origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual', ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}) });
    const outgoing: Record<string, string> = {};
    for (const key of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options']) { const value = response.headers.get(key); if (value) outgoing[key] = value; }
    res.writeHead(response.status, outgoing).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Recovery fixture request failed:', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Recovery fixture failed"}');
  }
});
await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
console.log(`Isolated Git recovery preview: http://127.0.0.1:${port}`);
console.log(`Disposable data: ${work}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; server.close(); await runtime.stop(); await relay.close(); process.exit(0); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
