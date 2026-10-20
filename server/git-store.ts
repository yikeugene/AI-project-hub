import type { Store } from './db.js';
import { appError } from './validation.js';
import { gitApprovalSchema, gitApprovalSubmissionSchema, gitExecutionResultSchema, gitPreviewSchema } from '../shared/git.js';
import type { GitApproval, GitApprovalSubmission, GitAuditEvent, GitExecutionResult, GitPreview, GitRequestView, LocalGitState } from '../shared/git.js';
import type { PreparedGitOperation } from './git-operations.js';

type Row = Record<string, string | number | null>;
export interface SavedGitOperation {
  preview: GitPreview; plan: PreparedGitOperation; state: LocalGitState;
  profileId: string; networkId: string; deviceId: string; repositoryKey: string;
  submission: GitApprovalSubmission | null; approval: GitApproval | null;
  executionId: string | null; result: GitExecutionResult | null; error: string | null;
  reportPending: boolean; fenceAcknowledged: boolean; updatedAt: string;
}
export type GitRecord = Omit<SavedGitOperation, 'plan'>;
const RECORD_COLUMNS = 'id,project_id,profile_id,network_id,device_id,repository_key,preview_json,state,submission_json,approval_json,execution_id,result_json,error_code,report_pending,fence_acknowledged,updated_at';
const parseRecord = (row: Row): GitRecord => ({
  preview: gitPreviewSchema.parse(JSON.parse(String(row.preview_json))),
  state: row.state as LocalGitState, profileId: String(row.profile_id), networkId: String(row.network_id),
  deviceId: String(row.device_id), repositoryKey: String(row.repository_key),
  submission: row.submission_json ? gitApprovalSubmissionSchema.parse(JSON.parse(String(row.submission_json))) : null,
  approval: row.approval_json ? gitApprovalSchema.parse(JSON.parse(String(row.approval_json))) : null,
  executionId: row.execution_id as string | null,
  result: row.result_json ? gitExecutionResultSchema.parse(JSON.parse(String(row.result_json))) : null,
  error: row.error_code as string | null, reportPending: !!row.report_pending,
  fenceAcknowledged: !!row.fence_acknowledged, updatedAt: String(row.updated_at),
});
const parse = (row: Row): SavedGitOperation => ({ ...parseRecord(row), plan: JSON.parse(String(row.plan_json)) as PreparedGitOperation });
const terminal = new Set<LocalGitState>(['stale', 'expired', 'cancelled', 'rejected', 'succeeded', 'failed', 'partial', 'unknown']);

