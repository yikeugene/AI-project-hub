import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createSupabaseRelay } from '../../server/supabase-relay.js';
import type { RelayConfiguration } from '../../shared/devices.js';

export const sqlRelayConfiguration: RelayConfiguration = {
  url: 'https://local-relay-test.supabase.co', publishableKey: 'sb_publishable_local_sql_test_only_000000',
};
// GovernanceRelay -> versioned RPC mapping, also used for actual SQL integration tests.
// publishStatus intentionally transports a TEXT JSON string: version equality is exact
// UTF-8 bytes, not JSONB equivalence. All other structured inputs use strict JSONB DTOs.
const signatures: Record<string, { sql: string; parameters: string[] }> = {
  hub_v2_policy: { sql: 'SELECT public.hub_v2_policy($1::text) AS result', parameters: ['p_token'] },
  hub_v2_set_role: { sql: 'SELECT public.hub_v2_set_role($1::text,$2::uuid,$3::text) AS result', parameters: ['p_token', 'p_device_id', 'p_role'] },
  hub_v2_submit_git: { sql: 'SELECT public.hub_v2_submit_git($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_request'] },
  hub_v2_list_git: { sql: 'SELECT public.hub_v2_list_git($1::text) AS result', parameters: ['p_token'] },
  hub_v2_get_git: { sql: 'SELECT public.hub_v2_get_git($1::text,$2::uuid) AS result', parameters: ['p_token', 'p_id'] },
  hub_v2_decide_git: { sql: 'SELECT public.hub_v2_decide_git($1::text,$2::uuid,$3::text,$4::text,$5::text) AS result', parameters: ['p_token', 'p_id', 'p_digest', 'p_decision', 'p_reason'] },
  hub_v2_cancel_git: { sql: 'SELECT public.hub_v2_cancel_git($1::text,$2::uuid,$3::text) AS result', parameters: ['p_token', 'p_id', 'p_digest'] },
  hub_v2_consume_git: { sql: 'SELECT public.hub_v2_consume_git($1::text,$2::uuid,$3::text,$4::uuid) AS result', parameters: ['p_token', 'p_id', 'p_digest', 'p_execution_id'] },
  hub_v2_report_git: { sql: 'SELECT public.hub_v2_report_git($1::text,$2::uuid,$3::uuid,$4::jsonb) AS result', parameters: ['p_token', 'p_id', 'p_execution_id', 'p_result'] },
  hub_v2_publish_status: { sql: 'SELECT public.hub_v2_publish_status($1::text,$2::text) AS result', parameters: ['p_token', 'p_status'] },
  hub_v2_statuses: { sql: 'SELECT public.hub_v2_statuses($1::text) AS result', parameters: ['p_token'] },
  hub_pair: { sql: 'SELECT public.hub_pair($1::uuid,$2::uuid,$3::text,$4::text,$5::text) AS result', parameters: ['p_attempt_id', 'p_device_id', 'p_token', 'p_code', 'p_name'] },
  hub_devices: { sql: 'SELECT public.hub_devices($1::text) AS result', parameters: ['p_token'] },
  hub_rename: { sql: 'SELECT public.hub_rename($1::text,$2::text) AS result', parameters: ['p_token', 'p_name'] },
  hub_invite: { sql: 'SELECT public.hub_invite($1::text,$2::text) AS result', parameters: ['p_token', 'p_code'] },
  hub_revoke: { sql: 'SELECT public.hub_revoke($1::text,$2::uuid) AS result', parameters: ['p_token', 'p_device_id'] },
  hub_publish: { sql: 'SELECT public.hub_publish($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_snapshot'] },
  hub_manifest: { sql: 'SELECT public.hub_manifest($1::text,$2::text) AS result', parameters: ['p_token', 'p_after'] },
  hub_snapshots: { sql: 'SELECT public.hub_snapshots($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_refs'] },
  hub_send: { sql: 'SELECT public.hub_send($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_message'] },
  hub_pull: { sql: 'SELECT public.hub_pull($1::text) AS result', parameters: ['p_token'] },
  hub_ack: { sql: 'SELECT public.hub_ack($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_ids'] },
  hub_statuses: { sql: 'SELECT public.hub_statuses($1::text,$2::jsonb) AS result', parameters: ['p_token', 'p_ids'] },
  hub_check_proposal: { sql: 'SELECT public.hub_check_proposal($1::text,$2::uuid,$3::text) AS result', parameters: ['p_token', 'p_id', 'p_hash'] },
  hub_resolve: { sql: 'SELECT public.hub_resolve($1::text,$2::uuid,$3::jsonb) AS result', parameters: ['p_token', 'p_id', 'p_decision'] },
};

/** Actual delivered SQL and actual SET LOCAL ROLE, not an in-memory relay imitation.
 * One instance can serve multiple isolated desktop stores. Always close it after tests.
 * Transport is injected; the production adapter's endpoint restrictions are unchanged.
 */
export async function createSqlRelayFixture(options: { governance?: boolean } = {}) {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
    const migration = await readFile(fileURLToPath(new URL('../../supabase/migrations/202610190001_desktop_relay.sql', import.meta.url)), 'utf8');
    await db.exec(migration);
    if (options.governance !== false) {
      await db.exec(await readFile(fileURLToPath(new URL('../../supabase/migrations/202610200001_device_git_approval.sql', import.meta.url)), 'utf8'));
    }
  } catch (error) { await db.close(); throw error; }
  async function asRole<T extends Record<string, unknown> = Record<string, unknown>>(role: 'anon' | 'authenticated' | 'postgres', sql: string, parameters: unknown[] = []) {
    return db.transaction(async tx => {
      // Fixed role allowlist, not user input. The actual PostgreSQL ACLs apply.
      await tx.exec(role === 'anon' ? 'SET LOCAL ROLE anon' : role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE postgres');
      return tx.query<T>(sql, parameters);
    });
  }
  async function rpc(name: string, args: Record<string, unknown>, role: 'anon' | 'authenticated' = 'anon'): Promise<unknown> {
    const signature = signatures[name];
    if (!signature || Object.keys(args).length !== signature.parameters.length || signature.parameters.some(key => !(key in args))) throw new Error('Unknown SQL relay RPC signature');
    const parameters = signature.parameters.map(key => {
      const value = args[key];
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    });
    const result = await asRole<{ result: unknown }>(role, signature.sql, parameters);
    return result.rows[0].result;
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== sqlRelayConfiguration.url || init?.method !== 'POST' || init.redirect !== 'error') throw new Error('Invalid fixture request');
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const result = await rpc(url.pathname.replace('/rest/v1/rpc/', ''), JSON.parse(String(init.body)));
      return Response.json(result);
    } catch (error) {
      // Same machine-code envelope used by PostgREST; no SQL query/parameters in responses.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'XX000';
      return Response.json({ code, message: 'SQL fixture request refused' }, { status: 400 });
    }
  };
  return {
    db, rpc, asRole, fetch: fetcher, configuration: sqlRelayConfiguration,
    relay: createSupabaseRelay(sqlRelayConfiguration, { fetch: fetcher }),
    async bootstrap(name = 'Test devices'): Promise<{ networkId: string; code: string; expiresAt: string }> {
      const result = await asRole<{ result: { networkId: string; code: string; expiresAt: string } }>('postgres', 'SELECT hub_private.bootstrap($1) AS result', [name]);
      return result.rows[0].result;
    },
    async reset() { await db.exec('TRUNCATE hub_private.networks CASCADE'); },
    async close() { await db.close(); },
  };
}
export type SqlRelayFixture = Awaited<ReturnType<typeof createSqlRelayFixture>>;
