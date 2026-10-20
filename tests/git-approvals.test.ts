import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { DeviceService } from '../server/devices.js';
import { GovernanceService } from '../server/governance.js';
import { GitApprovalService, type GitEngine } from '../server/git-approvals.js';
import type { PreparedGitOperation } from '../server/git-operations.js';
import { RelayError, type RelayClient } from '../server/relay.js';
import type { GitDetails, GitPreview, GitReviewSummary } from '../shared/git.js';
import { testCredentialCodec } from './helpers/credentials.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';

let relay: SqlRelayFixture;
interface Peer {
  store: Store; devices: DeviceService; governance: GovernanceService; git: GitApprovalService;
  version: string; launches: number; interrupted: boolean; offline: boolean;
  transport: RelayClient; beforePrepare?: () => Promise<void>; beforeAuthorize?: () => Promise<void>;
}
const peers: Peer[] = [];
const profile = (peer: Peer) => peer.devices.state().profileId!;
beforeAll(async () => { relay = await createSqlRelayFixture(); }, 60000);
afterAll(async () => { await relay?.close(); });
beforeEach(async () => { await relay.reset(); });
afterEach(async () => { for (const peer of peers.splice(0)) { await peer.git.stop(); await peer.governance.stop(); await peer.devices.stop(); peer.store.close(); } });
const oid = '1'.repeat(40);
function details(peer: Peer): GitDetails {
  return { snapshot: { isRepo: true, branch: 'main', head: oid, branches: ['main'], commits: [], changes: [{ path: 'readme.txt', index: ' ', worktree: 'M' }],
    changedCount: 1, stagedCount: 0, untrackedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() },
  remotes: [], upstream: null, ahead: null, behind: null, operationState: null, unsupportedReasons: [], identity: { name: 'Test', email: 'test@example.invalid' } };
}
function peer(): Peer {
  const p = { store: new Store(':memory:'), version: 'before', launches: 0, interrupted: false, offline: false, transport: relay.relay } as Peer;
  const factory = (): RelayClient => p.offline ? { ...p.transport, governance: { ...p.transport.governance!, policy: async () => { throw new RelayError('unavailable', 'offline', true); } } } : p.transport;
  p.devices = new DeviceService(p.store, { mode: 'desktop', codec: testCredentialCodec(), relayFactory: factory });
  p.governance = new GovernanceService(p.store, p.devices);
  const engine: GitEngine = {
    recover: async () => {},
    details: async () => details(p), diff: async (_path, input) => ({ ...input, text: 'local-only-source', binary: false, truncated: false }),
    prepare: async (_path, operation, context) => {
      await p.beforePrepare?.();
      const summary: GitReviewSummary = { projectName: context.projectName, kind: operation.kind, paths: 'paths' in operation ? operation.paths : [], branch: 'main', head: oid,
        target: null, remoteUrl: null, targetRef: null, changedCount: 1, stagedCount: 0, message: null, authorName: null, authorEmail: null };
      return { operation, summary, directory: _path, fingerprint: p.version, repositoryKey: 'isolated-common-directory' } as PreparedGitOperation;
    },
    execute: async (plan, options) => {
      await p.beforeAuthorize?.();
      if (plan.fingerprint !== p.version) throw Object.assign(new Error('changed'), { code: 'stale' });
      await options.authorize();
      if (p.interrupted) throw Object.assign(new Error('interrupted'), { code: 'unknown' });
      options.onStarting(); p.launches++; p.version = 'after';
      return { status: 'succeeded', code: 'completed', head: oid };
    },
  };
  p.git = new GitApprovalService(p.store, p.devices, p.governance, engine);
  p.governance.onRefresh((client, context) => p.git.sync(client, context));
  p.devices.onSynced(async profileId => { await p.governance.refresh(profileId); });
  peers.push(p); return p;
}
async function pair() {
  const admin = peer(), origin = peer(), invite = await relay.bootstrap();
  await admin.devices.pair({ ...relay.configuration, code: invite.code, name: 'Administrator', confirm: true });
  const memberInvite = await admin.devices.invitation(profile(admin));
  await origin.devices.pair({ ...relay.configuration, code: memberInvite.code, name: 'Origin', confirm: true });
  await admin.devices.syncNow(profile(admin)); await origin.devices.syncNow(profile(origin));
  expect(admin.governance.state().policy?.role).toBe('admin');
  expect(origin.governance.state().available).toBe(true);
  return { admin, origin };
}
async function request(origin: Peer, admin: Peer) {
  const project = origin.store.createProject({ path: '/private/project', name: 'Explicit review' });
  const preview = await origin.git.preview(profile(origin), project.id, { kind: 'stage', paths: ['readme.txt'] });
  await origin.git.submit(profile(origin), preview.id, admin.devices.state().localDevice.id, preview.digest);
  await admin.governance.refresh(profile(admin));
  return { project, preview };
}
async function approve(admin: Peer, origin: Peer, preview: GitPreview) {
  await admin.git.decide(profile(admin), preview.id, preview.digest, 'approved', 'Checked operation');
  await origin.governance.refresh(profile(origin));
  expect(origin.git.repository.get(preview.id).state).toBe('approved');
}

