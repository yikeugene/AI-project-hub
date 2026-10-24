import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db.js';
import { DeviceService } from '../server/devices.js';
import { GovernanceService } from '../server/governance.js';
import { AppObservationService } from '../server/app-observation.js';
import type { AppObservationSource } from '../server/app-observation-source.js';
import type { AppObservation } from '../shared/app-observation.js';
import type { RelayClient } from '../server/relay.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';
import { testCredentialCodec } from './helpers/credentials.js';

interface Peer {
  store: Store; devices: DeviceService; observations: AppObservationService; source: AppObservationSource;
  transport: RelayClient; now: number; name: string | null; available: boolean; credentialsAvailable: boolean;
  probe: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<AppObservation>>>;
}
let fixture: SqlRelayFixture;
const peers: Peer[] = [];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const id = (peer: Peer) => peer.devices.state().profileId!;
beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => { await fixture.reset(); });
afterEach(async () => { for (const peer of peers.splice(0)) { await peer.observations.stop(); await peer.devices.stop(); peer.store.close(); } });
function peer(transport = fixture.relay): Peer {
  const value = { store: new Store(':memory:'), transport, now: Date.now(), name: 'PRIVATE_OBSERVATION_ONLY', available: true, credentialsAvailable: true } as Peer;
  value.probe = vi.fn(async () => ({ name: value.name, observedAt: new Date(value.now).toISOString() }));
  value.source = { available: () => value.available, sample: signal => value.probe(signal) };
  value.devices = new DeviceService(value.store, { mode: 'desktop', codec: { ...testCredentialCodec(), available: () => value.credentialsAvailable }, relayFactory: () => value.transport, clock: () => value.now });
  value.observations = new AppObservationService(value.store, value.devices, { source: value.source, autoRefresh: false });
  value.observations.setSessionAvailable(true);
  peers.push(value); return value;
}
async function pair() {
  const a = peer(), b = peer(); const bootstrap = await fixture.bootstrap();
  await a.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'Sender', confirm: true });
  const invitation = await a.devices.invitation(id(a));
  await b.devices.pair({ ...fixture.configuration, code: invitation.code, name: 'Receiver', confirm: true });
  await a.devices.syncNow(id(a)); await b.devices.syncNow(id(b)); await turn();
  return { a, b };
}
function consent(peer: Peer, enabled: boolean, profileId = id(peer)) {
  const preview = peer.observations.previewSharing(profileId, { enabled });
  return peer.observations.saveSharing(profileId, preview.policy, preview.digest);
}
async function received(receiver: Peer, deviceId: string) {
  return (await receiver.observations.refresh(id(receiver), true)).statuses.find(value => value.deviceId === deviceId);
}
function dumpLocal(store: Store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  return JSON.stringify(tables.map(row => store.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()));
}

