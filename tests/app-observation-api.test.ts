import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import { PROFILE_HEADER } from '../shared/devices.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';

let fixture: SqlRelayFixture, directory: string, assets: string;
const runtimes: HubRuntime[] = [];
beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.reset(); directory = await mkdtemp(join(tmpdir(), 'hub-app-observation-api-'));
  assets = join(directory, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<!doctype html><title>isolated app observation</title>');
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
async function start() {
  const secret = randomBytes(32).toString('hex');
  const sample = vi.fn(async () => ({ name: 'API_ONLY_APP_SAMPLE', observedAt: new Date().toISOString() }));
  const runtime = await createHubRuntime({ assetDirectory: assets, dataDir: join(directory, randomUUID()), port: 0, mode: 'desktop', desktopSecret: secret,
    enablePolling: false, deviceOptions: { codec: testCredentialCodec(), relayFactory: () => fixture.relay, enablePolling: false },
    appObservationOptions: { source: { available: () => true, sample }, autoRefresh: false },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) } });
  runtimes.push(runtime); runtime.setAppObservationSessionAvailable(true);
  const headers = { [DESKTOP_KEY_HEADER]: secret };
  const workspace = await (await fetch(runtime.origin + '/api/workspace', { headers })).json();
  const request = (path: string, method = 'GET', body?: unknown, profileId?: string) => fetch(runtime.origin + path, { method,
    headers: { ...headers, 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken, ...(profileId ? { [PROFILE_HEADER]: profileId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { runtime, headers, request, sample };
}

describe('profile-scoped foreground observation HTTP boundary', () => {
  it('keeps desktop/Origin/token guards and does not collect from reads or previews', async () => {
    const a = await start();
    expect((await fetch(a.runtime.origin + '/api/app-observation')).status).toBe(401);
    expect((await fetch(a.runtime.origin + '/api/app-observation', { headers: { ...a.headers, Origin: 'https://outside.example' } })).status).toBe(403);
    expect((await a.request('/api/app-observation')).status).toBe(200);
    expect(a.sample).not.toHaveBeenCalled();
    const bootstrap = await fixture.bootstrap();
    const paired = await (await a.request('/api/devices/pair', 'POST', { ...fixture.configuration, code: bootstrap.code, name: 'HTTP source', confirm: true })).json();
    const profileId = paired.profileId;
    expect((await a.request('/api/app-observation/sharing/preview', 'POST', { policy: { enabled: true } })).status).toBe(400);
    const preview = await (await a.request('/api/app-observation/sharing/preview', 'POST', { policy: { enabled: true } }, profileId)).json();
    expect(preview.fields).toEqual(['name', 'observedAt']); expect(a.sample).not.toHaveBeenCalled();
    const missingToken = await fetch(a.runtime.origin + '/API/app-observation/sharing', { method: 'POST', headers: { ...a.headers, 'Content-Type': 'application/json', [PROFILE_HEADER]: profileId }, body: JSON.stringify({ policy: preview.policy, digest: preview.digest, confirm: true }) });
    expect(missingToken.status).toBe(403);
    expect((await a.request('/api/app-observation/sharing', 'POST', { policy: preview.policy, digest: preview.digest, confirm: false }, profileId)).status).toBe(400);
    expect((await a.request('/api/app-observation/sharing', 'POST', { policy: preview.policy, digest: preview.digest, confirm: true, observation: { name: 'forged' } }, profileId)).status).toBe(400);
    expect(a.sample).not.toHaveBeenCalled();
    expect((await a.request('/api/app-observation/sharing', 'POST', { policy: preview.policy, digest: preview.digest, confirm: true }, profileId)).status).toBe(200);
    const refreshed = await (await a.request('/api/app-observation/refresh', 'POST', { confirm: true }, profileId)).json();
    expect(refreshed.local.name).toBe('API_ONLY_APP_SAMPLE'); expect(a.sample).toHaveBeenCalledOnce();
    const unscoped = await (await a.request('/api/app-observation')).json();
    expect(unscoped.profileId).toBeNull(); expect(unscoped.statuses).toEqual([]); expect(unscoped.local).toBeNull();
  });
  it('passes the source name through actual runtimes without turning on receiver collection', async () => {
    const a = await start(), b = await start();
    const bootstrap = await fixture.bootstrap();
    await a.runtime.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'Source', confirm: true });
    const aId = a.runtime.devices.state().profileId!, invitation = await a.runtime.devices.invitation(aId);
    await b.runtime.devices.pair({ ...fixture.configuration, code: invitation.code, name: 'Receiver', confirm: true });
    const bId = b.runtime.devices.state().profileId!;
    await a.runtime.devices.syncNow(aId); await b.runtime.devices.syncNow(bId);
    await a.runtime.appObservation.refresh(aId); await b.runtime.appObservation.refresh(bId);
    const preview = await (await a.request('/api/app-observation/sharing/preview', 'POST', { policy: { enabled: true } }, aId)).json();
    await a.request('/api/app-observation/sharing', 'POST', { policy: preview.policy, digest: preview.digest, confirm: true }, aId);
    const response = await a.request('/api/app-observation/refresh', 'POST', { confirm: true }, aId); expect(response.status).toBe(200);
    const incoming = await (await b.request('/api/app-observation/refresh', 'POST', { confirm: true }, bId)).json();
    expect(incoming.policy.enabled).toBe(false); expect(incoming.statuses[0].observation.name).toBe('API_ONLY_APP_SAMPLE');
    expect(incoming.statuses[0].deviceId).toBe(a.runtime.devices.state(aId).localDevice.id);
    expect(b.sample).not.toHaveBeenCalled();
    expect((await b.request('/api/app-observation/sharing', 'POST', { policy: preview.policy, digest: preview.digest, confirm: true }, bId)).status).toBe(409);
  });
});
