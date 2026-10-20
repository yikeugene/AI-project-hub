import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gitApprovalSchema, gitApprovalSubmissionSchema, gitExecutionResultSchema, GIT_OPERATION_KINDS, type GitApprovalSubmission } from '../shared/git.js';
import { deviceStatusPublicationSchema, type DeviceStatusPublication, type SharedProjectStatus } from '../shared/governance.js';
import type { PairAttempt, SharedProject } from '../shared/devices.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';

const token = () => randomBytes(32).toString('hex');
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const now = () => new Date().toISOString();
const shared = (): SharedProject => ({ name: 'Shared', status: 'active', priority: 'normal', stage: '', nextAction: '', revision: 1, memory: {} });
const request = (reviewerDeviceId: string): GitApprovalSubmission => ({
  id: randomUUID(), reviewerDeviceId, digest: token(), expiresAt: future(),
  summary: { projectName: 'Review project', kind: 'stage', paths: ['src/程式.ts', 'new\nline.ts', ':(literal).txt'], branch: 'main', head: 'a'.repeat(40), target: null,
    remoteUrl: null, targetRef: null, changedCount: 3, stagedCount: 0, message: null, authorName: null, authorEmail: null },
});
const statusProject = (projectId = randomUUID()): SharedProjectStatus => ({ projectId, name: 'Shared',
  git: { branch: 'main', changedCount: 3, stagedCount: 1, conflictCount: 0, observedAt: now(), unavailable: false },
  tasks: { todo: 1, doing: 2, blocked: 0, done: 3 },
});
const status = (projects: SharedProjectStatus[] = []): DeviceStatusPublication => ({ version: 1, projects,
  activity: { mode: 'background', sync: 'online', lastSyncAt: now(), operations: [{ kind: 'git', state: 'pending', at: now() }] },
});
let f: SqlRelayFixture;
const denied = (promise: Promise<unknown>, code = 'HU403') => expect(promise).rejects.toMatchObject({ code });
async function pair(code: string, fixture = f) {
  const attempt: PairAttempt = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: token(), inviteToken: code, name: 'Same name' };
  const result = await fixture.relay.pair(attempt);
  return { ...attempt, networkId: result.networkId };
}
async function member(admin: Awaited<ReturnType<typeof pair>>) {
  const code = token(); await f.relay.createInvite(admin.deviceToken, code); return pair(code);
}
async function network() {
  const a = await pair((await f.bootstrap()).code), b = await member(a), c = await member(a);
  return { a, b, c, g: f.relay.governance! };
}
const submit = (deviceToken: string, value: unknown) => f.rpc('hub_v2_submit_git', { p_token: deviceToken, p_request: value });
const decide = (deviceToken: string, r: GitApprovalSubmission, overrides: Record<string, unknown> = {}) => f.rpc('hub_v2_decide_git', { p_token: deviceToken, p_id: r.id, p_digest: r.digest, p_decision: 'approved', p_reason: '', ...overrides });
const consume = (deviceToken: string, r: GitApprovalSubmission, executionId = randomUUID()) => f.rpc('hub_v2_consume_git', { p_token: deviceToken, p_id: r.id, p_digest: r.digest, p_execution_id: executionId });
const publish = (deviceToken: string, value: unknown) => f.rpc('hub_v2_publish_status', { p_token: deviceToken, p_status: JSON.stringify(value) });

beforeAll(async () => { f = await createSqlRelayFixture(); }, 60_000);
afterAll(async () => { await f?.close(); });
beforeEach(async () => { await f.reset(); });

