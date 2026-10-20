import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { DeviceService } from '../server/devices.js';
import { RelayError, type RelayClient, type SecureCodec } from '../server/relay.js';
import { EMPTY_MEMORY } from '../shared/types.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';

interface Peer { file: string; store: Store; service: DeviceService; codec: SecureCodec; relay: RelayClient; now: number }
let fixture: SqlRelayFixture, directory: string;
const peers: Peer[] = [];
beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => { await fixture.reset(); directory = await mkdtemp(join(tmpdir(), 'hub-devices-')); });
afterEach(async () => { for (const peer of peers.splice(0)) { await peer.service.stop(); peer.store.close(); } await rm(directory, { recursive: true, force: true }); });
function peer(relay = fixture.relay): Peer {
  const file = join(directory, `${randomUUID()}.sqlite`), store = new Store(file), codec = testCredentialCodec();
  const result = { file, store, codec, relay, now: Date.now() } as Peer;
  result.service = new DeviceService(store, { mode: 'desktop', codec, relayFactory: () => result.relay, clock: () => result.now });
  peers.push(result); return result;
}
async function restart(value: Peer, codec = value.codec) {
  await value.service.stop(); value.store.close(); value.store = new Store(value.file); value.codec = codec;
  value.service = new DeviceService(value.store, { mode: 'desktop', codec, relayFactory: () => value.relay, clock: () => value.now });
}
const profile = (value: Peer) => value.service.state().profileId!;
async function paired() {
  const a = peer(), b = peer(); const bootstrap = await fixture.bootstrap();
  await a.service.pair({ ...fixture.configuration, code: bootstrap.code, name: '工作電腦', confirm: true });
  const invitation = await a.service.invitation(profile(a));
  await b.service.pair({ ...fixture.configuration, code: invitation.code, name: '工作電腦', confirm: true });
  await sync(a, b); return { a, b };
}
async function sync(...values: Peer[]) {
  for (const value of values) {
    await value.service.syncNow(profile(value));
    expect(value.service.state().lastError).toBeNull();
    expect(value.service.state().connection).toBe('online');
  }
}
async function shared(a: Peer, b: Peer) {
  const created = a.store.createProject({ path: '/private/source', name: 'Only selected content', nextAction: '原本下一步' });
  const project = a.store.saveMemory(created.id, created.revision, { ...EMPTY_MEMORY, status: '可以分享', notes: 'SECRET_NOT_SHARED' });
  a.service.share(profile(a), project.id, { enabled: true, memoryFields: ['status'] }); await sync(a, b);
  return project;
}
async function proposal(a: Peer, b: Peer) {
  const project = await shared(a, b);
  const sent = b.service.compose(profile(b), { toDeviceId: a.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'proposal', text: '請在本機審閱', projectId: project.id, baseRevision: project.revision,
    changes: { nextAction: '經本機確認的新下一步', memory: { status: '已確認的新狀態' } } } });
  await sync(b, a); return { project, sent };
}

