import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PairAttempt } from '../shared/devices.js';
import { APP_NAME_FORBIDDEN_RANGES, appObservationPublicationSchema, type AppObservationPublication } from '../shared/app-observation.js';
import { createSqlRelayFixture, type SqlRelayFixture } from './helpers/sql-relay.js';

const token = () => randomBytes(32).toString('hex');
const publication = (name: string | null = 'Visual Studio Code', sequence = 1): AppObservationPublication => ({ protocol: 1, sequence, observation: { name, observedAt: '2026-10-24T01:02:03.004Z' } });
const denied = (promise: Promise<unknown>, code = 'HU400') => expect(promise).rejects.toMatchObject({ code });
const publishRaw = (deviceToken: string, value: unknown) => f.rpc('hub_app_v1_publish', { p_token: deviceToken, p_payload: JSON.stringify(value) });
let f: SqlRelayFixture;
async function pair(code: string, fixture = f) {
  const attempt: PairAttempt = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: token(), inviteToken: code, name: 'App test device' };
  const result = await fixture.relay.pair(attempt);
  return { ...attempt, networkId: result.networkId };
}
beforeAll(async () => { f = await createSqlRelayFixture(); }, 60_000);
afterAll(async () => { await f?.close(); });
beforeEach(async () => { await f.reset(); });