describe('v2 upgrade, exact ACLs and authoritative roles', () => {
  it('keeps private tables/helpers inaccessible, RLS enabled and all 25 RPCs scoped to the dedicated definer', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of ['networks', 'devices', 'invites', 'messages', 'snapshots', 'governance_audit', 'git_approvals', 'device_statuses']) {
        await denied(f.asRole(role, `SELECT * FROM hub_private.${table}`), '42501');
        await denied(f.asRole(role, `DELETE FROM hub_private.${table}`), '42501');
      }
      await denied(f.asRole(role, 'SELECT hub_private.designate_initial_admin($1,$2)', [randomUUID(), randomUUID()]), '42501');
      await denied(f.asRole(role, 'SELECT hub_private.bootstrap()'), '42501');
    }
    const functions = await f.db.query<{ owner: string; prosecdef: boolean; config: string; anon: boolean; authenticated: boolean; public: boolean }>(`
      SELECT r.rolname AS owner,p.prosecdef,p.proconfig::text AS config,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'hub_%'`);
    expect(functions.rows).toHaveLength(25);
    for (const fn of functions.rows) expect(fn).toEqual({ owner: 'hub_relay_owner', prosecdef: true, config: '{"search_path=\\"\\""}', anon: true, authenticated: true, public: false });
    const helpers = await f.db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hub_private'");
    expect(helpers.rows.every(row => !row.allowed)).toBe(true);
    const tables = await f.db.query<{ rls: boolean; allowed: boolean }>("SELECT c.relrowsecurity AS rls,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hub_private' AND c.relkind='r'");
    expect(tables.rows).toHaveLength(8); expect(tables.rows.every(row => row.rls && !row.allowed)).toBe(true);
    const owner = await f.db.query<{ allowed: boolean }>("SELECT has_schema_privilege('hub_relay_owner','public','CREATE') AS allowed");
    expect(owner.rows[0].allowed).toBe(false);
  });

  it('bootstraps one admin explicitly, normal invitations create only members and public self-promotion is impossible', async () => {
    const { a, b, c, g } = await network();
    const policy = await g.policy(b.deviceToken);
    expect(policy).toMatchObject({ protocol: 2, networkId: a.networkId, deviceId: b.deviceId, role: 'member', epoch: 1 });
    expect(policy.roles.filter(r => r.role === 'admin')).toEqual([{ deviceId: a.deviceId, role: 'admin' }]);
    await denied(f.rpc('hub_v2_set_role', { p_token: b.deviceToken, p_device_id: b.deviceId, p_role: 'admin' }));
    await denied(f.rpc('hub_revoke', { p_token: b.deviceToken, p_device_id: a.deviceId }));
    await denied(f.rpc('hub_revoke', { p_token: b.deviceToken, p_device_id: c.deviceId }));
    await denied(f.rpc('hub_revoke', { p_token: b.deviceToken, p_device_id: b.deviceId }));
    const memberInvite = token(); await f.relay.createInvite(b.deviceToken, memberInvite);
    const next = await pair(memberInvite); expect((await g.policy(next.deviceToken)).role).toBe('member');
    const initial = await f.db.query<{ initial_admin: boolean }>('SELECT initial_admin FROM hub_private.invites WHERE consumed_by=$1', [a.deviceId]);
    expect(initial.rows[0].initial_admin).toBe(true);
    // v1 pairing/devices retain their exact strict schemas (no added role fields).
    expect(Object.keys((await f.relay.listDevices(a.deviceToken))[0]).sort()).toEqual(['id', 'lastSeenAt', 'name', 'revokedAt']);
  });

  it('leaves migrated existing networks unprivileged until an explicit private initialization, without promoting existing invites', async () => {
    const old = await createSqlRelayFixture({ governance: false });
    try {
      const boot = await old.bootstrap(), a = await pair(boot.code, old);
      await expect(old.relay.governance!.policy(a.deviceToken)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
      const unused = token(); await old.relay.createInvite(a.deviceToken, unused);
      await old.db.exec(await readFile(new URL('../supabase/migrations/202610200001_device_git_approval.sql', import.meta.url), 'utf8'));
      const g = old.relay.governance!;
      expect(await g.policy(a.deviceToken)).toMatchObject({ role: 'member', epoch: 0 });
      await expect(g.submitGit(a.deviceToken, request(a.deviceId))).rejects.toMatchObject({ code: 'denied' });
      await expect(g.setRole(a.deviceToken, a.deviceId, 'admin')).rejects.toMatchObject({ code: 'denied' });
      const b = await pair(unused, old); expect((await g.policy(b.deviceToken)).role).toBe('member');
      await old.asRole('postgres', 'SELECT hub_private.designate_initial_admin($1,$2)', [a.networkId, a.deviceId]);
      expect(await g.policy(a.deviceToken)).toMatchObject({ role: 'admin', epoch: 1 });
      await denied(old.asRole('postgres', 'SELECT hub_private.designate_initial_admin($1,$2)', [a.networkId, b.deviceId]), 'HU409');
      expect((await g.submitGit(a.deviceToken, request(a.deviceId))).state).toBe('pending');
    } finally { await old.close(); }
  }, 60_000);

  it('audits grants, demotions and legacy revocations, increments epoch once, protects the last admin and never inherits roles on re-pair', async () => {
    const { a, b, c, g } = await network();
    await expect(g.setRole(a.deviceToken, a.deviceId, 'member')).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.relay.revokeDevice(a.deviceToken, a.deviceId)).rejects.toMatchObject({ code: 'conflict' });
    await g.setRole(a.deviceToken, b.deviceId, 'admin');
    await g.setRole(a.deviceToken, b.deviceId, 'admin');
    expect((await g.policy(a.deviceToken)).epoch).toBe(2);
    await g.setRole(b.deviceToken, a.deviceId, 'member');
    await expect(g.setRole(a.deviceToken, c.deviceId, 'admin')).rejects.toMatchObject({ code: 'denied' });
    await f.relay.revokeDevice(b.deviceToken, a.deviceId); await f.relay.revokeDevice(b.deviceToken, a.deviceId);
    expect((await g.policy(b.deviceToken)).epoch).toBe(4);
    expect((await g.policy(b.deviceToken)).roles.some(r => r.deviceId === a.deviceId)).toBe(false);
    const fresh = await member(b); expect((await g.policy(fresh.deviceToken)).role).toBe('member');
    expect(() => f.relay.pair(a)).toThrow(); // extra local networkId is never accepted
    const { networkId: _network, ...retry } = a;
    await expect(f.relay.pair(retry)).rejects.toMatchObject({ code: 'unauthorized' });
    const audit = await f.db.query<{ action: string; epoch: number; actor: string | null }>('SELECT action,epoch::integer,actor_device_id AS actor FROM hub_private.governance_audit ORDER BY epoch');
    expect(audit.rows).toEqual([{ action: 'bootstrap', epoch: 1, actor: null }, { action: 'grant', epoch: 2, actor: a.deviceId }, { action: 'demote', epoch: 3, actor: b.deviceId }, { action: 'revoke', epoch: 4, actor: b.deviceId }]);
  });

  it('isolates networks and reauthenticates every v2 operation after token revocation', async () => {
    const { a, b, g } = await network(), outside = await pair((await f.bootstrap()).code), r = request(a.deviceId);
    await g.submitGit(b.deviceToken, r);
    await expect(g.setRole(a.deviceToken, outside.deviceId, 'member')).rejects.toMatchObject({ code: 'denied' });
    await expect(g.submitGit(b.deviceToken, request(outside.deviceId))).rejects.toMatchObject({ code: 'denied' });
    await expect(g.getGit(outside.deviceToken, r.id)).rejects.toMatchObject({ code: 'denied' });
    await denied(decide(outside.deviceToken, r)); await denied(consume(outside.deviceToken, r));
    expect(await g.listGit(outside.deviceToken)).toEqual([]); expect(await g.statuses(outside.deviceToken)).toEqual([]);
    await f.relay.revokeDevice(a.deviceToken, b.deviceId);
    const calls: [string, Record<string, unknown>][] = [
      ['hub_v2_policy', {}], ['hub_v2_set_role', { p_device_id: a.deviceId, p_role: 'admin' }], ['hub_v2_submit_git', { p_request: r }],
      ['hub_v2_list_git', {}], ['hub_v2_get_git', { p_id: r.id }], ['hub_v2_decide_git', { p_id: r.id, p_digest: r.digest, p_decision: 'approved', p_reason: '' }],
      ['hub_v2_cancel_git', { p_id: r.id, p_digest: r.digest }], ['hub_v2_consume_git', { p_id: r.id, p_digest: r.digest, p_execution_id: randomUUID() }],
      ['hub_v2_report_git', { p_id: r.id, p_execution_id: randomUUID(), p_result: { status: 'unknown', code: 'unknown', head: null } }],
      ['hub_v2_publish_status', { p_status: JSON.stringify(status()) }], ['hub_v2_statuses', {}],
    ];
    for (const p_token of [b.deviceToken, token(), 'bad']) for (const [name, args] of calls) await denied(f.rpc(name, { p_token, ...args }), 'HU401');
    await denied(decide(a.deviceToken, r));
  });
});

