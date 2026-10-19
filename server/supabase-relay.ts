import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_BATCH, MAX_RELAY_BYTES, decisionSchema, deviceNameSchema, deviceRecordSchema,
  manifestEntrySchema, messagePayloadSchema, messageReceiptSchema, outboundMessageSchema,
  pairResultSchema, publicationSchema, relayMessageSchema, remoteSnapshotSchema, tokenSchema,
  type RelayConfiguration,
} from '../shared/devices.js';
import { RelayError, type RelayClient } from './relay.js';

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const configurationSchema = z.object({ url: z.string().min(1).max(250), publishableKey: z.string().min(20).max(2048) }).strict();
const pairSchema = z.object({ attemptId: uuid, deviceId: uuid, deviceToken: tokenSchema, inviteToken: tokenSchema, name: deviceNameSchema }).strict();
const idsSchema = z.array(uuid).max(MAX_BATCH);
const refsSchema = z.array(z.object({ ownerDeviceId: uuid, projectId: uuid }).strict()).max(MAX_BATCH);
const cursorSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).nullable();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function invalid(): RelayError { return new RelayError('invalid', '雲端設定或請求格式無效。'); }
function unavailable(): RelayError { return new RelayError('unavailable', '雲端暫時無法使用，請稍後重試。', true); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function validPayload(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > MAX_RELAY_BYTES) return false;
  try { return messagePayloadSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
}
const messageSchema = relayMessageSchema.refine(value => validPayload(value.payload)
  && createHash('sha256').update(value.payload, 'utf8').digest('hex') === value.hash);
const snapshotSchema = remoteSnapshotSchema.refine(value => Buffer.byteLength(JSON.stringify({ projectId: value.projectId, version: value.version, project: value.project }), 'utf8') <= MAX_RELAY_BYTES);

/** Public gateway keys only. Device authorization is separate, in each RPC's POST body. */
export function validateRelayConfiguration(config: RelayConfiguration): RelayConfiguration {
  const value = parse(configurationSchema, config);
  // Match the original string as well as URL fields: URL parsing must not normalize away
  // credentials, dot paths, encoded hosts, backslashes, explicit ports or a query.
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co\/?$/i.test(value.url)) throw invalid();
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw invalid();
  const key = value.publishableKey;
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}$/.test(key)) throw invalid();
    try {
      const [header, payload] = key.split('.');
      const h: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const p: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!z.object({ alg: z.literal('HS256') }).passthrough().safeParse(h).success
        || !z.object({ role: z.literal('anon') }).passthrough().safeParse(p).success) throw invalid();
    } catch { throw invalid(); }
  }
  return { url: url.origin, publishableKey: key };
}

export interface SupabaseRelayTestingOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

