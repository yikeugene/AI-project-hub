import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RELAY_BYTES, messagePayloadSchema, type MessageDecision, type OutboundMessage, type PairAttempt, type SharedProject } from '../shared/devices.js';
import { MEMORY_FIELDS, PRIORITIES, PROJECT_STATUSES } from '../shared/types.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';

const token = () => randomBytes(32).toString('hex');
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const project = (): SharedProject => ({ name: 'Shared project', status: 'active', priority: 'normal', stage: '', nextAction: 'Review', revision: 1, memory: {} });
const message = (toDeviceId: string, payload = JSON.stringify({ schemaVersion: 1, kind: 'message', text: 'Hello' })): OutboundMessage => ({ id: randomUUID(), toDeviceId, payload, expiresAt: future() });
const proposal = (toDeviceId: string) => message(toDeviceId, JSON.stringify({ schemaVersion: 1, kind: 'proposal', text: 'Please review', projectId: randomUUID(), baseRevision: 1, changes: { nextAction: 'Check tests', memory: { notes: 'A suggestion' } } }));
const result = (status: MessageDecision['status'] = 'read'): MessageDecision => ({ status, revision: status === 'applied' ? 2 : null, at: new Date().toISOString() });
let fixture: SqlRelayFixture;
async function pair(code: string, name = 'Desktop') {
  const attempt: PairAttempt = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: token(), inviteToken: code, name };
  const paired = await fixture.relay.pair(attempt);
  return { ...attempt, paired };
}
async function network() {
  const bootstrap = await fixture.bootstrap();
  const a = await pair(bootstrap.code, 'Same display name');
  const code = token(); await fixture.relay.createInvite(a.deviceToken, code);
  const b = await pair(code, 'Same display name');
  return { a, b, bootstrap };
}
const denied = (promise: Promise<unknown>, code = 'HU403') => expect(promise).rejects.toMatchObject({ code });

beforeAll(async () => { fixture = await createSqlRelayFixture(); }, 60_000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => { await fixture.reset(); });