describe('immutable approval and one-shot execution authorization', () => {
  it('binds immutable request/origin/reviewer/digest/summary/expiry and permits only the designated active admin decision', async () => {
    const { a, b, c, g } = await network(); await g.setRole(a.deviceToken, c.deviceId, 'admin');
    const r = request(a.deviceId), pending = await g.submitGit(b.deviceToken, r);
    expect(gitApprovalSchema.safeParse(pending).success).toBe(true);
    expect(pending).toMatchObject({ fromDeviceId: b.deviceId, state: 'pending', approvedBy: null, approvedEpoch: null, executionId: null });
    expect(Math.abs(Date.parse(pending.createdAt) - Date.now())).toBeLessThan(5000);
    expect(await g.submitGit(b.deviceToken, r)).toEqual(pending);
    for (const change of [{ digest: token() }, { reviewerDeviceId: c.deviceId }, { summary: { ...r.summary, paths: ['different.ts'] } }, { expiresAt: new Date(Date.now() + 7_200_000).toISOString() }]) await denied(submit(b.deviceToken, { ...r, ...change }), 'HU409');
    await denied(submit(c.deviceToken, r), 'HU409');
    await denied(decide(b.deviceToken, r)); await denied(decide(c.deviceToken, r));
    await denied(f.rpc('hub_v2_get_git', { p_token: c.deviceToken, p_id: r.id }));
    await denied(decide(a.deviceToken, r, { p_digest: token() }), 'HU409');
    await denied(consume(b.deviceToken, r), 'HU409');
    const approved = await g.decideGit(a.deviceToken, r.id, r.digest, 'approved', 'Reviewed');
    expect(approved).toMatchObject({ state: 'approved', approvedBy: a.deviceId, approvedEpoch: 2, reason: 'Reviewed' });
    expect(await g.decideGit(a.deviceToken, r.id, r.digest, 'approved', 'Reviewed')).toEqual(approved);
    await denied(decide(a.deviceToken, r, { p_reason: 'changed' }), 'HU409');
    await denied(decide(a.deviceToken, r, { p_decision: 'rejected', p_reason: 'Reviewed' }), 'HU409');
    await denied(consume(a.deviceToken, r));
  });

  it('permits admin self-review as a separate action and records one immutable attempt; retry receipts cannot authorize another launch', async () => {
    const { a, g } = await network(), r = request(a.deviceId), executionId = randomUUID();
    await g.submitGit(a.deviceToken, r); await denied(consume(a.deviceToken, r, executionId), 'HU409');
    await g.decideGit(a.deviceToken, r.id, r.digest, 'approved', 'Self review');
    const first = await g.consumeGit(a.deviceToken, r.id, r.digest, executionId);
    expect(first).toMatchObject({ id: r.id, executionId, replayed: false });
    const replay = await g.consumeGit(a.deviceToken, r.id, r.digest, executionId);
    expect(replay).toEqual({ ...first, replayed: true });
    await denied(consume(a.deviceToken, r), 'HU409');
    await denied(consume(a.deviceToken, { ...r, digest: token() }, executionId), 'HU409');
    await expect(g.cancelGit(a.deviceToken, r.id, r.digest)).rejects.toMatchObject({ code: 'conflict' });
    expect((await g.getGit(a.deviceToken, r.id)).executionId).toBe(executionId);
  });

  it('invalidates approvals on any policy epoch change, including demote/regrant, and checks expiry immediately before consuming', async () => {
    const { a, b, c, g } = await network();
    const r = request(a.deviceId); await g.submitGit(b.deviceToken, r); await g.decideGit(a.deviceToken, r.id, r.digest, 'approved', '');
    await g.setRole(a.deviceToken, c.deviceId, 'admin');
    await denied(consume(b.deviceToken, r));
    await g.setRole(c.deviceToken, a.deviceId, 'member'); await g.setRole(c.deviceToken, a.deviceId, 'admin');
    await denied(consume(b.deviceToken, r));
    const expiring = request(a.deviceId); await g.submitGit(b.deviceToken, expiring); await decide(a.deviceToken, expiring);
    await f.db.query("UPDATE hub_private.git_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring.id]);
    await denied(consume(b.deviceToken, expiring), 'HU410');
    const revoke = request(a.deviceId); await g.submitGit(b.deviceToken, revoke); await decide(a.deviceToken, revoke);
    await f.relay.revokeDevice(c.deviceToken, a.deviceId); await denied(consume(b.deviceToken, revoke));
  });

  it('caps new pending expiry at 24 hours, rejects expired decisions and supports immutable submit retries after expiry', async () => {
    const { a, b, g } = await network();
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 86_401_000).toISOString()]) await denied(submit(b.deviceToken, { ...request(a.deviceId), expiresAt }), 'HU410');
    const r = { ...request(a.deviceId), expiresAt: new Date(Date.now() + 100).toISOString() };
    const original = await g.submitGit(b.deviceToken, r); await new Promise(resolve => setTimeout(resolve, 120));
    expect(await g.submitGit(b.deviceToken, r)).toEqual(original);
    await denied(decide(a.deviceToken, r), 'HU410');
    expect((await g.cancelGit(b.deviceToken, r.id, r.digest)).state).toBe('cancelled');
  });

  it('makes rejection terminal and cancellation origin-only before or after approval', async () => {
    const { a, b, c, g } = await network(), r = request(a.deviceId);
    await g.submitGit(b.deviceToken, r); await g.decideGit(a.deviceToken, r.id, r.digest, 'rejected', 'No');
    await denied(consume(b.deviceToken, r), 'HU409'); await denied(decide(a.deviceToken, r), 'HU409');
    for (const approved of [false, true]) {
      const next = request(a.deviceId); await g.submitGit(b.deviceToken, next); if (approved) await decide(a.deviceToken, next);
      for (const p_token of [a.deviceToken, c.deviceToken]) await denied(f.rpc('hub_v2_cancel_git', { p_token, p_id: next.id, p_digest: next.digest }));
      const cancelled = await g.cancelGit(b.deviceToken, next.id, next.digest);
      expect(await g.cancelGit(b.deviceToken, next.id, next.digest)).toEqual(cancelled);
      await denied(consume(b.deviceToken, next), 'HU409'); await denied(decide(a.deviceToken, next), 'HU409');
    }
  });

  it('accepts only immutable safe origin-owned result reports, including after expiry/reviewer revocation, while the caller stays active', async () => {
    const { a, b, c, g } = await network(); await g.setRole(a.deviceToken, c.deviceId, 'admin');
    const r = request(a.deviceId), executionId = randomUUID(), result = { status: 'partial' as const, code: 'git.partial', head: 'a'.repeat(64) };
    await g.submitGit(b.deviceToken, r);
    await expect(g.reportGit(b.deviceToken, r.id, executionId, result)).rejects.toMatchObject({ code: 'conflict' });
    await decide(a.deviceToken, r); const receipt = await g.consumeGit(b.deviceToken, r.id, r.digest, executionId);
    await expect(g.reportGit(a.deviceToken, r.id, executionId, result)).rejects.toMatchObject({ code: 'denied' });
    await expect(g.reportGit(b.deviceToken, r.id, randomUUID(), result)).rejects.toMatchObject({ code: 'conflict' });
    await f.db.query("UPDATE hub_private.git_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r.id]);
    await f.relay.revokeDevice(c.deviceToken, a.deviceId);
    expect(await g.consumeGit(b.deviceToken, r.id, r.digest, executionId)).toEqual({ ...receipt, replayed: true });
    await g.reportGit(b.deviceToken, r.id, executionId, result); await g.reportGit(b.deviceToken, r.id, executionId, result);
    expect((await g.getGit(b.deviceToken, r.id)).result).toEqual(result);
    await expect(g.reportGit(b.deviceToken, r.id, executionId, { ...result, status: 'succeeded' })).rejects.toMatchObject({ code: 'conflict' });
    for (const p_result of [{ ...result, stderr: 'secret' }, { ...result, code: 'C:/private' }, { ...result, status: 'success' }, { ...result, head: 'BAD' }, { ...result, code: 'x'.repeat(81) }]) {
      expect(gitExecutionResultSchema.safeParse(p_result).success).toBe(false);
      await denied(f.rpc('hub_v2_report_git', { p_token: b.deviceToken, p_id: r.id, p_execution_id: executionId, p_result }), 'HU400');
    }
    await f.relay.revokeDevice(c.deviceToken, b.deviceId);
    await expect(g.reportGit(b.deviceToken, r.id, executionId, result)).rejects.toMatchObject({ code: 'unauthorized' });
    await denied(consume(b.deviceToken, r, executionId), 'HU401');
  });

  it('bounds recent own/assigned history to 100 and prioritizes live requests over newer terminal history', async () => {
    const { a, b, c, g } = await network(), pending = request(a.deviceId);
    await g.submitGit(b.deviceToken, pending);
    for (let i = 0; i < 105; i++) { const r = request(a.deviceId); await g.submitGit(b.deviceToken, r); await g.cancelGit(b.deviceToken, r.id, r.digest); }
    const mine = await g.listGit(b.deviceToken), assigned = await g.listGit(a.deviceToken);
    expect(mine).toHaveLength(100); expect(mine[0].id).toBe(pending.id); expect(assigned.map(r => r.id)).toEqual(mine.map(r => r.id));
    expect(await g.listGit(c.deviceToken)).toEqual([]);
  });
});