describe('desktop device service with the delivered SQL relay', () => {
  it('localizes proposal labels and rejection reasons without changing payloads, hashes or revisions', async () => {
    const { a, b } = await paired(); const { project, sent } = await proposal(a, b);
    const message = a.service.messages(profile(a), 'inbox')[0];
    const english = a.service.preview(profile(a), sent.id);
    expect(english.changes.map(change => change.label)).toEqual(['Next action', 'Current development status']);
    a.store.updateSettings({ locale: 'zh-TW' });
    const chinese = a.service.preview(profile(a), sent.id);
    expect(chinese.changes.map(change => change.label)).toEqual(['下一步行動', '目前開發狀態']);
    expect(chinese.hash).toBe(english.hash); expect(chinese.revision).toBe(english.revision);
    expect(chinese.changes.map(({ label: _label, ...change }) => change)).toEqual(english.changes.map(({ label: _label, ...change }) => change));
    expect(a.service.messages(profile(a), 'inbox')[0]).toEqual(message); expect(a.store.getProject(project.id)).toEqual(project);
    await a.service.enable(profile(a), false);
    const blockedZh = a.service.preview(profile(a), sent.id);
    expect(blockedZh.reason).toBe('啟用桌面同步後才能即時驗證來源並套用。'); expect(blockedZh.reasonCode).toBe('proposal.enableSync');
    a.store.updateSettings({ locale: 'en' });
    const blockedEn = a.service.preview(profile(a), sent.id);
    expect(blockedEn.reason).toBe('Enable desktop sync to verify the source live and apply the request.');
    expect(blockedEn.reasonCode).toBe(blockedZh.reasonCode); expect(blockedEn.hash).toBe(english.hash);
    expect(b.store.getSettings().locale).toBe('en');
  });
  it('makes no client or network calls while disabled and preserves local use', async () => {
    const value = peer(), factory = vi.fn(() => fixture.relay);
    const standalone = new DeviceService(value.store, { mode: 'desktop', codec: value.codec, relayFactory: factory });
    standalone.start(); await standalone.syncAll();
    expect(standalone.state()).toMatchObject({ enabled: false, paired: false, sharing: [] });
    expect(factory).not.toHaveBeenCalled();
    standalone.rename('只在本機命名'); expect(standalone.state().localDevice.name).toBe('只在本機命名');
    value.store.createProject({ path: '/local', name: 'Local survives' });
    expect(value.store.listProjects()).toHaveLength(1); await standalone.stop();
  });
  it('encrypts credentials, isolates safe DTOs and permits duplicate display names', async () => {
    const { a, b } = await paired();
    expect(a.service.state().devices).toHaveLength(2);
    expect(a.service.state().localDevice.id).not.toBe(b.service.state().localDevice.id);
    const profile = a.service.repository.profile()!;
    const secret = JSON.parse(a.codec.decrypt(profile.credentials)).token;
    expect(Buffer.from(profile.credentials).includes(Buffer.from(secret))).toBe(false);
    expect(JSON.stringify(a.service.state())).not.toContain(secret);
    expect(JSON.stringify(a.store.getSettings())).not.toContain(secret);
  });
  it('shares nothing by default and keeps remote identities outside local projects', async () => {
    const { a, b } = await paired();
    const project = a.store.createProject({ path: '/secret/path', name: 'Explicit share only' });
    a.store.saveMemory(project.id, project.revision, { ...EMPTY_MEMORY, status: 'SHARED', notes: 'PRIVATE_NOTES' });
    await sync(a, b); expect(b.service.remoteProjects(profile(b), a.service.state().localDevice.id)).toEqual([]);
    a.service.share(profile(a), project.id, { enabled: true, memoryFields: ['status'] }); await sync(a, b);
    const remote = b.service.remoteProjects(profile(b), a.service.state().localDevice.id)[0]!;
    expect(remote.project!.memory).toEqual({ status: 'SHARED' });
    expect(JSON.stringify(remote)).not.toMatch(/secret\/path|PRIVATE_NOTES|csrfToken|dataDir/);
    expect(b.store.listProjects()).toEqual([]);
    const shadow = b.store.createProject({ path: '/other/local', name: 'Same UUID, different owner' });
    b.store.db.prepare('UPDATE projects SET id=? WHERE id=?').run(project.id, shadow.id);
    expect(b.store.getProject(project.id).name).toBe('Same UUID, different owner');
    expect(b.service.remoteProjects(profile(b), a.service.state().localDevice.id)[0]!.project!.name).toBe('Explicit share only');
  });
  it('persists an offline outbox across restart and survives a lost send response', async () => {
    const { a, b } = await paired();
    const sent = b.service.compose(profile(b), { toDeviceId: a.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'message', text: '離線保存的訊息' } });
    await restart(b);
    expect(b.service.messages(profile(b), 'sent')[0]!.id).toBe(sent.id);
    let lost = true;
    b.relay = { ...fixture.relay, send: async (...args) => {
      const result = await fixture.relay.send(...args);
      if (lost) { lost = false; throw new Error('provider secret raw text MUST_NOT_LEAK'); }
      return result;
    } };
    await b.service.syncNow(profile(b));
    expect(b.service.messages(profile(b), 'sent')[0]!.delivery).toBe('queued');
    expect(JSON.stringify(b.service.state())).not.toContain('MUST_NOT_LEAK');
    b.now += 5000; await sync(b, a, b, a);
    expect(a.service.messages(profile(a), 'inbox')).toHaveLength(1);
    expect(a.service.messages(profile(a), 'inbox')[0]!.payload).toMatchObject({ text: '離線保存的訊息' });
    expect(b.service.messages(profile(b), 'sent')[0]!.delivery).toBe('received');
  });
  it('receives proposals without editing, previews, applies once, and returns a durable decision', async () => {
    const { a, b } = await paired(); const { project, sent } = await proposal(a, b);
    expect(a.store.getProject(project.id)).toEqual(project);
    const preview = a.service.preview(profile(a), sent.id); expect(preview.canApply).toBe(true);
    expect(preview.changes).toHaveLength(2);
    const applied = await a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true });
    expect(applied.result!.status).toBe('applied');
    const updated = a.store.getProject(project.id);
    expect(updated.revision).toBe(project.revision + 1); expect(updated.memory.notes).toBe('SECRET_NOT_SHARED');
    expect(updated.nextAction).toBe('經本機確認的新下一步');
    await restart(a);
    await a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true });
    expect(a.store.getProject(project.id).revision).toBe(updated.revision);
    await sync(a, b);
    expect(b.service.messages(profile(b), 'sent')[0]!.result).toMatchObject({ status: 'applied', revision: updated.revision });
  });
  it('rejects stale revisions, withdrawn fields, bad hashes, and offline acceptance', async () => {
    const { a, b } = await paired(); const { project, sent } = await proposal(a, b);
    const preview = a.service.preview(profile(a), sent.id);
    await expect(a.service.accept(profile(a), sent.id, { hash: '0'.repeat(64), revision: preview.revision, confirm: true })).rejects.toThrow(/preview/i);
    await a.service.enable(profile(a), false);
    await expect(a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true })).rejects.toThrow(/Enable/);
    await a.service.enable(profile(a), true); await a.service.syncNow(profile(a));
    a.service.share(profile(a), project.id, { enabled: true, memoryFields: [] });
    expect(a.service.preview(profile(a), sent.id).canApply).toBe(false);
    a.service.share(profile(a), project.id, { enabled: true, memoryFields: ['status'] });
    a.store.updateProject(project.id, { revision: project.revision, nextAction: 'LOCAL_NEWER' });
    expect(a.service.preview(profile(a), sent.id).reason).toMatch(/version/);
    await expect(a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true })).rejects.toThrow(/version/);
    expect(a.store.getProject(project.id).nextAction).toBe('LOCAL_NEWER');
    a.service.decide(profile(a), sent.id, 'rejected'); await sync(a, b);
    expect(b.service.messages(profile(b), 'sent')[0]!.result!.status).toBe('rejected');
  });
  it('rolls back project mutation, decision and outbox together if a decision write fails', async () => {
    const { a, b } = await paired(); const { project, sent } = await proposal(a, b);
    const preview = a.service.preview(profile(a), sent.id);
    a.store.db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE OF result ON device_messages WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END;");
    await expect(a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true })).rejects.toThrow(/injected/);
    expect(a.store.getProject(project.id)).toEqual(project);
    expect(a.service.messages(profile(a), 'inbox')[0]!.result).toBeNull();
    expect(a.store.db.prepare("SELECT COUNT(*) AS n FROM device_outbox WHERE kind='decision'").get()!.n).toBe(0);
    a.store.db.exec('DROP TRIGGER injected_failure');
    await a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true });
    expect(a.store.getProject(project.id).revision).toBe(project.revision + 1);
  });
  it('recovers a consumed pairing invitation after a lost response and process restart', async () => {
    let lose = true;
    const value = peer({ ...fixture.relay, pair: async (...args) => {
      const result = await fixture.relay.pair(...args);
      if (lose) { lose = false; throw new RelayError('unavailable', 'lost', true); } return result;
    } });
    const initial = await fixture.bootstrap();
    await expect(value.service.pair({ ...fixture.configuration, name: 'Recover', code: initial.code, confirm: true })).rejects.toThrow(/Retry pairing/);
    expect(value.service.state().pairingPending).toBe(true);
    const deviceId = value.service.state().localDevice.id;
    await restart(value); await value.service.retryPair(profile(value)); await sync(value);
    expect(value.service.state().localDevice.id).toBe(deviceId);
    expect(value.service.state().devices).toHaveLength(1);
    expect(value.service.state().paired).toBe(true);
  });
  it('revalidates a source revoked by a third device even when the local cache is stale', async () => {
    const { a, b } = await paired(); const { project, sent } = await proposal(a, b);
    const c = peer(); const invitation = await a.service.invitation(profile(a));
    await c.service.pair({ ...fixture.configuration, name: 'Third', code: invitation.code, confirm: true }); await sync(c);
    const preview = a.service.preview(profile(a), sent.id); expect(preview.canApply).toBe(true);
    await a.service.withGovernance(profile(a), client => client.setRole(c.service.state().localDevice.id, 'admin'));
    await c.service.revoke(profile(c), b.service.state().localDevice.id);
    await expect(a.service.accept(profile(a), sent.id, { hash: preview.hash, revision: preview.revision, confirm: true })).rejects.toThrow();
    expect(a.store.getProject(project.id)).toEqual(project);
    expect(a.service.messages(profile(a), 'inbox')[0]!.result).toBeNull();
    expect(a.service.state().enabled).toBe(true);
    expect(a.service.state().connection).not.toBe('revoked');
    await sync(a);
  });
  it('withdraws summaries and cannot republish them from old queued publications after restart', async () => {
    const { a, b } = await paired(); const project = await shared(a, b);
    const old = a.service.repository.publications(a.service.repository.profile()!.id);
    expect(old).toEqual([]);
    a.store.updateProject(project.id, { revision: project.revision, nextAction: 'NOT_TO_PUBLISH' });
    a.service.repository.reconcilePublications(a.service.repository.profile()!.id);
    a.service.share(profile(a), project.id, { enabled: false, memoryFields: [] });
    await restart(a); await sync(a, b);
    expect(b.service.remoteProjects(profile(b), a.service.state().localDevice.id)).toEqual([]);
    const published = a.store.db.prepare('SELECT * FROM project_publications').get()!;
    expect(published.payload).toBeNull(); expect(published.sent_version).toBe(published.version);
  });
  it('isolates old queued data when connecting to another network', async () => {
    const { a, b } = await paired(); const project = await shared(a, b);
    a.service.compose(profile(a), { toDeviceId: b.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'message', text: 'OLD_NETWORK_ONLY' } });
    const detachedProfile = a.service.repository.profile()!.id;
    await a.service.disconnect(profile(a));
    expect(a.service.repository.profile(detachedProfile)!.credentials.byteLength).toBe(0);
    const next = await fixture.bootstrap();
    await a.service.pair({ ...fixture.configuration, code: next.code, name: 'New network', confirm: true }); await sync(a);
    expect(a.service.state().sharing).toEqual([]); expect(a.service.messages(profile(a), 'sent')).toEqual([]);
    expect(a.service.state().devices).toHaveLength(1); expect(a.store.getProject(project.id).name).toBe(project.name);
    await sync(b); expect(b.service.messages(profile(b), 'inbox')).toEqual([]);
  });
  it.each(['withdraw', 'deselect', 'delete'] as const)('rechecks each publication after an in-flight request when another project is changed: %s', async change => {
    const { a, b } = await paired();
    const projects = ['First', 'Second'].map((name, index) => {
      const value = a.store.createProject({ path: `/race-${index}`, name });
      const updated = a.store.saveMemory(value.id, value.revision, { ...EMPTY_MEMORY, notes: 'SELECTED_BEFORE_WITHDRAWAL' });
      a.service.share(profile(a), updated.id, { enabled: true, memoryFields: ['notes'] }); return updated;
    });
    const pending = a.service.repository.publications(a.service.repository.profile()!.id);
    const second = projects.find(project => project.id === pending[1]!.projectId)!;
    let begin!: () => void, release!: () => void;
    const firstStarted = new Promise<void>(resolve => { begin = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const uploaded: typeof pending = [];
    let first = true;
    a.relay = { ...fixture.relay, publish: async (...args) => {
      uploaded.push(args[1]); await fixture.relay.publish(...args);
      if (first) { first = false; begin(); await gate; }
    } };
    const running = a.service.syncNow(profile(a)); await firstStarted;
    if (change === 'delete') a.store.deleteProject(second.id, second.revision);
    else a.service.share(profile(a), second.id, { enabled: change !== 'withdraw', memoryFields: [] });
    release(); await running;
    const secondUploads = uploaded.filter(snapshot => snapshot.projectId === second.id);
    expect(secondUploads.length).toBeGreaterThan(0);
    expect(secondUploads.every(snapshot => snapshot.project?.memory.notes === undefined)).toBe(true);
    if (change !== 'deselect') expect(secondUploads.every(snapshot => snapshot.project === null)).toBe(true);
    await sync(b);
  });
  it('isolates oversized sharing, keeps withdrawal controls available and continues other messages', async () => {
    const { a, b } = await paired();
    const project = a.store.createProject({ path: '/oversized', name: 'Too large later' });
    const other = a.store.createProject({ path: '/unrelated', name: 'Unrelated remains usable' });
    const fields = ['overview', 'status', 'architecture', 'completed', 'pending'] as const;
    a.service.share(profile(a), project.id, { enabled: true, memoryFields: [...fields] }); await sync(a, b);
    a.store.saveMemory(project.id, project.revision, { ...EMPTY_MEMORY, ...Object.fromEntries(fields.map(field => [field, '漢'.repeat(20000)])) });
    const current = a.service.previewShare(profile(a), project.id);
    expect(current.policy.enabled).toBe(true); expect(current).toMatchObject({ project: null, error: expect.stringMatching(/256 KiB/) });
    expect(() => a.service.share(profile(a), other.id, { enabled: true, memoryFields: [] })).not.toThrow();
    b.service.compose(profile(b), { toDeviceId: a.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'message', text: 'INCOMING_STILL_WORKS' } });
    a.service.compose(profile(a), { toDeviceId: b.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'message', text: 'OUTGOING_STILL_WORKS' } });
    await sync(b); await a.service.syncNow(profile(a)); await sync(b);
    expect(a.service.state().connection).toBe('online'); expect(a.service.state().lastError).toMatch(/summaries/);
    expect(a.service.messages(profile(a), 'inbox').some(message => message.payload.text === 'INCOMING_STILL_WORKS')).toBe(true);
    expect(b.service.messages(profile(b), 'inbox').some(message => message.payload.text === 'OUTGOING_STILL_WORKS')).toBe(true);
    expect(b.service.remoteProjects(profile(b), a.service.state().localDevice.id).some(snapshot => snapshot.projectId === project.id)).toBe(false);
    expect(() => a.service.share(profile(a), project.id, { enabled: false, memoryFields: [] })).not.toThrow();
    await sync(a);
  });
  it('does not block messages when the relay rejects one publication permanently', async () => {
    const { a, b } = await paired();
    const project = a.store.createProject({ path: '/unsupported-relay-text', name: 'Local text remains local' });
    a.service.share(profile(a), project.id, { enabled: true, memoryFields: ['notes'] });
    a.store.saveMemory(project.id, project.revision, { ...EMPTY_MEMORY, notes: 'PostgreSQL cannot store this NUL: \u0000' });
    a.service.compose(profile(a), { toDeviceId: b.service.state().localDevice.id, payload: { schemaVersion: 1, kind: 'message', text: 'OTHER_WORK_CONTINUES' } });
    await a.service.syncNow(profile(a)); await sync(b);
    expect(a.service.state().connection).toBe('online'); expect(a.service.state().lastError).toMatch(/summaries/);
    expect(b.service.messages(profile(b), 'inbox')[0]!.payload.text).toBe('OTHER_WORK_CONTINUES');
    expect(() => a.service.share(profile(a), project.id, { enabled: false, memoryFields: [] })).not.toThrow();
  });
  it('fails closed on unavailable decryption while local projects remain usable', async () => {
    const { a } = await paired();
    a.store.createProject({ path: '/safe-local', name: 'Still here' });
    const requests = vi.fn(() => Promise.resolve([]));
    a.relay = { ...fixture.relay, listDevices: requests };
    await restart(a, testCredentialCodec());
    await a.service.syncNow(profile(a));
    expect(a.service.state().connection).toBe('locked'); expect(requests).not.toHaveBeenCalled();
    expect(a.store.listProjects()[0]!.name).toBe('Still here');
  });
});
