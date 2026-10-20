import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRelay } from '../server/supabase-relay.js';
import { RelayError } from '../server/relay.js';
import type { DeviceStatusPublication } from '../shared/governance.js';
import type { GitApproval, GitApprovalSubmission, GitExecutionResult } from '../shared/git.js';

const config = { url: 'https://governance-fixture.supabase.co', publishableKey: 'sb_publishable_only_test_key_1234567890' };
const token = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();
const request = (): GitApprovalSubmission => ({ id: randomUUID(), reviewerDeviceId: randomUUID(), digest: token(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  summary: { projectName: 'Project', kind: 'commit', paths: ['src/安全.ts'], branch: 'main', head: 'a'.repeat(40), target: null, remoteUrl: null, targetRef: null,
    changedCount: 1, stagedCount: 1, message: 'Reviewed change', authorName: 'Test', authorEmail: 'test@example.test' },
});
const approval = (r = request()): GitApproval => ({ ...r, fromDeviceId: randomUUID(), createdAt: now(), state: 'pending', decidedAt: null, reason: null,
  approvedBy: null, approvedEpoch: null, executionId: null, consumedAt: null, result: null,
});
const publication = (): DeviceStatusPublication => ({ version: 1, activity: { mode: 'foreground', sync: 'idle', lastSyncAt: null, operations: [] }, projects: [] });
function stub(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
  return { fetch, g: createSupabaseRelay(config, { fetch }).governance! };
}

describe('optional governance capability and explicit v2 RPC transport', () => {
  it('maps every fixed method to its named RPC using bounded existing transport, body-only token auth and exact status bytes', async () => {
    const secret = token(), r = request(), pending = approval(r), executionId = randomUUID(), consumedAt = now();
    const approved = { ...pending, state: 'approved', approvedBy: r.reviewerDeviceId, approvedEpoch: 4, decidedAt: now(), reason: 'Reviewed' };
    const own = randomUUID(), networkId = randomUUID(), status = publication();
    const result: GitExecutionResult = { status: 'succeeded', code: 'git.ok', head: 'b'.repeat(40) };
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input)), name = url.pathname.split('/').at(-1)!, body = JSON.parse(String(init?.body));
      expect(url.origin).toBe(config.url); expect(url.search).toBe(''); expect(String(input)).not.toContain(secret);
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers); expect(headers.get('apikey')).toBe(config.publishableKey); expect(headers.has('authorization')).toBe(false);
      expect(body.p_token).toBe(secret); calls.push({ name, body });
      const responses: Record<string, unknown> = {
        hub_v2_policy: { protocol: 2, networkId, deviceId: own, role: 'member', epoch: 4, roles: [{ deviceId: own, role: 'member' }, { deviceId: r.reviewerDeviceId, role: 'admin' }] },
        hub_v2_submit_git: pending, hub_v2_list_git: [pending], hub_v2_get_git: pending,
        hub_v2_decide_git: approved, hub_v2_cancel_git: { ...approved, state: 'cancelled' },
        hub_v2_consume_git: { id: r.id, executionId, consumedAt, replayed: false },
        hub_v2_statuses: [{ ...status, deviceId: own, receivedAt: now() }],
      };
      return Response.json(responses[name] ?? null);
    });
    const relay = createSupabaseRelay(config, { fetch }), g = relay.governance!;
    await g.policy(secret); await g.setRole(secret, own, 'admin'); await g.submitGit(secret, r); await g.listGit(secret); await g.getGit(secret, r.id);
    await g.decideGit(secret, r.id, r.digest, 'approved', 'Reviewed'); await g.cancelGit(secret, r.id, r.digest);
    expect(await g.consumeGit(secret, r.id, r.digest, executionId)).toEqual({ id: r.id, executionId, consumedAt, replayed: false });
    await g.reportGit(secret, r.id, executionId, result); await g.publishStatus(secret, status); await g.statuses(secret);
    expect(calls.map(c => c.name)).toEqual(['hub_v2_policy', 'hub_v2_set_role', 'hub_v2_submit_git', 'hub_v2_list_git', 'hub_v2_get_git', 'hub_v2_decide_git', 'hub_v2_cancel_git', 'hub_v2_consume_git', 'hub_v2_report_git', 'hub_v2_publish_status', 'hub_v2_statuses']);
    expect(calls[1].body).toEqual({ p_token: secret, p_device_id: own, p_role: 'admin' });
    expect(calls[2].body).toEqual({ p_token: secret, p_request: r });
    expect(calls[5].body).toEqual({ p_token: secret, p_id: r.id, p_digest: r.digest, p_decision: 'approved', p_reason: 'Reviewed' });
    expect(calls[7].body).toEqual({ p_token: secret, p_id: r.id, p_digest: r.digest, p_execution_id: executionId });
    expect(calls[8].body).toEqual({ p_token: secret, p_id: r.id, p_execution_id: executionId, p_result: result });
    expect(calls[9].body).toEqual({ p_token: secret, p_status: JSON.stringify(status) });
  });

  it('validates all local DTOs and privacy limits before networking and never accepts command/root/source fields', () => {
    const { fetch, g } = stub(null), secret = token(), r = request(), p = publication();
    const invalid: (() => unknown)[] = [
      () => g.policy('wrong'), () => g.setRole(secret, r.id, 'owner' as 'admin'), () => g.getGit(secret, 'bad'),
      () => g.submitGit(secret, { ...r, root: 'C:/secret' } as GitApprovalSubmission),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, source: 'source code' } } as GitApprovalSubmission),
      () => g.submitGit(secret, { ...r, digest: 'A'.repeat(64) }),
      () => g.submitGit(secret, { ...r, digest: r.digest + '\n' }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, head: 'a'.repeat(40) + '\n' } }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, remoteUrl: 'https://example.test/repo\n' } }),
      () => g.reportGit(secret, r.id, randomUUID(), { status: 'failed', code: 'safe\n', head: null }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, paths: ['C:/secret'] } }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, paths: ['../secret'] } }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, remoteUrl: 'https://user:secret@example.test/repo' } }),
      () => g.submitGit(secret, { ...r, summary: { ...r.summary, paths: Array(200).fill('漢'.repeat(1000)) } }),
      () => g.decideGit(secret, r.id, r.digest, 'anything' as 'approved', ''), () => g.decideGit(secret, r.id, r.digest, 'approved', 'x'.repeat(1001)),
      () => g.cancelGit(secret, r.id, 'bad'), () => g.consumeGit(secret, r.id, r.digest, 'bad'),
      () => g.reportGit(secret, r.id, randomUUID(), { status: 'failed', code: 'C:/secret', head: null }),
      () => g.reportGit(secret, r.id, randomUUID(), { status: 'failed', code: 'safe', head: null, stderr: 'secret' } as GitExecutionResult),
      () => g.publishStatus(secret, { ...p, deviceId: randomUUID() } as DeviceStatusPublication),
      () => g.publishStatus(secret, { ...p, activity: { ...p.activity!, operations: Array(11).fill({ kind: 'git', state: 'running', at: now() }) } }),
    ];
    const projects = Array.from({ length: 20 }, () => ({ projectId: randomUUID(), name: '漢'.repeat(120), git: null, tasks: null }));
    invalid.push(() => g.publishStatus(secret, { ...p, projects }));
    invalid.push(() => g.publishStatus(secret, { ...p, projects: [projects[0], projects[0]] }));
    for (const invoke of invalid) expect(invoke).toThrow(RelayError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pins returned identities, immutable request contents and execution nonce; rejects added fields or inconsistent policy/approval state', async () => {
    const secret = token(), r = request(), a = approval(r), executionId = randomUUID();
    for (const value of [
      { ...a, id: randomUUID() }, { ...a, digest: token() }, { ...a, reviewerDeviceId: randomUUID() },
      { ...a, expiresAt: now() }, { ...a, summary: { ...a.summary, paths: ['changed'] } }, { ...a, token: secret },
      { ...a, state: 'approved' }, { ...a, result: { status: 'succeeded', code: 'ok', head: null } },
    ]) await expect(stub(value).g.submitGit(secret, r)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub(a).g.getGit(secret, randomUUID())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub(a).g.cancelGit(secret, r.id, r.digest)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub({ ...a, state: 'approved', approvedBy: r.reviewerDeviceId, approvedEpoch: 1, decidedAt: now(), reason: 'different' }).g.decideGit(secret, r.id, r.digest, 'approved', 'expected')).rejects.toMatchObject({ code: 'unavailable' });
    for (const change of [{ id: randomUUID() }, { executionId: randomUUID() }, { replayed: 'false' }, { authorization: true }]) {
      await expect(stub({ id: r.id, executionId, consumedAt: now(), replayed: false, ...change }).g.consumeGit(secret, r.id, r.digest, executionId)).rejects.toMatchObject({ code: 'unavailable' });
    }
    const self = randomUUID(), policy = { protocol: 2, networkId: randomUUID(), deviceId: self, role: 'member', epoch: 0, roles: [{ deviceId: self, role: 'member' }] };
    for (const change of [{ protocol: 1 }, { epoch: -1 }, { roles: [] }, { role: 'admin' }, { roles: [policy.roles[0], policy.roles[0]] }, { privateKey: secret }]) await expect(stub({ ...policy, ...change }).g.policy(secret)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub(Array(101).fill(a)).g.listGit(secret)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub([{ ...publication(), deviceId: self, receivedAt: now(), root: '/private' }]).g.statuses(secret)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub({ ok: true }).g.reportGit(secret, r.id, executionId, { status: 'unknown', code: 'unknown', head: null })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('exposes replayed=true verbatim rather than converting a historical receipt into new authorization', async () => {
    const r = request(), executionId = randomUUID(), consumedAt = now();
    expect(await stub({ id: r.id, executionId, consumedAt, replayed: true }).g.consumeGit(token(), r.id, r.digest, executionId)).toEqual({ id: r.id, executionId, consumedAt, replayed: true });
  });
});

