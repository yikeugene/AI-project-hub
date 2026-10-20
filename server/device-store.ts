import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Store } from './db.js';
import { appError } from './validation.js';
import { translateError } from '../shared/messages.js';
import { MAX_RELAY_BYTES, messagePayloadSchema, selectedMemory, sharedProjectSchema } from '../shared/devices.js';
import { remoteDeviceStatusSchema, statusSharingPolicySchema } from '../shared/governance.js';
import type { CachedSnapshot, ConnectionStatus, DeviceRecord, MessageDecision, MessageReceipt, MessageView, OutboundMessage, RelayConfiguration, RelayMessage, RemoteSnapshot, SharePolicy, SharedPreview, SnapshotPublication } from '../shared/devices.js';

export interface RelayProfile {
  id: string; attached: boolean; label: string; configuration: RelayConfiguration; deviceId: string; networkId: string | null;
  credentials: Uint8Array; pairingPending: boolean; enabled: boolean; connection: ConnectionStatus;
  lastSyncAt: string | null; lastError: string | null;
}
export interface OutboxItem { id: string; kind: 'send' | 'ack' | 'decision' | 'rename'; payload: string; attempts: number }
type Row = Record<string, string | number | null | Uint8Array>;
export const payloadHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export function boundedJson(text: string) {
  if (Buffer.byteLength(text, 'utf8') > MAX_RELAY_BYTES) throw appError(413, 'device.shareLarge');
  return JSON.parse(text) as unknown;
}
export function parseMessage(text: string) { return messagePayloadSchema.parse(boundedJson(text)); }
const encoded = (value: unknown) => JSON.stringify(value);
function profileFrom(row: Row): RelayProfile {
  const label = String(row.label || `${new URL(String(row.url)).host} · ${String(row.network_id || row.device_id).slice(0, 8)}/${String(row.device_id).slice(0, 8)}`);
  return { id: String(row.id), attached: !!row.attached, label, configuration: { url: String(row.url), publishableKey: String(row.publishable_key) }, deviceId: String(row.device_id), networkId: row.network_id as string | null,
    credentials: row.credentials as Uint8Array, pairingPending: !!row.pairing_pending, enabled: !!row.enabled, connection: row.connection as ConnectionStatus,
    lastSyncAt: row.last_sync_at as string | null, lastError: row.last_error as string | null };
}
function messageFrom(row: Row): MessageView {
  return { id: String(row.id), fromDeviceId: String(row.from_id), toDeviceId: String(row.to_id), payload: parseMessage(String(row.payload)), hash: String(row.hash),
    direction: row.direction as MessageView['direction'], delivery: row.delivery as MessageView['delivery'], createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    receivedAt: row.received_at as string | null, result: row.result ? JSON.parse(String(row.result)) : null, error: row.error as string | null };
}