describe('origin-local execution after actual SQL administrator approval', () => {
  it('never executes during submit, delivery or approval; executes once only after the origin confirms', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    expect(admin.git.approvals(profile(admin))).toHaveLength(1); expect(origin.launches).toBe(0);
    const beforePolling = origin.git.audit(profile(origin), preview.id);
    await origin.governance.refresh(profile(origin)); await origin.governance.refresh(profile(origin));
    expect(origin.git.audit(profile(origin), preview.id)).toEqual(beforePolling);
    await expect(origin.git.decide(profile(origin), preview.id, preview.digest, 'approved', '')).rejects.toThrow();
    await approve(admin, origin, preview); expect(origin.launches).toBe(0);
    const [first, duplicate] = await Promise.all([origin.git.execute(profile(origin), preview.id, preview.digest), origin.git.execute(profile(origin), preview.id, preview.digest)]);
    expect(first.state).toBe('succeeded'); expect(duplicate.state).toBe('succeeded'); expect(origin.launches).toBe(1);
    expect(() => origin.git.execute(profile(origin), preview.id, preview.digest)).toThrow();
    expect(origin.git.audit(profile(origin), preview.id).map(event => event.state)).toContain('executing');
    expect(origin.git.list(profile(origin), project.id)[0].result?.status).toBe('succeeded');
    const remote = await origin.devices.withGovernance(profile(origin), client => client.getGit(preview.id));
    expect(remote.state).toBe('consumed'); expect(remote.result?.status).toBe('succeeded');
  });
  it('allows an administrator to self-approve without skipping the local execute step', async () => {
    const { admin } = await pair(); const { preview } = await request(admin, admin);
    await approve(admin, admin, preview); expect(admin.launches).toBe(0);
    expect((await admin.git.execute(profile(admin), preview.id, preview.digest)).state).toBe('succeeded'); expect(admin.launches).toBe(1);
  });
  it('rejects local drift before consuming the approval or invoking the mutation', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.version = 'external-change';
    expect((await origin.git.execute(profile(origin), preview.id, preview.digest)).state).toBe('stale'); expect(origin.launches).toBe(0);
    expect((await origin.devices.withGovernance(profile(origin), client => client.getGit(preview.id))).state).toBe('approved');
  });
  it('rechecks role epoch online rather than trusting a cached approved flag', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview);
    await admin.devices.withGovernance(profile(admin), client => client.setRole(origin.devices.state().localDevice.id, 'admin'));
    expect((await origin.git.execute(profile(origin), preview.id, preview.digest)).state).toBe('failed'); expect(origin.launches).toBe(0);
  });
  it('cannot use an already-consumed approval to launch again even if the local state was tampered with', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview); await origin.git.execute(profile(origin), preview.id, preview.digest);
    origin.version = 'before'; origin.git.repository.transition(preview.id, 'approved');
    const result = await origin.git.execute(profile(origin), preview.id, preview.digest);
    expect(result.state).toBe('failed'); expect(origin.launches).toBe(1);
  });
  it('fences uncertain outcomes and never replays on refresh; acknowledgement does not execute', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.interrupted = true;
    expect((await origin.git.execute(profile(origin), preview.id, preview.digest)).state).toBe('unknown');
    await origin.governance.refresh(profile(origin)); await origin.governance.refresh(profile(origin)); expect(origin.launches).toBe(0);
    await expect(origin.git.preview(profile(origin), project.id, { kind: 'stage', paths: ['readme.txt'] })).rejects.toThrow();
    expect((await origin.git.acknowledge(profile(origin), preview.id)).state).toBe('unknown'); expect(origin.launches).toBe(0);
    expect((await origin.git.preview(profile(origin), project.id, { kind: 'stage', paths: ['readme.txt'] })).id).not.toBe(preview.id);
  });
  it('keeps offline requests durably queued and sends them later without executing', async () => {
    const { admin, origin } = await pair(); origin.offline = true;
    const { preview } = await request(origin, admin);
    expect(origin.git.repository.get(preview.id).state).toBe('pending'); expect(origin.launches).toBe(0);
    expect(origin.git.repository.pending(origin.devices.repository.profile()!.id)[0]).not.toHaveProperty('plan');
    expect(origin.git.repository.rows(origin.devices.repository.profile()!.id, preview.projectId)[0]).not.toHaveProperty('plan');
    origin.offline = false; await origin.governance.refresh(profile(origin)); await admin.governance.refresh(profile(admin));
    expect(admin.git.approvals(profile(admin)).some(item => item.id === preview.id)).toBe(true); expect(origin.launches).toBe(0);
  });
  it('turns an interrupted durable execution journal into unknown without launching', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview);
    origin.git.repository.transition(preview.id, 'consuming'); origin.git.repository.recover();
    expect(origin.git.repository.get(preview.id).state).toBe('unknown'); expect(origin.launches).toBe(0);
  });
  it('does not starve queued work or pending reviews behind more than 100 newer history entries', async () => {
    const { admin, origin } = await pair(); origin.offline = true;
    const { project, preview } = await request(origin, admin);
    for (let i = 0; i < 105; i++) {
      const newer = await origin.git.preview(profile(origin), project.id, { kind: 'stage', paths: ['readme.txt'] });
      origin.git.repository.transition(newer.id, 'failed');
    }
    origin.offline = false; await origin.governance.refresh(profile(origin)); await admin.governance.refresh(profile(admin));
    const pending = admin.git.approvals(profile(admin)).find(item => item.id === preview.id)!; expect(pending).toBeDefined();
    for (let i = 0; i < 105; i++) admin.git.repository.applyApproval(admin.devices.repository.profile()!.id,
      { ...pending, id: randomUUID(), state: 'rejected', reason: 'History', decidedAt: new Date().toISOString() });
    expect(admin.git.approvals(profile(admin)).some(item => item.id === preview.id)).toBe(true);
  });
  it('keeps old-connection uncertainty recoverable locally after re-pairing, without reviving its approval', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.interrupted = true;
    await origin.git.execute(profile(origin), preview.id, preview.digest); await origin.devices.disconnect(profile(origin));
    const invitation = await admin.devices.invitation(profile(admin));
    await origin.devices.pair({ ...relay.configuration, name: 'New identity', code: invitation.code, confirm: true });
    await origin.devices.syncNow(profile(origin));
    expect(origin.git.list(profile(origin), project.id).some(item => item.preview.id === preview.id && item.state === 'unknown')).toBe(true);
    origin.store.deleteProject(project.id, project.revision);
    const readded = origin.store.createProject({ path: project.path, name: 'Same repository, new Hub record' });
    expect(origin.git.list(profile(origin), readded.id).some(item => item.preview.id === preview.id && item.state === 'unknown')).toBe(true);
    await expect(origin.git.preview(profile(origin), readded.id, { kind: 'stage', paths: ['readme.txt'] })).rejects.toThrow();
    await origin.git.acknowledge(profile(origin), preview.id);
    expect(() => origin.git.execute(profile(origin), preview.id, preview.digest)).toThrow();
    expect((await origin.git.preview(profile(origin), readded.id, { kind: 'stage', paths: ['readme.txt'] })).id).not.toBe(preview.id);
    expect(origin.launches).toBe(0);
  });
  it('rejects a changed digest and requires a new preview after a connection is detached', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview);
    expect(() => origin.git.execute(profile(origin), preview.id, '0'.repeat(64))).toThrow();
    const oldProfile = profile(origin); await origin.devices.disconnect(oldProfile); expect(() => origin.git.execute(oldProfile, preview.id, preview.digest)).toThrow(); expect(origin.launches).toBe(0);
  });
});

