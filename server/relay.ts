import type { DeviceRecord, ManifestEntry, MessageDecision, MessageReceipt, OutboundMessage, PairAttempt, PairResult, RelayConfiguration, RelayMessage, RemoteSnapshot, SnapshotPublication } from '../shared/devices.js';
import type { GovernanceRelay } from '../shared/governance.js';
import type { AppObservationRelay } from '../shared/app-observation.js';

export interface SecureCodec {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}
export interface RelayClient {
  /** Absent on legacy/custom relays. Capability failure must never bypass Git approval. */
  governance?: GovernanceRelay;
  /** Independent optional channel; never extends the legacy governance/status wire DTOs. */
  appObservation?: AppObservationRelay;
  pair(input: PairAttempt, signal?: AbortSignal): Promise<PairResult>;
  listDevices(token: string, signal?: AbortSignal): Promise<DeviceRecord[]>;
  renameDevice(token: string, name: string, signal?: AbortSignal): Promise<void>;
  createInvite(token: string, code: string, signal?: AbortSignal): Promise<{ expiresAt: string }>;
  revokeDevice(token: string, deviceId: string, signal?: AbortSignal): Promise<void>;
  publish(token: string, snapshot: SnapshotPublication, signal?: AbortSignal): Promise<void>;
  manifest(token: string, after: string | null, signal?: AbortSignal): Promise<{ entries: ManifestEntry[]; next: string | null }>;
  snapshots(token: string, refs: { ownerDeviceId: string; projectId: string }[], signal?: AbortSignal): Promise<RemoteSnapshot[]>;
  send(token: string, message: OutboundMessage, signal?: AbortSignal): Promise<RelayMessage>;
  pull(token: string, signal?: AbortSignal): Promise<RelayMessage[]>;
  acknowledge(token: string, ids: string[], signal?: AbortSignal): Promise<void>;
  statuses(token: string, ids: string[], signal?: AbortSignal): Promise<MessageReceipt[]>;
  checkProposal(token: string, id: string, hash: string, signal?: AbortSignal): Promise<RelayMessage>;
  resolve(token: string, id: string, decision: MessageDecision, signal?: AbortSignal): Promise<void>;
}
export type RelayFactory = (configuration: RelayConfiguration) => RelayClient;
export class RelayError extends Error {
  constructor(public code: 'unauthorized' | 'denied' | 'invalid' | 'conflict' | 'expired' | 'unavailable' | 'aborted', message: string, public retryable = false) {
    super(message); this.name = 'RelayError';
  }
}