/** Uses the same connection as local projects so an accepted change and its receipt commit together. */
export class DeviceStore {
  constructor(readonly store: Store, readonly clock: () => number = Date.now) {
    store.db.prepare('INSERT OR IGNORE INTO device_installation(singleton,id,name) VALUES(1,?,?)').run(randomUUID(), hostname().slice(0, 80) || 'This computer');
  }
  now() { return new Date(this.clock()).toISOString(); }
  installation(): { id: string; name: string; activeProfile: string | null } {
    const row = this.store.db.prepare('SELECT * FROM device_installation WHERE singleton=1').get() as Row;
    return { id: String(row.id), name: String(row.name), activeProfile: row.active_profile as string | null };
  }
  profile(id = this.installation().activeProfile): RelayProfile | null {
    if (!id) return null;
    const row = this.store.db.prepare('SELECT * FROM relay_profiles WHERE id=?').get(id) as Row | undefined;
    return row ? profileFrom(row) : null;
  }
  profiles(): RelayProfile[] {
    return (this.store.db.prepare('SELECT * FROM relay_profiles WHERE attached=1 ORDER BY created_at,id').all() as Row[]).map(profileFrom);
  }
  addProfile(configuration: RelayConfiguration, deviceId: string, credentials: Uint8Array, label = ''): RelayProfile {
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO relay_profiles(id,url,publishable_key,device_id,credentials,created_at,attached,label) VALUES(?,?,?,?,?,?,1,?)')
        .run(id, configuration.url, configuration.publishableKey, deviceId, credentials, this.now(), label);
      this.store.db.prepare('UPDATE device_installation SET active_profile=? WHERE singleton=1').run(id);
    });
    return this.profile(id)!;
  }
  selectProfile(id: string) {
    if (!this.profile(id)?.attached) throw appError(409, 'device.profileUnavailable');
    this.store.db.prepare('UPDATE device_installation SET active_profile=? WHERE singleton=1').run(id);
  }
  labelProfile(id: string, label: string) {
    this.store.db.prepare('UPDATE relay_profiles SET label=? WHERE id=? AND attached=1').run(label, id);
  }
  finishPairing(id: string, networkId: string, credentials: Uint8Array, device: DeviceRecord) {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE relay_profiles SET network_id=?,credentials=?,pairing_pending=0,enabled=1,connection='idle',last_error=NULL WHERE id=?")
        .run(networkId, credentials, id);
      this.cacheDevices(id, [device]);
      // An explicit installation rename during a recoverable pairing is queued without changing the retry attempt.
      const rename = this.store.db.prepare("SELECT payload FROM device_outbox WHERE profile_id=? AND id='rename' AND kind='rename'").get(id) as Row | undefined;
      if (rename) this.store.db.prepare('UPDATE paired_devices SET name=? WHERE profile_id=? AND id=?').run(JSON.parse(String(rename.payload)).name, id, device.id);
    });
  }
  setEnabled(id: string, enabled: boolean) {
    this.store.db.prepare('UPDATE relay_profiles SET enabled=?,connection=?,last_error=NULL WHERE id=?').run(Number(enabled), enabled ? 'idle' : 'disabled', id);
  }
  detach(id: string) {
    this.store.transaction(() => {
      this.setEnabled(id, false);
      this.store.db.prepare("UPDATE relay_profiles SET attached=0,credentials=X'',pairing_pending=0 WHERE id=?").run(id);
      if (this.installation().activeProfile === id) {
        this.store.db.prepare('UPDATE device_installation SET active_profile=? WHERE singleton=1').run(this.profiles()[0]?.id ?? null);
      }
    });
  }
  setConnection(id: string, connection: ConnectionStatus, error: string | null = null, synced = false) {
    this.store.db.prepare('UPDATE relay_profiles SET connection=?,last_error=?,last_sync_at=CASE WHEN ? THEN ? ELSE last_sync_at END WHERE id=?')
      .run(connection, error, Number(synced), this.now(), id);
  }
  rename(name: string) {
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE device_installation SET name=? WHERE singleton=1').run(name);
      for (const profile of this.profiles()) {
        if (profile.connection !== 'revoked' && !this.devices(profile.id).some(device => device.id === profile.deviceId && !!device.revokedAt)) {
          this.store.db.prepare('UPDATE paired_devices SET name=? WHERE profile_id=? AND id=?').run(name, profile.id, profile.deviceId);
          this.queue(profile.id, 'rename', 'rename', { name }, true);
        }
      }
    });
  }
  cacheDevices(profile: string, devices: DeviceRecord[]) {
    const statement = this.store.db.prepare(`INSERT INTO paired_devices(profile_id,id,name,last_seen_at,revoked_at) VALUES(?,?,?,?,?)
      ON CONFLICT(profile_id,id) DO UPDATE SET name=excluded.name,last_seen_at=excluded.last_seen_at,revoked_at=COALESCE(paired_devices.revoked_at,excluded.revoked_at)`);
    for (const device of devices) {
      statement.run(profile, device.id, device.name, device.lastSeenAt, device.revokedAt);
      if (device.revokedAt) {
        this.store.db.prepare('UPDATE remote_snapshots SET payload=NULL WHERE profile_id=? AND owner_id=?').run(profile, device.id);
        this.withdrawCachedStatus(profile, device.id);
      }
    }
  }
  devices(profile: string): DeviceRecord[] {
    return (this.store.db.prepare('SELECT * FROM paired_devices WHERE profile_id=? ORDER BY name,id').all(profile) as Row[])
      .map(row => ({ id: String(row.id), name: String(row.name), lastSeenAt: String(row.last_seen_at), revokedAt: row.revoked_at as string | null }));
  }
  activeDevice(profile: string, id: string) { return this.devices(profile).find(device => device.id === id && !device.revokedAt); }
  policies(profile: string): SharePolicy[] {
    return (this.store.db.prepare('SELECT * FROM project_shares WHERE profile_id=? ORDER BY project_id').all(profile) as Row[])
      .map(row => ({ projectId: String(row.project_id), enabled: !!row.enabled, memoryFields: JSON.parse(String(row.memory_fields)) }));
  }
  policy(profile: string, projectId: string): SharePolicy {
    return this.policies(profile).find(value => value.projectId === projectId) ?? { projectId, enabled: false, memoryFields: [] };
  }
  preview(projectId: string, policy: SharePolicy): SharedPreview {
    const project = this.store.getProject(projectId);
    const shared = policy.enabled ? sharedProjectSchema.parse({ name: project.name, status: project.status, priority: project.priority, stage: project.stage,
      nextAction: project.nextAction, revision: project.revision, memory: selectedMemory(project.memory, policy.memoryFields) }) : null;
    const bytes = Buffer.byteLength(encoded(shared), 'utf8');
    // Keep policy controls usable even when later local edits exceed the transport limit.
    const error = bytes > MAX_RELAY_BYTES ? translateError('device.summaryLarge', this.store.getSettings().locale) : null;
    return { projectId, policy, project: error ? null : shared, bytes, error, ...(error ? { errorCode: 'device.summaryLarge' as const } : {}) };
  }
  setPolicy(profile: string, policy: SharePolicy) {
    const preview = this.preview(policy.projectId, policy);
    if (preview.error) throw appError(413, 'device.summaryLarge');
    this.store.transaction(() => this.writePolicy(profile, policy));
    return preview;
  }
  /** Internal write primitive: caller validates previews and owns the transaction. */
  writePolicy(profile: string, policy: SharePolicy) {
    this.store.db.prepare(`INSERT INTO project_shares(profile_id,project_id,enabled,memory_fields) VALUES(?,?,?,?)
      ON CONFLICT(profile_id,project_id) DO UPDATE SET enabled=excluded.enabled,memory_fields=excluded.memory_fields`)
      .run(profile, policy.projectId, Number(policy.enabled), encoded([...new Set(policy.memoryFields)]));
    this.reconcilePublication(profile, policy.projectId);
    if (!policy.enabled) {
      const row = this.store.db.prepare('SELECT sharing_json FROM governance_profiles WHERE profile_id=?').get(profile) as Row | undefined;
      if (row) {
        const sharing = statusSharingPolicySchema.parse(JSON.parse(String(row.sharing_json)));
        sharing.projects = sharing.projects.filter(project => project.projectId !== policy.projectId);
        this.store.db.prepare('UPDATE governance_profiles SET sharing_json=? WHERE profile_id=?').run(JSON.stringify(sharing), profile);
      }
    }
  }
  reconcilePublication(profile: string, projectId: string): string | null {
    const policy = this.policy(profile, projectId);
    const exists = !!this.store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    const preview = exists && policy.enabled ? this.preview(projectId, policy) : null;
    // An invalid projection withdraws any previously queued/published body instead of leaking stale fields.
    const payload = preview?.project ? encoded(preview.project) : null;
    const old = this.store.db.prepare('SELECT payload FROM project_publications WHERE profile_id=? AND project_id=?').get(profile, projectId) as Row | undefined;
    if ((!old && payload !== null) || (old && old.payload !== payload)) {
      this.store.db.prepare(`INSERT INTO project_publications(profile_id,project_id,version,payload) VALUES(?,?,1,?)
        ON CONFLICT(profile_id,project_id) DO UPDATE SET version=project_publications.version+1,payload=excluded.payload`).run(profile, projectId, payload);
    }
    return preview?.error ?? null;
  }
  reconcilePublications(profile: string): string[] {
    const previous = this.store.db.prepare('SELECT project_id FROM project_publications WHERE profile_id=?').all(profile) as Row[];
    const ids = new Set([...this.policies(profile).map(policy => policy.projectId), ...previous.map(row => String(row.project_id))]);
    const errors: string[] = [];
    for (const id of ids) { const error = this.reconcilePublication(profile, id); if (error) errors.push(error); }
    return errors;
  }
  pendingPublication(profile: string, projectId: string): SnapshotPublication | null {
    const row = this.store.db.prepare('SELECT * FROM project_publications WHERE profile_id=? AND project_id=? AND sent_version<version').get(profile, projectId) as Row | undefined;
    return row ? { projectId, version: Number(row.version), project: row.payload ? JSON.parse(String(row.payload)) : null } : null;
  }
  publications(profile: string): SnapshotPublication[] {
    return (this.store.db.prepare('SELECT * FROM project_publications WHERE profile_id=? AND sent_version<version ORDER BY project_id LIMIT 50').all(profile) as Row[])
      .map(row => ({ projectId: String(row.project_id), version: Number(row.version), project: row.payload ? JSON.parse(String(row.payload)) : null }));
  }
  publicationSent(profile: string, projectId: string, version: number) {
    this.store.db.prepare('UPDATE project_publications SET published_at=CASE WHEN ?>sent_version THEN ? ELSE published_at END,sent_version=MAX(sent_version,?) WHERE profile_id=? AND project_id=?')
      .run(version, this.now(), version, profile, projectId);
  }
  ownSnapshots(profile: string) {
    // Local edits or withdrawn fields must never leave an older projection visible in the aggregate.
    this.reconcilePublications(profile);
    return (this.store.db.prepare('SELECT * FROM project_publications WHERE profile_id=? AND payload IS NOT NULL ORDER BY project_id').all(profile) as Row[])
      .map(row => ({ projectId: String(row.project_id), version: Number(row.version), project: sharedProjectSchema.parse(boundedJson(String(row.payload))),
        pending: Number(row.sent_version) < Number(row.version), publishedAt: Number(row.sent_version) >= Number(row.version) ? row.published_at as string | null : null }));
  }
  cachedVersion(profile: string, owner: string, project: string): number {
    const row = this.store.db.prepare('SELECT version FROM remote_snapshots WHERE profile_id=? AND owner_id=? AND project_id=?').get(profile, owner, project) as Row | undefined;
    return Number(row?.version ?? 0);
  }
  private withdrawCachedStatus(profile: string, owner: string, projectId?: string) {
    const row = this.store.db.prepare('SELECT statuses_json FROM governance_profiles WHERE profile_id=?').get(profile) as Row | undefined;
    if (!row) return;
    const statuses = (JSON.parse(String(row.statuses_json)) as unknown[]).map(value => remoteDeviceStatusSchema.parse(value))
      .filter(status => projectId !== undefined || status.deviceId !== owner)
      .map(status => status.deviceId === owner ? { ...status, projects: status.projects.filter(project => project.projectId !== projectId) } : status);
    this.store.db.prepare('UPDATE governance_profiles SET statuses_json=? WHERE profile_id=?').run(JSON.stringify(statuses), profile);
  }
  cacheSnapshot(profile: string, snapshot: RemoteSnapshot) {
    const previous = this.store.db.prepare('SELECT version,payload FROM remote_snapshots WHERE profile_id=? AND owner_id=? AND project_id=?').get(profile, snapshot.ownerDeviceId, snapshot.projectId) as Row | undefined;
    const payload = snapshot.project ? encoded(snapshot.project) : null;
    if (previous && Number(previous.version) > snapshot.version) return;
    if (previous && Number(previous.version) === snapshot.version) {
      if (previous.payload !== payload) throw appError(409, 'device.summaryConflict');
      if (payload === null) this.withdrawCachedStatus(profile, snapshot.ownerDeviceId, snapshot.projectId);
      return;
    }
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO remote_snapshots(profile_id,owner_id,project_id,version,payload,published_at,received_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(profile_id,owner_id,project_id) DO UPDATE SET version=excluded.version,payload=excluded.payload,published_at=excluded.published_at,received_at=excluded.received_at`)
        .run(profile, snapshot.ownerDeviceId, snapshot.projectId, snapshot.version, payload, snapshot.publishedAt, this.now());
      if (payload === null) this.withdrawCachedStatus(profile, snapshot.ownerDeviceId, snapshot.projectId);
    });
  }
  snapshots(profile: string, owner: string): CachedSnapshot[] {
    if (!this.activeDevice(profile, owner)) return [];
    return (this.store.db.prepare('SELECT * FROM remote_snapshots WHERE profile_id=? AND owner_id=? AND payload IS NOT NULL ORDER BY project_id').all(profile, owner) as Row[])
      .map(row => ({ ownerDeviceId: owner, projectId: String(row.project_id), version: Number(row.version), project: sharedProjectSchema.parse(boundedJson(String(row.payload))), publishedAt: String(row.published_at), receivedAt: String(row.received_at) }));
  }
  queue(profile: string, id: string, kind: OutboxItem['kind'], payload: unknown, replace = false) {
    const text = encoded(payload);
    if (replace) this.store.db.prepare(`INSERT INTO device_outbox(profile_id,id,kind,payload,next_attempt_at) VALUES(?,?,?,?,?)
      ON CONFLICT(profile_id,id) DO UPDATE SET payload=excluded.payload,attempts=0,next_attempt_at=excluded.next_attempt_at,last_error=NULL`).run(profile, id, kind, text, this.now());
    else this.store.db.prepare('INSERT OR IGNORE INTO device_outbox(profile_id,id,kind,payload,next_attempt_at) VALUES(?,?,?,?,?)').run(profile, id, kind, text, this.now());
  }
  due(profile: string): OutboxItem[] {
    return (this.store.db.prepare('SELECT * FROM device_outbox WHERE profile_id=? AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 50').all(profile, this.now()) as Row[])
      .map(row => ({ id: String(row.id), kind: row.kind as OutboxItem['kind'], payload: String(row.payload), attempts: Number(row.attempts) }));
  }
  removeJob(profile: string, item: OutboxItem) {
    // A rename can be replaced while its predecessor is in flight.
    this.store.db.prepare('DELETE FROM device_outbox WHERE profile_id=? AND id=? AND payload=?').run(profile, item.id, item.payload);
  }
  retryJob(profile: string, item: OutboxItem, message: string) {
    const delay = Math.min(300000, 2000 * 2 ** Math.min(item.attempts, 7));
    this.store.db.prepare('UPDATE device_outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE profile_id=? AND id=? AND payload=?')
      .run(new Date(this.clock() + delay).toISOString(), message, profile, item.id, item.payload);
  }
  enqueue(profile: RelayProfile, message: OutboundMessage): MessageView {
    parseMessage(message.payload);
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO device_messages(profile_id,id,direction,from_id,to_id,payload,hash,created_at,expires_at,delivery)
        VALUES(?,?,'sent',?,?,?,?,?,?,'queued')`).run(profile.id, message.id, profile.deviceId, message.toDeviceId, message.payload, payloadHash(message.payload), this.now(), message.expiresAt);
      this.queue(profile.id, `send:${message.id}`, 'send', message);
    });
    return this.message(profile.id, message.id);
  }
  ingest(profile: RelayProfile, message: RelayMessage) {
    parseMessage(message.payload);
    if (message.toDeviceId !== profile.deviceId || payloadHash(message.payload) !== message.hash) throw appError(400, 'device.messageVerification');
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM device_messages WHERE profile_id=? AND id=?').get(profile.id, message.id) as Row | undefined;
      if (row && (row.direction !== 'inbox' || row.payload !== message.payload || row.hash !== message.hash || row.from_id !== message.fromDeviceId || row.to_id !== message.toDeviceId || row.expires_at !== message.expiresAt))
        throw appError(409, 'device.messageConflict');
      if (!row) this.store.db.prepare(`INSERT INTO device_messages(profile_id,id,direction,from_id,to_id,payload,hash,created_at,expires_at,received_at,delivery)
        VALUES(?,?,'inbox',?,?,?,?,?,?,?,'received')`).run(profile.id, message.id, message.fromDeviceId, message.toDeviceId, message.payload, message.hash, message.createdAt, message.expiresAt, this.now());
      this.queue(profile.id, `ack:${message.id}`, 'ack', { id: message.id });
    });
  }
  message(profile: string, id: string): MessageView {
    const row = this.store.db.prepare('SELECT * FROM device_messages WHERE profile_id=? AND id=?').get(profile, id) as Row | undefined;
    if (!row) throw appError(404, 'device.messageNotFound');
    return messageFrom(row);
  }
  messages(profile: string, direction: 'inbox' | 'sent'): MessageView[] {
    return (this.store.db.prepare('SELECT * FROM device_messages WHERE profile_id=? AND direction=? ORDER BY created_at DESC,id DESC LIMIT 200').all(profile, direction) as Row[]).map(messageFrom);
  }
  submitted(profile: string, id: string) {
    this.store.db.prepare("UPDATE device_messages SET delivery=CASE WHEN received_at IS NULL THEN 'submitted' ELSE delivery END,error=NULL WHERE profile_id=? AND id=? AND direction='sent'").run(profile, id);
  }
  failed(profile: string, id: string, error: string) {
    this.store.db.prepare("UPDATE device_messages SET delivery='failed',error=? WHERE profile_id=? AND id=? AND direction='sent' AND delivery='queued'").run(error, profile, id);
  }
  statusIds(profile: string): string[] {
    return (this.store.db.prepare("SELECT id FROM device_messages WHERE profile_id=? AND direction='sent' AND delivery IN ('submitted','received') AND result IS NULL ORDER BY COALESCE(status_checked_at,''),created_at LIMIT 50").all(profile) as Row[]).map(row => String(row.id));
  }
  checkedStatuses(profile: string, ids: string[]) {
    for (const id of ids) this.store.db.prepare('UPDATE device_messages SET status_checked_at=? WHERE profile_id=? AND id=?').run(this.now(), profile, id);
  }
  receipt(profile: string, receipt: MessageReceipt) {
    const previous = this.message(profile, receipt.id);
    if (previous.direction !== 'sent') throw appError(400, 'device.receiptNotSent');
    if (previous.result && receipt.result && (previous.result.status !== receipt.result.status || previous.result.revision !== receipt.result.revision)) throw appError(409, 'device.receiptOverwrite');
    this.store.db.prepare(`UPDATE device_messages SET received_at=COALESCE(received_at,?),result=COALESCE(result,?),
      delivery=CASE WHEN received_at IS NOT NULL OR ? IS NOT NULL THEN 'received' ELSE delivery END WHERE profile_id=? AND id=?`)
      .run(receipt.receivedAt, receipt.result ? encoded(receipt.result) : null, receipt.receivedAt, profile, receipt.id);
  }
  decide(profile: string, id: string, decision: MessageDecision) {
    const old = this.message(profile, id);
    if (old.direction !== 'inbox') throw appError(400, 'device.incomingOnly');
    if (old.result) {
      if (old.result.status !== decision.status) throw appError(409, 'device.decisionFinal');
      return;
    }
    this.store.db.prepare('UPDATE device_messages SET result=? WHERE profile_id=? AND id=? AND result IS NULL').run(encoded(decision), profile, id);
    this.queue(profile, `decision:${id}`, 'decision', { id, decision });
  }
  counts(profile: string) {
    const jobs = this.store.db.prepare('SELECT COUNT(*) AS n FROM device_outbox WHERE profile_id=?').get(profile) as Row;
    const publications = this.store.db.prepare('SELECT COUNT(*) AS n FROM project_publications WHERE profile_id=? AND version>sent_version').get(profile) as Row;
    const inbox = this.store.db.prepare("SELECT COUNT(*) AS n FROM device_messages WHERE profile_id=? AND direction='inbox' AND result IS NULL").get(profile) as Row;
    return { queuedCount: Number(jobs.n) + Number(publications.n), inboxCount: Number(inbox.n) };
  }
}