describe('actual migration permissions and authentication', () => {
  it('enforces real anon/authenticated ACLs, RLS and dedicated definer ownership', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of ['networks', 'devices', 'invites', 'messages', 'snapshots']) {
        await denied(fixture.asRole(role, `SELECT * FROM hub_private.${table}`), '42501');
        await denied(fixture.asRole(role, `DELETE FROM hub_private.${table}`), '42501');
      }
      await denied(fixture.asRole(role, "SELECT hub_private.bootstrap('forbidden')"), '42501');
      await denied(fixture.asRole(role, 'SELECT hub_private.auth($1)', [token()]), '42501');
      await denied(fixture.asRole(role, 'SELECT public.hub_devices($1)', [token()]), 'HU401');
    }
    const functions = await fixture.db.query<{ proname: string; prosecdef: boolean; owner: string; config: string; anon_execute: boolean }>(`
      SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig::text AS config,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'hub_%'`);
    expect(functions.rows).toHaveLength(14);
    for (const fn of functions.rows) expect(fn).toMatchObject({ prosecdef: true, owner: 'hub_relay_owner', anon_execute: true, config: '{"search_path=\\"\\""}' });
    const helpers = await fixture.db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hub_private'");
    expect(helpers.rows.every(row => !row.allowed)).toBe(true);
    const tables = await fixture.db.query<{ rls: boolean; allowed: boolean }>("SELECT c.relrowsecurity AS rls, has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hub_private' AND c.relkind='r'");
    expect(tables.rows).toHaveLength(5);
    expect(tables.rows.every(row => row.rls && !row.allowed)).toBe(true);
  });

  it('reauthenticates every public operation with wrong or revoked credentials', async () => {
    const { a, b } = await network();
    const invalidTokens = [token(), 'short', a.deviceToken];
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    for (const p_token of invalidTokens) {
      const calls: [string, Record<string, unknown>][] = [
        ['hub_devices', {}], ['hub_rename', { p_name: 'Renamed' }], ['hub_invite', { p_code: token() }],
        ['hub_revoke', { p_device_id: b.deviceId }], ['hub_publish', { p_snapshot: { projectId: randomUUID(), version: 1, project: null } }],
        ['hub_manifest', { p_after: null }], ['hub_snapshots', { p_refs: [] }], ['hub_send', { p_message: message(b.deviceId) }],
        ['hub_pull', {}], ['hub_ack', { p_ids: [] }], ['hub_statuses', { p_ids: [] }],
        ['hub_check_proposal', { p_id: randomUUID(), p_hash: token() }], ['hub_resolve', { p_id: randomUUID(), p_decision: result() }],
      ];
      for (const [name, args] of calls) await denied(fixture.rpc(name, { p_token, ...args }), 'HU401');
    }
  });

  it('stores only token/invitation hashes, trims names and trusts every active device equally', async () => {
    const { a, b } = await network();
    await fixture.relay.renameDevice(b.deviceToken, '  Secondary desktop  ');
    const cCode = token(); await fixture.relay.createInvite(b.deviceToken, cCode);
    const c = await pair(cCode, 'Third');
    await fixture.relay.revokeDevice(c.deviceToken, a.deviceId);
    const devices = await fixture.relay.listDevices(b.deviceToken);
    expect(devices.find(d => d.id === a.deviceId)?.revokedAt).not.toBeNull();
    expect(devices.find(d => d.id === b.deviceId)?.name).toBe('Secondary desktop');
    const stored = await fixture.db.query<{ token_hash: Uint8Array }>('SELECT token_hash FROM hub_private.devices WHERE id=$1', [b.deviceId]);
    expect(Buffer.from(stored.rows[0].token_hash).toString('hex')).toBe(createHash('sha256').update(b.deviceToken).digest('hex'));
    const columns = await fixture.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='hub_private'");
    expect(columns.rows.map(row => row.column_name)).not.toContain('token');
    expect(columns.rows.map(row => row.column_name)).not.toContain('code');
  });
});

describe('atomic pairing and lost replies', () => {
  it('allows only the identical consumed attempt/device/token retry, even after expiry, never after revoke', async () => {
    const { a, b, bootstrap } = await network();
    await fixture.db.query('UPDATE hub_private.invites SET expires_at=clock_timestamp()-interval \'1 minute\' WHERE network_id=$1', [bootstrap.networkId]);
    const { paired: _paired, ...retry } = a;
    expect((await fixture.relay.pair(retry)).device.id).toBe(a.deviceId);
    const raw = { p_attempt_id: a.attemptId, p_device_id: a.deviceId, p_token: a.deviceToken, p_code: a.inviteToken, p_name: a.name };
    for (const override of [{ p_attempt_id: randomUUID() }, { p_device_id: randomUUID() }, { p_token: token() }]) await denied(fixture.rpc('hub_pair', { ...raw, ...override }), 'HU409');
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    await denied(fixture.rpc('hub_pair', raw), 'HU401');
    const count = await fixture.db.query<{ n: number }>('SELECT count(*)::integer AS n FROM hub_private.devices');
    expect(count.rows[0].n).toBe(2);
  });

  it('rejects unused expired codes, unknown codes and invitations from subsequently revoked issuers', async () => {
    const { a, b } = await network();
    const expired = await fixture.bootstrap('Expired');
    await fixture.db.query('UPDATE hub_private.invites SET expires_at=clock_timestamp()-interval \'1 minute\' WHERE network_id=$1', [expired.networkId]);
    const raw = { p_attempt_id: randomUUID(), p_device_id: randomUUID(), p_token: token(), p_code: expired.code, p_name: 'Third' };
    await denied(fixture.rpc('hub_pair', raw), 'HU410');
    await denied(fixture.rpc('hub_pair', { ...raw, p_code: token() }));
    const code = token(); await fixture.relay.createInvite(a.deviceToken, code);
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    await denied(fixture.rpc('hub_pair', { ...raw, p_code: code }));
  });

  it('does not consume a fresh invitation when an existing device/token or attempt ID collides', async () => {
    const { a, b } = await network();
    const code = token(); await fixture.relay.createInvite(b.deviceToken, code);
    const raw = { p_attempt_id: randomUUID(), p_device_id: a.deviceId, p_token: token(), p_code: code, p_name: 'Third' };
    await denied(fixture.rpc('hub_pair', raw), 'HU409');
    await denied(fixture.rpc('hub_pair', { ...raw, p_device_id: randomUUID(), p_token: a.deviceToken }), 'HU409');
    await denied(fixture.rpc('hub_pair', { ...raw, p_device_id: randomUUID(), p_attempt_id: a.attemptId }), 'HU409');
    await pair(code);
  });
});

