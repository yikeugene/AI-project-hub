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
interface Peer { store: Store; devices: DeviceService; governance: GovernanceService; git: GitApprovalService; version: string; launches: number; interrupted: boolean; offline: boolean }
const peers: Peer[] = [];
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
  const p = { store: new Store(':memory:'), version: 'before', launches: 0, interrupted: false, offline: false } as Peer;
  const factory = (): RelayClient => p.offline ? { ...relay.relay, governance: { ...relay.relay.governance!, policy: async () => { throw new RelayError('unavailable', 'offline', true); } } } : relay.relay;
  p.devices = new DeviceService(p.store, { mode: 'desktop', codec: testCredentialCodec(), relayFactory: factory });
  p.governance = new GovernanceService(p.store, p.devices);
  const engine: GitEngine = {
    recover: async () => {},
    details: async () => details(p), diff: async (_path, input) => ({ ...input, text: 'local-only-source', binary: false, truncated: false }),
    prepare: async (_path, operation, context) => {
      const summary: GitReviewSummary = { projectName: context.projectName, kind: operation.kind, paths: 'paths' in operation ? operation.paths : [], branch: 'main', head: oid,
        target: null, remoteUrl: null, targetRef: null, changedCount: 1, stagedCount: 0, message: null, authorName: null, authorEmail: null };
      return { operation, summary, directory: _path, fingerprint: p.version, repositoryKey: 'isolated-common-directory' } as PreparedGitOperation;
    },
    execute: async (plan, options) => {
      if (plan.fingerprint !== p.version) throw Object.assign(new Error('changed'), { code: 'stale' });
      await options.authorize();
      if (p.interrupted) throw Object.assign(new Error('interrupted'), { code: 'unknown' });
      options.onStarting(); p.launches++; p.version = 'after';
      return { status: 'succeeded', code: 'completed', head: oid };
    },
  };
  p.git = new GitApprovalService(p.store, p.devices, p.governance, engine);
  p.governance.onRefresh((client, context) => p.git.sync(client, context));
  p.devices.onSynced(async () => { await p.governance.refresh(); });
  peers.push(p); return p;
}
async function pair() {
  const admin = peer(), origin = peer(), invite = await relay.bootstrap();
  await admin.devices.pair({ ...relay.configuration, code: invite.code, name: 'Administrator', confirm: true });
  const memberInvite = await admin.devices.invitation();
  await origin.devices.pair({ ...relay.configuration, code: memberInvite.code, name: 'Origin', confirm: true });
  await admin.devices.worker.syncNow(); await origin.devices.worker.syncNow();
  expect(admin.governance.state().policy?.role).toBe('admin');
  expect(origin.governance.state().available).toBe(true);
  return { admin, origin };
}
async function request(origin: Peer, admin: Peer) {
  const project = origin.store.createProject({ path: '/private/project', name: 'Explicit review' });
  const preview = await origin.git.preview(project.id, { kind: 'stage', paths: ['readme.txt'] });
  await origin.git.submit(preview.id, admin.devices.state().localDevice.id, preview.digest);
  await admin.governance.refresh();
  return { project, preview };
}
async function approve(admin: Peer, origin: Peer, preview: GitPreview) {
  await admin.git.decide(preview.id, preview.digest, 'approved', 'Checked operation');
  await origin.governance.refresh();
  expect(origin.git.repository.get(preview.id).state).toBe('approved');
}