describe('strict Git schemas, privacy and bounded SQL inputs', () => {
  it('mirrors fixed fields/enums/UTF-16 limits and rejects unknown data even when bypassing the adapter', async () => {
    const { a, b } = await network(), base = request(a.deviceId);
    for (const kind of GIT_OPERATION_KINDS) expect(await submit(b.deviceToken, { ...base, id: randomUUID(), summary: { ...base.summary, kind } })).toMatchObject({ state: 'pending' });
    const changes = [
      { root: 'C:/private' }, { diff: 'source code' }, { kind: 'reset' }, { projectName: '' }, { projectName: '😀'.repeat(61) },
      { paths: Array(201).fill('file') }, { paths: ['x'.repeat(4097)] }, { paths: [null] }, { paths: [''] },
      { branch: '' }, { branch: 'x'.repeat(257) }, { head: 'A'.repeat(40) }, { target: 'a'.repeat(41) },
      { targetRef: 'x'.repeat(513) }, { remoteUrl: 'x'.repeat(2049) }, { changedCount: -1 }, { stagedCount: 0.5 },
      { message: 'x'.repeat(10001) }, { authorName: 'x'.repeat(201) }, { authorEmail: 'x'.repeat(255) },
    ];
    for (const change of changes) {
      const invalid = { ...base, summary: { ...base.summary, ...change } };
      expect(gitApprovalSubmissionSchema.safeParse(invalid).success).toBe(false); await denied(submit(b.deviceToken, invalid), 'HU400');
    }
    for (const extra of [{ fromDeviceId: a.deviceId }, { networkId: a.networkId }, { approvedBy: a.deviceId }, { createdAt: now() }, { expiresAt: '2026-02-31T12:00:00Z' }, { expiresAt: '2026-10-20T24:00:00Z' }]) await denied(submit(b.deviceToken, { ...base, ...extra }), 'HU400');
    for (const key of Object.keys(base.summary)) {
      const summary = { ...base.summary } as Record<string, unknown>; delete summary[key]; await denied(submit(b.deviceToken, { ...base, summary }), 'HU400');
    }
    await denied(submit(b.deviceToken, { ...base, summary: { ...base.summary, paths: ['\0'] } }), '22P05');
    const valid = { ...base, summary: { ...base.summary, projectName: '😀'.repeat(60), message: 'x'.repeat(10000), remoteUrl: 'https://example.test/repo.git' } };
    expect(await submit(b.deviceToken, valid)).toMatchObject({ digest: base.digest });
  });

  it('allows explicitly previewed relative filenames but never absolute/escaping paths or local/credentialed remote URLs', async () => {
    const { a, b } = await network(), base = request(a.deviceId);
    for (const path of ['/etc/private', 'C:/Users/private', 'c:relative-drive', '\\root', '\\\\server\\share', '../private', 'src/../../private', 'src\\..\\private']) {
      await denied(submit(b.deviceToken, { ...base, summary: { ...base.summary, paths: [path] } }), 'HU400');
    }
    for (const remoteUrl of ['C:/private/repo', '/private/repo', 'file:///private', 'ssh://git@example.test/repo', 'https://user:secret@example.test/repo', 'https://example.test/repo?token=secret', 'https://example.test/#secret', 'https://example.test/\nsecret']) {
      await denied(submit(b.deviceToken, { ...base, summary: { ...base.summary, remoteUrl } }), 'HU400');
    }
    const huge = { ...base, summary: { ...base.summary, paths: Array(200).fill('漢'.repeat(1000)) } };
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(262144); await denied(submit(b.deviceToken, huge), 'HU400');
  });
});