describe('network isolation and immutable cursor-free delivery', () => {
  it('rejects cross-network send/revoke/snapshot references and derives the sender from credentials', async () => {
    const { a, b } = await network(); const outsider = await pair((await fixture.bootstrap('Other network')).code);
    expect(await fixture.relay.listDevices(a.deviceToken)).toHaveLength(2);
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(outsider.deviceId) }));
    await denied(fixture.rpc('hub_revoke', { p_token: a.deviceToken, p_device_id: outsider.deviceId }));
    await denied(fixture.rpc('hub_snapshots', { p_token: a.deviceToken, p_refs: [{ ownerDeviceId: outsider.deviceId, projectId: randomUUID() }] }));
    const outgoing = message(b.deviceId);
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: { ...outgoing, fromDeviceId: outsider.deviceId } }), 'HU400');
    const sent = await fixture.relay.send(a.deviceToken, outgoing);
    expect(sent.fromDeviceId).toBe(a.deviceId);
    expect(await fixture.relay.statuses(outsider.deviceToken, [sent.id])).toEqual([]);
    expect(await fixture.relay.pull(outsider.deviceToken)).toEqual([]);
  });

  it('hashes the exact UTF-8 JSON string and permits only identical event replays', async () => {
    const { a, b } = await network();
    const outgoing = message(b.deviceId, '{ "schemaVersion": 1, "kind": "message", "text": "你好 👋" }');
    const sent = await fixture.relay.send(a.deviceToken, outgoing);
    expect(sent.hash).toBe(createHash('sha256').update(outgoing.payload, 'utf8').digest('hex'));
    expect(await fixture.relay.send(a.deviceToken, outgoing)).toEqual(sent);
    for (const change of [{ payload: JSON.stringify(JSON.parse(outgoing.payload)) }, { toDeviceId: a.deviceId }, { expiresAt: new Date(Date.now() + 7_200_000).toISOString() }]) {
      await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: { ...outgoing, ...change } }), 'HU409');
    }
    await denied(fixture.rpc('hub_send', { p_token: b.deviceToken, p_message: outgoing }), 'HU409');
  });

  it('returns a committed duplicate after expiry but rejects a new expired event', async () => {
    const { a, b } = await network();
    const outgoing = { ...message(b.deviceId), expiresAt: new Date(Date.now() + 250).toISOString() };
    const sent = await fixture.relay.send(a.deviceToken, outgoing);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await fixture.relay.send(a.deviceToken, outgoing)).toEqual(sent);
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: { ...outgoing, id: randomUUID() } }), 'HU410');
    expect((await fixture.relay.statuses(a.deviceToken, [outgoing.id]))[0].result).toBeNull();
  });

  it('redelivers until explicit recipient ACK, handles late messages without cursors and protects receipts atomically', async () => {
    const { a, b } = await network();
    const one = await fixture.relay.send(a.deviceToken, message(b.deviceId));
    expect(await fixture.relay.pull(b.deviceToken)).toEqual([one]);
    expect(await fixture.relay.pull(b.deviceToken)).toEqual([one]);
    await denied(fixture.rpc('hub_ack', { p_token: a.deviceToken, p_ids: [one.id] }));
    await denied(fixture.rpc('hub_ack', { p_token: b.deviceToken, p_ids: [one.id, randomUUID()] }));
    expect((await fixture.relay.statuses(a.deviceToken, [one.id]))[0].receivedAt).toBeNull();
    const two = await fixture.relay.send(a.deviceToken, message(b.deviceId));
    await fixture.relay.acknowledge(b.deviceToken, [one.id]);
    const receipt = (await fixture.relay.statuses(a.deviceToken, [one.id]))[0];
    await fixture.relay.acknowledge(b.deviceToken, [one.id]);
    expect((await fixture.relay.statuses(a.deviceToken, [one.id]))[0]).toEqual(receipt);
    expect((await fixture.relay.pull(b.deviceToken)).map(m => m.id)).toEqual([two.id]);
    expect(await fixture.relay.statuses(b.deviceToken, [one.id, two.id])).toEqual([]);
  });
});

