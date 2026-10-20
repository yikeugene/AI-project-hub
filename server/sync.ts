import { deviceRecordSchema, manifestEntrySchema, messageReceiptSchema, relayMessageSchema, remoteSnapshotSchema } from '../shared/devices.js';
import type { MessageDecision, OutboundMessage } from '../shared/devices.js';
import { DeviceStore, payloadHash, type RelayProfile } from './device-store.js';
import { RelayError, type RelayClient } from './relay.js';
import { DEFAULT_LOCALE, type Locale } from '../shared/i18n.js';
import { translateError, type ErrorCode } from '../shared/messages.js';

export interface SyncSession { profile: RelayProfile; token: string; relay: RelayClient; generation: number }
export function syncError(error: unknown, locale: Locale = DEFAULT_LOCALE) {
  const code = error instanceof RelayError ? error.code : 'unavailable';
  const messageCode: ErrorCode = `relay.${code}`;
  return { code, messageCode, message: translateError(messageCode, locale), retryable: error instanceof RelayError ? error.retryable : true };
}

/** No global delivery cursor: receipt ACKs are queued only after durable local ingestion. */
export class SyncWorker {
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private stopped = false;
  private nextAt = 0;
  private failures = 0;
  // A DeviceService worker is permanently bound to one profile; cursor/backoff never follow management selection.
  private cursor: string | null = null;
  constructor(private repository: DeviceStore, private session: () => SyncSession | null, private current: (session: SyncSession) => boolean, private afterSync?: () => Promise<void>) {}
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { if (this.repository.clock() >= this.nextAt) void this.syncNow(); }, 15000);
    this.timer.unref();
    void this.syncNow();
  }
  syncNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const controller = new AbortController(); this.controller = controller;
    this.running = this.tick(controller.signal).finally(() => { this.running = undefined; if (this.controller === controller) this.controller = undefined; });
    return this.running;
  }
  async interrupt() { this.controller?.abort(); await this.running; this.cursor = null; }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.interrupt(); }
  private async tick(signal: AbortSignal) {
    let session: SyncSession | null = null;
    try {
      session = this.session();
      if (!session) return;
      const { profile, token, relay } = session;
      const guard = () => {
        if (signal.aborted || this.stopped || !this.current(session!)) throw new RelayError('aborted', '同步已暫停。');
      };
      guard(); this.repository.setConnection(profile.id, 'syncing');
      const devices = (await relay.listDevices(token, signal)).map(value => deviceRecordSchema.parse(value));
      guard();
      if (!devices.some(device => device.id === profile.deviceId && !device.revokedAt)) throw new RelayError('unauthorized', '設備已撤銷。');
      this.repository.cacheDevices(profile.id, devices);
      // Never drain an old snapshot before rechecking current sharing/deletion state after restart.
      const publicationErrors = this.repository.reconcilePublications(profile.id);
      for (const captured of this.repository.publications(profile.id)) {
        guard();
        // A prior await may have allowed unsharing, field deselection or project deletion.
        const error = this.repository.reconcilePublication(profile.id, captured.projectId);
        if (error) publicationErrors.push(error);
        const snapshot = this.repository.pendingPublication(profile.id, captured.projectId);
        if (!snapshot) continue;
        try {
          await relay.publish(token, snapshot, signal); guard();
          this.repository.publicationSent(profile.id, snapshot.projectId, snapshot.version);
        } catch (error) {
          guard(); const safe = syncError(error, this.repository.store.getSettings().locale);
          if (safe.retryable || safe.code === 'unauthorized' || safe.code === 'aborted') throw error;
          publicationErrors.push(safe.message);
        }
      }
      for (const item of this.repository.due(profile.id)) {
        guard();
        try {
          const data = JSON.parse(item.payload);
          if (item.kind === 'send') {
            const message = data as OutboundMessage;
            if (!this.repository.activeDevice(profile.id, message.toDeviceId)) throw new RelayError('invalid', '目的設備不可用。');
            const result = relayMessageSchema.parse(await relay.send(token, message, signal)); guard();
            if (result.id !== message.id || result.toDeviceId !== message.toDeviceId || result.fromDeviceId !== profile.deviceId || result.payload !== message.payload || result.hash !== payloadHash(message.payload) || Date.parse(result.expiresAt) !== Date.parse(message.expiresAt))
              throw new RelayError('invalid', '訊息回覆不符。');
            this.repository.submitted(profile.id, message.id);
            this.repository.receipt(profile.id, result);
          } else if (item.kind === 'ack') await relay.acknowledge(token, [data.id], signal);
          else if (item.kind === 'decision') await relay.resolve(token, data.id, data.decision as MessageDecision, signal);
          else await relay.renameDevice(token, data.name, signal);
          guard(); this.repository.removeJob(profile.id, item);
        } catch (error) {
          guard();
          const safe = syncError(error, this.repository.store.getSettings().locale);
          if (safe.code === 'unauthorized' || safe.code === 'aborted') throw error;
          if (safe.retryable) { this.repository.retryJob(profile.id, item, safe.message); throw error; }
          if (item.kind === 'send') this.repository.failed(profile.id, JSON.parse(item.payload).id, safe.message);
          this.repository.removeJob(profile.id, item);
        }
      }
      for (let page = 0; page < 5; page++) {
        const manifest = await relay.manifest(token, this.cursor, signal); guard();
        const entries = manifest.entries.map(value => manifestEntrySchema.parse(value));
        if (entries.length > 50 || (manifest.next !== null && (typeof manifest.next !== 'string' || manifest.next === this.cursor))) throw new RelayError('invalid', '摘要分頁無效。');
        const changed = entries.filter(entry => entry.ownerDeviceId !== profile.deviceId && this.repository.activeDevice(profile.id, entry.ownerDeviceId)
          && entry.version > this.repository.cachedVersion(profile.id, entry.ownerDeviceId, entry.projectId));
        for (let offset = 0; offset < changed.length; offset += 5) {
          const refs = changed.slice(offset, offset + 5).map(({ ownerDeviceId, projectId }) => ({ ownerDeviceId, projectId }));
          const snapshots = await relay.snapshots(token, refs, signal); guard();
          if (snapshots.length > refs.length) throw new RelayError('invalid', '摘要回覆數量不符。');
          for (const raw of snapshots) {
            const snapshot = remoteSnapshotSchema.parse(raw);
            if (!refs.some(ref => ref.ownerDeviceId === snapshot.ownerDeviceId && ref.projectId === snapshot.projectId)) throw new RelayError('invalid', '摘要來源不符。');
            this.repository.cacheSnapshot(profile.id, snapshot);
          }
        }
        this.cursor = manifest.next;
        if (!this.cursor) break;
      }
      const incoming = await relay.pull(token, signal); guard();
      if (incoming.length > 50) throw new RelayError('invalid', '訊息批次過大。');
      for (const raw of incoming) {
        const message = relayMessageSchema.parse(raw);
        if (!devices.some(device => device.id === message.fromDeviceId) || message.fromDeviceId === profile.deviceId) throw new RelayError('invalid', '訊息來源不符。');
        this.repository.ingest(profile, message);
      }
      // Flush only receipts created by the completed ingest, never acknowledge before persistence.
      for (const item of this.repository.due(profile.id).filter(item => item.kind === 'ack')) {
        guard(); await relay.acknowledge(token, [JSON.parse(item.payload).id], signal); guard(); this.repository.removeJob(profile.id, item);
      }
      const ids = this.repository.statusIds(profile.id);
      if (ids.length) {
        const receipts = await relay.statuses(token, ids, signal); guard();
        if (receipts.length > ids.length) throw new RelayError('invalid', '回覆狀態數量不符。');
        for (const raw of receipts) {
          const receipt = messageReceiptSchema.parse(raw);
          if (!ids.includes(receipt.id)) throw new RelayError('invalid', '回覆的訊息識別碼不符。');
          this.repository.receipt(profile.id, receipt);
        }
        this.repository.checkedStatuses(profile.id, ids);
      }
      guard(); this.repository.setConnection(profile.id, 'online', publicationErrors.length ? translateError('device.publicationErrors', this.repository.store.getSettings().locale) : null, true);
      await this.afterSync?.();
      guard(); this.failures = 0; this.nextAt = this.repository.clock() + 15000;
    } catch (error) {
      const safe = syncError(error, this.repository.store.getSettings().locale);
      if (session && this.current(session) && !signal.aborted && !this.stopped) {
        if (safe.code === 'unauthorized') this.repository.setEnabled(session.profile.id, false);
        this.repository.setConnection(session.profile.id, safe.code === 'unauthorized' ? 'revoked' : 'error', safe.message);
      }
      this.failures++;
      this.nextAt = this.repository.clock() + Math.min(300000, 15000 * 2 ** Math.min(this.failures, 4)) + Math.floor(Math.random() * 1000);
    }
  }
}
