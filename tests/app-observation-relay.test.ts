import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRelay } from '../server/supabase-relay.js';
import { RelayError } from '../server/relay.js';
import { APP_NAME_FORBIDDEN_RANGES, type AppObservationPublication } from '../shared/app-observation.js';

const config = { url: 'https://app-fixture.supabase.co', publishableKey: 'sb_publishable_only_test_key_1234567890' };
const token = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();
const publication = (name: string | null = 'Visual Studio Code', sequence = 1): AppObservationPublication => ({ protocol: 1, sequence, observation: { name, observedAt: now() } });
function stub(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
  const relay = createSupabaseRelay(config, { fetch });
  return { fetch, relay, app: relay.appObservation! };
}

describe('independent app observation relay', () => {
  it('discovers the strict optional capability through the existing protected HTTP transport', async () => {
    const secret = token(), capability = { protocol: 1, networkId: randomUUID(), deviceId: randomUUID() };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe(`${config.url}/rest/v1/rpc/hub_app_v1_capability`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ apikey: config.publishableKey, accept: 'application/json', 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({ p_token: secret });
      expect(String(input)).not.toContain(secret);
      return Response.json(capability);
    });
    const relay = createSupabaseRelay(config, { fetch });
    expect(relay.appObservation).toBeDefined();
    expect(await relay.appObservation!.capability(secret)).toEqual(capability);
  });

  it('publishes exact text bytes and receives the separate strict observation DTO, including unknown and withdrawal', async () => {
    const secret = token(), value = publication(), deviceId = randomUUID(), receivedAt = now();
    const { app, fetch } = stub(null);
    await app.publish(secret, value); await app.publish(secret, { ...value, sequence: 2, observation: { name: null, observedAt: now() } });
    await app.publish(secret, { protocol: 1, sequence: 3, observation: null });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(Array(3).fill(`${config.url}/rest/v1/rpc/hub_app_v1_publish`));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ p_token: secret, p_payload: JSON.stringify(value) });
    const remote = [{ ...value, deviceId, receivedAt }];
    const reader = stub(remote);
    expect(await reader.app.statuses(secret)).toEqual(remote);
    expect(reader.fetch.mock.calls[0][0]).toBe(`${config.url}/rest/v1/rpc/hub_app_v1_statuses`);
    expect(JSON.parse(String(reader.fetch.mock.calls[0][1]?.body))).toEqual({ p_token: secret });
  });

  it('treats only recognized absent capability RPC codes as unsupported; legacy governance still fails closed', async () => {
    const secret = token();
    for (const code of ['PGRST202', '42883']) {
      const { app, relay } = stub({ code, message: secret, details: config.publishableKey }, 404);
      expect(await app.capability(secret)).toBeNull();
      await expect(app.publish(secret, publication())).rejects.toMatchObject({ code: 'unavailable' });
      await expect(app.statuses(secret)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(relay.governance!.policy(secret)).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    }
    for (const body of [null, {}, { protocol: 1 }, { protocol: 2, deviceId: randomUUID(), networkId: randomUUID() }, { protocol: 1, deviceId: randomUUID(), networkId: randomUUID(), title: 'private' }]) {
      await expect(stub(body).app.capability(secret)).rejects.toMatchObject({ code: 'unavailable' });
    }
    for (const body of [{ code: 'PGRST202\n' }, { message: 'PGRST202' }, { code: 'XX000' }]) {
      await expect(stub(body, 404).app.capability(secret)).rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('rejects extra fields, forbidden names and invalid sequences before a request leaves the process', () => {
    const { app, fetch } = stub(null), secret = token(), base = publication();
    for (const extra of [{ title: 'Document' }, { pid: 123 }, { path: 'C:/secret' }, { deviceId: randomUUID() }, { networkId: randomUUID() }]) {
      expect(() => app.publish(secret, { ...base, ...extra } as AppObservationPublication)).toThrow(RelayError);
      expect(() => app.publish(secret, { ...base, observation: { ...base.observation!, ...extra } } as AppObservationPublication)).toThrow(RelayError);
    }
    const forbidden = APP_NAME_FORBIDDEN_RANGES.flatMap(([first, last]) => [first, last]).map(point => `App${String.fromCodePoint(point)}`);
    for (const name of ['', '.', '..', ' padded', 'padded ', 'A'.repeat(97), '😀'.repeat(97), ...Array.from('\\/:*?"<>|').map(char => `App${char}name`), ...forbidden]) {
      expect(() => app.publish(secret, publication(name)), JSON.stringify(name)).toThrow(RelayError);
    }
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) expect(() => app.publish(secret, { ...base, sequence })).toThrow(RelayError);
    expect(() => app.capability('bad')).toThrow(RelayError);
    expect(() => app.statuses('bad')).toThrow(RelayError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized remote state and accepts the 96-code-point / 384-byte Unicode boundary', async () => {
    const secret = token(), value = publication('😀'.repeat(96)), { app } = stub(null);
    await expect(app.publish(secret, value)).resolves.toBeUndefined();
    const remote = { ...value, deviceId: randomUUID(), receivedAt: now() };
    expect(await stub([remote]).app.statuses(secret)).toEqual([remote]);
    for (const body of [
      [{ ...remote, title: 'private' }], [{ ...remote, observation: { ...remote.observation, pid: 9 } }],
      [{ ...remote, receivedAt: 'yesterday' }], [{ ...remote, observation: { name: 'C:/private', observedAt: now() } }],
      [{ ...remote, sequence: 0 }], [remote, remote], Array.from({ length: 101 }, () => ({ ...remote, deviceId: randomUUID() })),
    ]) await expect(stub(body).app.statuses(secret)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(stub({ ok: true }).app.publish(secret, value)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('app transport security and bounded cancellation', () => {
  it('retains strict public Supabase endpoints and accepts no management keys', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const url of ['http://app-fixture.supabase.co', 'https://localhost', `${config.url}/rest/v1`, `${config.url}?token=x`, 'https://user:password@app-fixture.supabase.co']) {
      expect(() => createSupabaseRelay({ ...config, url }, { fetch })).toThrow(RelayError);
    }
    const serviceKey = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"role":"service_role"}').toString('base64url'), 'x'.repeat(43)].join('.');
    for (const publishableKey of ['sb_secret_' + 's'.repeat(40), serviceKey]) expect(() => createSupabaseRelay({ ...config, publishableKey }, { fetch })).toThrow(RelayError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves caller authentication/denial errors and never echoes provider names, tokens or details', async () => {
    const secret = token(), privateName = 'Private application sentinel';
    for (const [code, expected] of [['HU401', 'unauthorized'], ['HU403', 'denied'], ['HU400', 'invalid'], ['HU409', 'conflict'], ['HU410', 'expired'], ['XX000', 'unavailable']]) {
      const error = await stub({ code, message: secret, details: privateName, hint: config.publishableKey }, 400).app.capability(secret).catch(error => error);
      expect(error).toBeInstanceOf(RelayError); expect(error).toMatchObject({ code: expected });
      for (const text of [secret, privateName, config.publishableKey]) expect(String(error)).not.toContain(text);
    }
    for (const status of [401, 403, 404, 429, 500]) await expect(stub({}, status).app.capability(secret)).rejects.toMatchObject({ code: 'unavailable' });
    const failure: typeof fetch = async () => { throw new Error(`${secret} ${privateName}`); };
    const error = await createSupabaseRelay(config, { fetch: failure }).appObservation!.capability(secret).catch(error => error);
    expect(error).toMatchObject({ code: 'unavailable' }); expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(privateName);
  });

  it('enforces 150 KiB status streaming and small capability limits even with a dishonest content-length', async () => {
    let cancelled = false, chunks = 0;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(32 * 1024).fill(32)); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', 'content-length': '2' } });
    await expect(createSupabaseRelay(config, { fetch: fetcher }).appObservation!.statuses(token())).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancelled).toBe(true); expect(chunks).toBeLessThanOrEqual(6);
    for (const response of [
      () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': String(150 * 1024 + 1) } }),
      () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
      () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      () => Response.json({ code: 'PGRST202', details: 'x'.repeat(9000) }, { status: 404 }),
      () => Response.redirect('https://untrusted.example', 302),
    ]) await expect(createSupabaseRelay(config, { fetch: async () => response() }).appObservation!.capability(token())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('aborts in-flight calls, skips pre-aborted requests and times out hung headers and bodies', async () => {
    const hung = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    const app = createSupabaseRelay(config, { fetch: hung }).appObservation!, controller = new AbortController();
    const pending = app.publish(token(), publication(), controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(app.capability(token(), controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(hung).toHaveBeenCalledTimes(1); expect(hung.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(createSupabaseRelay(config, { fetch: hung, timeoutMs: 10 }).appObservation!.capability(token())).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    let cancelled = false;
    const stream: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
    await expect(createSupabaseRelay(config, { fetch: stream, timeoutMs: 10 }).appObservation!.statuses(token())).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancelled).toBe(true);
  });
});