describe('fresh proposal authorization and durable monotonic results', () => {
  it('distinguishes revoked peer/source/target denial from a still-valid caller credential', async () => {
    const { a, b } = await network();
    const code = token(); await fixture.relay.createInvite(a.deviceToken, code);
    const c = await pair(code, 'Revoking desktop');
    const projectId = randomUUID();
    await fixture.relay.publish(b.deviceToken, { projectId, version: 1, project: project() });
    const incoming = await fixture.relay.send(b.deviceToken, proposal(a.deviceId));
    await fixture.relay.checkProposal(a.deviceToken, incoming.id, incoming.hash);
    expect(await fixture.relay.snapshots(a.deviceToken, [{ ownerDeviceId: b.deviceId, projectId }])).toHaveLength(1);
    // A remains active while independent device C revokes B between preview and accept.
    await fixture.relay.revokeDevice(c.deviceToken, b.deviceId);
    const deniedPeerCalls = [
      () => fixture.relay.checkProposal(a.deviceToken, incoming.id, incoming.hash),
      () => fixture.relay.send(a.deviceToken, message(b.deviceId)),
      () => fixture.relay.snapshots(a.deviceToken, [{ ownerDeviceId: b.deviceId, projectId }]),
      () => fixture.relay.snapshots(a.deviceToken, [{ ownerDeviceId: randomUUID(), projectId }]),
      () => fixture.relay.acknowledge(a.deviceToken, [randomUUID()]),
      () => fixture.relay.resolve(a.deviceToken, randomUUID(), result('rejected')),
    ];
    for (const operation of deniedPeerCalls) {
      await expect(operation()).rejects.toMatchObject({ code: 'denied', retryable: false });
      expect((await fixture.relay.listDevices(a.deviceToken)).find(d => d.id === a.deviceId)?.revokedAt).toBeNull();
    }
    const outside = await pair((await fixture.bootstrap('Outside')).code);
    await expect(fixture.relay.send(a.deviceToken, message(outside.deviceId))).rejects.toMatchObject({ code: 'denied' });
    await expect(fixture.relay.revokeDevice(a.deviceToken, outside.deviceId)).rejects.toMatchObject({ code: 'denied' });
    await expect(fixture.relay.snapshots(a.deviceToken, [{ ownerDeviceId: outside.deviceId, projectId }])).rejects.toMatchObject({ code: 'denied' });
    await expect(fixture.rpc('hub_invite', { p_token: a.deviceToken, p_code: 'malformed' })).rejects.toMatchObject({ code: 'HU400' });
    expect(await fixture.relay.listDevices(a.deviceToken)).toHaveLength(3);
    await expect(fixture.relay.listDevices(b.deviceToken)).rejects.toMatchObject({ code: 'unauthorized', retryable: false });
    // Active A can still publish and send to C after any denied peer operation.
    await fixture.relay.publish(a.deviceToken, { projectId, version: 1, project: project() });
    await expect(fixture.relay.send(a.deviceToken, message(c.deviceId))).resolves.toMatchObject({ fromDeviceId: a.deviceId });
  });

  it('checks recipient, exact hash, active source, pending state and deadline', async () => {
    const { a, b } = await network();
    const sent = await fixture.relay.send(a.deviceToken, proposal(b.deviceId));
    expect((await fixture.relay.checkProposal(b.deviceToken, sent.id, sent.hash)).id).toBe(sent.id);
    await denied(fixture.rpc('hub_check_proposal', { p_token: a.deviceToken, p_id: sent.id, p_hash: sent.hash }));
    await denied(fixture.rpc('hub_check_proposal', { p_token: b.deviceToken, p_id: sent.id, p_hash: token() }), 'HU409');
    await fixture.db.query("UPDATE hub_private.messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [sent.id]);
    await denied(fixture.rpc('hub_check_proposal', { p_token: b.deviceToken, p_id: sent.id, p_hash: sent.hash }), 'HU410');
    const another = await fixture.relay.send(a.deviceToken, proposal(b.deviceId));
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    await denied(fixture.rpc('hub_check_proposal', { p_token: b.deviceToken, p_id: another.id, p_hash: another.hash }));
  });

  it('accepts delayed authorized applied results after source revocation/expiry, idempotently and recipient-only', async () => {
    const { a, b } = await network();
    const sent = await fixture.relay.send(a.deviceToken, proposal(b.deviceId));
    await fixture.relay.checkProposal(b.deviceToken, sent.id, sent.hash);
    await denied(fixture.rpc('hub_resolve', { p_token: a.deviceToken, p_id: sent.id, p_decision: result('applied') }));
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    await fixture.db.query("UPDATE hub_private.messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [sent.id]);
    const decision = result('applied');
    await fixture.relay.resolve(b.deviceToken, sent.id, decision);
    await fixture.relay.resolve(b.deviceToken, sent.id, decision);
    await denied(fixture.rpc('hub_resolve', { p_token: b.deviceToken, p_id: sent.id, p_decision: { ...decision, status: 'rejected' } }), 'HU409');
    const stored = await fixture.db.query<{ result: unknown; received_at: unknown }>('SELECT result,received_at FROM hub_private.messages WHERE id=$1', [sent.id]);
    expect(stored.rows[0].result).toEqual(decision);
    expect(stored.rows[0].received_at).not.toBeNull();
  });

  it('allows read/rejected after expiry, never rewrites a decision or fabricates expiry', async () => {
    const { a, b } = await network();
    const plain = await fixture.relay.send(a.deviceToken, message(b.deviceId));
    const request = await fixture.relay.send(a.deviceToken, proposal(b.deviceId));
    await fixture.db.exec("UPDATE hub_private.messages SET expires_at=clock_timestamp()-interval '1 second'");
    expect((await fixture.relay.statuses(a.deviceToken, [plain.id, request.id])).every(r => r.result === null)).toBe(true);
    await fixture.relay.resolve(b.deviceToken, plain.id, result('read'));
    await fixture.relay.resolve(b.deviceToken, request.id, result('rejected'));
    await denied(fixture.rpc('hub_check_proposal', { p_token: b.deviceToken, p_id: request.id, p_hash: request.hash }), 'HU409');
    await denied(fixture.rpc('hub_resolve', { p_token: b.deviceToken, p_id: plain.id, p_decision: result('expired') }), 'HU409');
    expect((await fixture.relay.statuses(a.deviceToken, [request.id]))[0].result?.status).toBe('rejected');
  });
});

describe('snapshot ownership, tombstones, keyset pages and schema parity', () => {
  it('isolates same project IDs by owner and enforces monotonic versions with immutable same-version data', async () => {
    const { a, b } = await network(); const projectId = randomUUID();
    const publication = { projectId, version: 1, project: project() };
    await fixture.relay.publish(a.deviceToken, publication);
    await fixture.relay.publish(a.deviceToken, publication);
    await fixture.relay.publish(b.deviceToken, { ...publication, project: { ...project(), name: 'Other owner' } });
    await denied(fixture.rpc('hub_publish', { p_token: a.deviceToken, p_snapshot: { ...publication, ownerDeviceId: b.deviceId } }), 'HU400');
    await denied(fixture.rpc('hub_publish', { p_token: a.deviceToken, p_snapshot: { ...publication, project: { ...project(), name: 'Changed same version' } } }), 'HU409');
    await fixture.relay.publish(a.deviceToken, { projectId, version: 2, project: null });
    await denied(fixture.rpc('hub_publish', { p_token: a.deviceToken, p_snapshot: publication }), 'HU409');
    expect((await fixture.relay.manifest(b.deviceToken, null)).entries).toEqual([{ ownerDeviceId: a.deviceId, projectId, version: 2, deleted: true }]);
    const [tombstone] = await fixture.relay.snapshots(b.deviceToken, [{ ownerDeviceId: a.deviceId, projectId }]);
    expect(tombstone).toMatchObject({ project: null, version: 2 });
    expect((await fixture.relay.snapshots(a.deviceToken, [{ ownerDeviceId: b.deviceId, projectId }]))[0].project?.name).toBe('Other owner');
    await fixture.relay.revokeDevice(b.deviceToken, a.deviceId);
    expect((await fixture.relay.manifest(b.deviceToken, null)).entries).toEqual([]);
    await denied(fixture.rpc('hub_snapshots', { p_token: b.deviceToken, p_refs: [{ ownerDeviceId: a.deviceId, projectId }] }));
  });

  it('pages by stable owner/project keys in bounded pages, including tombstones', async () => {
    const { a, b } = await network();
    for (let i = 0; i < 53; i++) await fixture.relay.publish(a.deviceToken, { projectId: randomUUID(), version: 1, project: i % 2 ? project() : null });
    const first = await fixture.relay.manifest(b.deviceToken, null);
    const second = await fixture.relay.manifest(b.deviceToken, first.next);
    expect(first.entries).toHaveLength(50); expect(first.next).not.toBeNull();
    expect(second.entries).toHaveLength(3); expect(second.next).toBeNull();
    const keys = [...first.entries, ...second.entries].map(e => `${e.ownerDeviceId}/${e.projectId}`);
    expect(keys).toEqual([...keys].sort()); expect(new Set(keys).size).toBe(53);
    await denied(fixture.rpc('hub_manifest', { p_token: b.deviceToken, p_after: '../arbitrary' }), 'HU400');
  });

  it('mirrors every shared enum and memory field and rejects path/command/unknown/empty patch payloads', async () => {
    const { a, b } = await network();
    for (const status of PROJECT_STATUSES) for (const priority of PRIORITIES) await fixture.relay.publish(a.deviceToken, { projectId: randomUUID(), version: 1, project: { ...project(), status, priority, memory: Object.fromEntries(MEMORY_FIELDS.map(key => [key, 'shared'])) } });
    const base = JSON.parse(proposal(b.deviceId).payload);
    for (const changes of [{ command: 'echo unsafe' }, { path: 'C:\\secret' }, {}, { memory: {} }, { memory: { password: 'secret' } }, { nextAction: null }, { memory: { notes: 12 } }]) {
      expect(messagePayloadSchema.safeParse({ ...base, changes }).success).toBe(false);
      await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, JSON.stringify({ ...base, changes })) }), 'HU400');
    }
    for (const change of [{ path: 'C:\\private' }, { status: 'not-real' }, { priority: 'critical' }, { revision: 0 }, { revision: 9007199254740992 }, { stage: 'x'.repeat(161) }, { memory: { extra: 'secret' } }]) {
      await denied(fixture.rpc('hub_publish', { p_token: a.deviceToken, p_snapshot: { projectId: randomUUID(), version: 1, project: { ...project(), ...change } } }), 'HU400');
    }
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, JSON.stringify({ schemaVersion: 1, kind: 'message', text: '\u00a0\t\n' })) }), 'HU400');
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, JSON.stringify({ schemaVersion: 1, kind: 'message', text: '😀'.repeat(5001) })) }), 'HU400');
    expect((await fixture.relay.send(a.deviceToken, message(b.deviceId, JSON.stringify({ schemaVersion: 1, kind: 'message', text: '😀'.repeat(5000) })))).id).toBeTruthy();
  });
});

