import type { CachedSnapshot, ConnectionStatus, DeviceRecord, DeviceState, MemoryField, MessageView, ProposalChanges } from '../shared/devices';
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
  return !!state?.desktopAvailable && state.paired && state.connection !== 'revoked' && state.connection !== 'locked';
}
export function isNetworkOnline(state: DeviceState | null): boolean {
  return canUseNetwork(state) && !!state?.enabled && state.connection === 'online';
}
export const shortDeviceId = (id: string) => id.slice(0, 8);
export const snapshotKey = (snapshot: Pick<CachedSnapshot, 'ownerDeviceId' | 'projectId'>) => `${snapshot.ownerDeviceId}:${snapshot.projectId}`;

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
