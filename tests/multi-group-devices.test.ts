import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { DeviceService } from '../server/devices.js';
import { RelayError, type RelayClient, type SecureCodec } from '../server/relay.js';
import { EMPTY_MEMORY } from '../shared/types.js';
import type { GroupShareInput, RelayConfiguration, SharedProject } from '../shared/devices.js';
import { formatSharedSummary } from '../shared/shared-summary.js';
import * as summaries from '../shared/shared-summary.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';

let relayA: SqlRelayFixture, relayB: SqlRelayFixture, directory: string;
let configurationA: RelayConfiguration, configurationB: RelayConfiguration;
interface Peer { file: string; store: Store; service: DeviceService; codec: SecureCodec; relays: Map<string, RelayClient> }
const peers: Peer[] = [];
beforeAll(async () => {
  [relayA, relayB] = await Promise.all([createSqlRelayFixture(), createSqlRelayFixture()]);
  configurationA = relayA.configuration;
  configurationB = { ...relayB.configuration, url: 'https://second-relay.supabase.co' };
}, 60000);
afterAll(async () => { await Promise.all([relayA?.close(), relayB?.close()]); });
beforeEach(async () => { await Promise.all([relayA.reset(), relayB.reset()]); directory = await mkdtemp(join(tmpdir(), 'hub-multi-group-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const peer of peers.splice(0)) { await peer.service.stop(); peer.store.close(); }
  await rm(directory, { recursive: true, force: true });
});
function peer(): Peer {
  const value = { file: join(directory, `${randomUUID()}.sqlite`), codec: testCredentialCodec(), relays: new Map([[configurationA.url, relayA.relay], [configurationB.url, relayB.relay]]) } as Peer;
  value.store = new Store(value.file);
  value.service = new DeviceService(value.store, { mode: 'desktop', codec: value.codec, relayFactory: configuration => value.relays.get(configuration.url)! });
  peers.push(value); return value;
}
async function restart(value: Peer) {
  await value.service.stop(); value.store.close(); value.store = new Store(value.file);
  value.service = new DeviceService(value.store, { mode: 'desktop', codec: value.codec, relayFactory: configuration => value.relays.get(configuration.url)! });
}
async function joinGroup(value: Peer, group: 'a' | 'b', code?: string, name = 'Installation', label = 'Same local label') {
  const relay = group === 'a' ? relayA : relayB, configuration = group === 'a' ? configurationA : configurationB;
  const invitation = code ? { code } : await relay.bootstrap();
  const state = await value.service.pair({ ...configuration, code: invitation.code, name, label, confirm: true });
  return state.profileId!;
}
async function twoGroups() {
  const local = peer(), a = await joinGroup(local, 'a'), b = await joinGroup(local, 'b', undefined, 'A different new membership name');
  return { local, a, b };
}
function project(value: Peer) {
  const created = value.store.createProject({ path: `/private/${randomUUID()}`, name: 'Same project name', nextAction: 'Shared next step' });
  value.store.createTask(created.id, { title: 'PRIVATE_TASK_NEVER_EXPORTED' });
  return value.store.saveMemory(created.id, created.revision, { ...EMPTY_MEMORY, status: 'A_ONLY', architecture: 'B_ONLY', notes: 'PRIVATE_NOTE_NEVER_EXPORTED' });
}
function targets(a: string, b: string): GroupShareInput[] {
  return [{ profileId: a, enabled: true, memoryFields: ['status'] }, { profileId: b, enabled: true, memoryFields: ['architecture'] }];
}
function batch(value: Peer, projectId: string, policies: GroupShareInput[]) {
  const preview = value.service.groupSharing(projectId, policies);
  return value.service.shareGroups(projectId, { policies, digest: preview.digest, confirm: true });
}
function gate() {
  let started!: () => void, release!: () => void;
  return { start: new Promise<void>(resolve => { started = resolve; }), wait: new Promise<void>(resolve => { release = resolve; }), started: () => started(), release: () => release() };
}

describe('multi-group membership, synchronization and lifecycle isolation', () => {
  it('joins two independent relays, preserves names, opts into neither, and restarts without merging identities', async () => {
    const { local, a, b } = await twoGroups();
    const installation = local.service.state().installationId;
    expect(local.service.state().localDevice.name).toBe('Installation');
    expect(local.service.state(a).devices[0].name).toBe('Installation');
    expect(local.service.state(b).devices[0].name).toBe('A different new membership name');
    expect(local.service.state(a).localDevice.id).not.toBe(local.service.state(b).localDevice.id);
    const aProfile = local.service.repository.profile(a)!, bProfile = local.service.repository.profile(b)!;
    expect(aProfile.configuration.url).not.toBe(bProfile.configuration.url);
    expect(local.codec.decrypt(aProfile.credentials)).not.toBe(local.codec.decrypt(bProfile.credentials));
    expect(local.service.state().groups.map(group => group.label)).toEqual(['Same local label', 'Same local label']);
    expect(local.service.state(a).sharing).toEqual([]); expect(local.service.state(b).sharing).toEqual([]);
    expect(local.store.db.prepare('SELECT COUNT(*) AS n FROM governance_profiles').get()!.n).toBe(0);
    local.service.selectGroup(a); await local.service.syncAll(); expect(local.service.state().profileId).toBe(a);
    expect(local.service.state(a).connection).toBe('online'); expect(local.service.state(b).connection).toBe('online');
    await restart(local);
    expect(local.service.state().installationId).toBe(installation); expect(local.service.state().profileId).toBe(a);
    expect(local.service.workers.size).toBe(2);
    expect(local.service.repository.profile(a)!.credentials).toEqual(aProfile.credentials);
    expect(local.service.repository.profile(b)!.credentials).toEqual(bProfile.credentials);
    local.service.labelGroup(b, 'Locally renamed'); expect(local.service.state(a).groups.find(group => group.id === b)!.label).toBe('Locally renamed');
    local.service.rename('Explicit installation rename');
    expect(local.service.state(a).devices[0].name).toBe('Explicit installation rename');
    expect(local.service.state(b).devices[0].name).toBe('Explicit installation rename');
  });
  it('keeps a failed or paused group independent and reports callbacks with their original profile', async () => {
    const { local, a, b } = await twoGroups(); const callbacks: string[] = [];
    local.service.onSynced(async profileId => { callbacks.push(profileId); });
    local.relays.set(configurationA.url, { ...relayA.relay, listDevices: async () => { throw new RelayError('unavailable', 'private provider error', true); } });
    await local.service.syncAll();
    expect(local.service.state(a).connection).toBe('error'); expect(local.service.state(b).connection).toBe('online'); expect(callbacks).toEqual([b]);
    await local.service.enable(a, false); await local.service.syncAll();
    expect(local.service.state(a).connection).toBe('disabled'); expect(callbacks).toEqual([b, b]);
    expect(local.service.state().profileId).toBe(b);
  });
  it('locks only the profile with unreadable ciphertext and never clears another group credential', async () => {
    const { local, a, b } = await twoGroups(), otherCodec = testCredentialCodec();
    const badCiphertext = otherCodec.encrypt(JSON.stringify({ token: 'f'.repeat(64) }));
    local.store.db.prepare('UPDATE relay_profiles SET credentials=? WHERE id=?').run(badCiphertext, a);
    const bCiphertext = local.service.repository.profile(b)!.credentials;
    const request = vi.fn(relayA.relay.listDevices);
    local.relays.set(configurationA.url, { ...relayA.relay, listDevices: request });
    await local.service.syncAll();
    expect(local.service.state(a).connection).toBe('locked'); expect(request).not.toHaveBeenCalled();
    expect(local.service.state(b).connection).toBe('online');
    expect(Buffer.from(local.service.repository.profile(a)!.credentials)).toEqual(Buffer.from(badCiphertext));
    expect(local.service.repository.profile(b)!.credentials).toEqual(bCiphertext);
  });
  it('does not cancel background A when management selection changes, and pausing A does not invalidate B', async () => {
    const { local, a, b } = await twoGroups(), paused = gate();
    const aCapture = local.service.captureProfile(a), bCapture = local.service.captureProfile(b);
    local.relays.set(configurationA.url, { ...relayA.relay, listDevices: async (...args) => { paused.started(); await paused.wait; return relayA.relay.listDevices(...args); } });
    local.service.selectGroup(a); const running = local.service.syncNow(a); await paused.start;
    local.service.selectGroup(b); await local.service.syncNow(b);
    expect(() => aCapture.assertCurrent()).not.toThrow(); expect(() => bCapture.assertCurrent()).not.toThrow();
    paused.release(); await running; expect(local.service.state(a).connection).toBe('online'); expect(local.service.state().profileId).toBe(b);
    await local.service.enable(a, false); await local.service.enable(a, true);
    await local.service.workers.get(a)!.syncNow();
    expect(() => aCapture.assertCurrent()).toThrow(); expect(() => bCapture.assertCurrent()).not.toThrow();
  });
  it('aborts and drains only the disconnected group, rejects its stale response, and preserves B credentials and worker', async () => {
    const { local, a, b } = await twoGroups(), paused = gate();
    const secretB = local.service.repository.profile(b)!.credentials;
    local.relays.set(configurationA.url, { ...relayA.relay, listDevices: async (...args) => {
      const rows = await relayA.relay.listDevices(...args); paused.started(); await paused.wait; return rows;
    } });
    const running = local.service.workers.get(a)!.syncNow(); await paused.start;
    const leaving = local.service.disconnect(a);
    await local.service.enable(b, false); await local.service.enable(b, true); await local.service.syncNow(b);
    expect(local.service.state(b).connection).toBe('online');
    paused.release(); await Promise.all([running, leaving]);
    expect(local.service.state().groups.map(group => group.id)).toEqual([b]);
    expect(local.service.repository.profile(a)!.credentials.byteLength).toBe(0);
    expect(local.service.repository.profile(b)!.credentials).toEqual(secretB);
    expect(local.service.workers.has(a)).toBe(false); expect(local.service.workers.has(b)).toBe(true);
    expect(() => local.service.state(a)).toThrow(/no longer joined/);
  });
  it('recovers each pairing attempt independently after a lost response and restart without selecting the retried group', async () => {
    const local = peer(); let attemptId = '', deviceId = '';
    local.relays.set(configurationA.url, { ...relayA.relay, pair: async (...args) => {
      attemptId = args[0].attemptId; deviceId = args[0].deviceId; await relayA.relay.pair(...args); throw new RelayError('unavailable', 'lost response', true);
    } });
    await expect(joinGroup(local, 'a')).rejects.toThrow(/Retry pairing/);
    const a = local.service.state().profileId!, encryptedAttempt = local.service.repository.profile(a)!.credentials;
    const b = await joinGroup(local, 'b'); const secretB = local.codec.decrypt(local.service.repository.profile(b)!.credentials);
    await restart(local);
    local.relays.set(configurationA.url, { ...relayA.relay, pair: async (...args) => {
      expect(args[0].attemptId).toBe(attemptId); expect(args[0].deviceId).toBe(deviceId); return relayA.relay.pair(...args);
    } });
    expect(local.service.repository.profile(a)!.credentials).toEqual(encryptedAttempt);
    local.service.rename('Explicit rename during pending pairing');
    const recovered = await local.service.retryPair(a);
    expect(recovered.devices.find(device => device.id === deviceId)!.name).toBe('Explicit rename during pending pairing');
    expect(recovered.profileId).toBe(a); expect(local.service.state().profileId).toBe(b);
    expect(recovered.localDevice.id).toBe(deviceId); expect(local.codec.decrypt(local.service.repository.profile(a)!.credentials)).not.toContain('inviteToken');
    expect(local.codec.decrypt(local.service.repository.profile(b)!.credentials)).toBe(secretB);
    await local.service.syncAll(); expect(local.service.state(a).connection).toBe('online'); expect(local.service.state(b).connection).toBe('online');
  });
  it('leaves locally without cloud revocation and rejoining creates a fresh membership with no historical policies or outbox', async () => {
    const { local, a, b } = await twoGroups(), created = project(local);
    batch(local, created.id, targets(a, b)); await local.service.syncAll();
    const old = local.service.repository.profile(a)!, token = JSON.parse(local.codec.decrypt(old.credentials)).token;
    local.service.repository.queue(a, 'old-rename', 'rename', { name: 'OLD_OUTBOX' });
    await local.service.disconnect(a);
    expect((await relayA.relay.listDevices(token)).find(device => device.id === old.deviceId)?.revokedAt).toBeNull();
    expect(local.store.db.prepare('SELECT COUNT(*) AS n FROM project_publications WHERE profile_id=?').get(a)!.n).toBe(1);
    expect(local.store.db.prepare('SELECT COUNT(*) AS n FROM device_outbox WHERE profile_id=?').get(a)!.n).toBe(1);
    const invitation = await relayA.relay.createInvite(token, 'a'.repeat(64)); expect(invitation.expiresAt).toBeTruthy();
    const next = await joinGroup(local, 'a', 'a'.repeat(64));
    expect(next).not.toBe(a); expect(local.service.state(next).localDevice.id).not.toBe(old.deviceId);
    expect(local.service.state(next).sharing).toEqual([]); expect(local.service.messages(next, 'sent')).toEqual([]);
    expect(local.service.state(next).queuedCount).toBe(0); expect(local.service.state(b).sharing[0].enabled).toBe(true);
    expect(local.service.state().localDevice.name).toBe('Installation');
  });
});

describe('atomic multi-group sharing and strict aggregate/download boundaries', () => {
  it('keeps group fields separate, acknowledges only sent versions, and withdraws only the chosen group', async () => {
    const { local, a, b } = await twoGroups(), created = project(local), remoteA = peer(), remoteB = peer();
    const inviteA = await local.service.invitation(a), inviteB = await local.service.invitation(b);
    const ra = await joinGroup(remoteA, 'a', inviteA.code), rb = await joinGroup(remoteB, 'b', inviteB.code);
    batch(local, created.id, targets(a, b));
    let items = local.service.sharedWorkspace().items;
    expect(items).toHaveLength(2); expect(items.every(item => item.pending && item.publishedAt === null)).toBe(true);
    expect(items.find(item => item.profileId === a)!.project.memory).toEqual({ status: 'A_ONLY' });
    expect(items.find(item => item.profileId === b)!.project.memory).toEqual({ architecture: 'B_ONLY' });
    await local.service.syncAll(); await remoteA.service.syncNow(ra); await remoteB.service.syncNow(rb);
    items = local.service.sharedWorkspace().items;
    expect(items.every(item => !item.pending && item.publishedAt !== null)).toBe(true);
    expect(remoteA.service.sharedWorkspace().items[0].project.memory).toEqual({ status: 'A_ONLY' });
    expect(remoteB.service.sharedWorkspace().items[0].project.memory).toEqual({ architecture: 'B_ONLY' });
    expect(remoteA.store.listProjects()).toEqual([]); expect(remoteB.store.listProjects()).toEqual([]);
    const old = items.find(item => item.profileId === b)!;
    local.store.updateProject(created.id, { revision: created.revision, nextAction: 'Local edit awaits publication' });
    items = local.service.sharedWorkspace().items;
    expect(items.every(item => item.pending && item.publishedAt === null)).toBe(true);
    expect(() => local.service.downloadSummary({ profileId: old.profileId, ownerDeviceId: old.ownerDeviceId, projectId: old.projectId, version: old.version })).toThrow(/version changed/);
    batch(local, created.id, [{ profileId: a, enabled: false, memoryFields: ['status'] }, { profileId: b, enabled: true, memoryFields: ['architecture'] }]);
    expect(local.service.sharedWorkspace().items.map(item => item.profileId)).toEqual([b]);
    await local.service.syncNow(a); await remoteA.service.syncNow(ra);
    expect(remoteA.service.sharedWorkspace().items).toEqual([]);
    await remoteB.service.enable(rb, false); expect(remoteB.service.sharedWorkspace().items).toHaveLength(1);
    const cached = remoteB.service.sharedWorkspace().items[0];
    expect(remoteB.service.downloadSummary({ profileId: cached.profileId, ownerDeviceId: cached.ownerDeviceId, projectId: cached.projectId, version: cached.version }).text).toContain('B_ONLY');
  });
  it('binds confirmation to the complete target set, local revision, current policies and newly joined memberships', async () => {
    const { local, a, b } = await twoGroups(), created = project(local), policies = targets(a, b);
    const preview = local.service.groupSharing(created.id, policies);
    expect(() => local.service.shareGroups(created.id, { policies: [policies[0]], digest: preview.digest, confirm: true })).toThrow();
    expect(() => local.service.shareGroups(created.id, { policies: [policies[0], { ...policies[1], profileId: randomUUID() }], digest: preview.digest, confirm: true })).toThrow();
    expect(() => local.service.shareGroups(created.id, { policies: [policies[0], policies[0]], digest: preview.digest, confirm: true })).toThrow();
    expect(local.service.state(a).sharing).toEqual([]); expect(local.service.state(b).sharing).toEqual([]);
    local.service.share(a, created.id, { enabled: true, memoryFields: [] });
    expect(() => local.service.shareGroups(created.id, { policies, digest: preview.digest, confirm: true })).toThrow(/changed/);
    let newer = local.service.groupSharing(created.id, policies);
    local.store.updateProject(created.id, { revision: created.revision, nextAction: 'Changed revision' });
    expect(() => local.service.shareGroups(created.id, { policies, digest: newer.digest, confirm: true })).toThrow(/changed/);
    newer = local.service.groupSharing(created.id, policies); const c = await joinGroup(local, 'a');
    expect(() => local.service.shareGroups(created.id, { policies, digest: newer.digest, confirm: true })).toThrow(/changed/);
    expect(local.service.state(c).sharing).toEqual([]);
    const complete = [...policies, { profileId: c, enabled: false, memoryFields: [] }]; batch(local, created.id, complete);
    expect(local.service.sharedWorkspace().items.map(item => item.profileId).sort()).toEqual([a, b].sort());
    const now = local.service.groupSharing(created.id, complete); await local.service.disconnect(a);
    expect(() => local.service.shareGroups(created.id, { policies: complete, digest: now.digest, confirm: true })).toThrow();
    expect(local.service.state(b).sharing[0].memoryFields).toEqual(['architecture']);
  });
  it('rolls back policies, publications and status withdrawals together when any group write fails', async () => {
    const { local, a, b } = await twoGroups(), created = project(local);
    batch(local, created.id, targets(a, b));
    for (const id of [a, b]) local.store.db.prepare('INSERT INTO governance_profiles(profile_id,sharing_json) VALUES(?,?)').run(id,
      JSON.stringify({ activity: true, projects: [{ projectId: created.id, tasks: false, git: false }] }));
    const before = ['project_shares', 'project_publications', 'governance_profiles'].map(table => local.store.db.prepare(`SELECT * FROM ${table}`).all());
    const policies = targets(a, b).map(policy => ({ ...policy, enabled: false })), preview = local.service.groupSharing(created.id, policies);
    const last = preview.groups.at(-1)!.group.id;
    local.store.db.exec(`CREATE TRIGGER fail_batch BEFORE UPDATE ON project_shares WHEN NEW.profile_id='${last}' BEGIN SELECT RAISE(ABORT, 'injected atomic failure'); END;`);
    expect(() => local.service.shareGroups(created.id, { policies, digest: preview.digest, confirm: true })).toThrow(/injected/);
    expect(['project_shares', 'project_publications', 'governance_profiles'].map(table => local.store.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    local.store.db.exec('DROP TRIGGER fail_batch'); batch(local, created.id, policies);
    expect(local.service.sharedWorkspace().items).toEqual([]);
    expect(local.store.db.prepare('SELECT sharing_json FROM governance_profiles').all().every(row => JSON.parse(String(row.sharing_json)).projects.length === 0)).toBe(true);
  });
  it('keys cache identity by group, owner and project even with identical names and IDs; ignores unknown/revoked owners', async () => {
    const { local, a, b } = await twoGroups(), owner = randomUUID(), projectId = randomUUID();
    const base: SharedProject = { name: 'Same name', status: 'active', priority: 'normal', stage: '', nextAction: '', revision: 1, memory: { status: 'A_VIEW' } };
    for (const [id, memory] of [[a, { status: 'A_VIEW' }], [b, { architecture: 'B_VIEW' }]] as const) {
      local.service.repository.cacheDevices(id, [{ id: owner, name: 'Same name', lastSeenAt: new Date().toISOString(), revokedAt: null }]);
      local.service.repository.cacheSnapshot(id, { ownerDeviceId: owner, projectId, version: 1, project: { ...base, memory }, publishedAt: new Date().toISOString() });
    }
    const unknown = randomUUID();
    local.service.repository.cacheSnapshot(a, { ownerDeviceId: unknown, projectId, version: 1, project: base, publishedAt: new Date().toISOString() });
    expect(local.service.sharedWorkspace().items).toHaveLength(2);
    const download = (id: string) => local.service.downloadSummary({ profileId: id, ownerDeviceId: owner, projectId, version: 1 });
    expect(download(a).text).toContain('A_VIEW'); expect(download(a).text).not.toContain('B_VIEW');
    expect(download(b).text).toContain('B_VIEW'); expect(download(b).text).not.toContain('A_VIEW');
    local.service.repository.cacheDevices(a, [{ id: owner, name: 'Same name', lastSeenAt: new Date().toISOString(), revokedAt: new Date().toISOString() }]);
    expect(local.service.sharedWorkspace().items.map(item => item.profileId)).toEqual([b]); expect(() => download(a)).toThrow(); expect(() => download(b)).not.toThrow();
    local.service.repository.cacheSnapshot(b, { ownerDeviceId: owner, projectId, version: 2, project: null, publishedAt: new Date().toISOString() });
    expect(() => download(b)).toThrow(); expect(local.service.sharedWorkspace().items).toEqual([]);
  });
  it('hides only confirmed-revoked groups and rejects stale export, while locked/offline cached summaries remain available', async () => {
    const { local, a, b } = await twoGroups(), created = project(local); batch(local, created.id, targets(a, b)); await local.service.syncAll();
    const key = (id: string) => ({ profileId: id, ownerDeviceId: local.service.state(id).localDevice.id, projectId: created.id, version: 1 });
    local.service.repository.setConnection(a, 'locked');
    expect(local.service.downloadSummary(key(a)).text).toContain('A_ONLY');
    local.relays.set(configurationA.url, { ...relayA.relay, listDevices: async () => { throw new RelayError('unauthorized', 'revoked'); } });
    await local.service.syncAll();
    expect(local.service.state(a).connection).toBe('revoked'); expect(local.service.state(b).connection).toBe('online');
    expect(local.service.sharedWorkspace().groups.map(group => group.id)).toEqual([b]);
    expect(() => local.service.downloadSummary(key(a))).toThrow(); expect(() => local.service.share(a, created.id, { enabled: true, memoryFields: [] })).toThrow();
    expect(local.service.downloadSummary(key(b)).text).toContain('B_ONLY');
  });
  it('exports only strict allowed content with safe filenames, both locales, honest pending status and a 1 MiB output cap', async () => {
    const { local, a, b } = await twoGroups(), created = project(local);
    local.store.updateProject(created.id, { revision: created.revision, name: '../CON:<bad>\\file\u0000', nextAction: '~~~\n<script>not active HTML</script>' });
    batch(local, created.id, targets(a, b));
    const item = local.service.sharedWorkspace().items.find(item => item.profileId === a)!;
    const key = { profileId: a, ownerDeviceId: item.ownerDeviceId, projectId: item.projectId, version: item.version };
    const download = local.service.downloadSummary(key);
    expect(download.filename).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/); expect(download.filename).toMatch(/\.md$/);
    expect(download.text).toContain('Pending sync'); expect(download.text).toContain('A_ONLY');
    expect(download.text).not.toMatch(/PRIVATE_NOTE|PRIVATE_TASK|B_ONLY|\/private\//);
    expect(download.text).toContain('~~~~text\n~~~');
    local.store.updateSettings({ locale: 'zh-TW' }); expect(local.service.downloadSummary(key).text).toContain('目前開發狀態');
    const metadata = { ...key, groupLabel: 'Group', ownerName: 'Owner', pending: true, publishedAt: null, receivedAt: null, lastSyncAt: null };
    expect(() => formatSharedSummary({ ...item.project, path: '/LOCAL_SECRET' } as SharedProject, metadata)).toThrow();
    expect(() => formatSharedSummary(item.project, { ...metadata, token: 'SECRET' } as typeof metadata)).toThrow();
    vi.spyOn(summaries, 'formatSharedSummary').mockReturnValue({ filename: 'safe.md', text: '漢'.repeat(400000) });
    expect(() => local.service.downloadSummary(key)).toThrow(/1 MiB/);
  });
});