describe('origin-local execution after actual SQL administrator approval', () => {
  it('never executes during submit, delivery or approval; executes once only after the origin confirms', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    expect(admin.git.approvals()).toHaveLength(1); expect(origin.launches).toBe(0);
    const beforePolling = origin.git.audit(preview.id);
    await origin.governance.refresh(); await origin.governance.refresh();
    expect(origin.git.audit(preview.id)).toEqual(beforePolling);
    await expect(origin.git.decide(preview.id, preview.digest, 'approved', '')).rejects.toThrow();
    await approve(admin, origin, preview); expect(origin.launches).toBe(0);
    const [first, duplicate] = await Promise.all([origin.git.execute(preview.id, preview.digest), origin.git.execute(preview.id, preview.digest)]);
    expect(first.state).toBe('succeeded'); expect(duplicate.state).toBe('succeeded'); expect(origin.launches).toBe(1);
    expect(() => origin.git.execute(preview.id, preview.digest)).toThrow();
    expect(origin.git.audit(preview.id).map(event => event.state)).toContain('executing');
    expect(origin.git.list(project.id)[0].result?.status).toBe('succeeded');
    const remote = await origin.devices.withGovernance(client => client.getGit(preview.id));
    expect(remote.state).toBe('consumed'); expect(remote.result?.status).toBe('succeeded');
  });
  it('allows an administrator to self-approve without skipping the local execute step', async () => {
    const { admin } = await pair(); const { preview } = await request(admin, admin);
    await approve(admin, admin, preview); expect(admin.launches).toBe(0);
    expect((await admin.git.execute(preview.id, preview.digest)).state).toBe('succeeded'); expect(admin.launches).toBe(1);
  });
  it('rejects local drift before consuming the approval or invoking the mutation', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.version = 'external-change';
    expect((await origin.git.execute(preview.id, preview.digest)).state).toBe('stale'); expect(origin.launches).toBe(0);
    expect((await origin.devices.withGovernance(client => client.getGit(preview.id))).state).toBe('approved');
  });
  it('rechecks role epoch online rather than trusting a cached approved flag', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview);
    await admin.devices.withGovernance(client => client.setRole(origin.devices.state().localDevice.id, 'admin'));
    expect((await origin.git.execute(preview.id, preview.digest)).state).toBe('failed'); expect(origin.launches).toBe(0);
  });
  it('cannot use an already-consumed approval to launch again even if the local state was tampered with', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview); await origin.git.execute(preview.id, preview.digest);
    origin.version = 'before'; origin.git.repository.transition(preview.id, 'approved');
    const result = await origin.git.execute(preview.id, preview.digest);
    expect(result.state).toBe('failed'); expect(origin.launches).toBe(1);
  });
  it('fences uncertain outcomes and never replays on refresh; acknowledgement does not execute', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.interrupted = true;
    expect((await origin.git.execute(preview.id, preview.digest)).state).toBe('unknown');
    await origin.governance.refresh(); await origin.governance.refresh(); expect(origin.launches).toBe(0);
    await expect(origin.git.preview(project.id, { kind: 'stage', paths: ['readme.txt'] })).rejects.toThrow();
    expect((await origin.git.acknowledge(preview.id)).state).toBe('unknown'); expect(origin.launches).toBe(0);
    expect((await origin.git.preview(project.id, { kind: 'stage', paths: ['readme.txt'] })).id).not.toBe(preview.id);
  });
  it('keeps offline requests durably queued and sends them later without executing', async () => {
    const { admin, origin } = await pair(); origin.offline = true;
    const { preview } = await request(origin, admin);
    expect(origin.git.repository.get(preview.id).state).toBe('pending'); expect(origin.launches).toBe(0);
    expect(origin.git.repository.pending(origin.devices.repository.profile()!.id)[0]).not.toHaveProperty('plan');
    expect(origin.git.repository.rows(origin.devices.repository.profile()!.id, preview.projectId)[0]).not.toHaveProperty('plan');
    origin.offline = false; await origin.governance.refresh(); await admin.governance.refresh();
    expect(admin.git.approvals().some(item => item.id === preview.id)).toBe(true); expect(origin.launches).toBe(0);
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
      const newer = await origin.git.preview(project.id, { kind: 'stage', paths: ['readme.txt'] });
      origin.git.repository.transition(newer.id, 'failed');
    }
    origin.offline = false; await origin.governance.refresh(); await admin.governance.refresh();
    const pending = admin.git.approvals().find(item => item.id === preview.id)!; expect(pending).toBeDefined();
    for (let i = 0; i < 105; i++) admin.git.repository.applyApproval(admin.devices.repository.profile()!.id,
      { ...pending, id: randomUUID(), state: 'rejected', reason: 'History', decidedAt: new Date().toISOString() });
    expect(admin.git.approvals().some(item => item.id === preview.id)).toBe(true);
  });
  it('keeps old-connection uncertainty recoverable locally after re-pairing, without reviving its approval', async () => {
    const { admin, origin } = await pair(); const { project, preview } = await request(origin, admin);
    await approve(admin, origin, preview); origin.interrupted = true;
    await origin.git.execute(preview.id, preview.digest); await origin.devices.disconnect();
    const invitation = await admin.devices.invitation();
    await origin.devices.pair({ ...relay.configuration, name: 'New identity', code: invitation.code, confirm: true });
    await origin.devices.worker.syncNow();
    expect(origin.git.list(project.id).some(item => item.preview.id === preview.id && item.state === 'unknown')).toBe(true);
    origin.store.deleteProject(project.id, project.revision);
    const readded = origin.store.createProject({ path: project.path, name: 'Same repository, new Hub record' });
    expect(origin.git.list(readded.id).some(item => item.preview.id === preview.id && item.state === 'unknown')).toBe(true);
    await expect(origin.git.preview(readded.id, { kind: 'stage', paths: ['readme.txt'] })).rejects.toThrow();
    await origin.git.acknowledge(preview.id);
    expect(() => origin.git.execute(preview.id, preview.digest)).toThrow();
    expect((await origin.git.preview(readded.id, { kind: 'stage', paths: ['readme.txt'] })).id).not.toBe(preview.id);
    expect(origin.launches).toBe(0);
  });
  it('rejects a changed digest and requires a new preview after a connection is detached', async () => {
    const { admin, origin } = await pair(); const { preview } = await request(origin, admin);
    await approve(admin, origin, preview);
    expect(() => origin.git.execute(preview.id, '0'.repeat(64))).toThrow();
    await origin.devices.disconnect(); expect(() => origin.git.execute(preview.id, preview.digest)).toThrow(); expect(origin.launches).toBe(0);
  });
});

