import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHubRuntime, DESKTOP_KEY_HEADER, type HubRuntime } from '../server/runtime.js';
import type { GitEngine } from '../server/git-approvals.js';
import type { PreparedGitOperation } from '../server/git-operations.js';
import { PROFILE_HEADER } from '../shared/devices.js';
import type { GitDetails, GitPreview } from '../shared/git.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';

let fixture: SqlRelayFixture, directory: string, assets: string;
const runtimes: HubRuntime[] = [];
const oid = '1'.repeat(40);
const details: GitDetails = {
  snapshot: { isRepo: true, branch: 'main', head: oid, branches: ['main'], commits: [], changes: [], changedCount: 0, stagedCount: 0, untrackedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() },
  remotes: [], upstream: null, ahead: null, behind: null, operationState: null, unsupportedReasons: [], identity: { name: 'Test', email: 'test@example.invalid' },
};
beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60_000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.reset(); directory = await mkdtemp(join(tmpdir(), 'hub-git-profile-api-'));
  assets = join(directory, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<!doctype html><title>Isolated profile API tests</title>');
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
async function start() {
  let launches = 0, recoveries = 0;
  const secret = randomBytes(32).toString('hex'), factory = vi.fn(() => fixture.relay);
  const engine: GitEngine = {
    details: async () => details,
    diff: async (_path, input) => ({ ...input, text: 'Local-only diff', binary: false, truncated: false }),
    prepare: async (path, operation, context) => ({ operation, directory: path, repositoryKey: 'same-physical-repository', fingerprint: 'before',
      summary: { projectName: context.projectName, kind: operation.kind, paths: 'paths' in operation ? operation.paths : [], branch: 'main', head: oid,
        target: null, remoteUrl: null, targetRef: null, changedCount: 0, stagedCount: 0, message: null, authorName: null, authorEmail: null },
    }) as PreparedGitOperation,
    execute: async (_plan, options) => { await options.authorize(); options.onStarting(); launches++; return { status: 'succeeded', code: 'completed', head: oid }; },
    recover: async () => { recoveries++; },
  };
  const runtime = await createHubRuntime({ assetDirectory: assets, dataDir: join(directory, randomUUID()), port: 0, mode: 'desktop', desktopSecret: secret, enablePolling: false,
    gitEngine: engine, deviceOptions: { codec: testCredentialCodec(), relayFactory: factory, enablePolling: false },
    appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) } });
  runtimes.push(runtime);
  const desktopHeaders = { [DESKTOP_KEY_HEADER]: secret };
  const workspace = await (await fetch(runtime.origin + '/api/workspace', { headers: desktopHeaders })).json();
  const request = (profileId: string | null, path: string, method = 'GET', body?: unknown) => fetch(runtime.origin + '/api' + path, {
    method, headers: { ...desktopHeaders, 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken, ...(profileId === null ? {} : { [PROFILE_HEADER]: profileId }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { runtime, request, factory, desktopHeaders, launches: () => launches, recoveries: () => recoveries };
}
async function twoGroups() {
  const local = await start(), { runtime } = local;
  const bootstrap = await fixture.bootstrap('A');
  const a = (await runtime.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'A administrator', confirm: true })).profileId!;
  const second = await fixture.bootstrap('B');
  const bOwner = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex'), inviteToken: second.code, name: 'B owner' };
  await fixture.relay.pair(bOwner);
  const code = randomBytes(32).toString('hex'); await fixture.relay.createInvite(bOwner.deviceToken, code);
  const b = (await runtime.devices.pair({ ...fixture.configuration, code, name: 'B member', confirm: true })).profileId!;
  await runtime.devices.syncNow(a); await runtime.devices.syncNow(b);
  return { ...local, a, b, bOwner };
}
const operation = { kind: 'stage', paths: ['readme.txt'] };

describe('profile-bound Git and governance HTTP routes', () => {
  it('requires valid profile headers on every network-scoped mutation before any relay work', async () => {
    const local = await start(), id = randomUUID(), digest = '0'.repeat(64);
    const project = local.runtime.store.createProject({ path: directory, name: 'Local repository' });
    const mutations: [string, string, unknown][] = [
      ['/governance/refresh', 'POST', { confirm: true }],
      [`/governance/roles/${id}`, 'PATCH', { role: 'admin', confirm: true }],
      ['/governance/sharing/preview', 'POST', { policy: { activity: false, projects: [] } }],
      ['/governance/sharing', 'POST', { policy: { activity: false, projects: [] }, digest, confirm: true }],
      [`/projects/${project.id}/git/preview`, 'POST', { operation }],
      ['/git/requests', 'POST', { previewId: id, reviewerDeviceId: id, digest, confirm: true }],
      [`/git/requests/${id}/execute`, 'POST', { digest, confirm: true }],
      [`/git/requests/${id}/cancel`, 'POST', { digest, confirm: true }],
      [`/git/approvals/${id}/decision`, 'POST', { digest, decision: 'approved', reason: '', confirm: true }],
    ];
    for (const [path, method, body] of mutations) {
      for (const profileId of [null, '', 'not-a-profile', `${id}, ${id}`]) expect((await local.request(profileId, path, method, body)).status).toBe(400);
      const response = await local.request(id, path, method, body);
      expect(response.status).toBe(409); expect((await response.json()).code).toBe('device.profileUnavailable');
    }
    expect(local.factory).not.toHaveBeenCalled(); expect(local.launches()).toBe(0);
    expect(local.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get()!.n).toBe(0);
  });

  it('keeps details/diff local and treats missing GET scope as empty or recovery-only, never selected', async () => {
    const { runtime, request, a } = await twoGroups();
    const project = runtime.store.createProject({ path: directory, name: 'Local inspection' });
    await runtime.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    expect((await request(null, `/projects/${project.id}/git/details`)).status).toBe(200);
    const diff = await request(null, `/projects/${project.id}/git/diff`, 'POST', { path: 'readme.txt', source: 'worktree' });
    expect(diff.status).toBe(200); expect((await diff.json()).text).toBe('Local-only diff');
    expect(await (await request(null, '/governance')).json()).toMatchObject({ available: false, policy: null, statuses: [] });
    expect(await (await request(null, '/git/approvals')).json()).toEqual([]);
    expect(await (await request(null, `/projects/${project.id}/git/requests`)).json()).toEqual([]);
    for (const path of ['/governance', '/git/approvals', `/projects/${project.id}/git/requests`]) expect((await request('bad', path)).status).toBe(400);
    expect((await (await request(a, `/projects/${project.id}/git/requests`)).json()).length).toBe(1);
  });

  it('binds stale A headers to A while selected B remains a member and rejects cross-profile digests/approvals', async () => {
    const { runtime, request, a, b, launches } = await twoGroups();
    const selfA = runtime.devices.state(a).localDevice.id, selfB = runtime.devices.state(b).localDevice.id;
    expect(runtime.devices.state().profileId).toBe(b);
    expect((await (await request(a, '/governance')).json()).policy.role).toBe('admin');
    expect((await (await request(b, '/governance')).json()).policy.role).toBe('member');
    expect((await request(b, `/governance/roles/${selfB}`, 'PATCH', { role: 'admin', confirm: true })).status).toBe(403);
    const memberCode = await runtime.devices.invitation(a);
    const member = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex'), inviteToken: memberCode.code, name: 'A new member' };
    await fixture.relay.pair(member);
    const grant = await request(a, `/governance/roles/${member.deviceId}`, 'PATCH', { role: 'admin', confirm: true });
    expect(grant.status).toBe(200); expect((await grant.json()).policy.deviceId).toBe(selfA);
    const policy = { activity: true, projects: [] };
    const sharing = await (await request(a, '/governance/sharing/preview', 'POST', { policy })).json();
    expect((await request(b, '/governance/sharing', 'POST', { policy, digest: sharing.digest, confirm: true })).status).toBe(409);
    expect((await request(a, '/governance/sharing', 'POST', { policy, digest: sharing.digest, confirm: true })).status).toBe(200);
    expect(runtime.governance.state(b).sharing.activity).toBe(false);
    const project = runtime.store.createProject({ path: directory, name: 'Explicit A review' });
    const response = await request(a, `/projects/${project.id}/git/preview`, 'POST', { operation });
    expect(response.status).toBe(200); const preview = await response.json() as GitPreview;
    expect(runtime.git.repository.get(preview.id).profileId).toBe(a);
    const submission = { previewId: preview.id, reviewerDeviceId: selfA, digest: preview.digest, confirm: true };
    expect((await request(b, '/git/requests', 'POST', submission)).status).toBe(404);
    expect((await request(a, '/git/requests', 'POST', submission)).status).toBe(200);
    expect(await (await request(b, '/git/approvals')).json()).toEqual([]);
    const decision = { digest: preview.digest, decision: 'approved', reason: '', confirm: true };
    expect((await request(b, `/git/approvals/${preview.id}/decision`, 'POST', decision)).status).toBe(403);
    expect((await request(a, `/git/approvals/${preview.id}/decision`, 'POST', decision)).status).toBe(200);
    const confirmation = { digest: preview.digest, confirm: true };
    expect((await request(b, `/git/requests/${preview.id}/cancel`, 'POST', confirmation)).status).toBe(404);
    expect((await request(b, `/git/requests/${preview.id}/execute`, 'POST', confirmation)).status).toBe(404);
    expect((await request(b, `/git/requests/${preview.id}/audit`)).status).toBe(404);
    expect((await request(null, `/git/requests/${preview.id}/audit`)).status).toBe(404);
    expect(launches()).toBe(0);
    const executed = await request(a, `/git/requests/${preview.id}/execute`, 'POST', confirmation);
    expect(executed.status).toBe(200); expect((await executed.json()).state).toBe('succeeded'); expect(launches()).toBe(1);
    expect(runtime.devices.state().profileId).toBe(b); expect(runtime.governance.state(b).policy?.role).toBe('member');
  });

  it('hides a closed group but preserves installation-wide unknown journals and local recovery exemptions', async () => {
    const { runtime, request, a, b, launches, recoveries } = await twoGroups();
    const project = runtime.store.createProject({ path: directory, name: 'Retained journal' });
    const unknown = await runtime.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    const normal = await runtime.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    runtime.git.repository.transition(unknown.id, 'unknown', { result: { status: 'unknown', code: 'interrupted', head: null }, error: 'gitops.unknown' });
    await runtime.devices.disconnect(a);
    expect(await (await request(a, '/governance')).json()).toMatchObject({ policy: null, statuses: [], available: false });
    expect(await (await request(a, '/git/approvals')).json()).toEqual([]);
    const retained = await (await request(null, `/projects/${project.id}/git/requests`)).json();
    expect(retained.map((row: { preview: GitPreview }) => row.preview.id)).toEqual([unknown.id]);
    const oldScope = await (await request(a, `/projects/${project.id}/git/requests`)).json();
    expect(oldScope.map((row: { preview: GitPreview }) => row.preview.id)).toEqual([unknown.id]);
    expect((await request(b, `/projects/${project.id}/git/preview`, 'POST', { operation })).status).toBe(409);
    expect((await request(a, `/projects/${project.id}/git/preview`, 'POST', { operation })).status).toBe(409);
    expect((await request(a, '/governance/refresh', 'POST', { confirm: true })).status).toBe(409);
    expect((await request(null, `/git/requests/${normal.id}/audit`)).status).toBe(404);
    expect((await request(null, `/git/requests/${normal.id}/acknowledge`, 'POST', { confirm: true })).status).toBe(404);
    expect((await request('bad', `/git/requests/${unknown.id}/audit`)).status).toBe(400);
    expect((await request(null, `/git/requests/${unknown.id}/audit`)).status).toBe(200);
    expect((await request(null, `/git/requests/${unknown.id}/acknowledge`, 'POST', { confirm: false })).status).toBe(400);
    expect((await request(null, `/git/requests/${unknown.id}/acknowledge`, 'POST', { confirm: true })).status).toBe(200);
    expect(launches()).toBe(0); expect(recoveries()).toBe(1);
    expect((await request(a, `/git/requests/${unknown.id}/execute`, 'POST', { digest: unknown.digest, confirm: true })).status).toBe(409);
    expect((await request(b, `/projects/${project.id}/git/preview`, 'POST', { operation })).status).toBe(200);
  });

  it('retains desktop, Origin and CSRF protections on header-exempt local recovery', async () => {
    const { runtime, request, desktopHeaders, a } = await twoGroups();
    const project = runtime.store.createProject({ path: directory, name: 'Recovery guard' });
    const preview = await runtime.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    runtime.git.repository.transition(preview.id, 'unknown');
    const url = runtime.origin + `/api/git/requests/${preview.id}/acknowledge`;
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...desktopHeaders, 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status).toBe(403);
    expect((await fetch(runtime.origin + `/api/git/requests/${preview.id}/audit`, { headers: { ...desktopHeaders, Origin: 'https://outside.example' } })).status).toBe(403);
    expect((await request(null, `/git/requests/${preview.id}/audit`)).status).toBe(200);
  });
});
