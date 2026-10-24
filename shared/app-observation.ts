import { z } from 'zod';

export const APP_OBSERVATION_PROTOCOL = 1;
export const APP_OBSERVATION_MAX_BYTES = 1024;
export const APP_OBSERVATION_INTERVAL_MS = 15000;
// Keep these ranges identical in the native helper and SQL. No control/bidi/zero-width labels.
export const APP_NAME_FORBIDDEN_RANGES = [
  [0, 31], [127, 159], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xd800, 0xdfff], [0xfeff, 0xfeff],
] as const;
export function isAppObservationName(value: string): boolean {
  const points = Array.from(value);
  return points.length > 0 && points.length <= 96 && value === value.trim()
    && value !== '.' && value !== '..' && !/[\\/:*?"<>|]/u.test(value)
    && new TextEncoder().encode(value).length <= 384
    && points.every(point => { const code = point.codePointAt(0)!; return !APP_NAME_FORBIDDEN_RANGES.some(([first, last]) => code >= first && code <= last); });
}
export const appObservationNameSchema = z.string().refine(isAppObservationName, 'Invalid application name');
export function isAppObservationTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = Number(match[9] ?? 0), offsetMinute = Number(match[10] ?? 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 14 && offsetMinute <= 59
    && (offsetHour !== 14 || offsetMinute === 0);
}
const timestamp = z.string().max(64).refine(isAppObservationTimestamp, 'Invalid observation timestamp');
const uuid = z.string().uuid();
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const appObservationSchema = z.object({ name: appObservationNameSchema.nullable(), observedAt: timestamp }).strict();
export type AppObservation = z.infer<typeof appObservationSchema>;
export const appObservationPublicationSchema = z.object({ protocol: z.literal(1), sequence, observation: appObservationSchema.nullable() }).strict();
export type AppObservationPublication = z.infer<typeof appObservationPublicationSchema>;
export const remoteAppObservationSchema = appObservationPublicationSchema.extend({ deviceId: uuid, receivedAt: timestamp }).strict();
export type RemoteAppObservation = z.infer<typeof remoteAppObservationSchema>;
export const appObservationCapabilitySchema = z.object({ protocol: z.literal(1), networkId: uuid, deviceId: uuid }).strict();
export type AppObservationCapability = z.infer<typeof appObservationCapabilitySchema>;
export const appObservationPolicySchema = z.object({ enabled: z.boolean() }).strict();
export type AppObservationPolicy = z.infer<typeof appObservationPolicySchema>;
export interface AppObservationPreview {
  policy: AppObservationPolicy; revision: number; digest: string; fields: ['name', 'observedAt'];
}
export type AppObservationProblem = 'upgrade-required' | 'connection' | 'invalid' | 'conflict' | 'collector-unavailable' | 'session-unavailable' | null;
export interface AppObservationState {
  profileId: string | null; policy: AppObservationPolicy; revision: number;
  collectorAvailable: boolean; sessionAvailable: boolean;
  capability: 'unknown' | 'supported' | 'unsupported';
  pendingWithdrawal: boolean; local: AppObservation | null; statuses: RemoteAppObservation[];
  problem: AppObservationProblem;
}
export interface AppObservationRelay {
  /** Null is only a recognized absent optional RPC, never an authentication failure. */
  capability(token: string, signal?: AbortSignal): Promise<AppObservationCapability | null>;
  publish(token: string, publication: AppObservationPublication, signal?: AbortSignal): Promise<void>;
  statuses(token: string, signal?: AbortSignal): Promise<RemoteAppObservation[]>;
}