describe('Git byte-boundary parity', () => {
  it('accepts the exact compact UTF-8 request limit and keeps large list responses under the transport cap', async () => {
    const { a, b, g } = await network(), r = request(a.deviceId);
    r.summary.paths = [...Array<string>(63).fill('x'.repeat(4096)), 'x'];
    r.summary.paths[63] = 'x'.repeat(1 + 262144 - Buffer.byteLength(JSON.stringify(r)));
    expect(r.summary.paths[63].length).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(r))).toBe(262144);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) { const item = { ...r, id: randomUUID() }; ids.push(item.id); await g.submitGit(b.deviceToken, item); }
    const listed = await g.listGit(a.deviceToken);
    expect(listed.length).toBeGreaterThan(0); expect(listed.length).toBeLessThan(6);
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(1048576);
    expect((await g.getGit(b.deviceToken, ids[0])).id).toBe(ids[0]);
    const oversized = { ...r, id: randomUUID(), summary: { ...r.summary, paths: [...r.summary.paths.slice(0, 63), r.summary.paths[63] + 'x'] } };
    await denied(submit(b.deviceToken, oversized), 'HU400');
  });
});

describe('opt-in status privacy, exact bytes and monotonic tombstones', () => {
  it('publishes only caller-owned currently shared projects, uses authoritative receipt times, retains stale data and hides revoked devices', async () => {
    const { a, b, c, g } = await network(), p = statusProject();
    await denied(publish(b.deviceToken, status([p])));
    await f.relay.publish(a.deviceToken, { projectId: p.projectId, version: 1, project: shared() });
    await denied(publish(b.deviceToken, status([p])));
    await f.relay.publish(b.deviceToken, { projectId: p.projectId, version: 1, project: shared() });
    const value = status([p]); value.activity!.lastSyncAt = '2000-01-01T00:00:00Z';
    await g.publishStatus(b.deviceToken, value);
    const [remote] = await g.statuses(c.deviceToken);
    expect(remote).toMatchObject({ deviceId: b.deviceId, version: 1, projects: [p], activity: value.activity });
    expect(Math.abs(Date.parse(remote.receivedAt) - Date.now())).toBeLessThan(5000);
    await f.db.exec("UPDATE hub_private.device_statuses SET received_at='2000-01-01T00:00:00Z'");
    expect((await g.statuses(c.deviceToken))[0].receivedAt).toMatch(/^2000-/);
    const outside = await pair((await f.bootstrap()).code); expect(await g.statuses(outside.deviceToken)).toEqual([]);
    await f.relay.revokeDevice(a.deviceToken, b.deviceId);
    expect(await g.statuses(c.deviceToken)).toEqual([]);
    await expect(g.publishStatus(b.deviceToken, { version: 2, activity: null, projects: [] })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('preserves empty tombstones and exact-version bytes, never advances receipt times for retries or accepts rollbacks', async () => {
    const { a, b, g } = await network(), value = status();
    await g.publishStatus(b.deviceToken, value); const first = (await g.statuses(a.deviceToken))[0];
    await g.publishStatus(b.deviceToken, value); expect((await g.statuses(a.deviceToken))[0]).toEqual(first);
    await denied(publish(b.deviceToken, { ...value, activity: null }), 'HU409');
    await denied(f.rpc('hub_v2_publish_status', { p_token: b.deviceToken, p_status: JSON.stringify(value, null, 1) }), 'HU409');
    const tombstone = { version: 2, activity: null, projects: [] };
    await g.publishStatus(b.deviceToken, tombstone); await g.publishStatus(b.deviceToken, tombstone);
    expect((await g.statuses(a.deviceToken))[0]).toMatchObject(tombstone);
    await denied(publish(b.deviceToken, value), 'HU409');
  });

  it('clears extensions when a v1 client unshares, and neither identical retries nor re-sharing resurrect old extensions', async () => {
    const { a, b, g } = await network(), p = statusProject(), q = statusProject();
    for (const project of [p, q]) await f.relay.publish(b.deviceToken, { projectId: project.projectId, version: 1, project: shared() });
    const value = status([p, q]); await g.publishStatus(b.deviceToken, value);
    await f.relay.publish(b.deviceToken, { projectId: p.projectId, version: 2, project: null });
    expect((await g.statuses(a.deviceToken))[0].projects).toEqual([q]);
    await g.publishStatus(b.deviceToken, value); expect((await g.statuses(a.deviceToken))[0].projects).toEqual([q]);
    await denied(publish(b.deviceToken, { ...value, version: 2 }));
    await f.relay.publish(b.deviceToken, { projectId: p.projectId, version: 3, project: shared() });
    await g.publishStatus(b.deviceToken, value); expect((await g.statuses(a.deviceToken))[0].projects).toEqual([q]);
    await g.publishStatus(b.deviceToken, { ...value, version: 2 }); expect((await g.statuses(a.deviceToken))[0].projects).toEqual([p, q]);
  });

  it('enforces 8192 exact UTF-8 bytes, at most 20 unique projects/10 operations, finite safe counters and every nested strict key', async () => {
    const { a, b, g } = await network(), p = statusProject();
    await f.relay.publish(b.deviceToken, { projectId: p.projectId, version: 1, project: shared() });
    const value = status([p]);
    const invalids: unknown[] = [
      { ...value, deviceId: a.deviceId }, { ...value, receivedAt: now() }, { ...value, version: 0 }, { ...value, version: 9007199254740992 },
      { ...value, projects: Array(21).fill(p) }, { ...value, activity: { ...value.activity, mode: 'sleeping' } },
      { ...value, activity: { ...value.activity, sync: 'ready' } }, { ...value, activity: { ...value.activity, operations: Array(11).fill(value.activity!.operations[0]) } },
      { ...value, activity: { ...value.activity, cpu: 90 } }, { ...value, activity: { ...value.activity, operations: [{ kind: 'terminal', state: 'running', at: now() }] } },
      { ...value, projects: [{ ...p, root: '/private' }] }, { ...value, projects: [{ ...p, name: '😀'.repeat(61) }] },
      { ...value, projects: [{ ...p, git: { ...p.git, diff: 'source' } }] }, { ...value, projects: [{ ...p, git: { ...p.git, branch: 'x'.repeat(257) } }] },
      { ...value, projects: [{ ...p, git: { ...p.git, changedCount: -1 } }] }, { ...value, projects: [{ ...p, tasks: { ...p.tasks, doing: 0.5 } }] },
      { ...value, projects: [{ ...p, git: { ...p.git, unavailable: 'false' } }] }, { ...value, projects: [{ ...p, tasks: { todo: 1, doing: 0, blocked: 0 } }] },
    ];
    for (const invalid of invalids) { expect(deviceStatusPublicationSchema.safeParse(invalid).success).toBe(false); await denied(publish(b.deviceToken, invalid), 'HU400'); }
    await denied(publish(b.deviceToken, { ...value, projects: [p, p] }), 'HU400');
    for (const at of ['yesterday', '2026-02-30T00:00:00Z', '2026-10-20T24:00:00Z']) await denied(publish(b.deviceToken, { ...value, activity: { ...value.activity, lastSyncAt: at } }), 'HU400');
    const text = JSON.stringify(value), padded = text + ' '.repeat(8192 - Buffer.byteLength(text));
    await f.rpc('hub_v2_publish_status', { p_token: b.deviceToken, p_status: padded });
    await f.rpc('hub_v2_publish_status', { p_token: b.deviceToken, p_status: padded });
    await denied(f.rpc('hub_v2_publish_status', { p_token: b.deviceToken, p_status: padded + ' ' }), 'HU400');
    const twenty = Array.from({ length: 20 }, () => ({ ...statusProject(), git: null, tasks: null }));
    for (const project of twenty) await f.relay.publish(b.deviceToken, { projectId: project.projectId, version: 1, project: shared() });
    await g.publishStatus(b.deviceToken, { version: 2, activity: { ...value.activity!, operations: Array(10).fill(value.activity!.operations[0]) }, projects: twenty });
    expect((await g.statuses(a.deviceToken))[0].projects).toHaveLength(20);
  });
});
