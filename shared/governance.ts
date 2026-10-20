import { z } from 'zod';
import { gitApprovalSchema, gitApprovalSubmissionSchema, gitConsumptionSchema, gitExecutionResultSchema } from './git.js';
import type { GitApproval, GitApprovalSubmission, GitConsumption, GitExecutionResult } from './git.js';

const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deviceRoleSchema = z.enum(['admin', 'member']);
export type DeviceRole = z.infer<typeof deviceRoleSchema>;
export const governancePolicySchema = z.object({
  protocol: z.literal(2), networkId: uuid, deviceId: uuid, role: deviceRoleSchema,
  epoch: count, roles: z.array(z.object({ deviceId: uuid, role: deviceRoleSchema }).strict()).max(100),
}).strict();
export type GovernancePolicy = z.infer<typeof governancePolicySchema>;
export const appActivitySchema = z.object({
  mode: z.enum(['foreground', 'background']),
  sync: z.enum(['idle', 'syncing', 'online', 'error', 'paused']),
  lastSyncAt: date.nullable(),
  operations: z.array(z.object({
    kind: z.enum(['scan', 'sync', 'git']),
    state: z.enum(['pending', 'running', 'succeeded', 'failed', 'unknown']),
    at: date,
  }).strict()).max(10),
}).strict();
export type AppActivity = z.infer<typeof appActivitySchema>;
export const sharedProjectStatusSchema = z.object({
  projectId: uuid, name: z.string().min(1).max(120),
  git: z.object({
    branch: z.string().max(256).nullable(), changedCount: count, stagedCount: count,
    conflictCount: count, observedAt: date.nullable(), unavailable: z.boolean(),
  }).strict().nullable(),
  tasks: z.object({ todo: count, doing: count, blocked: count, done: count }).strict().nullable(),
}).strict();
export type SharedProjectStatus = z.infer<typeof sharedProjectStatusSchema>;
export const deviceStatusPublicationSchema = z.object({
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  activity: appActivitySchema.nullable(), projects: z.array(sharedProjectStatusSchema).max(20),
}).strict();
export type DeviceStatusPublication = z.infer<typeof deviceStatusPublicationSchema>;
export const remoteDeviceStatusSchema = deviceStatusPublicationSchema.extend({ deviceId: uuid, receivedAt: date }).strict();
export type RemoteDeviceStatus = z.infer<typeof remoteDeviceStatusSchema>;
export const statusSharingPolicySchema = z.object({
  activity: z.boolean(),
  projects: z.array(z.object({ projectId: uuid, git: z.boolean(), tasks: z.boolean() }).strict()).max(20),
}).strict();
export type StatusSharingPolicy = z.infer<typeof statusSharingPolicySchema>;
export interface GovernanceState {
  available: boolean; policy: GovernancePolicy | null;
  error: string | null; sharing: StatusSharingPolicy; statuses: RemoteDeviceStatus[];
}
export interface StatusSharingPreview {
  policy: StatusSharingPolicy; publication: DeviceStatusPublication; digest: string; bytes: number;
}
export interface GovernanceRelay {
  policy(token: string, signal?: AbortSignal): Promise<GovernancePolicy>;
  setRole(token: string, deviceId: string, role: DeviceRole, signal?: AbortSignal): Promise<void>;
  submitGit(token: string, request: GitApprovalSubmission, signal?: AbortSignal): Promise<GitApproval>;
  listGit(token: string, signal?: AbortSignal): Promise<GitApproval[]>;
  getGit(token: string, id: string, signal?: AbortSignal): Promise<GitApproval>;
  decideGit(token: string, id: string, digest: string, decision: 'approved' | 'rejected', reason: string, signal?: AbortSignal): Promise<GitApproval>;
  cancelGit(token: string, id: string, digest: string, signal?: AbortSignal): Promise<GitApproval>;
  consumeGit(token: string, id: string, digest: string, executionId: string, signal?: AbortSignal): Promise<GitConsumption>;
  reportGit(token: string, id: string, executionId: string, result: GitExecutionResult, signal?: AbortSignal): Promise<void>;
  publishStatus(token: string, status: DeviceStatusPublication, signal?: AbortSignal): Promise<void>;
  statuses(token: string, signal?: AbortSignal): Promise<RemoteDeviceStatus[]>;
}
export { gitApprovalSchema, gitApprovalSubmissionSchema, gitConsumptionSchema, gitExecutionResultSchema };