describe('byte and batch bounds executed in SQL', () => {
  it('enforces 256 KiB by UTF-8 bytes, not characters, on messages and snapshots', async () => {
    const { a, b } = await network();
    const small = message(b.deviceId).payload;
    await fixture.relay.send(a.deviceToken, message(b.deviceId, small.padEnd(MAX_RELAY_BYTES, ' ')));
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, small.padEnd(MAX_RELAY_BYTES + 1, ' ')) }), 'HU400');
    const largeMemory = Object.fromEntries(MEMORY_FIELDS.map(key => [key, '漢'.repeat(10_000)]));
    const payload = JSON.stringify({ schemaVersion: 1, kind: 'proposal', text: '', projectId: randomUUID(), baseRevision: 1, changes: { memory: largeMemory } });
    expect(payload.length).toBeLessThan(MAX_RELAY_BYTES); expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_RELAY_BYTES);
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, payload) }), 'HU400');
    await denied(fixture.rpc('hub_publish', { p_token: a.deviceToken, p_snapshot: { projectId: randomUUID(), version: 1, project: { ...project(), memory: largeMemory } } }), 'HU400');
    await denied(fixture.rpc('hub_send', { p_token: a.deviceToken, p_message: message(b.deviceId, JSON.stringify({ schemaVersion: 1, kind: 'proposal', text: '', projectId: randomUUID(), baseRevision: 1, changes: { nextAction: 'x'.repeat(2001) } })) }), 'HU400');
  });

  it('limits request arrays to 50 and returns a safe byte-prefix with no dropped unacked messages', async () => {
    const { a, b } = await network();
    for (const method of ['hub_ack', 'hub_statuses']) await denied(fixture.rpc(method, { p_token: b.deviceToken, p_ids: Array.from({ length: 51 }, () => randomUUID()) }), 'HU400');
    await denied(fixture.rpc('hub_snapshots', { p_token: b.deviceToken, p_refs: Array.from({ length: 51 }, () => ({ ownerDeviceId: a.deviceId, projectId: randomUUID() })) }), 'HU400');
    for (let i = 0; i < 5; i++) await fixture.relay.send(a.deviceToken, message(b.deviceId, message(b.deviceId).payload.padEnd(MAX_RELAY_BYTES, ' ')));
    const first = await fixture.relay.pull(b.deviceToken);
    expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThan(5);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1048576);
    await fixture.relay.acknowledge(b.deviceToken, first.map(m => m.id));
    const rest = await fixture.relay.pull(b.deviceToken);
    expect(first.length + rest.length).toBe(5);
    const refs = [];
    for (let i = 0; i < 5; i++) {
      const projectId = randomUUID(); refs.push({ ownerDeviceId: a.deviceId, projectId });
      await fixture.relay.publish(a.deviceToken, { projectId, version: 1, project: { ...project(), memory: Object.fromEntries(MEMORY_FIELDS.map(key => [key, '漢'.repeat(9000)])) } });
    }
    const snapshots = await fixture.relay.snapshots(b.deviceToken, refs);
    expect(snapshots.length).toBeGreaterThan(0); expect(snapshots.length).toBeLessThan(5);
    expect(Buffer.byteLength(JSON.stringify(snapshots))).toBeLessThanOrEqual(1048576);
    expect((await fixture.relay.snapshots(b.deviceToken, refs.slice(snapshots.length))).length + snapshots.length).toBe(5);
  });
});
