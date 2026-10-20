import type { CachedSnapshot, ConnectionStatus, DeviceGroup, DeviceRecord, DeviceState, GroupShareInput, GroupSharingPreview, MemoryField, MessageView, ProposalChanges, SharedWorkspaceItem } from '../shared/devices';
import { MEMORY_FIELDS } from '../shared/types';
import { createTranslator, DEFAULT_LOCALE, LocalizedError, type Locale } from '../shared/i18n';
import { clientMessages } from './locales/client';

export function getConnectionLabels(locale: Locale): Record<ConnectionStatus, string> {
  const t = createTranslator(clientMessages, locale);
  return { disabled: t('paused'), unconfigured: t('unconfigured'), idle: t('idle'), syncing: t('syncing'), online: t('online'), error: t('connectionError'), revoked: t('revokedDevice'), locked: t('locked') };
}
export function getDeliveryLabels(locale: Locale): Record<MessageView['delivery'], string> {
  const t = createTranslator(clientMessages, locale);
  return { queued: t('queued'), submitted: t('submitted'), received: t('received'), failed: t('failed') };
}
export function getDecisionLabels(locale: Locale) {
  const t = createTranslator(clientMessages, locale);
  return { read: t('read'), applied: t('applied'), rejected: t('rejected'), conflict: t('conflictDecision'), expired: t('expired') };
}
export const connectionLabels = getConnectionLabels(DEFAULT_LOCALE);
export const deliveryLabels = getDeliveryLabels(DEFAULT_LOCALE);
export const decisionLabels = getDecisionLabels(DEFAULT_LOCALE);

/** Presence is a recent heartbeat, never the time the renderer fetched cached records. */
export function devicePresence(device: DeviceRecord, now = Date.now(), locale: Locale = DEFAULT_LOCALE): string {
  const t = createTranslator(clientMessages, locale);
  if (device.revokedAt) return t('revoked');
  const lastSeen = Date.parse(device.lastSeenAt);
  return Number.isFinite(lastSeen) && lastSeen <= now + 30_000 && now - lastSeen < 120_000 ? t('recent') : t('offline');
}
export function canUseNetwork(state: DeviceState | null): boolean {
  return !!state?.desktopAvailable && !!state.profileId && state.paired && state.connection !== 'revoked' && state.connection !== 'locked';
}
export function isNetworkOnline(state: DeviceState | null): boolean {
  return canUseNetwork(state) && !!state?.enabled && state.connection === 'online';
}
export const shortDeviceId = (id: string) => id.slice(0, 8);
export const snapshotKey = (snapshot: Pick<CachedSnapshot, 'ownerDeviceId' | 'projectId'>) => `${snapshot.ownerDeviceId}:${snapshot.projectId}`;
/** Labels are not identities, and fields must never be combined across memberships. */
export const sharedWorkspaceKey = (item: Pick<SharedWorkspaceItem, 'profileId' | 'ownerDeviceId' | 'projectId'>) => JSON.stringify([item.profileId, item.ownerDeviceId, item.projectId]);
export const canSyncGroup = (group: DeviceGroup) => group.paired && group.enabled && group.connection !== 'revoked' && group.connection !== 'locked';
export function workspaceItems(items: SharedWorkspaceItem[], groups: DeviceGroup[], profileId: string, query: string): SharedWorkspaceItem[] {
  const visible = new Set(groups.filter(group => group.paired && group.connection !== 'revoked').map(group => group.id));
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => visible.has(item.profileId) && (!profileId || item.profileId === profileId)
    && (!search || [item.groupLabel, item.ownerName, item.ownerDeviceId, item.projectId, item.project.name, item.project.stage, item.project.nextAction, ...Object.values(item.project.memory)].join('\n').toLocaleLowerCase().includes(search)));
}
export function groupSharePolicies(snapshot: GroupSharingPreview): GroupShareInput[] {
  return snapshot.groups.map(({ group, preview }) => ({ profileId: group.id, enabled: preview.policy.enabled, memoryFields: MEMORY_FIELDS.filter(field => preview.policy.memoryFields.includes(field)) }));
}
export function canonicalGroupPolicies(policies: GroupShareInput[]): string {
  return JSON.stringify(policies.map(policy => ({ profileId: policy.profileId, enabled: policy.enabled, memoryFields: MEMORY_FIELDS.filter(field => policy.memoryFields.includes(field)) })).sort((a, b) => a.profileId.localeCompare(b.profileId)));
}

/** Omitted/unshared fields must remain omitted, including when a selected value is intentionally blank. */
export function proposalChanges(snapshot: CachedSnapshot, nextAction: string | undefined, memory: Partial<Record<MemoryField, string>>, _locale: Locale = DEFAULT_LOCALE): ProposalChanges {
  if (!snapshot.project) throw new LocalizedError(clientMessages, 'withdrawn');
  const changes: ProposalChanges = {};
  if (nextAction !== undefined && nextAction !== snapshot.project.nextAction) changes.nextAction = nextAction;
  const selected: Partial<Record<MemoryField, string>> = {};
  for (const field of MEMORY_FIELDS) {
    if (Object.hasOwn(snapshot.project.memory, field) && memory[field] !== undefined && memory[field] !== snapshot.project.memory[field]) selected[field] = memory[field];
  }
  if (Object.keys(selected).length) changes.memory = selected;
  return changes;
}