describe('optional device activity and project status projection', () => {
  it('shares nothing by default, previews only opted-in fields and withdraws unshared projects', async () => {
    const { admin, origin } = await pair(); const project = origin.store.createProject({ path: '/PRIVATE_ROOT', name: 'Shared progress' });
    origin.store.saveObservation(project.id, details(origin).snapshot, null);
    origin.store.createTask(project.id, { title: 'PRIVATE_TASK_TITLE', detail: 'PRIVATE_CONTENT', status: 'doing' });
    await origin.governance.refresh(); await admin.governance.refresh(); expect(admin.governance.state().statuses).toEqual([]);
    expect(() => origin.governance.previewSharing({ activity: true, projects: [{ projectId: project.id, git: true, tasks: true }] })).toThrow();
    origin.devices.share(project.id, { enabled: true, memoryFields: [] }); await origin.devices.worker.syncNow(); await admin.devices.worker.syncNow();
    origin.governance.setActivityMode('background'); origin.governance.record('git', 'pending');
    const preview = origin.governance.previewSharing({ activity: true, projects: [{ projectId: project.id, git: true, tasks: true }] });
    expect(preview.publication.activity?.mode).toBe('background'); expect(preview.publication.projects[0].tasks?.doing).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(/PRIVATE_ROOT|PRIVATE_TASK_TITLE|PRIVATE_CONTENT|local-only-source/);
    expect(origin.governance.state().sharing.activity).toBe(false);
    origin.governance.saveSharing(preview.policy, preview.digest); await origin.governance.refresh(); await admin.governance.refresh();
    const status = admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)!;
    expect(status.projects[0].git?.branch).toBe('main'); expect(status.activity?.mode).toBe('background');
    admin.offline = true; // V1 remains reachable, but the optional v2 status refresh fails.
    origin.devices.share(project.id, { enabled: false, memoryFields: [] }); await origin.devices.worker.syncNow(); await admin.devices.worker.syncNow();
    expect(admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)?.projects).toEqual([]);
    expect(origin.governance.state().sharing.projects).toEqual([]);
    origin.devices.share(project.id, { enabled: true, memoryFields: [] }); await origin.devices.worker.syncNow(); await admin.devices.worker.syncNow();
    expect(admin.devices.remoteProjects(origin.devices.state().localDevice.id)).toHaveLength(1);
    expect(admin.governance.state().statuses.find(item => item.deviceId === origin.devices.state().localDevice.id)?.projects).toEqual([]);
  });
  it('does not pretend an old successful Git snapshot is a fresh observation after a read failure', async () => {
    const { origin } = await pair(); const project = origin.store.createProject({ path: '/PRIVATE_ROOT', name: 'Unavailable observation' });
    origin.devices.share(project.id, { enabled: true, memoryFields: [] });
    origin.store.saveObservation(project.id, details(origin).snapshot, null);
    origin.store.saveObservation(project.id, null, 'PRIVATE_DIAGNOSTIC');
    const preview = origin.governance.previewSharing({ activity: false, projects: [{ projectId: project.id, git: true, tasks: false }] });
    expect(preview.publication.projects[0].git).toMatchObject({ unavailable: true, branch: null });
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_DIAGNOSTIC');
  });
});
