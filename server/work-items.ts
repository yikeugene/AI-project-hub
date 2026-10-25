import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { appError } from './validation.js';
import {
  activeWorkHold, buildWorkBrief, canCompleteWork, createWorkItemSchema, isWorkBriefReady, workCommandSchema,
  type CreateWorkItemInput, type WorkItem, type WorkItemDetail, type WorkEvent, type WorkMutation, type WorkCommand, type WorkPreview,
} from '../shared/work-items.js';

type Row = Record<string, string | number | null>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const noChecks = () => ({ self: null, partner: null });
function readItem(row: Row): WorkItem {
  return { id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), version: Number(row.version),
    phase: row.phase as WorkItem['phase'], brief: JSON.parse(String(row.brief_json)), progress: String(row.progress), nextAction: String(row.next_action),
    hold: row.hold_json ? JSON.parse(String(row.hold_json)) : null, currentSubmissionId: row.submission_id as string | null,
    checks: JSON.parse(String(row.checks_json)), sourceWorkItemId: row.source_work_item_id as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function readEvent(row: Row): WorkEvent {
  return { id: String(row.id), itemId: String(row.item_id), commandId: String(row.command_id), type: String(row.type),
    version: Number(row.version), payload: JSON.parse(String(row.payload_json)), at: String(row.at), resultRevision: Number(row.result_revision) };
}

/** One transaction owns the state, version invariants and durable retry receipt. No project or sync writes. */
export class WorkItems {
  constructor(private store: Store, private clock: () => string = () => new Date().toISOString()) {}
  list(projectId?: string): WorkItem[] {
    const rows = projectId
      ? this.store.db.prepare('SELECT * FROM work_items WHERE project_id=? ORDER BY updated_at DESC,id').all(projectId)
      : this.store.db.prepare('SELECT * FROM work_items ORDER BY updated_at DESC,id').all();
    return (rows as Row[]).map(readItem);
  }
  get(id: string): WorkItem {
    const row = this.store.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as Row | undefined;
    if (!row) throw appError(404, 'work.notFound');
    return readItem(row);
  }
  detail(id: string): WorkItemDetail {
    return { item: this.get(id), events: (this.store.db.prepare('SELECT * FROM work_item_events WHERE item_id=? ORDER BY result_revision,id').all(id) as Row[]).map(readEvent) };
  }
  preview(id: string): WorkPreview {
    const item = this.get(id);
    if (item.phase === 'draft' || !isWorkBriefReady(item.brief)) throw appError(409, 'work.incompleteBrief');
    const markdown = buildWorkBrief(item, this.store.getSettings().locale);
    return { markdown, hash: createHash('sha256').update(markdown, 'utf8').digest('hex'), version: item.version, revision: item.revision };
  }
  createDraft(projectId: string, raw: CreateWorkItemInput): WorkMutation {
    const input = createWorkItemSchema.parse(raw), hash = digest({ projectId, input });
    return this.store.transaction(() => {
      const replay = this.replay(input.commandId, hash);
      if (replay) return replay;
      this.store.getProject(projectId);
      if (!input.brief.title.trim() && !input.brief.goal.trim()) throw appError(400, 'work.incompleteBrief');
      if (input.sourceWorkItemId && this.get(input.sourceWorkItemId).projectId !== projectId) throw appError(400, 'work.sourceProject');
      const at = this.clock(), id = randomUUID();
      this.store.db.prepare(`INSERT INTO work_items(id,project_id,phase,brief_json,checks_json,source_work_item_id,created_at,updated_at)
        VALUES(?,?,'draft',?,?,?,?,?)`).run(id, projectId, JSON.stringify(input.brief), JSON.stringify(noChecks()), input.sourceWorkItemId ?? null, at, at);
      const item = this.get(id);
      return this.record(item, input.commandId, hash, 'created', { brief: item.brief, sourceWorkItemId: item.sourceWorkItemId }, at);
    });
  }
  apply(id: string, raw: WorkCommand): WorkMutation {
    const command = workCommandSchema.parse(raw), hash = digest({ id, command });
    return this.store.transaction(() => {
      const replay = this.replay(command.commandId, hash);
      if (replay) return replay;
      const item = this.get(id);
      if (item.revision !== command.expectedRevision) throw appError(409, 'revision.stale');
      const at = this.clock(), action = command.action;
      const stage = (...allowed: WorkItem['phase'][]) => { if (!allowed.includes(item.phase)) throw appError(409, 'work.invalidAction'); };
      const available = () => { if (activeWorkHold(item, Date.parse(at))) throw appError(409, 'work.held'); };
      let payload: Record<string, unknown> = { ...action };
      switch (action.type) {
        case 'saveDraft':
          stage('draft');
          if (!action.brief.title.trim() && !action.brief.goal.trim()) throw appError(400, 'work.incompleteBrief');
          item.brief = action.brief;
          break;
        case 'confirm':
          stage('draft'); available();
          if (!isWorkBriefReady(item.brief)) throw appError(400, 'work.incompleteBrief');
          item.phase = 'ready';
          break;
        case 'dispatch': {
          stage('ready'); available();
          const preview = this.preview(id);
          if (preview.hash !== action.previewHash) throw appError(409, 'work.previewChanged');
          item.phase = 'awaiting_return'; item.currentSubmissionId = randomUUID(); item.checks = noChecks();
          payload = { submissionId: item.currentSubmissionId, source: 'codex', brief: item.brief, markdown: preview.markdown, hash: preview.hash };
          break;
        }
        case 'startReview': {
          stage('ready', 'awaiting_return'); available();
          const manual = item.phase === 'ready';
          if (manual) item.currentSubmissionId = randomUUID();
          if (!item.currentSubmissionId) throw appError(409, 'work.invalidAction');
          item.phase = 'review';
          payload = { submissionId: item.currentSubmissionId, source: manual ? 'manual' : 'codex', resultNote: action.resultNote, brief: item.brief };
          break;
        }
        case 'recordCheck':
          stage('review'); available();
          if (action.version !== item.version || action.submissionId !== item.currentSubmissionId) throw appError(409, 'work.checkVersion');
          if (item.checks[action.role]) throw appError(409, 'work.checkRecorded');
          if ((action.role === 'self') !== (action.source === 'self')) throw appError(400, 'work.checkSource');
          item.checks[action.role] = { role: action.role, outcome: action.outcome, note: action.note, source: action.source,
            version: item.version, submissionId: action.submissionId, recordedAt: at, recordedBy: 'local-user' };
          break;
        case 'saveProgress':
          stage('draft', 'ready', 'awaiting_return', 'review');
          item.progress = action.progress; item.nextAction = action.nextAction;
          break;
        case 'revise':
          if (action.kind === 'reopen') stage('done');
          else if (action.kind === 'rework') stage('awaiting_return', 'review');
          else stage('ready', 'awaiting_return', 'review', 'done');
          available();
          payload = { ...action, previousVersion: item.version, previousSubmissionId: item.currentSubmissionId, previousChecks: item.checks, previousBrief: item.brief };
          item.version++; item.phase = action.kind === 'scope' ? 'draft' : 'ready';
          item.currentSubmissionId = null; item.checks = noChecks();
          break;
        case 'setHold':
          stage('draft', 'ready', 'awaiting_return', 'review');
          if (action.hold.kind === 'deferred' && Date.parse(action.hold.until!) <= Date.parse(at)) throw appError(400, 'work.deferTime');
          item.hold = action.hold;
          break;
        case 'resume':
          if (!item.hold) throw appError(409, 'work.invalidAction');
          item.hold = null;
          break;
        case 'complete':
          stage('review'); available();
          if (!canCompleteWork(item, Date.parse(at))) throw appError(409, 'work.notVerified');
          item.phase = 'done';
          break;
      }
      const changed = this.store.db.prepare(`UPDATE work_items SET revision=revision+1,version=?,phase=?,brief_json=?,progress=?,next_action=?,
        hold_json=?,submission_id=?,checks_json=?,updated_at=? WHERE id=? AND revision=?`).run(item.version, item.phase, JSON.stringify(item.brief),
          item.progress, item.nextAction, item.hold ? JSON.stringify(item.hold) : null, item.currentSubmissionId, JSON.stringify(item.checks), at, id, command.expectedRevision);
      if (Number(changed.changes) !== 1) throw appError(409, 'revision.changed');
      item.revision++; item.updatedAt = at;
      return this.record(item, command.commandId, hash, action.type, payload, at);
    });
  }
  private replay(commandId: string, hash: string): WorkMutation | null {
    const row = this.store.db.prepare('SELECT * FROM work_item_events WHERE command_id=?').get(commandId) as Row | undefined;
    if (!row) return null;
    if (row.request_hash !== hash) throw appError(409, 'work.commandChanged');
    return { item: this.get(String(row.item_id)), receipt: { eventId: String(row.id), commandId, resultRevision: Number(row.result_revision), replayed: true } };
  }
  private record(item: WorkItem, commandId: string, hash: string, type: string, payload: Record<string, unknown>, at: string): WorkMutation {
    const id = randomUUID();
    this.store.db.prepare(`INSERT INTO work_item_events(id,item_id,command_id,request_hash,type,version,payload_json,at,result_revision)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, item.id, commandId, hash, type, item.version, JSON.stringify(payload), at, item.revision);
    return { item, receipt: { eventId: id, commandId, resultRevision: item.revision, replayed: false } };
  }
}