describe('governance fails closed with bounded, secret-free provider errors', () => {
  it('maps missing old-relay capability to unavailable, not unauthorized or an implicit mutation bypass', async () => {
    const secret = token(), r = request();
    for (const code of ['PGRST202', '42883', 'XX000']) {
      const { fetch, g } = stub({ code, message: `SQL ${secret}`, details: 'private SQL details', hint: config.publishableKey }, 404);
      await expect(g.policy(secret)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
      await expect(g.consumeGit(secret, r.id, r.digest, randomUUID())).rejects.toMatchObject({ code: 'unavailable' });
      expect(fetch.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['hub_v2_policy', 'hub_v2_consume_git']);
    }
  });

  it('keeps SQL/auth/provider errors secret-free using only bounded machine codes', async () => {
    const secret = token();
    for (const [code, expected] of [['HU400', 'invalid'], ['HU401', 'unauthorized'], ['HU403', 'denied'], ['HU409', 'conflict'], ['HU410', 'expired'], ['PGRST202', 'unavailable']]) {
      const error: unknown = await stub({ code, message: secret, details: config.publishableKey, hint: 'private' }, 400).g.policy(secret).catch(error => error);
      expect(error).toMatchObject({ code: expected }); expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(config.publishableKey); expect(String(error)).not.toContain('private');
    }
    for (const status of [401, 403, 500]) await expect(stub({}, status).g.policy(secret)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reuses response streaming byte bounds and abort deadlines for v2, including hung transports', async () => {
    let cancelled = false;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(256 * 1024).fill(32)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json', 'content-length': '2' } });
    await expect(createSupabaseRelay(config, { fetch: fetcher }).governance!.statuses(token())).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancelled).toBe(true);
    const hung = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    await expect(createSupabaseRelay(config, { fetch: hung, timeoutMs: 10 }).governance!.policy(token())).rejects.toMatchObject({ code: 'unavailable' });
    const controller = new AbortController(), g = createSupabaseRelay(config, { fetch: hung }).governance!;
    const pending = g.listGit(token(), controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(g.listGit(token(), controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(hung).toHaveBeenCalledTimes(2);
  });
});
