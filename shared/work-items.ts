import { z } from 'zod';
import type { Locale } from './i18n.js';

const text = z.string().max(2000);
const nonempty = text.refine(value => value.trim().length > 0);
const uuid = z.string().uuid();
export const WORK_PHASES = ['draft', 'ready', 'awaiting_return', 'review', 'done'] as const;
export const workBriefSchema = z.object({
  title: z.string().max(160), goal: text, nonGoals: text,
  acceptanceCriteria: z.array(z.string().max(500)).max(10), firstCheck: text,
}).strict();
export type WorkBrief = z.infer<typeof workBriefSchema>;
export const emptyWorkBrief = (): WorkBrief => ({ title: '', goal: '', nonGoals: '', acceptanceCriteria: [], firstCheck: '' });
export function isWorkBriefReady(brief: WorkBrief): boolean {
  return !!brief.title.trim() && !!brief.goal.trim() && !!brief.firstCheck.trim()
    && brief.acceptanceCriteria.length > 0 && brief.acceptanceCriteria.every(value => !!value.trim());
}
export const workHoldSchema = z.object({
  kind: z.enum(['deferred', 'waiting', 'paused']), reason: nonempty, resumeAction: nonempty,
  until: z.string().datetime().nullable().default(null),
}).strict().refine(value => value.kind !== 'deferred' || value.until !== null);
export type WorkHold = z.infer<typeof workHoldSchema>;
export const checkSources = ['self', 'message', 'call', 'in_person', 'other'] as const;
export interface WorkCheck {
  role: 'self' | 'partner'; outcome: 'pass' | 'fail'; note: string;
  source: typeof checkSources[number]; version: number; submissionId: string;
  recordedAt: string; recordedBy: 'local-user';
}
export interface WorkItem {
  id: string; projectId: string; revision: number; version: number;
  phase: typeof WORK_PHASES[number]; brief: WorkBrief; progress: string; nextAction: string;
  hold: WorkHold | null; currentSubmissionId: string | null;
  checks: { self: WorkCheck | null; partner: WorkCheck | null };
  sourceWorkItemId: string | null; createdAt: string; updatedAt: string;
}
export interface WorkEvent {
  id: string; itemId: string; commandId: string; type: string; version: number;
  payload: Record<string, unknown>; at: string; resultRevision: number;
}
export interface WorkItemDetail { item: WorkItem; events: WorkEvent[] }
export interface WorkPreview { markdown: string; hash: string; version: number; revision: number }
export interface WorkReceipt { eventId: string; commandId: string; resultRevision: number; replayed: boolean }
export interface WorkMutation { item: WorkItem; receipt: WorkReceipt }
export const createWorkItemSchema = z.object({
  commandId: uuid, brief: workBriefSchema, sourceWorkItemId: uuid.optional(),
}).strict();
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export const workActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('saveDraft'), brief: workBriefSchema }).strict(),
  z.object({ type: z.literal('confirm') }).strict(),
  z.object({ type: z.literal('dispatch'), previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal('startReview'), resultNote: text.default('') }).strict(),
  z.object({ type: z.literal('recordCheck'), role: z.enum(['self', 'partner']), outcome: z.enum(['pass', 'fail']),
    note: nonempty, source: z.enum(checkSources), version: z.number().int().positive(), submissionId: uuid }).strict(),
  z.object({ type: z.literal('saveProgress'), progress: text, nextAction: nonempty }).strict(),
  z.object({ type: z.literal('revise'), kind: z.enum(['scope', 'rework', 'reopen']), reason: nonempty }).strict(),
  z.object({ type: z.literal('setHold'), hold: workHoldSchema }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('complete') }).strict(),
]);
export type WorkAction = z.infer<typeof workActionSchema>;
export const workCommandSchema = z.object({ commandId: uuid, expectedRevision: z.number().int().positive(), action: workActionSchema }).strict();
export type WorkCommand = z.infer<typeof workCommandSchema>;
export function activeWorkHold(item: Pick<WorkItem, 'hold'>, now = Date.now()): WorkHold | null {
  const hold = item.hold;
  return hold && (hold.kind !== 'deferred' || !hold.until || Date.parse(hold.until) > now) ? hold : null;
}
export function canCompleteWork(item: WorkItem, now = Date.now()): boolean {
  return item.phase === 'review' && !activeWorkHold(item, now) && !!item.currentSubmissionId
    && [item.checks.self, item.checks.partner].every(check => check?.outcome === 'pass'
      && check.version === item.version && check.submissionId === item.currentSubmissionId);
}
export function buildWorkBrief(item: Pick<WorkItem, 'id' | 'version' | 'brief' | 'progress' | 'nextAction'>, locale: Locale = 'zh-TW'): string {
  const zh = locale === 'zh-TW', { brief } = item;
  return [
    `# ${brief.title}`, '', `${zh ? '本輪成果' : 'Work item'}: ${item.id} / v${item.version}`, '',
    zh ? '請只完成以下已確認的範圍。遵循專案現有指引；不要因補充資料而擴大任務或上傳秘密。' : 'Complete only the confirmed scope below. Follow existing project instructions; context is not permission to expand the task or upload secrets.', '',
    `## ${zh ? '本輪目標' : 'Goal'}`, brief.goal, '',
    `## ${zh ? '本輪不做' : 'Out of scope'}`, brief.nonGoals || (zh ? '沒有另外列出的非目標；不要增加未要求的功能。' : 'No additional exclusions; do not add unrequested features.'), '',
    `## ${zh ? '驗收條件' : 'Acceptance criteria'}`, ...brief.acceptanceCriteria.map(value => `- ${value}`), '',
    `## ${zh ? '返回後先檢查' : 'First check on return'}`, brief.firstCheck, '',
    ...(item.progress ? [`## ${zh ? '已記錄的進度' : 'Recorded progress'}`, item.progress, ''] : []),
    ...(item.nextAction ? [`## ${zh ? '已記錄的下一步' : 'Recorded next action'}`, item.nextAction, ''] : []),
    zh ? '完成後請列出實際變更、實際執行的測試、未解決問題及如何驗證。沒有執行的測試請明確說明；不要將 AI 回覆視為雙方已驗收。' : 'Report actual changes, tests actually run, unresolved issues and how to verify. State which tests were not run; an AI reply is not acceptance by both reviewers.',
  ].join('\n');
}
