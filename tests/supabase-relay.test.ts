import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRelay, validateRelayConfiguration } from '../server/supabase-relay.js';
import { RelayError } from '../server/relay.js';
import { MAX_RELAY_BYTES, type OutboundMessage, type RelayConfiguration, type RelayMessage, type SnapshotPublication } from '../shared/devices.js';

const config: RelayConfiguration = { url: 'https://relay-project.supabase.co', publishableKey: 'sb_publishable_public_test_key_1234567890' };
const token = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();
const jwt = (role: string, alg = 'HS256') => [Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url'), 'x'.repeat(43)].join('.');
const device = (id = randomUUID()) => ({ id, name: 'Desktop', lastSeenAt: now(), revokedAt: null });
const outbound = (): OutboundMessage => ({ id: randomUUID(), toDeviceId: randomUUID(), payload: JSON.stringify({ schemaVersion: 1, kind: 'message', text: 'Hello' }), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
const envelope = (message: OutboundMessage = outbound()): RelayMessage => ({ ...message, fromDeviceId: randomUUID(), hash: createHash('sha256').update(message.payload).digest('hex'), createdAt: now(), receivedAt: null, result: null });

function stub(response: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response, { status }));
  return { fetch, relay: createSupabaseRelay(config, { fetch }) };
}

describe('public Supabase origin and key configuration', () => {
  it('accepts publishable keys or legacy anon JWTs and normalizes the root origin', () => {
    expect(validateRelayConfiguration({ ...config, url: `${config.url}/` })).toEqual(config);
    expect(validateRelayConfiguration({ ...config, publishableKey: jwt('anon') }).publishableKey).toBe(jwt('anon'));
    expect(validateRelayConfiguration({ ...config, url: 'https://RELAY-PROJECT.supabase.co' }).url).toBe(config.url);
  });
  it('rejects secret/service keys, malformed keys and additional settings', () => {
    for (const publishableKey of ['sb_secret_' + 's'.repeat(40), jwt('service_role'), jwt('authenticated'), jwt('anon', 'none'), 'x'.repeat(40), config.publishableKey + '\n', 'sb_publishable_short']) {
      expect(() => validateRelayConfiguration({ ...config, publishableKey })).toThrow(RelayError);
    }
    expect(() => validateRelayConfiguration({ ...config, allowHttp: true } as RelayConfiguration)).toThrow(RelayError);
  });
  it('rejects SSRF paths, custom hosts, credentials, queries, fragments, ports and parser normalization tricks', () => {
    for (const url of [
      'http://relay-project.supabase.co', 'https://localhost', 'https://127.0.0.1', 'https://supabase.co',
      'https://relay-project.supabase.co.evil.example', 'https://evil.example/relay-project.supabase.co',
      'https://nested.relay-project.supabase.co', `${config.url}/rest/v1`, `${config.url}/../`, `${config.url}/?x=1`, `${config.url}?`,
      `${config.url}#`, `${config.url}:443`, `${config.url}:8443`, 'https://user:password@relay-project.supabase.co',
      'https://relay-project.supabase.co@evil.example', 'https://%72elay-project.supabase.co',
      'https://relay-project.supabase.co\\@evil.example', ' https://relay-project.supabase.co',
    ]) expect(() => validateRelayConfiguration({ ...config, url })).toThrow(RelayError);
  });
});

describe('purpose-specific RPC transport contracts', () => {
  it('maps all explicit RelayClient operations to camelCase-returning RPCs, with only apikey and POST-body device auth', async () => {
    const deviceToken = token(), code = token(), deviceId = randomUUID(), attemptId = randomUUID();
    const item = envelope();
    const proposal = envelope({ ...outbound(), payload: JSON.stringify({ schemaVersion: 1, kind: 'proposal', text: '', projectId: randomUUID(), baseRevision: 1, changes: { nextAction: 'Review' } }) });
    const calls: { name: string; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe(config.publishableKey); expect(headers.has('authorization')).toBe(false);
      expect(headers.get('content-type')).toBe('application/json');
      const url = new URL(String(input)); expect(url.origin).toBe(config.url); expect(url.search).toBe('');
      expect(String(input)).not.toContain(deviceToken); expect(String(input)).not.toContain(code);
      const name = url.pathname.split('/').at(-1)!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ name, body }); expect(body.p_token).toBe(deviceToken);
      const responses: Record<string, unknown> = {
        hub_pair: { networkId: randomUUID(), device: device(deviceId) }, hub_devices: [device(deviceId)],
        hub_invite: { expiresAt: now() }, hub_manifest: { entries: [], next: null }, hub_snapshots: [],
        hub_send: item, hub_pull: [item], hub_statuses: [{ id: item.id, receivedAt: null, result: null }], hub_check_proposal: proposal,
      };
      return Response.json(responses[name] ?? null);
    });
    const relay = createSupabaseRelay(config, { fetch });
    const snapshot = { projectId: randomUUID(), version: 1, project: null };
    const decision = { status: 'read' as const, revision: null, at: now() };
    await relay.pair({ attemptId, deviceId, deviceToken, inviteToken: code, name: 'Desktop' });
    await relay.listDevices(deviceToken); await relay.renameDevice(deviceToken, 'Renamed'); await relay.createInvite(deviceToken, code);
    await relay.revokeDevice(deviceToken, deviceId); await relay.publish(deviceToken, snapshot); await relay.manifest(deviceToken, null);
    await relay.snapshots(deviceToken, [{ ownerDeviceId: deviceId, projectId: snapshot.projectId }]);
    const outgoing = { id: item.id, toDeviceId: item.toDeviceId, payload: item.payload, expiresAt: item.expiresAt };
    await relay.send(deviceToken, outgoing); await relay.pull(deviceToken); await relay.acknowledge(deviceToken, [item.id]);
    await relay.statuses(deviceToken, [item.id]); await relay.checkProposal(deviceToken, proposal.id, proposal.hash); await relay.resolve(deviceToken, item.id, decision);
    expect(calls.map(call => call.name)).toEqual(['hub_pair', 'hub_devices', 'hub_rename', 'hub_invite', 'hub_revoke', 'hub_publish', 'hub_manifest', 'hub_snapshots', 'hub_send', 'hub_pull', 'hub_ack', 'hub_statuses', 'hub_check_proposal', 'hub_resolve']);
    expect(calls[0].body).toEqual({ p_attempt_id: attemptId, p_device_id: deviceId, p_token: deviceToken, p_code: code, p_name: 'Desktop' });
    expect(calls[5].body).toEqual({ p_token: deviceToken, p_snapshot: snapshot });
    expect(calls[8].body).toEqual({ p_token: deviceToken, p_message: outgoing });
    expect(calls[13].body).toEqual({ p_token: deviceToken, p_id: item.id, p_decision: decision });
    expect(await relay.acknowledge(deviceToken, [])).toBeUndefined();
  });

  it('validates input before networking and rejects unknown fields and UTF-8 oversize payloads', () => {
    const { relay, fetch } = stub(null); const secret = token();
    expect(() => relay.listDevices('wrong-token')).toThrow(RelayError);
    expect(() => relay.acknowledge(secret, Array.from({ length: 51 }, () => randomUUID()))).toThrow(RelayError);
    expect(() => relay.manifest(secret, 'unsafe-cursor')).toThrow(RelayError);
    expect(() => relay.publish(secret, { projectId: randomUUID(), version: 1, project: null, path: 'C:/secret' } as SnapshotPublication)).toThrow(RelayError);
    expect(() => relay.send(secret, { ...outbound(), fromDeviceId: randomUUID() } as OutboundMessage)).toThrow(RelayError);
    expect(() => relay.send(secret, { ...outbound(), payload: '{not json}' })).toThrow(RelayError);
    expect(() => relay.send(secret, { ...outbound(), payload: JSON.stringify({ schemaVersion: 1, kind: 'message', text: 'message', command: 'do not execute' }) })).toThrow(RelayError);
    expect(() => relay.send(secret, { ...outbound(), payload: outbound().payload.padEnd(MAX_RELAY_BYTES + 1, ' ') })).toThrow(RelayError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown output fields, incorrect hashes, invalid embedded payloads and mismatched send identities', async () => {
    const item = envelope(); const secret = token();
    const responses = [[{ ...item, token: secret }], [{ ...item, hash: token() }], [{ ...item, payload: '{}' }], [{ ...item, receivedAt: 'yesterday' }]];
    for (const response of responses) {
      const { relay } = stub(response);
      await expect(relay.pull(secret)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    }
    const { relay } = stub(item);
    await expect(relay.send(secret, outbound())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub({ entries: [], next: null, private: 'hidden' }).relay.manifest(secret, null)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('safe errors, bounded streaming and cancellation', () => {
  it('maps only safe SQL machine codes and never echoes credentials or provider errors', async () => {
    const secret = token();
    for (const [provider, expected] of [['HU400', 'invalid'], ['HU401', 'unauthorized'], ['HU403', 'denied'], ['HU409', 'conflict'], ['HU410', 'expired'], ['XX000', 'unavailable']]) {
      const { relay } = stub({ code: provider, message: `private ${secret}`, details: config.publishableKey, hint: 'SQL data' }, 400);
      const error = await relay.listDevices(secret).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RelayError); expect(error).toMatchObject({ code: expected });
      expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(config.publishableKey); expect(String(error)).not.toContain('SQL data');
    }
    for (const status of [401, 403]) {
      await expect(stub({}, status).relay.pull(secret)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
      await expect(stub({ code: 'HU403' }, status).relay.pull(secret)).rejects.toMatchObject({ code: 'denied', retryable: false });
      await expect(stub({ code: 'HU401' }, status).relay.pull(secret)).rejects.toMatchObject({ code: 'unauthorized', retryable: false });
    }
    for (const status of [429, 500, 503]) await expect(stub({}, status).relay.pull(secret)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('does not follow redirects or surface native fetch error content', async () => {
    const secret = token();
    const redirect = vi.fn<typeof fetch>(async () => Response.redirect('https://untrusted.example/', 302));
    await expect(createSupabaseRelay(config, { fetch: redirect }).pull(secret)).rejects.toMatchObject({ code: 'unavailable' });
    expect(redirect).toHaveBeenCalledTimes(1); expect(redirect.mock.calls[0][1]?.redirect).toBe('error');
    const failure = vi.fn<typeof fetch>(async () => { throw new Error(`Failed request ${secret}`); });
    const error = await createSupabaseRelay(config, { fetch: failure }).pull(secret).catch((error: unknown) => error);
    expect(String(error)).not.toContain(secret); expect(error).toMatchObject({ code: 'unavailable' });
  });

  it('bounds streaming success bodies without trusting content-length and cancels the stream', async () => {
    let cancelled = false, chunks = 0;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(128 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', 'content-length': '2' } });
    await expect(createSupabaseRelay(config, { fetch: fetcher }).pull(token())).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancelled).toBe(true); expect(chunks).toBeLessThanOrEqual(18);
  });

  it('rejects declared oversized bodies, malformed JSON/content-types and bounds provider-error bodies', async () => {
    for (const response of [
      () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '999999999' } }),
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      () => new Response('[]', { headers: { 'content-type': 'text/html' } }),
      () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
      () => Response.json({ error: 'x'.repeat(9000) }, { status: 500 }),
    ]) await expect(createSupabaseRelay(config, { fetch: async () => response() }).pull(token())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('times out hung headers even when an injected transport ignores AbortSignal', async () => {
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}); };
    await expect(createSupabaseRelay(config, { fetch: fetcher, timeoutMs: 10 }).pull(token())).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    expect(signal?.aborted).toBe(true);
  });

  it('times out a hung streaming body and cancels its reader', async () => {
    let cancelled = false;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('[')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
    await expect(createSupabaseRelay(config, { fetch: fetcher, timeoutMs: 10 }).pull(token())).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancelled).toBe(true);
  });

  it('propagates caller cancellation, skips pre-aborted calls and removes request timers', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    const relay = createSupabaseRelay(config, { fetch: fetcher, timeoutMs: 1000 });
    const pending = relay.pull(token(), controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retryable: false });
    await expect(relay.pull(token(), controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => createSupabaseRelay(config, { timeoutMs: 0 })).toThrow(RelayError);
    expect(() => createSupabaseRelay(config, { timeoutMs: Infinity })).toThrow(RelayError);
  });
});
