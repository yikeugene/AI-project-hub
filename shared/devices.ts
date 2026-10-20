import { z } from 'zod';
import { MEMORY_FIELDS, PRIORITIES, PROJECT_STATUSES } from './types.js';
import type { ProjectMemory } from './types.js';
import type { MessageParams } from './i18n.js';
import type { ErrorCode } from './messages.js';

export const DEVICE_PROTOCOL = 1;
export const MAX_RELAY_BYTES = 262144;
export const MAX_BATCH = 50;
export type MemoryField = typeof MEMORY_FIELDS[number];
const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const deviceNameSchema = z.string().trim().min(1).max(80);
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const memoryPatchSchema = z.object(Object.fromEntries(MEMORY_FIELDS.map(key => [key, z.string().max(20000)])) as Record<MemoryField, z.ZodString>).partial().strict();
export const proposalChangesSchema = z.object({ nextAction: z.string().max(2000).optional(), memory: memoryPatchSchema.optional() }).strict()
  .refine(value => value.nextAction !== undefined || Object.keys(value.memory ?? {}).length > 0, '請至少提出一項變更。');
export const messagePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(1), kind: z.literal('message'), text: z.string().trim().min(1).max(10000) }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal('proposal'), text: z.string().max(10000), projectId: uuid, baseRevision: positive, changes: proposalChangesSchema }).strict(),
]);
export type MessagePayload = z.infer<typeof messagePayloadSchema>;
export type ProposalPayload = Extract<MessagePayload, { kind: 'proposal' }>;
export type ProposalChanges = z.infer<typeof proposalChangesSchema>;

export const sharedProjectSchema = z.object({
  name: z.string().min(1).max(120), status: z.enum(PROJECT_STATUSES), priority: z.enum(PRIORITIES),
  stage: z.string().max(160), nextAction: z.string().max(2000), revision: positive, memory: memoryPatchSchema,
}).strict();
export type SharedProject = z.infer<typeof sharedProjectSchema>;
export const sharePolicySchema = z.object({ projectId: uuid, enabled: z.boolean(), memoryFields: z.array(z.enum(MEMORY_FIELDS)).max(MEMORY_FIELDS.length) }).strict();
export type SharePolicy = z.infer<typeof sharePolicySchema>;
export const publicationSchema = z.object({ projectId: uuid, version: positive, project: sharedProjectSchema.nullable() }).strict();
export type SnapshotPublication = z.infer<typeof publicationSchema>;
export const remoteSnapshotSchema = publicationSchema.extend({ ownerDeviceId: uuid, publishedAt: date }).strict();
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>;
export interface CachedSnapshot extends RemoteSnapshot { receivedAt: string }
export const manifestEntrySchema = z.object({ ownerDeviceId: uuid, projectId: uuid, version: positive, deleted: z.boolean() }).strict();
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export const deviceRecordSchema = z.object({ id: uuid, name: deviceNameSchema, lastSeenAt: date, revokedAt: date.nullable() }).strict();
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export const DECISIONS = ['read', 'applied', 'rejected', 'conflict', 'expired'] as const;
export type Decision = typeof DECISIONS[number];
export const decisionSchema = z.object({ status: z.enum(DECISIONS), revision: positive.nullable(), at: date }).strict();
export type MessageDecision = z.infer<typeof decisionSchema>;
export const outboundMessageSchema = z.object({ id: uuid, toDeviceId: uuid, payload: z.string().max(MAX_RELAY_BYTES), expiresAt: date }).strict();
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
export const relayMessageSchema = outboundMessageSchema.extend({ fromDeviceId: uuid, hash: tokenSchema, createdAt: date, receivedAt: date.nullable(), result: decisionSchema.nullable() }).strict();
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export const messageReceiptSchema = z.object({ id: uuid, receivedAt: date.nullable(), result: decisionSchema.nullable() }).strict();
export type MessageReceipt = z.infer<typeof messageReceiptSchema>;
export interface MessageView {
  id: string; fromDeviceId: string; toDeviceId: string; payload: MessagePayload; hash: string;
  direction: 'inbox' | 'sent'; delivery: 'queued' | 'submitted' | 'received' | 'failed';
  createdAt: string; expiresAt: string; receivedAt: string | null; result: MessageDecision | null; error: string | null;
}
export interface ChangeEntry { key: string; label: string; before: string; after: string }
export interface ProposalPreview {
  messageId: string; hash: string; projectId: string; projectName: string;
  revision: number; baseRevision: number; changes: ChangeEntry[]; canApply: boolean; reason: string | null;
  reasonCode?: ErrorCode; reasonParams?: MessageParams;
}
export const groupLabelSchema = z.string().trim().min(1).max(120);
export const pairInputSchema = z.object({ url: z.string().max(250), publishableKey: z.string().min(20).max(2048), name: deviceNameSchema, code: tokenSchema, label: groupLabelSchema.optional(), confirm: z.literal(true) }).strict();
export type PairInput = z.infer<typeof pairInputSchema>;
export const pairResultSchema = z.object({ networkId: uuid, device: deviceRecordSchema }).strict();
export type PairResult = z.infer<typeof pairResultSchema>;
export interface PairAttempt { attemptId: string; deviceId: string; deviceToken: string; inviteToken: string; name: string }
export interface RelayConfiguration { url: string; publishableKey: string }
export interface Invitation { code: string; expiresAt: string; url: string; publishableKey: string }
export type ConnectionStatus = 'disabled' | 'unconfigured' | 'idle' | 'syncing' | 'online' | 'error' | 'revoked' | 'locked';
export const PROFILE_HEADER = 'X-Hub-Profile-Id';
export interface DeviceGroup {
  id: string; label: string; url: string; networkId: string | null; deviceId: string;
  enabled: boolean; paired: boolean; pairingPending: boolean; connection: ConnectionStatus;
  lastSyncAt: string | null; lastError: string | null;
}
export interface GroupShareInput { profileId: string; enabled: boolean; memoryFields: MemoryField[] }
export interface GroupSharingPreview {
  projectId: string; revision: number; digest: string;
  groups: { group: DeviceGroup; preview: SharedPreview }[];
}
export interface SharedWorkspaceItem {
  profileId: string; groupLabel: string; ownerDeviceId: string; ownerName: string;
  projectId: string; version: number; project: SharedProject; owned: boolean; pending: boolean;
  publishedAt: string | null; receivedAt: string | null; lastSyncAt: string | null;
}
export interface SharedWorkspaceState { groups: DeviceGroup[]; items: SharedWorkspaceItem[] }
export interface SummaryDownload { filename: string; text: string }
export interface DeviceState {
  installationId: string; profileId: string | null; groups: DeviceGroup[];
  localDevice: { id: string; name: string };
  desktopAvailable: boolean; enabled: boolean; paired: boolean; pairingPending: boolean;
  connection: ConnectionStatus; configuration: RelayConfiguration | null; networkId: string | null;
  devices: DeviceRecord[]; sharing: SharePolicy[]; lastSyncAt: string | null; lastError: string | null;
  queuedCount: number; inboxCount: number;
}
export interface ComposeMessageInput { toDeviceId: string; payload: MessagePayload }
export interface ApplyProposalInput { hash: string; revision: number; confirm: true }
export interface SharedPreview { projectId: string; policy: SharePolicy; project: SharedProject | null; bytes: number; error?: string | null; errorCode?: ErrorCode; errorParams?: MessageParams }
export function selectedMemory(memory: ProjectMemory, fields: readonly MemoryField[]): Partial<ProjectMemory> {
  return Object.fromEntries(fields.map(field => [field, memory[field]]));
}