describe('independent app observation consent and real SQL delivery', () => {
  it('does not collect on default state, legacy activity consent, or an unconfirmed preview', async () => {
    const { a } = await pair();
    expect(a.observations.state(id(a)).policy.enabled).toBe(false);
    const governance = new GovernanceService(a.store, a.devices);
    const old = governance.previewSharing(id(a), { activity: true, projects: [] });
    governance.saveSharing(id(a), old.policy, old.digest);
    const proposed = a.observations.previewSharing(id(a), { enabled: true });
    expect(proposed.fields).toEqual(['name', 'observedAt']); expect(JSON.stringify(proposed)).not.toContain(a.name);
    await a.observations.refresh(id(a));
    expect(a.probe).not.toHaveBeenCalled();
    expect(a.observations.state(id(a)).policy.enabled).toBe(false);
    expect(governance.sharing(id(a))).toEqual({ activity: true, projects: [] });
    await governance.stop();
  });
  it('publishes the application name and source time independently of HelpTool activity', async () => {
    const { a, b } = await pair(); const device = a.devices.state().localDevice.id;
    consent(a, true); await a.observations.refresh(id(a));
    const observed = await received(b, device);
    expect(observed!.observation).toEqual({ name: a.name, observedAt: new Date(a.now).toISOString() });
    expect(b.observations.state(id(b)).policy.enabled).toBe(false); expect(b.probe).not.toHaveBeenCalled();
    const legacy = new GovernanceService(a.store, a.devices);
    expect((await legacy.refresh(id(a))).statuses).toEqual([]);
    await legacy.stop();
    expect(dumpLocal(a.store)).not.toContain(a.name!); expect(dumpLocal(b.store)).not.toContain(a.name!);
    expect(a.store.db.prepare('SELECT * FROM app_observation_profiles').all()[0]).toMatchObject({ enabled: 1, revision: 2 });
  });
  it('receives peers without a local collector and rejects enabling unsupported sources', async () => {
    const { a, b } = await pair(); b.available = false;
    consent(a, true); await a.observations.refresh(id(a));
    expect((await received(b, a.devices.state().localDevice.id))!.observation!.name).toBe(a.name);
    expect(() => consent(b, true)).toThrow(); expect(b.probe).not.toHaveBeenCalled();
    expect(() => consent(b, false)).not.toThrow();
  });
  it('withdraws with a higher sequence and stores only non-sensitive metadata', async () => {
    const { a, b } = await pair(); consent(a, true); await a.observations.refresh(id(a));
    const first = await received(b, a.devices.state().localDevice.id);
    const calls = a.probe.mock.calls.length;
    consent(a, false); expect(a.observations.state(id(a)).local).toBeNull();
    await a.observations.refresh(id(a));
    const withdrawn = await received(b, a.devices.state().localDevice.id);
    expect(withdrawn!.sequence).toBeGreaterThan(first!.sequence); expect(withdrawn!.observation).toBeNull();
    expect(a.probe).toHaveBeenCalledTimes(calls); expect(dumpLocal(a.store)).not.toContain(a.name!);
  });
  it('ignores a late probe after opt-out and never publishes that observation', async () => {
    const { a, b } = await pair(); consent(a, true); await a.observations.refresh(id(a)); a.now += 16000;
    let release!: (value: AppObservation) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<AppObservation>(resolve => { release = resolve; });
    let signal!: AbortSignal;
    a.probe.mockImplementation(current => { signal = current; started(); return gate; });
    const running = a.observations.refresh(id(a)); await began;
    consent(a, false); expect(signal.aborted).toBe(true);
    release({ name: 'LATE_PRIVATE_NAME', observedAt: new Date(a.now).toISOString() }); await running;
    await a.observations.refresh(id(a));
    expect((await received(b, a.devices.state().localDevice.id))!.observation).toBeNull();
    expect(dumpLocal(a.store)).not.toContain('LATE_PRIVATE_NAME');
  });
  it('clears unknown results instead of retaining the previous application name', async () => {
    const { a, b } = await pair(); consent(a, true); await a.observations.refresh(id(a));
    a.now += 16000; a.name = null; await a.observations.refresh(id(a));
    expect((await received(b, a.devices.state().localDevice.id))!.observation).toEqual({ name: null, observedAt: new Date(a.now).toISOString() });
  });
  it('blocks collection while locked and collects anew after unlock without replaying old names', async () => {
    const { a, b } = await pair(); consent(a, true); await a.observations.refresh(id(a));
    a.observations.setSessionAvailable(false); await a.observations.refresh(id(a));
    expect(a.probe).toHaveBeenCalledTimes(1);
    expect((await received(b, a.devices.state().localDevice.id))!.observation!.name).toBeNull();
    a.now += 1000; a.name = 'NEW_APP_AFTER_UNLOCK'; a.observations.setSessionAvailable(true);
    await a.observations.refresh(id(a));
    expect(a.probe).toHaveBeenCalledTimes(2); expect((await received(b, a.devices.state().localDevice.id))!.observation!.name).toBe(a.name);
  });
  it('queues withdrawal while paused and sends it before a later observation', async () => {
    const { a, b } = await pair(); consent(a, true); await a.observations.refresh(id(a));
    await a.devices.enable(id(a), false); await turn();
    const calls = a.probe.mock.calls.length;
    consent(a, false); await a.observations.refresh(id(a)); expect(a.probe).toHaveBeenCalledTimes(calls);
    expect(a.observations.state(id(a)).pendingWithdrawal).toBe(true);
    await a.devices.enable(id(a), true); await turn();
    await a.observations.refresh(id(a));
    expect((await received(b, a.devices.state().localDevice.id))!.observation).toBeNull();
  });
  it('keeps group consent independent of management selection and never reuses pre-consent samples', async () => {
    const { a, b } = await pair(); const firstProfile = id(a), firstDevice = a.devices.state().localDevice.id;
    consent(a, true, firstProfile); await a.observations.refresh(firstProfile);
    const c = peer(), bootstrap = await fixture.bootstrap();
    await c.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'Other group', confirm: true });
    const invitation = await c.devices.invitation(id(c));
    await a.devices.pair({ ...fixture.configuration, code: invitation.code, name: 'Sender', confirm: true });
    const secondProfile = id(a), secondDevice = a.devices.state().localDevice.id;
    await c.devices.syncNow(id(c)); await a.devices.syncNow(secondProfile); await turn();
    await a.observations.refresh(secondProfile);
    expect((await c.observations.refresh(id(c))).statuses.some(value => value.deviceId === secondDevice)).toBe(false);
    await a.observations.refresh(firstProfile);
    expect((await received(b, firstDevice))!.observation!.name).toBe('PRIVATE_OBSERVATION_ONLY');
    const calls = a.probe.mock.calls.length;
    a.now += 1; a.name = 'APP_AFTER_SECOND_CONSENT'; consent(a, true, secondProfile);
    await a.observations.refresh(secondProfile);
    expect(a.probe).toHaveBeenCalledTimes(calls + 1);
    expect((await received(c, secondDevice))!.observation!.name).toBe(a.name);
    expect(a.observations.state(firstProfile).policy.enabled).toBe(true);
  });
  it('coalesces consecutive supported profiles and refreshes only after the capture interval', async () => {
    const { a } = await pair(); const first = id(a), bootstrap = await fixture.bootstrap();
    await a.devices.pair({ ...fixture.configuration, code: bootstrap.code, name: 'Same computer other group', confirm: true });
    const second = id(a); await a.devices.syncNow(second); await turn();
    consent(a, true, first); consent(a, true, second);
    await a.observations.refresh(first); await a.observations.refresh(second);
    expect(a.probe).toHaveBeenCalledTimes(1);
    a.now += 15001; await a.observations.refresh(first); expect(a.probe).toHaveBeenCalledTimes(2);
  });
  it('keeps old relay support failures isolated from governance and performs zero sampling', async () => {
    const old = await createSqlRelayFixture({ includeAppObservation: false });
    try {
      const a = peer(old.relay), bootstrap = await old.bootstrap();
      await a.devices.pair({ ...old.configuration, code: bootstrap.code, name: 'Old relay', confirm: true });
      await a.devices.syncNow(id(a)); await turn();
      consent(a, true); const state = await a.observations.refresh(id(a));
      expect(state.capability).toBe('unsupported'); expect(state.problem).toBe('upgrade-required'); expect(a.probe).not.toHaveBeenCalled();
      expect(a.devices.state().enabled).toBe(true); expect(a.devices.state().connection).toBe('online');
      const governance = new GovernanceService(a.store, a.devices); await governance.refresh(id(a));
      expect(governance.state(id(a)).available).toBe(true); await governance.stop();
    } finally { await old.close(); }
  });
  it('fences previews to group and consent revision, and forgets detached consent', async () => {
    const { a } = await pair();
    const profileId = id(a), before = a.observations.previewSharing(profileId, { enabled: true });
    consent(a, false);
    expect(() => a.observations.saveSharing(profileId, before.policy, before.digest)).toThrow();
    consent(a, true); await a.observations.refresh(profileId);
    await a.devices.disconnect(profileId); await turn();
    expect(a.store.db.prepare('SELECT * FROM app_observation_profiles WHERE profile_id=?').get(profileId)).toBeUndefined();
    expect(a.observations.state(profileId).local).toBeNull(); expect(a.observations.state(profileId).statuses).toEqual([]);
  });
  it('does not replay a positive observation after coordinator restart', async () => {
    const { a } = await pair(); consent(a, true); await a.observations.refresh(id(a));
    await a.observations.stop();
    a.observations = new AppObservationService(a.store, a.devices, { source: a.source, autoRefresh: false });
    expect(a.observations.state(id(a)).local).toBeNull(); expect(a.observations.state(id(a)).statuses).toEqual([]);
    expect(a.observations.state(id(a)).policy.enabled).toBe(true);
    a.now += 1000; a.name = 'NEW_APP_AFTER_RESTART'; a.observations.setSessionAvailable(true);
    await a.observations.refresh(id(a)); expect(a.observations.state(id(a)).local!.name).toBe(a.name);
    expect(dumpLocal(a.store)).not.toContain(a.name!);
  });
  it('invalidates credential-readiness loss and never replays a disallowed late sample after recovery', async () => {
    const { a, b } = await pair(); consent(a, true);
    let release!: (value: AppObservation) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<AppObservation>(resolve => { release = resolve; }); let signal!: AbortSignal;
    a.probe.mockImplementationOnce(current => { signal = current; started(); return gate; });
    const running = a.observations.refresh(id(a)); await began;
    try {
      a.credentialsAvailable = false;
      await a.observations.refresh(id(a));
      expect(signal.aborted).toBe(true);
    } finally { release({ name: 'DISALLOWED_DURING_VAULT_LOSS', observedAt: new Date(a.now).toISOString() }); }
    await running;
    a.credentialsAvailable = true; a.name = 'FRESH_AFTER_VAULT_RECOVERY';
    await a.observations.refresh(id(a));
    expect(a.probe).toHaveBeenCalledTimes(2);
    expect((await received(b, a.devices.state().localDevice.id))!.observation!.name).toBe(a.name);
  });
  it('waits out an invalidated refresh when explicitly refreshing after consent changes', async () => {
    const { a } = await pair();
    let release!: () => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    a.transport = { ...fixture.relay, appObservation: { ...fixture.relay.appObservation!, capability: async (...args) => {
      const result = await fixture.relay.appObservation!.capability(...args);
      if (first) { first = false; started(); await gate; }
      return result;
    } } };
    const old = a.observations.refresh(id(a)); await began;
    consent(a, true); const fresh = a.observations.refresh(id(a), true); release();
    await old; const state = await fresh;
    expect(a.probe).toHaveBeenCalledOnce(); expect(state.local!.name).toBe(a.name);
  });
  it('drains an aborted capture and does not write after shutdown', async () => {
    const { a } = await pair(); consent(a, true);
    let release!: (value: AppObservation) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<AppObservation>(resolve => { release = resolve; }); let signal!: AbortSignal;
    a.probe.mockImplementation(current => { signal = current; started(); return gate; });
    const running = a.observations.refresh(id(a)); await began;
    let stopped = false; const stopping = a.observations.stop().then(() => { stopped = true; });
    expect(signal.aborted).toBe(true); await turn(); expect(stopped).toBe(false);
    release({ name: 'LATE_AFTER_SHUTDOWN', observedAt: new Date(a.now).toISOString() });
    await Promise.all([running, stopping]); expect(stopped).toBe(true);
    expect(dumpLocal(a.store)).not.toContain('LATE_AFTER_SHUTDOWN');
  });
});
