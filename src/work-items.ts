import { activeWorkHold, canCompleteWork, workBriefSchema, type CreateWorkItemInput, type WorkAction, type WorkBrief, type WorkCheck, type WorkCommand, type WorkItem, type WorkMutation } from '../shared/work-items';
import { translate, type Locale } from '../shared/i18n';
import { workItemApi } from './api';
import { workItemMessages, type WorkItemMessageKey } from './locales/work-items';

export type WorkBucket = 'actionable' | 'returning' | 'held' | 'completed';
export function currentWorkCheck(item: WorkItem, role: WorkCheck['role']): WorkCheck | null {
  const check = item.checks[role];
  return check && check.version === item.version && check.submissionId === item.currentSubmissionId ? check : null;
}
export function hasFailedWorkCheck(item: WorkItem): boolean {
  return ['self', 'partner'].some(role => currentWorkCheck(item, role as WorkCheck['role'])?.outcome === 'fail');
}
export function workBucket(item: WorkItem, now = Date.now()): WorkBucket {
  if (item.phase === 'done') return 'completed';
  if (activeWorkHold(item, now)) return 'held';
  if (hasFailedWorkCheck(item)) return 'actionable';
  return item.phase === 'awaiting_return' || item.phase === 'review' ? 'returning' : 'actionable';
}
/** Never filters using parent project status. Expired deferrals only change placement. */
export function groupWorkItems(items: WorkItem[], projectId = '', focusIds: readonly string[] = [], now = Date.now()): Record<WorkBucket, WorkItem[]> {
  const groups: Record<WorkBucket, WorkItem[]> = { actionable: [], returning: [], held: [], completed: [] };
  const rank = (item: WorkItem) => hasFailedWorkCheck(item) ? 0 : item.phase === 'review' ? 1 : item.phase === 'awaiting_return' ? 2 : item.phase === 'ready' ? 3 : 4;
  const focusRank = (id: string) => { const index = focusIds.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  for (const item of items) if (!projectId || item.projectId === projectId) groups[workBucket(item, now)].push(item);
  for (const [bucket, values] of Object.entries(groups)) values.sort((a, b) => bucket === 'completed'
    ? b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    : rank(a) - rank(b) || focusRank(a.projectId) - focusRank(b.projectId) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  return groups;
}
export function workNextAction(item: WorkItem, locale: Locale, now = Date.now()): string {
  const t = (key: WorkItemMessageKey) => translate(workItemMessages, locale, key);
  const hold = activeWorkHold(item, now);
  if (hold) return hold.resumeAction;
  if (hasFailedWorkCheck(item)) return t('next_rework');
  if (item.phase === 'done') return t('next_done');
  if (canCompleteWork(item, now)) return t('next_complete');
  if (item.nextAction.trim()) return item.nextAction;
  if (item.phase === 'review') {
    if (currentWorkCheck(item, 'self')?.outcome === 'pass') return t('next_partner');
    if (currentWorkCheck(item, 'partner')?.outcome === 'pass') return t('next_self');
  }
  return t(`next_${item.phase}`);
}
export const sameWorkBrief = (a: WorkBrief, b: WorkBrief) => JSON.stringify(a) === JSON.stringify(b);
export function validWorkDraft(brief: WorkBrief): boolean {
  return workBriefSchema.safeParse(brief).success && !!(brief.title.trim() || brief.goal.trim());
}
export function canAdoptWorkPoll(base: WorkItem, incoming: WorkItem | undefined, guarded: boolean): incoming is WorkItem {
  return !guarded && !!incoming && incoming.id === base.id && incoming.revision > base.revision;
}
/** A sent request owns its immutable payload. An explicit retry reuses it verbatim. */
export type PendingWorkRequest = { kind: 'create'; projectId: string; input: CreateWorkItemInput } | { kind: 'action'; itemId: string; input: WorkCommand };
export function prepareWorkCreate(projectId: string, brief: WorkBrief, sourceWorkItemId?: string): PendingWorkRequest {
  return { kind: 'create', projectId, input: { commandId: crypto.randomUUID(), brief: structuredClone(brief), ...(sourceWorkItemId ? { sourceWorkItemId } : {}) } };
}
export function prepareWorkAction(item: WorkItem, action: WorkAction): PendingWorkRequest {
  return { kind: 'action', itemId: item.id, input: { commandId: crypto.randomUUID(), expectedRevision: item.revision, action: structuredClone(action) } };
}
export function sendWorkRequest(request: PendingWorkRequest) {
  return request.kind === 'create' ? workItemApi.createDraft(request.projectId, request.input) : workItemApi.apply(request.itemId, request.input);
}
/** Commit feedback precedes refresh; a read failure never turns a successful write into a retry. */
export async function commitWorkRequest(request: PendingWorkRequest, committed: (result: WorkMutation) => void, refresh: (item: WorkItem) => Promise<void>): Promise<{ refreshFailed: boolean }> {
  const result = await sendWorkRequest(request);
  committed(result);
  try { await refresh(result.item); return { refreshFailed: false }; }
  catch { return { refreshFailed: true }; }
}
export function workEventLabel(type: string): WorkItemMessageKey {
  const key = `event_${type}`;
  return Object.hasOwn(workItemMessages.en, key) ? key as WorkItemMessageKey : 'event_unknown';
}