async function joinAnotherGroup(member: Peer) {
  const admin = peer(), invitation = await relay.bootstrap('Other group');
  await admin.devices.pair({ ...relay.configuration, code: invitation.code, name: 'Other administrator', confirm: true });
  const code = await admin.devices.invitation(profile(admin));
  const joined = await member.devices.pair({ ...relay.configuration, code: code.code, name: 'Member in other group', confirm: true });
  await admin.devices.syncNow(profile(admin)); await member.devices.syncNow(joined.profileId!);
  return { admin, memberProfile: joined.profileId!, adminProfile: profile(admin) };
}
function deferredGate() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { started, release, wait: () => { entered(); return pending; } };
}

describe('explicit multi-group governance and Git boundaries', () => {
  it('cannot borrow administrator authority or sharing confirmation from another membership', async () => {
    const { admin: local, origin } = await pair(), a = profile(local), aDevice = local.devices.state(a).localDevice.id;
    const { memberProfile: b } = await joinAnotherGroup(local);
    local.devices.selectGroup(a);
    expect(local.governance.state(a).policy?.role).toBe('admin');
    expect(local.governance.state(b).policy?.role).toBe('member');
    await expect(local.governance.setRole(b, local.devices.state(b).localDevice.id, 'admin')).rejects.toMatchObject({ code: 'relay.denied' });
    local.devices.selectGroup(b);
    await local.governance.setRole(a, origin.devices.state().localDevice.id, 'admin');
    expect(local.governance.state(b).policy?.role).toBe('member');
    const policy = { activity: true, projects: [] };
    const preview = local.governance.previewSharing(a, policy);
    expect(() => local.governance.saveSharing(b, policy, preview.digest)).toThrow();
    expect(local.governance.state(b).sharing.activity).toBe(false);
    local.governance.saveSharing(a, policy, preview.digest);
    expect(local.governance.state(a).sharing.activity).toBe(true);
    expect(local.governance.state(null).policy).toBeNull();
    const project = local.store.createProject({ path: '/scoped/repo', name: 'A only' });
    const git = await local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    const other = await local.git.preview(b, project.id, { kind: 'stage', paths: ['readme.txt'] });
    await expect(local.git.submit(b, other.id, aDevice, other.digest)).rejects.toMatchObject({ code: 'governance.admin' });
    expect(local.git.repository.get(other.id).state).toBe('prepared');
    await local.git.cancel(b, other.id, other.digest);
    await expect(local.git.submit(b, git.id, aDevice, git.digest)).rejects.toMatchObject({ code: 'gitops.notFound' });
    await expect(local.git.cancel(b, git.id, git.digest)).rejects.toMatchObject({ code: 'gitops.notFound' });
    expect(() => local.git.execute(b, git.id, git.digest)).toThrow();
    expect(() => local.git.audit(b, git.id)).toThrow();
    expect(() => local.git.audit(null, git.id)).toThrow();
    expect(local.git.list(b, project.id).map(row => row.preview.id)).toEqual([other.id]); expect(local.git.list(null, project.id)).toEqual([]);
    await local.git.submit(a, git.id, aDevice, git.digest);
    expect(local.git.approvals(a).map(item => item.id)).toContain(git.id);
    expect(local.git.approvals(b)).toEqual([]); expect(local.git.approvals(null)).toEqual([]);
    await expect(local.git.decide(b, git.id, git.digest, 'approved', '')).rejects.toMatchObject({ code: 'relay.denied' });
    expect(local.git.repository.get(git.id).state).toBe('pending');
    expect(local.launches).toBe(0);
  });

  it('runs refreshes independently and stores each response/error under its captured profile after selection changes', async () => {
    const { admin: local } = await pair(), a = profile(local);
    const { memberProfile: b } = await joinAnotherGroup(local);
    const networkA = local.devices.state(a).networkId, networkB = local.devices.state(b).networkId;
    const gate = deferredGate();
    local.transport = { ...relay.relay, governance: { ...relay.relay.governance!, policy: async (token, signal) => {
      const result = await relay.relay.governance!.policy(token, signal);
      if (result.networkId === networkA) await gate.wait();
      return result;
    } } };
    local.devices.selectGroup(a);
    const pending = local.governance.refresh(a); await gate.started;
    try {
      local.devices.selectGroup(b);
      expect((await local.governance.refresh(b)).policy?.networkId).toBe(networkB);
    } finally { gate.release(); }
    expect((await pending).policy?.networkId).toBe(networkA);
    expect(local.governance.state(a).policy?.networkId).toBe(networkA);
    expect(local.governance.state(b).policy?.networkId).toBe(networkB);
    local.transport = { ...relay.relay, governance: { ...relay.relay.governance!, policy: async (token, signal) => {
      const result = await relay.relay.governance!.policy(token, signal);
      if (result.networkId === networkA) throw new RelayError('unavailable', 'offline group A', true);
      return result;
    } } };
    expect((await local.governance.refresh(a)).error).not.toBeNull();
    expect(local.governance.state(b).error).toBeNull();
  });

  it('keeps an in-flight preview and explicit execution in A when the management selection becomes B', async () => {
    const { admin: local } = await pair(), a = profile(local), aDevice = local.devices.state(a).localDevice.id;
    const { memberProfile: b } = await joinAnotherGroup(local);
    const project = local.store.createProject({ path: '/scoped/repo', name: 'Captured A' });
    const prepare = deferredGate(); local.beforePrepare = prepare.wait;
    local.devices.selectGroup(a);
    const pending = local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] }); await prepare.started;
    local.devices.selectGroup(b); prepare.release();
    const preview = await pending;
    expect(local.git.repository.get(preview.id).profileId).toBe(a);
    await local.git.submit(a, preview.id, aDevice, preview.digest);
    await local.git.decide(a, preview.id, preview.digest, 'approved', 'Only A'); await local.governance.refresh(a);
    const execute = deferredGate(); local.beforeAuthorize = execute.wait;
    local.devices.selectGroup(a);
    const running = local.git.execute(a, preview.id, preview.digest); await execute.started;
    local.devices.selectGroup(b); execute.release();
    expect((await running).state).toBe('succeeded'); expect(local.launches).toBe(1);
    expect(local.devices.state().profileId).toBe(b);
    expect(local.git.approvals(b)).toEqual([]);
    expect((await local.devices.withGovernance(a, client => client.getGit(preview.id))).state).toBe('consumed');
  });

  it('invalidates a pending local preview on a captured membership lifecycle change, not selection', async () => {
    const { admin: local } = await pair(), a = profile(local);
    await joinAnotherGroup(local);
    const project = local.store.createProject({ path: '/scoped/repo', name: 'Lifecycle' });
    const gate = deferredGate(); local.beforePrepare = gate.wait;
    const pending = local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] }); await gate.started;
    await local.devices.enable(a, false); await local.devices.enable(a, true); gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'proposal.connectionChanged' });
    expect(local.git.repository.rows(a, project.id)).toEqual([]);
  });

  it('does not consume or launch after the captured execution membership is paused', async () => {
    const { admin: local } = await pair(), a = profile(local), aDevice = local.devices.state(a).localDevice.id;
    const { memberProfile: b } = await joinAnotherGroup(local);
    const project = local.store.createProject({ path: '/scoped/repo', name: 'Paused execution' });
    const preview = await local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    await local.git.submit(a, preview.id, aDevice, preview.digest);
    await local.git.decide(a, preview.id, preview.digest, 'approved', 'A'); await local.governance.refresh(a);
    const gate = deferredGate(); local.beforeAuthorize = gate.wait;
    const running = local.git.execute(a, preview.id, preview.digest); await gate.started;
    await local.devices.enable(a, false); gate.release();
    expect((await running).state).toBe('failed'); expect(local.launches).toBe(0);
    expect(local.git.repository.get(preview.id).approval?.state).toBe('approved');
    expect(local.devices.state(b).enabled).toBe(true);
    expect((await local.governance.refresh(b)).available).toBe(true);
  });

  it.each(['detached', 'revoked', 'cachedRevocation'] as const)('hides normal cached data and rejects new mutations for a %s membership', async condition => {
    const { admin: local } = await pair(), a = profile(local), aDevice = local.devices.state(a).localDevice.id;
    const { memberProfile: b } = await joinAnotherGroup(local);
    const project = local.store.createProject({ path: '/scoped/repo', name: 'Closed group' });
    const preview = await local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] });
    await local.git.submit(a, preview.id, aDevice, preview.digest);
    if (condition === 'detached') await local.devices.disconnect(a);
    else if (condition === 'revoked') local.devices.repository.setConnection(a, 'revoked');
    else local.devices.repository.cacheDevices(a, [{ ...local.devices.repository.activeDevice(a, aDevice)!, revokedAt: local.devices.repository.now() }]);
    expect(local.governance.state(a)).toMatchObject({ available: false, policy: null, statuses: [], sharing: { activity: false, projects: [] } });
    expect(local.governance.cachedPolicy(a)).toBeNull(); expect(local.git.approvals(a)).toEqual([]);
    expect(local.git.list(a, project.id)).toEqual([]);
    await expect(local.governance.refresh(a)).rejects.toThrow();
    await expect(local.git.preview(a, project.id, { kind: 'stage', paths: ['readme.txt'] })).rejects.toThrow();
    await expect(local.git.cancel(a, preview.id, preview.digest)).rejects.toThrow();
    expect(local.governance.state(b).policy?.role).toBe('member');
  });

  it('keeps repository uncertainty installation-wide across A/B and preserves old-group local recovery', async () => {
    const { admin: local } = await pair(), a = profile(local), aDevice = local.devices.state(a).localDevice.id;
    const { admin: bAdmin, memberProfile: b, adminProfile: bAdminProfile } = await joinAnotherGroup(local);
    const project = local.store.createProject({ path: '/scoped/repo', name: 'One physical repository' });
    const make = (profileId: string) => local.git.preview(profileId, project.id, { kind: 'stage', paths: ['readme.txt'] });
    const first = await make(a), second = await make(b);
    await local.git.submit(a, first.id, aDevice, first.digest);
    await local.git.decide(a, first.id, first.digest, 'approved', 'A'); await local.governance.refresh(a);
    await local.git.submit(b, second.id, bAdmin.devices.state(bAdminProfile).localDevice.id, second.digest);
    await bAdmin.governance.refresh(bAdminProfile);
    await bAdmin.git.decide(bAdminProfile, second.id, second.digest, 'approved', 'B'); await local.governance.refresh(b);
    local.interrupted = true;
    expect((await local.git.execute(a, first.id, first.digest)).state).toBe('unknown');
    expect(() => local.git.execute(b, second.id, second.digest)).toThrow();
    await expect(make(b)).rejects.toMatchObject({ code: 'gitops.unknown' });
    expect(local.git.repository.get(second.id).state).toBe('approved');
    await local.devices.disconnect(a);
    expect(local.git.list(b, project.id).some(row => row.preview.id === first.id && row.state === 'unknown')).toBe(true);
    expect(local.git.list(null, project.id).map(row => row.preview.id)).toEqual([first.id]);
    expect(local.git.audit(null, first.id).map(row => row.state)).toContain('unknown');
    expect((await local.git.acknowledge(null, first.id)).fenceAcknowledged).toBe(true);
    expect(local.launches).toBe(0); expect(() => local.git.execute(a, first.id, first.digest)).toThrow();
    local.interrupted = false;
    expect((await local.git.execute(b, second.id, second.digest)).state).toBe('succeeded');
    expect(local.launches).toBe(1);
  });
});

