import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { Store } from '../server/db.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';
import type { RelayClient } from '../server/relay.js';

let fixture: SqlRelayFixture, directory: string, assets: string;
const runtimes: HubRuntime[] = [];
beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.reset(); directory = await mkdtemp(join(tmpdir(), 'hub-device-api-'));
  assets = join(directory, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<!doctype html><title>isolated</title>');
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
async function start(relay = fixture.relay) {
  const secret = randomBytes(32).toString('hex'), factory = vi.fn(() => relay);
  const runtime = await createHubRuntime({ assetDirectory: assets, dataDir: join(directory, randomUUID()), port: 0, mode: 'desktop', desktopSecret: secret, enablePolling: false,
    deviceOptions: { codec: testCredentialCodec(), relayFactory: factory, enablePolling: false },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) } });
  runtimes.push(runtime);
  const headers = { [DESKTOP_KEY_HEADER]: secret };
  const workspace = await (await fetch(runtime.origin + '/api/workspace', { headers })).json();
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(runtime.origin + path, { method, headers: { ...headers, 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return { runtime, secret, workspace, headers, request, factory };
}

describe('guarded device API and two desktop runtimes', () => {
  it('keeps new local routes behind desktop, Origin and mutation token guards', async () => {
    const a = await start();
    expect((await fetch(a.runtime.origin + '/api/devices')).status).toBe(401);
    expect((await a.request('/api/devices')).status).toBe(200); expect(a.factory).not.toHaveBeenCalled();
    expect((await fetch(a.runtime.origin + '/api/devices', { headers: { ...a.headers, Origin: 'https://outside.example' } })).status).toBe(403);
    expect((await fetch(a.runtime.origin + '/API/devices/local', { method: 'PATCH', headers: { ...a.headers, 'Content-Type': 'application/json' }, body: '{"name":"forged"}' })).status).toBe(403);
    expect((await a.request('/api/devices/local', 'PATCH', { name: '本機新名稱' })).status).toBe(200);
    expect((await a.request('/api/devices/local', 'PATCH', { name: 'x', command: 'anything' })).status).toBe(400);
    expect(a.runtime.devices.state().localDevice.name).toBe('本機新名稱');
    expect(a.factory).not.toHaveBeenCalled();
  });
  it('guards Git and governance routes, requires explicit confirmation, and rejects arbitrary command fields', async () => {
    const a = await start(), id = randomUUID(), digest = '0'.repeat(64);
    expect((await fetch(a.runtime.origin + '/api/governance')).status).toBe(401);
    expect((await a.request('/api/governance')).status).toBe(200);
    expect((await fetch(a.runtime.origin + '/api/git/requests', { method: 'POST', headers: { ...a.headers, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await a.request(`/api/projects/${id}/git/preview`, 'POST', { operation: { kind: 'reset', hard: true } })).status).toBe(400);
    expect((await a.request(`/api/projects/${id}/git/preview`, 'POST', { operation: { kind: 'stage', paths: ['file'], command: 'anything' } })).status).toBe(400);
    expect((await a.request(`/api/git/requests/${id}/execute`, 'POST', { digest })).status).toBe(400);
    expect((await a.request(`/api/git/requests/${id}/execute`, 'POST', { digest, confirm: true, force: true })).status).toBe(400);
    expect((await a.request(`/api/git/approvals/${id}/decision`, 'POST', { digest, decision: 'approved', reason: '', confirm: false })).status).toBe(400);
    expect((await a.request(`/api/git/requests/${id}/execute`)).status).toBe(404);
    expect((await a.request('/api/governance/sharing', 'POST', { policy: { activity: true, projects: [] }, digest, confirm: false })).status).toBe(400);
    expect(a.factory).not.toHaveBeenCalled();
  });
  it('keeps Git mutations unavailable in browser mode even with a valid local request token', async () => {
    const runtime = await createHubRuntime({ assetDirectory: assets, dataDir: join(directory, randomUUID()), port: 0, mode: 'web', enablePolling: false,
      deviceOptions: { enablePolling: false }, appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) } });
    runtimes.push(runtime);
    const workspace = await (await fetch(runtime.origin + '/api/workspace')).json();
    const project = runtime.store.createProject({ path: directory, name: 'Browser-only project' });
    const response = await fetch(runtime.origin + `/api/projects/${project.id}/git/preview`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-token': workspace.csrfToken },
      body: JSON.stringify({ operation: { kind: 'stage', paths: ['file.txt'] } }) });
    expect(response.status).toBe(400); expect((await response.json()).code).toBe('device.desktopRequired');
    expect(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get()!.n).toBe(0);
  });
  it('performs pairing, remote viewing, proposal review and owner-only application through actual HTTP APIs', async () => {
    const a = await start(), b = await start(); const bootstrap = await fixture.bootstrap();
    let response = await a.request('/api/devices/pair', 'POST', { ...fixture.configuration, code: bootstrap.code, name: 'A', confirm: true });
    expect(response.status).toBe(200); const ownerId = (await response.json()).localDevice.id;
    const invitation = await (await a.request('/api/devices/invitation', 'POST', {})).json();
    response = await b.request('/api/devices/pair', 'POST', { ...fixture.configuration, code: invitation.code, name: 'B', confirm: true }); expect(response.status).toBe(200);
    const project = a.runtime.store.createProject({ path: directory, name: 'Local owned', nextAction: 'Original' });
    expect((await a.request(`/api/devices/sharing/${project.id}/preview`, 'POST', { enabled: true, memoryFields: [] })).status).toBe(200);
    expect(a.runtime.devices.state().sharing).toEqual([]);
    expect((await a.request(`/api/devices/sharing/${project.id}`, 'PUT', { enabled: true, memoryFields: [] })).status).toBe(200);
    await a.request('/api/devices/sync', 'POST', {}); await b.request('/api/devices/sync', 'POST', {});
    const snapshots = await (await b.request(`/api/devices/${ownerId}/projects`)).json();
    expect(snapshots[0].project.nextAction).toBe('Original'); expect(snapshots[0].project.path).toBeUndefined();
    expect((await b.request(`/api/devices/${ownerId}/projects/${project.id}`, 'PATCH', { nextAction: 'unauthorized' })).status).toBe(404);
    expect((await b.request(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision, nextAction: 'wrong computer' })).status).toBe(404);
    response = await b.request('/api/messages', 'POST', { toDeviceId: ownerId, payload: { schemaVersion: 1, kind: 'proposal', text: 'Please review', projectId: project.id, baseRevision: project.revision, changes: { nextAction: 'Approved locally' } } });
    expect(response.status).toBe(201); const sent = await response.json();
    await b.request('/api/devices/sync', 'POST', {}); await a.request('/api/devices/sync', 'POST', {});
    expect(a.runtime.store.getProject(project.id).nextAction).toBe('Original');
    const preview = await (await a.request(`/api/messages/${sent.id}/preview`, 'POST', {})).json(); expect(preview.canApply).toBe(true);
    expect((await a.request(`/api/messages/${sent.id}/accept`, 'POST', { hash: preview.hash, revision: preview.revision, confirm: false })).status).toBe(400);
    response = await a.request(`/api/messages/${sent.id}/accept`, 'POST', { hash: preview.hash, revision: preview.revision, confirm: true }); expect(response.status).toBe(200);
    expect(a.runtime.store.getProject(project.id).nextAction).toBe('Approved locally');
    await a.request('/api/devices/sync', 'POST', {}); await b.request('/api/devices/sync', 'POST', {});
    const sentList = await (await b.request('/api/messages?box=sent')).json(); expect(sentList[0].result.status).toBe('applied');
    const safeState = await (await a.request('/api/devices')).json();
    expect(safeState).not.toHaveProperty('credentials'); expect(safeState).not.toHaveProperty('token');
    const workspace = await (await a.request('/api/workspace')).json();
    expect(workspace.settings).not.toHaveProperty('credentials');
  });
  it('serves a packaged asset root inside a dot-directory without exposing dotfiles', async () => {
    const hiddenAssets = join(directory, '.hidden', 'assets'); await mkdir(hiddenAssets, { recursive: true });
    const index = '<!doctype html><title>Packaged root</title>';
    await writeFile(join(hiddenAssets, 'index.html'), index); await writeFile(join(hiddenAssets, '.private'), 'DO_NOT_SERVE');
    const runtime = await createHubRuntime({ assetDirectory: hiddenAssets, dataDir: join(directory, randomUUID()), port: 0, mode: 'web', enablePolling: false, deviceOptions: { enablePolling: false } });
    runtimes.push(runtime);
    const response = await fetch(runtime.origin + '/'); expect(response.status).toBe(200); expect(await response.text()).toBe(index);
    expect(await (await fetch(runtime.origin + '/.private')).text()).not.toContain('DO_NOT_SERVE');
  });
  it('aborts and drains a network request before closing SQLite', async () => {
    let started!: () => void; const fetching = new Promise<void>(resolve => { started = resolve; });
    const relay: RelayClient = { ...fixture.relay, listDevices: async (_token, signal) => {
      started(); return new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); });
    } };
    const a = await start(relay); const bootstrap = await fixture.bootstrap();
    await a.runtime.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'Shutdown', confirm: true });
    const pending = a.runtime.devices.worker.syncNow(); await fetching; await a.runtime.stop(); await pending;
    const reopened = new Store(join(a.runtime.dataDir, 'hub.sqlite'));
    try { expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM relay_profiles').get()!.n).toBe(1); } finally { reopened.close(); }
    await expect(fetch(a.runtime.origin + '/api/devices')).rejects.toThrow();
  });
});
