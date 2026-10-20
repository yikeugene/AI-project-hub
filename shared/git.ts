import { z } from 'zod';
import type { GitSnapshot } from './types.js';

const uuid = z.string().uuid();
export const gitDigestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).refine(value => value.length === 40 || value.length === 64);
const date = z.string().datetime({ offset: true });
const path = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'Invalid path');
const branch = z.string().min(1).max(256);
const remote = z.string().min(1).max(128);
const paths = z.array(path).min(1).max(200);
export const gitOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), paths }).strict(),
  z.object({ kind: z.literal('unstage'), paths }).strict(),
  z.object({ kind: z.literal('commit'), message: z.string().trim().min(1).max(10000), authorName: z.string().trim().min(1).max(200), authorEmail: z.string().trim().email().max(254) }).strict(),
  z.object({ kind: z.literal('createBranch'), branch }).strict(),
  z.object({ kind: z.literal('switchBranch'), branch }).strict(),
  z.object({ kind: z.literal('fetch'), remote, branch }).strict(),
  z.object({ kind: z.literal('pull'), remote, branch }).strict(),
  z.object({ kind: z.literal('push'), remote, branch }).strict(),
]);
export type GitOperation = z.infer<typeof gitOperationSchema>;
export const GIT_OPERATION_KINDS = ['stage', 'unstage', 'commit', 'createBranch', 'switchBranch', 'fetch', 'pull', 'push'] as const;
export const gitReviewSummarySchema = z.object({
  projectName: z.string().min(1).max(120), kind: z.enum(GIT_OPERATION_KINDS),
  paths: z.array(path).max(200), branch: branch.nullable(),
  head: gitOidSchema.nullable(), target: gitOidSchema.nullable(),
  remoteUrl: z.string().max(2048).nullable(), targetRef: z.string().max(512).nullable(),
  changedCount: z.number().int().nonnegative(), stagedCount: z.number().int().nonnegative(),
  message: z.string().max(10000).nullable(), authorName: z.string().max(200).nullable(), authorEmail: z.string().max(254).nullable(),
}).strict();
export type GitReviewSummary = z.infer<typeof gitReviewSummarySchema>;
export const gitExecutionResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'partial', 'unknown']),
  code: z.string().regex(/^[a-zA-Z0-9.-]{1,80}$/).refine(value => !/[\r\n]/.test(value)),
  head: gitOidSchema.nullable(),
}).strict();
export type GitExecutionResult = z.infer<typeof gitExecutionResultSchema>;
export interface GitRemote { name: string; url: string; supported: boolean }
export interface GitDetails {
  snapshot: GitSnapshot;
  remotes: GitRemote[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  operationState: string | null;
  unsupportedReasons: string[];
  identity: { name: string; email: string };
}
export const gitDiffInputSchema = z.object({ path, source: z.enum(['index', 'worktree']) }).strict();
export type GitDiffInput = z.infer<typeof gitDiffInputSchema>;
export interface GitDiff { path: string; source: 'index' | 'worktree'; text: string; binary: boolean; truncated: boolean }
export const gitPreviewSchema = z.object({
  id: uuid, projectId: uuid, operation: gitOperationSchema, summary: gitReviewSummarySchema,
  digest: gitDigestSchema, createdAt: date, expiresAt: date,
}).strict();
export type GitPreview = z.infer<typeof gitPreviewSchema>;
export const gitApprovalSubmissionSchema = z.object({
  id: uuid, reviewerDeviceId: uuid, digest: gitDigestSchema, summary: gitReviewSummarySchema, expiresAt: date,
}).strict();
export type GitApprovalSubmission = z.infer<typeof gitApprovalSubmissionSchema>;
export const gitApprovalSchema = gitApprovalSubmissionSchema.extend({
  fromDeviceId: uuid, createdAt: date,
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'consumed']),
  decidedAt: date.nullable(), reason: z.string().max(1000).nullable(),
  approvedBy: uuid.nullable(), approvedEpoch: z.number().int().nonnegative().nullable(),
  executionId: uuid.nullable(), consumedAt: date.nullable(), result: gitExecutionResultSchema.nullable(),
}).strict();
export type GitApproval = z.infer<typeof gitApprovalSchema>;
export const gitConsumptionSchema = z.object({ id: uuid, executionId: uuid, consumedAt: date, replayed: z.boolean() }).strict();
export type GitConsumption = z.infer<typeof gitConsumptionSchema>;
export type LocalGitState = 'prepared' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'stale' | 'consuming' | 'executing' | 'succeeded' | 'failed' | 'partial' | 'unknown';
export interface GitRequestView {
  preview: GitPreview;
  state: LocalGitState;
  approval: GitApproval | null;
  result: GitExecutionResult | null;
  error: string | null;
  fenceAcknowledged: boolean;
  updatedAt: string;
}
export interface GitAuditEvent { id: number; requestId: string; state: string; at: string }