describe('optional device activity and project status projection', () => {
  it('shares nothing by default, previews only opted-in fields and withdraws unshared projects', async () => {
    const { admin, origin } = await pair(); const project = origin.store.createProject({ path: '/PRIVATE_ROOT', name: 'Shared progress' });
    origin.store.saveObservation(project.id, details(origin).snapshot, null);
    origin.store.createTask(project.id, { title: 'PRIVATE_TASK_TITLE', detail: 'PRIVATE_CONTENT', status: 'doing' });
    await origin.governance.refresh(profile(origin)); await admin.governance.refresh(profile(admin)); expect(admin.governance.state().statuses).toEqual([]);
    expect(() => origin.governance.previewSharing(profile(origin), { activity: true, projects: [{ projectId: project.id, git: true, tasks: true }] })).toThrow();
    origin.devices.share(profile(origin), project.id, { enabled: true, memoryFields: [] }); await origin.devices.syncNow(profile(origin)); await admin.devices.syncNow(profile(admin));
    origin.governance.setActivityMode('background'); origin.governance.record('git', 'pending');
    const preview = origin.governance.previewSharing(profile(origin), { activity: true, projects: [{ projectId: project.id, git: true, tasks: true }] });
    expect(preview.publication.activity?.mode).toBe('background'); expect(preview.publication.projects[0].tasks?.doing).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(/PRIVATE_ROOT|PRIVATE_TASK_TITLE|PRIVATE_CONTENT|local-only-source/);
    expect(origin.governance.state().sharing.activity).toBe(false);
    origin.governance.saveSharing(profile(origin), preview.policy, preview.digest); await origin.governance.refresh(profile(origin)); await admin.governance.refresh(profile(admin));
    const status = admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)!;
    expect(status.projects[0].git?.branch).toBe('main'); expect(status.activity?.mode).toBe('background');
    admin.offline = true; // V1 remains reachable, but the optional v2 status refresh fails.
    origin.devices.share(profile(origin), project.id, { enabled: false, memoryFields: [] }); await origin.devices.syncNow(profile(origin)); await admin.devices.syncNow(profile(admin));
    expect(admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)?.projects).toEqual([]);
    expect(origin.governance.state().sharing.projects).toEqual([]);
    origin.devices.share(profile(origin), project.id, { enabled: true, memoryFields: [] }); await origin.devices.syncNow(profile(origin)); await admin.devices.syncNow(profile(admin));
    expect(admin.devices.remoteProjects(profile(admin), origin.devices.state().localDevice.id)).toHaveLength(1);
    expect(admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)?.projects).toEqual([]);
  });
  it('does not pretend an old successful Git snapshot is a fresh observation after a read failure', async () => {
    const { origin } = await pair(); const project = origin.store.createProject({ path: '/PRIVATE_ROOT', name: 'Unavailable observation' });
    origin.devices.share(profile(origin), project.id, { enabled: true, memoryFields: [] });
    origin.store.saveObservation(project.id, details(origin).snapshot, null);
    origin.store.saveObservation(project.id, null, 'PRIVATE_DIAGNOSTIC');
    const preview = origin.governance.previewSharing(profile(origin), { activity: false, projects: [{ projectId: project.id, git: true, tasks: false }] });
    expect(preview.publication.projects[0].git).toMatchObject({ unavailable: true, branch: null });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_DIAGNOSTIC');
  });
});