describe('actual independent app SQL migration', () => {
  it('derives capability identity from the active caller token for both API roles', async () => {
    const a = await pair((await f.bootstrap()).code);
    for (const role of ['anon', 'authenticated'] as const) {
      expect(await f.rpc('hub_app_v1_capability', { p_token: a.deviceToken }, role)).toEqual({ protocol: 1, networkId: a.networkId, deviceId: a.deviceId });
    }
    expect(await f.relay.appObservation!.capability(a.deviceToken)).toEqual({ protocol: 1, networkId: a.networkId, deviceId: a.deviceId });
  });

  it('shares only the latest observation, distinguishes unavailable from withdrawal and preserves exact retry receipts', async () => {
    const a = await pair((await f.bootstrap()).code), code = token();
    await f.relay.createInvite(a.deviceToken, code);
    const b = await pair(code), app = f.relay.appObservation!;
    const first: AppObservationPublication = { protocol: 1, sequence: 1, observation: { name: 'Visual Studio Code', observedAt: '2026-10-24T01:02:03.004Z' } };
    await app.publish(b.deviceToken, first);
    const initial = await app.statuses(a.deviceToken);
    expect(initial).toEqual([{ ...first, deviceId: b.deviceId, receivedAt: expect.any(String) }]);
    await app.publish(b.deviceToken, first);
    expect(await app.statuses(a.deviceToken)).toEqual(initial);
    await expect(f.rpc('hub_app_v1_publish', { p_token: b.deviceToken, p_payload: JSON.stringify(first) + ' ' })).rejects.toMatchObject({ code: 'HU409' });
    await expect(app.publish(b.deviceToken, { ...first, observation: null })).rejects.toMatchObject({ code: 'conflict' });
    const next = { ...first, sequence: 2, observation: { ...first.observation!, name: 'Firefox' } };
    await app.publish(b.deviceToken, next);
    expect(await app.statuses(a.deviceToken)).toEqual([{ ...next, deviceId: b.deviceId, receivedAt: expect.any(String) }]);
    await expect(app.publish(b.deviceToken, first)).rejects.toMatchObject({ code: 'conflict' });
    const unavailable = { ...first, sequence: 3, observation: { ...first.observation!, name: null } };
    await app.publish(b.deviceToken, unavailable);
    expect((await app.statuses(a.deviceToken))[0].observation).toEqual(unavailable.observation);
    await app.publish(b.deviceToken, { protocol: 1, sequence: 4, observation: null });
    expect(await app.statuses(a.deviceToken)).toEqual([{ protocol: 1, sequence: 4, observation: null, deviceId: b.deviceId, receivedAt: expect.any(String) }]);
    await expect(app.publish(b.deviceToken, next)).rejects.toMatchObject({ code: 'conflict' });
    const rows = await f.asRole('postgres', 'SELECT * FROM hub_private.app_observations');
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toMatch(/Firefox|Visual Studio Code/);
    expect((await f.asRole('postgres', 'SELECT count(*)::integer AS count FROM hub_private.messages')).rows).toEqual([{ count: 0 }]);
  });

  it('isolates networks, authenticates every RPC and deletes the full revoked-device row without changing legacy revoke', async () => {
    const a = await pair((await f.bootstrap()).code), code = token();
    await f.relay.createInvite(a.deviceToken, code);
    const b = await pair(code), outside = await pair((await f.bootstrap()).code), app = f.relay.appObservation!;
    await app.publish(a.deviceToken, publication('HelpTool'));
    await app.publish(b.deviceToken, publication('Firefox'));
    await app.publish(outside.deviceToken, publication('Other network'));
    expect((await app.statuses(a.deviceToken)).map(value => value.deviceId).sort()).toEqual([a.deviceId, b.deviceId].sort());
    expect((await app.statuses(outside.deviceToken)).map(value => value.deviceId)).toEqual([outside.deviceId]);
    await denied(publishRaw(b.deviceToken, { ...publication(), deviceId: a.deviceId }));
    await denied(publishRaw(b.deviceToken, { ...publication(), networkId: outside.networkId }));
    await expect(f.relay.revokeDevice(outside.deviceToken, b.deviceId)).rejects.toMatchObject({ code: 'denied' });
    await expect(f.relay.revokeDevice(b.deviceToken, a.deviceId)).rejects.toMatchObject({ code: 'denied' });
    await f.relay.revokeDevice(a.deviceToken, b.deviceId);
    for (const p_token of [b.deviceToken, token(), 'bad', null]) {
      await denied(f.rpc('hub_app_v1_capability', { p_token }), 'HU401');
      await denied(f.rpc('hub_app_v1_statuses', { p_token }), 'HU401');
      await denied(f.rpc('hub_app_v1_publish', { p_token, p_payload: JSON.stringify(publication()) }), 'HU401');
    }
    await expect(app.capability(b.deviceToken)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await app.statuses(a.deviceToken)).map(value => value.deviceId)).toEqual([a.deviceId]);
    expect((await f.asRole('postgres', 'SELECT * FROM hub_private.app_observations WHERE device_id=$1', [b.deviceId])).rows).toEqual([]);
    const retained = (await f.asRole('postgres', 'SELECT * FROM hub_private.app_observations')).rows;
    expect(retained).toHaveLength(2);
    expect(JSON.stringify(retained)).not.toContain('Firefox');
  });

  it('grants exactly three dedicated definer RPCs and no private table/helper access under real SET ROLE', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const statement of [
        'SELECT * FROM hub_private.app_observations', 'DELETE FROM hub_private.app_observations',
        "INSERT INTO hub_private.app_observations SELECT * FROM hub_private.app_observations", "UPDATE hub_private.app_observations SET payload='{}'",
        "SELECT hub_private.app_observation_value('{}')", "SELECT hub_private.app_observation_name_ok('null')",
        "SELECT hub_private.app_observation_timestamp_ok('null')", 'SELECT hub_private.clear_revoked_app_observation()',
      ]) await denied(f.asRole(role, statement), '42501');
    }
    const functions = await f.db.query<{ name: string; owner: string; definer: boolean; config: string[]; anon: boolean; authenticated: boolean; public: boolean }>(`
      SELECT p.proname AS name,r.rolname AS owner,p.prosecdef AS definer,p.proconfig AS config,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'hub_app_%' ORDER BY p.proname`);
    expect(functions.rows.map(value => value.name)).toEqual(['hub_app_v1_capability', 'hub_app_v1_publish', 'hub_app_v1_statuses']);
    for (const value of functions.rows) expect(value).toMatchObject({ owner: 'hub_relay_owner', definer: true, config: ['search_path=""'], anon: true, authenticated: true, public: false });
    const table = await f.db.query<{ rls: boolean; owner: string; allowed: boolean }>(`
      SELECT c.relrowsecurity AS rls,r.rolname AS owner,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS allowed
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='hub_private.app_observations'::regclass`);
    expect(table.rows).toEqual([{ rls: true, owner: 'hub_relay_owner', allowed: false }]);
    expect((await f.db.query("SELECT * FROM pg_policies WHERE schemaname='hub_private' AND tablename='app_observations'")).rows).toEqual([]);
    expect((await f.db.query("SELECT has_schema_privilege('hub_relay_owner','public','CREATE') AS allowed")).rows).toEqual([{ allowed: false }]);
    const helpers = await f.db.query<{ allowed: boolean }>(`SELECT has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') AS allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hub_private' AND (p.proname LIKE 'app_observation_%' OR p.proname='clear_revoked_app_observation')`);
    expect(helpers.rows).toHaveLength(4); expect(helpers.rows.every(value => !value.allowed)).toBe(true);
  });

  it('rejects unknown/nested private fields, malformed values and hidden duplicate members instead of sanitizing', async () => {
    const a = await pair((await f.bootstrap()).code), base = publication();
    for (const value of [null, [], 1, false, {}, { ...base, protocol: 2 }, { ...base, protocol: '1' }, { ...base, sequence: '1' }, { ...base, sequence: 0 },
      { ...base, sequence: -1 }, { ...base, sequence: 1.2 }, { ...base, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { protocol: 1, sequence: 1 }, { ...base, observation: {} }, { ...base, observation: 'App' }, { ...base, observation: { observedAt: base.observation!.observedAt } },
      { ...base, observation: { name: 'App' } }, { ...base, observation: { name: 123, observedAt: base.observation!.observedAt } },
    ]) await denied(publishRaw(a.deviceToken, value));
    for (const extra of [{ title: 'Document sentinel' }, { path: 'C:/private' }, { pid: 91 }, { url: 'https://private.test' }, { input: 'secret keys' }, { deviceId: randomUUID() }, { networkId: randomUUID() }]) {
      await denied(publishRaw(a.deviceToken, { ...base, ...extra }));
      await denied(publishRaw(a.deviceToken, { ...base, observation: { ...base.observation!, ...extra } }));
    }
    const time = base.observation!.observedAt;
    for (const p_payload of [null, '{bad', '{"protocol":1,"protocol":1,"sequence":1,"observation":null}',
      `{"protocol":1,"sequence":1,"observation":{"name":"C:/hidden","name":"App","observedAt":"${time}"}}`,
      `{"protocol":1,"sequence":1,"observation":{"name":"App","observedAt":"secret","observedAt":"${time}"}}`,
      `{"protocol":1,"sequence":1,"observation":{"name":"Hidden","observedAt":"${time}"},"observation":null}`,
    ]) await denied(f.rpc('hub_app_v1_publish', { p_token: a.deviceToken, p_payload }));
    expect(await f.relay.appObservation!.statuses(a.deviceToken)).toEqual([]);
  });

  it('matches the shared Unicode/path/byte bounds and admits 96 astral code points, not 96 UTF-16 units', async () => {
    const a = await pair((await f.bootstrap()).code), forbidden = APP_NAME_FORBIDDEN_RANGES.flatMap(([first, last]) => [first, last]).map(point => `App${String.fromCodePoint(point)}`);
    for (const name of ['', '.', '..', ' padded', 'padded ', '\u3000App', 'App\u00a0', 'App/name', 'App\\name', 'App:name', 'App*name', 'App?name', 'App"name', 'App<name', 'App>name', 'App|name',
      'A'.repeat(97), '😀'.repeat(97), ...forbidden]) {
      const value = publication(name);
      expect(appObservationPublicationSchema.safeParse(value).success, JSON.stringify(name)).toBe(false);
      await denied(publishRaw(a.deviceToken, value));
    }
    let sequence = 0;
    for (const name of ['A'.repeat(96), '漢'.repeat(96), '😀'.repeat(96), 'Visual Studio Code', '瀏覽器', 'code.exe', 'e\u0301ditor', null]) {
      const value = publication(name, ++sequence);
      expect(appObservationPublicationSchema.safeParse(value).success).toBe(true);
      await expect(publishRaw(a.deviceToken, value)).resolves.toBeNull();
      expect((await f.relay.appObservation!.statuses(a.deviceToken))[0].observation?.name).toBe(name);
    }
    const raw = JSON.stringify(publication('😀'.repeat(96), ++sequence)), padded = raw + ' '.repeat(1024 - Buffer.byteLength(raw, 'utf8'));
    expect(Buffer.byteLength(padded, 'utf8')).toBe(1024);
    await expect(f.rpc('hub_app_v1_publish', { p_token: a.deviceToken, p_payload: padded })).resolves.toBeNull();
    await denied(f.rpc('hub_app_v1_publish', { p_token: a.deviceToken, p_payload: padded + ' ' }));
    await denied(f.rpc('hub_app_v1_publish', { p_token: a.deviceToken, p_payload: raw }), 'HU409');
  });

  it('requires bounded real ISO source timestamps, preserving accepted precision/offset text verbatim', async () => {
    const a = await pair((await f.bootstrap()).code), base = publication();
    for (const observedAt of [null, 1, 'today', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '1900-02-29T00:00:00Z', '0000-01-01T00:00:00Z',
      '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+14:01', '2026-01-01T00:00:00+15:00',
      '2026-01-01T00:00Z', '2026-01-01T00:00:00+0800', '2026-01-01T00:00:00.1234567890Z',
      '2026-01-01T00:00:00', '2026-01-01T00:00:00Z\n', `2026-01-01T00:00:00.${'1'.repeat(80)}Z`,
    ]) {
      const value = { ...base, observation: { name: 'App', observedAt } };
      expect(appObservationPublicationSchema.safeParse(value).success, String(observedAt)).toBe(false);
      await denied(publishRaw(a.deviceToken, value));
    }
    let sequence = 0;
    for (const observedAt of ['0001-01-01T00:00:00Z', '2000-02-29T23:59:59.123456789Z', '9999-12-31T23:59:59Z', '2026-10-24T00:00:00+14:00', '2026-10-24T00:00:00-13:59']) {
      const value = { ...base, sequence: ++sequence, observation: { name: 'App', observedAt } };
      expect(appObservationPublicationSchema.safeParse(value).success).toBe(true);
      await f.relay.appObservation!.publish(a.deviceToken, value);
      expect((await f.relay.appObservation!.statuses(a.deviceToken))[0].observation?.observedAt).toBe(observedAt);
    }
  });

  it('bounds a full network to 100 latest statuses within 150 KiB and permits both API roles to use their own token', async () => {
    const admin = await pair((await f.bootstrap()).code), all = [admin];
    for (let i = 1; i < 100; i++) {
      const code = token(); await f.relay.createInvite(admin.deviceToken, code); all.push(await pair(code));
    }
    const value = publication('😀'.repeat(96), Number.MAX_SAFE_INTEGER);
    for (const [i, actor] of all.entries()) await expect(f.rpc('hub_app_v1_publish', { p_token: actor.deviceToken, p_payload: JSON.stringify(value) }, i % 2 ? 'anon' : 'authenticated')).resolves.toBeNull();
    const statuses = await f.relay.appObservation!.statuses(admin.deviceToken);
    expect(statuses).toHaveLength(100);
    expect(new Set(statuses.map(status => status.deviceId)).size).toBe(100);
    expect(statuses.every(status => status.sequence === Number.MAX_SAFE_INTEGER && status.observation?.name === value.observation?.name)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(statuses), 'utf8')).toBeLessThanOrEqual(150 * 1024);
    expect(await f.rpc('hub_app_v1_statuses', { p_token: admin.deviceToken }, 'authenticated')).toEqual(statuses);
    const extra = token(); await f.relay.createInvite(admin.deviceToken, extra);
    await expect(pair(extra)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.asRole('postgres', 'SELECT count(*)::integer AS count FROM hub_private.app_observations')).rows).toEqual([{ count: 100 }]);
    expect((await f.asRole('postgres', 'SELECT count(*)::integer AS count FROM hub_private.messages')).rows).toEqual([{ count: 0 }]);
  });

  it('supports missing-migration detection without disturbing old governance and leaves every existing SQL function unchanged on upgrade', async () => {
    const legacy = await createSqlRelayFixture({ includeAppObservation: false });
    try {
      const a = await pair((await legacy.bootstrap()).code, legacy), g = legacy.relay.governance!;
      expect(await legacy.relay.appObservation!.capability(a.deviceToken)).toBeNull();
      const policy = await g.policy(a.deviceToken);
      const oldStatus = { version: 1, activity: { mode: 'foreground' as const, sync: 'online' as const, lastSyncAt: null, operations: [] }, projects: [] };
      await g.publishStatus(a.deviceToken, oldStatus);
      const statuses = await g.statuses(a.deviceToken);
      const definitions = `SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl,p.proowner
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='public' AND p.proname LIKE 'hub_%' AND p.proname NOT LIKE 'hub_app_%')
        OR (n.nspname='hub_private' AND p.proname NOT LIKE 'app_observation_%' AND p.proname<>'clear_revoked_app_observation') ORDER BY n.nspname,p.proname,args`;
      const before = (await legacy.db.query(definitions)).rows;
      await legacy.db.exec(await readFile(new URL('../supabase/migrations/202610240001_foreground_app.sql', import.meta.url), 'utf8'));
      expect((await legacy.db.query(definitions)).rows).toEqual(before);
      expect(await legacy.relay.appObservation!.capability(a.deviceToken)).toEqual({ protocol: 1, networkId: a.networkId, deviceId: a.deviceId });
      await legacy.relay.appObservation!.publish(a.deviceToken, publication());
      expect(await g.policy(a.deviceToken)).toEqual(policy);
      await g.publishStatus(a.deviceToken, oldStatus);
      expect(await g.statuses(a.deviceToken)).toEqual(statuses);
      expect(Object.keys(statuses[0]).sort()).toEqual(['activity', 'deviceId', 'projects', 'receivedAt', 'version']);
    } finally { await legacy.close(); }
  }, 60_000);
});