async function readJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { cancel(); throw unavailable(); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function providerError(status: number, body: unknown): RelayError {
  // Inspect only a bounded machine code, never a provider message/details/hint.
  const code = z.object({ code: z.string().max(16) }).passthrough().safeParse(body);
  const value = code.success ? code.data.code : '';
  // Only the relay's caller-authentication code proves this device was revoked.
  // Gateway 401/403 may instead mean a public-key/configuration problem.
  if (value === 'HU401') return new RelayError('unauthorized', '設備憑證無效或已撤銷。');
  if (value === 'HU403') return new RelayError('denied', '來源、目標或資料已無法存取，請重新確認權限。');
  if (value === 'HU409' || status === 409) return new RelayError('conflict', '資料已變更或識別碼已被使用。');
  if (value === 'HU410' || status === 410) return new RelayError('expired', '配對碼或請求已過期。');
  if (value === 'HU400' || value === '22P05' || value === '22021') return invalid();
  return unavailable();
}

export function createSupabaseRelay(configuration: RelayConfiguration, options: SupabaseRelayTestingOptions = {}): RelayClient {
  const config = validateRelayConfiguration(configuration);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw invalid();

  async function rpc<T>(name: string, body: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, parent?: AbortSignal): Promise<T> {
    if (parent?.aborted) throw new RelayError('aborted', '雲端請求已取消。');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    parent?.addEventListener('abort', abort, { once: true });
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(timedOut ? unavailable() : new RelayError('aborted', '雲端請求已取消。'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetcher(`${config.url}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { apikey: config.publishableKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw unavailable();
        let data: unknown;
        try { data = await readJson(response, controller.signal, response.ok ? MAX_RESPONSE_BYTES : 8192); }
        catch { if (!response.ok) throw providerError(response.status, null); throw unavailable(); }
        if (!response.ok) throw providerError(response.status, data);
        const result = schema.safeParse(data);
        if (!result.success) throw unavailable();
        return result.data;
      })()]);
    } catch (error) {
      if (controller.signal.aborted) throw timedOut ? unavailable() : new RelayError('aborted', '雲端請求已取消。');
      if (error instanceof RelayError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  const authenticated = (token: string) => ({ p_token: parse(tokenSchema, token) });
  const empty = z.null().transform(() => undefined);
  return {
    pair(input, signal) {
      const value = parse(pairSchema, input);
      return rpc('hub_pair', { p_attempt_id: value.attemptId, p_device_id: value.deviceId, p_token: value.deviceToken, p_code: value.inviteToken, p_name: value.name }, pairResultSchema.refine(result => result.device.id === value.deviceId), signal);
    },
    listDevices(token, signal) { return rpc('hub_devices', authenticated(token), z.array(deviceRecordSchema).max(100), signal); },
    renameDevice(token, name, signal) { return rpc('hub_rename', { ...authenticated(token), p_name: parse(deviceNameSchema, name) }, empty, signal); },
    createInvite(token, code, signal) { return rpc('hub_invite', { ...authenticated(token), p_code: parse(tokenSchema, code) }, z.object({ expiresAt: timestamp }).strict(), signal); },
    revokeDevice(token, deviceId, signal) { return rpc('hub_revoke', { ...authenticated(token), p_device_id: parse(uuid, deviceId) }, empty, signal); },
    publish(token, snapshot, signal) {
      const value = parse(publicationSchema, snapshot);
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RELAY_BYTES) throw invalid();
      return rpc('hub_publish', { ...authenticated(token), p_snapshot: value }, empty, signal);
    },
    manifest(token, after, signal) { return rpc('hub_manifest', { ...authenticated(token), p_after: parse(cursorSchema, after) }, z.object({ entries: z.array(manifestEntrySchema).max(MAX_BATCH), next: cursorSchema }).strict(), signal); },
    snapshots(token, refs, signal) { return rpc('hub_snapshots', { ...authenticated(token), p_refs: parse(refsSchema, refs) }, z.array(snapshotSchema).max(MAX_BATCH), signal); },
    send(token, message, signal) {
      const value = parse(outboundMessageSchema, message);
      if (!validPayload(value.payload)) throw invalid();
      return rpc('hub_send', { ...authenticated(token), p_message: value }, messageSchema.refine(result => result.id === value.id && result.toDeviceId === value.toDeviceId && result.payload === value.payload && Date.parse(result.expiresAt) === Date.parse(value.expiresAt)), signal);
    },
    pull(token, signal) { return rpc('hub_pull', authenticated(token), z.array(messageSchema).max(MAX_BATCH), signal); },
    acknowledge(token, ids, signal) { return rpc('hub_ack', { ...authenticated(token), p_ids: parse(idsSchema, ids) }, empty, signal); },
    statuses(token, ids, signal) { return rpc('hub_statuses', { ...authenticated(token), p_ids: parse(idsSchema, ids) }, z.array(messageReceiptSchema).max(MAX_BATCH), signal); },
    checkProposal(token, id, hash, signal) {
      const value = { ...authenticated(token), p_id: parse(uuid, id), p_hash: parse(tokenSchema, hash) };
      return rpc('hub_check_proposal', value, messageSchema.refine(result => result.id === value.p_id && result.hash === value.p_hash && result.result === null && JSON.parse(result.payload).kind === 'proposal'), signal);
    },
    resolve(token, id, decision, signal) { return rpc('hub_resolve', { ...authenticated(token), p_id: parse(uuid, id), p_decision: parse(decisionSchema, decision) }, empty, signal); },
  };
}