/** Local execution journals never act as remote authorization. */
export class GitStore {
  constructor(readonly store: Store, readonly clock: () => number = Date.now) {}
  now() { return new Date(this.clock()).toISOString(); }
  recover() {
    const interrupted = this.store.db.prepare("SELECT id FROM git_operations WHERE state IN ('consuming','executing')").all() as Row[];
    for (const row of interrupted) this.transition(String(row.id), 'unknown', {
      result: { status: 'unknown', code: 'interrupted', head: null }, error: 'gitops.unknown', reportPending: true,
    });
  }
  get(id: string): SavedGitOperation {
    const row = this.store.db.prepare('SELECT * FROM git_operations WHERE id=?').get(id) as Row | undefined;
    if (!row) throw appError(404, 'gitops.notFound');
    return parse(row);
  }
  record(id: string): GitRecord {
    const row = this.store.db.prepare(`SELECT ${RECORD_COLUMNS} FROM git_operations WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw appError(404, 'gitops.notFound');
    return parseRecord(row);
  }
  create(preview: GitPreview, plan: PreparedGitOperation, profile: { id: string; networkId: string; deviceId: string }) {
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO git_operations(id,project_id,profile_id,network_id,device_id,repository_key,preview_json,plan_json,state,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'prepared',?)`).run(preview.id, preview.projectId, profile.id, profile.networkId, profile.deviceId,
        plan.repositoryKey, JSON.stringify(preview), JSON.stringify(plan), this.now());
      this.event(preview.id, 'prepared');
    });
    return preview;
  }
  event(id: string, state: string) { this.store.db.prepare('INSERT INTO git_audit(request_id,state,at) VALUES(?,?,?)').run(id, state, this.now()); }
  transition(id: string, state: LocalGitState, patch: {
    submission?: GitApprovalSubmission; approval?: GitApproval; executionId?: string;
    result?: GitExecutionResult; error?: string | null; reportPending?: boolean; fenceAcknowledged?: boolean;
  } = {}, expected?: readonly LocalGitState[]) {
    this.store.transaction(() => {
      const old = this.record(id);
      if (expected && !expected.includes(old.state)) throw appError(409, 'gitops.state');
      this.store.db.prepare(`UPDATE git_operations SET state=?,submission_json=?,approval_json=?,execution_id=?,result_json=?,error_code=?,report_pending=?,fence_acknowledged=?,updated_at=? WHERE id=?`)
        .run(state, (patch.submission ?? old.submission) ? JSON.stringify(patch.submission ?? old.submission) : null,
          (patch.approval ?? old.approval) ? JSON.stringify(patch.approval ?? old.approval) : null, patch.executionId ?? old.executionId,
          (patch.result ?? old.result) ? JSON.stringify(patch.result ?? old.result) : null, patch.error === undefined ? old.error : patch.error,
          Number(patch.reportPending ?? old.reportPending), Number(patch.fenceAcknowledged ?? old.fenceAcknowledged), this.now(), id);
      this.event(id, state);
    });
    return this.record(id);
  }
  applyApproval(profileId: string, approval: GitApproval) {
    this.store.db.prepare('INSERT INTO git_approval_inbox(profile_id,id,payload) VALUES(?,?,?) ON CONFLICT(profile_id,id) DO UPDATE SET payload=excluded.payload')
      .run(profileId, approval.id, JSON.stringify(approval));
    const raw = this.store.db.prepare(`SELECT ${RECORD_COLUMNS} FROM git_operations WHERE id=? AND profile_id=?`).get(approval.id, profileId) as Row | undefined;
    if (!raw) return;
    const old = parseRecord(raw);
    if (old.deviceId !== approval.fromDeviceId || old.preview.digest !== approval.digest
      || old.submission?.reviewerDeviceId !== approval.reviewerDeviceId
      || JSON.stringify(old.preview.summary) !== JSON.stringify(approval.summary)) throw appError(409, 'governance.invalid');
    if (old.approval && JSON.stringify(old.approval) === JSON.stringify(approval)) return;
    if (terminal.has(old.state) || old.state === 'consuming' || old.state === 'executing') {
      this.store.db.prepare('UPDATE git_operations SET approval_json=? WHERE id=?').run(JSON.stringify(approval), approval.id); return;
    }
    if (approval.state === 'consumed') {
      this.transition(approval.id, 'unknown', { approval, result: { status: 'unknown', code: 'unexpected-consumption', head: null }, error: 'gitops.unknown' });
    } else this.transition(approval.id, approval.state, { approval, error: null });
  }
  inbox(profileId: string): GitApproval[] {
    return (this.store.db.prepare(`SELECT payload FROM git_approval_inbox WHERE profile_id=?
      ORDER BY CASE WHEN json_extract(payload,'$.state') IN ('pending','approved') AND julianday(json_extract(payload,'$.expiresAt'))>julianday(?) THEN 0 ELSE 1 END,
      json_extract(payload,'$.createdAt') DESC, id LIMIT 100`).all(profileId, this.now()) as Row[])
      .map(row => gitApprovalSchema.parse(JSON.parse(String(row.payload))));
  }
  rows(profileId: string, projectId: string): GitRecord[] {
    return (this.store.db.prepare(`SELECT ${RECORD_COLUMNS} FROM git_operations WHERE profile_id=? AND project_id=? ORDER BY updated_at DESC LIMIT 100`).all(profileId, projectId) as Row[]).map(parseRecord);
  }
  recovery(projectId: string, directory: string): GitRecord[] {
    return (this.store.db.prepare(`SELECT ${RECORD_COLUMNS} FROM git_operations WHERE (project_id=? OR json_extract(plan_json,'$.directory')=?) AND state IN ('partial','unknown') AND fence_acknowledged=0 ORDER BY updated_at DESC LIMIT 100`).all(projectId, directory) as Row[]).map(parseRecord);
  }
  pending(profileId: string): GitRecord[] {
    return (this.store.db.prepare(`SELECT ${RECORD_COLUMNS} FROM git_operations WHERE profile_id=? AND ((state='pending' AND submission_json IS NOT NULL AND approval_json IS NULL) OR report_pending=1) ORDER BY updated_at,id LIMIT 50`).all(profileId) as Row[]).map(parseRecord);
  }
  view(row: GitRecord): GitRequestView {
    const state = ['prepared', 'pending', 'approved'].includes(row.state) && Date.parse(row.preview.expiresAt) <= this.clock() ? 'expired' : row.state;
    return { preview: row.preview, state, approval: row.approval, result: row.result, error: row.error, fenceAcknowledged: row.fenceAcknowledged, updatedAt: row.updatedAt };
  }
  list(profileId: string, projectId: string): GitRequestView[] { return this.rows(profileId, projectId).map(row => this.view(row)); }
  fenced(repositoryKey: string, exceptId?: string) {
    return !!this.store.db.prepare("SELECT id FROM git_operations WHERE repository_key=? AND id<>? AND state IN ('consuming','executing','partial','unknown') AND fence_acknowledged=0 LIMIT 1")
      .get(repositoryKey, exceptId ?? '');
  }
  audit(id: string): GitAuditEvent[] {
    return (this.store.db.prepare('SELECT * FROM git_audit WHERE request_id=? ORDER BY id LIMIT 500').all(id) as Row[])
      .map(row => ({ id: Number(row.id), requestId: String(row.request_id), state: String(row.state), at: String(row.at) }));
  }
}
