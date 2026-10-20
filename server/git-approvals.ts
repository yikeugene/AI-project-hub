import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import type { AuthorizedGovernance, DeviceService, GovernanceContext } from './devices.js';
import { GovernanceService } from './governance.js';
import { GitStore, type SavedGitOperation, type GitRecord } from './git-store.js';
import { HttpError, appError } from './validation.js';
import { RelayError } from './relay.js';
import { isErrorCode, translateError, type ErrorCode } from '../shared/messages.js';
import { gitApprovalSchema, gitExecutionResultSchema, gitOperationSchema, gitPreviewSchema, gitReviewSummarySchema } from '../shared/git.js';
import type { GitApproval, GitDiffInput, GitOperation, GitRequestView } from '../shared/git.js';
import { acknowledgeGitOperation, executeGitOperation, prepareGitOperation, readGitDetails, readGitDiff } from './git-operations.js';

export interface GitEngine {
  prepare: typeof prepareGitOperation; execute: typeof executeGitOperation;
  details: typeof readGitDetails; diff: typeof readGitDiff; recover: typeof acknowledgeGitOperation;
}
export function gitFailureCode(error: unknown): ErrorCode {
  if (error instanceof HttpError && error.code) return error.code;
  if (error instanceof RelayError) return `relay.${error.code}`;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'unavailable') return 'git.unavailable';
  return isErrorCode(`gitops.${code}`) ? `gitops.${code}` as ErrorCode : 'gitops.failed';
}
const digestOf = (plan: unknown, context: { networkId: string; deviceId: string; projectId: string }) =>
  createHash('sha256').update(JSON.stringify({ ...context, plan })).digest('hex');

/** Transport can deliver approval, but only this origin-local service can launch Git. */
export class GitApprovalService {
  readonly repository: GitStore;
  private running = new Map<string, Promise<GitRequestView>>();
  private closing = false;
  private engine: GitEngine;
  constructor(readonly store: Store, readonly devices: DeviceService, readonly governance: GovernanceService, engine: Partial<GitEngine> = {}) {
    this.repository = new GitStore(store, devices.repository.clock);
    this.engine = { prepare: prepareGitOperation, execute: executeGitOperation, details: readGitDetails, diff: readGitDiff, recover: acknowledgeGitOperation, ...engine };
    this.repository.recover();
  }
  private profile() {
    if (this.closing) throw appError(503, 'device.closing');
    if (!this.devices.state().desktopAvailable) throw appError(400, 'device.desktopRequired');
    const profile = this.devices.repository.profile();
    if (!profile?.networkId || profile.pairingPending) throw appError(409, 'device.pairRequired');
    return { ...profile, networkId: profile.networkId };
  }
  private owned(id: string) {
    const profile = this.profile(), row = this.repository.get(id);
    if (row.profileId !== profile.id || row.networkId !== profile.networkId || row.deviceId !== profile.deviceId) throw appError(404, 'gitops.notFound');
    return row;
  }
  private verifyDigest(row: SavedGitOperation, digest: string) {
    if (row.preview.digest !== digest || digestOf(row.plan, { networkId: row.networkId, deviceId: row.deviceId, projectId: row.preview.projectId }) !== digest)
      throw appError(409, 'gitops.digest');
  }
  private view(row: GitRecord) {
    const view = this.repository.view(row);
    return { ...view, error: view.error && isErrorCode(view.error) ? translateError(view.error, this.store.getSettings().locale) : view.error };
  }
  async details(projectId: string) {
    try { return await this.engine.details(this.store.getProject(projectId).path); }
    catch (error) { throw appError(400, gitFailureCode(error)); }
  }
  async diff(projectId: string, input: GitDiffInput) {
    try { return await this.engine.diff(this.store.getProject(projectId).path, input); }
    catch (error) { throw appError(400, gitFailureCode(error)); }
  }
  async preview(projectId: string, operation: GitOperation) {
    const profile = this.profile(), project = this.store.getProject(projectId);
    let plan;
    try { plan = await this.engine.prepare(project.path, gitOperationSchema.parse(operation), { projectId, projectName: project.name }); }
    catch (error) { throw appError(400, gitFailureCode(error)); }
    if (this.profile().id !== profile.id) throw appError(409, 'proposal.connectionChanged');
    if (this.repository.fenced(plan.repositoryKey)) throw appError(409, 'gitops.unknown');
    const createdAt = this.repository.now();
    const preview = gitPreviewSchema.parse({ id: randomUUID(), projectId, operation: plan.operation,
      summary: gitReviewSummarySchema.parse(plan.summary), createdAt, expiresAt: new Date(this.repository.clock() + 24 * 60 * 60 * 1000).toISOString(),
      digest: digestOf(plan, { networkId: profile.networkId, deviceId: profile.deviceId, projectId }) });
    return this.repository.create(preview, plan, profile);
  }
  async submit(id: string, reviewerDeviceId: string, digest: string) {
    const row = this.owned(id); this.verifyDigest(row, digest);
    if (Date.parse(row.preview.expiresAt) <= this.repository.clock()) throw appError(409, 'gitops.expired');
    if (row.state !== 'prepared') {
      if (row.submission?.reviewerDeviceId !== reviewerDeviceId) throw appError(409, 'gitops.state');
      return this.view(row);
    }
    const policy = this.governance.cachedPolicy(row.profileId);
    if (!policy || !policy.roles.some(role => role.deviceId === reviewerDeviceId && role.role === 'admin')
      || !this.devices.repository.activeDevice(row.profileId, reviewerDeviceId)) throw appError(409, 'governance.admin');
    const submission = { id, reviewerDeviceId, digest, summary: row.preview.summary, expiresAt: row.preview.expiresAt };
    this.repository.transition(id, 'pending', { submission, error: null }, ['prepared']);
    this.governance.record('git', 'pending');
    await this.governance.refresh();
    return this.view(this.owned(id));
  }
  list(projectId: string) {
    const project = this.store.getProject(projectId);
    const profile = this.devices.repository.profile();
    const current = profile ? this.repository.rows(profile.id, projectId) : [];
    const retained = this.devices.state().desktopAvailable ? this.repository.recovery(projectId, project.path) : [];
    return [...new Map([...retained, ...current].map(row => [row.preview.id, row])).values()].slice(0, 100).map(row => this.view(row));
  }
  approvals() {
    const profile = this.devices.repository.profile();
    return profile ? this.repository.inbox(profile.id) : [];
  }
  async decide(id: string, digest: string, decision: 'approved' | 'rejected', reason: string): Promise<GitApproval> {
    return this.devices.withGovernance(async (client, context) => {
      const result = gitApprovalSchema.parse(await client.decideGit(id, digest, decision, reason));
      if (result.id !== id || result.digest !== digest || result.reviewerDeviceId !== context.deviceId || result.state !== decision) throw appError(409, 'governance.invalid');
      this.repository.applyApproval(context.profileId, result); return result;
    });
  }
  async cancel(id: string, digest: string) {
    const row = this.owned(id); this.verifyDigest(row, digest);
    if (!['prepared', 'pending', 'approved'].includes(row.state)) throw appError(409, 'gitops.state');
    if (!row.submission) this.repository.transition(id, 'cancelled', {}, ['prepared']);
    else await this.devices.withGovernance(async (client, context) => {
      if (context.profileId !== row.profileId) throw appError(409, 'proposal.connectionChanged');
      const result = gitApprovalSchema.parse(await client.cancelGit(id, digest));
      this.repository.applyApproval(context.profileId, result);
    });
    return this.view(this.owned(id));
  }
  execute(id: string, digest: string): Promise<GitRequestView> {
    const row = this.owned(id); this.verifyDigest(row, digest);
    const existing = this.running.get(id);
    if (existing) return existing;
    if (row.state !== 'approved') throw appError(409, 'gitops.state');
    if (Date.parse(row.preview.expiresAt) <= this.repository.clock()) throw appError(409, 'gitops.expired');
    if (this.repository.fenced(row.repositoryKey, id)) throw appError(409, 'gitops.unknown');
    const executionId = randomUUID();
    this.repository.transition(id, 'consuming', { executionId, error: null }, ['approved']);
    const work = this.run(row, executionId).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }
  private async run(row: SavedGitOperation, executionId: string): Promise<GitRequestView> {
    let attempted = false, consumed = false, started = false;
    try {
      await this.devices.withGovernance(async (client, context) => {
        if (context.profileId !== row.profileId || context.networkId !== row.networkId || context.deviceId !== row.deviceId) throw appError(409, 'proposal.connectionChanged');
        const result = gitExecutionResultSchema.parse(await this.engine.execute(row.plan, {
          authorize: async () => {
            if (attempted) throw appError(409, 'gitops.replay');
            context.assertCurrent();
            this.store.getProject(row.preview.projectId);
            if (this.repository.fenced(row.repositoryKey, row.preview.id)) throw appError(409, 'gitops.unknown');
            attempted = true;
            try {
              const approval = await client.consumeGit(row.preview.id, row.preview.digest, executionId);
              consumed = true;
              if (approval.id !== row.preview.id || approval.executionId !== executionId || approval.replayed) throw appError(409, 'gitops.replay');
            } catch (error) {
              if (!consumed && error instanceof RelayError && !error.retryable && ['denied', 'unauthorized', 'invalid', 'expired', 'conflict'].includes(error.code)) attempted = false;
              throw error;
            }
            context.assertCurrent();
          },
          onStarting: () => {
            context.assertCurrent();
            if (!consumed || started) throw appError(409, 'gitops.replay');
            this.store.getProject(row.preview.projectId);
            this.repository.transition(row.preview.id, 'executing', {}, ['consuming']);
            started = true; this.governance.record('git', 'running');
          },
        }).catch(error => {
          if (error instanceof HttpError || error instanceof RelayError) throw error;
          throw appError(409, gitFailureCode(error));
        }));
        if (!consumed || !started) throw appError(409, 'governance.invalid');
        this.repository.transition(row.preview.id, result.status, { result, error: result.status === 'unknown' ? 'gitops.unknown' : null, reportPending: true });
        this.governance.record('git', result.status === 'succeeded' ? 'succeeded' : result.status === 'unknown' ? 'unknown' : 'failed');
        try {
          await client.reportGit(row.preview.id, executionId, result);
          this.repository.transition(row.preview.id, result.status, { reportPending: false });
        } catch { /* Durable result reporting retries, never the Git operation. */ }
      });
    } catch (error) {
      const current = this.repository.record(row.preview.id);
      if (current.state === 'consuming' || current.state === 'executing') {
        const code = gitFailureCode(error);
        const uncertain = attempted || consumed || started || code === 'gitops.unknown';
        const state = uncertain ? 'unknown' : code === 'gitops.stale' ? 'stale' : 'failed';
        this.repository.transition(row.preview.id, state, { result: { status: uncertain ? 'unknown' : 'failed', code: uncertain ? 'execution-unknown' : code, head: null },
          error: uncertain ? 'gitops.unknown' : code, reportPending: consumed });
        this.governance.record('git', uncertain ? 'unknown' : 'failed');
      }
    }
    try { const project = this.store.getProject(row.preview.projectId); const details = await this.engine.details(project.path); this.store.saveObservation(project.id, details.snapshot, null); }
    catch { /* A missing project or failed observation must not erase the execution journal. */ }
    return this.view(this.repository.record(row.preview.id));
  }
  async sync(client: AuthorizedGovernance, context: GovernanceContext) {
    for (const captured of this.repository.pending(context.profileId)) {
      context.assertCurrent();
      const row = this.repository.record(captured.preview.id);
      if (row.state === 'pending' && row.submission && !row.approval) {
        if (Date.parse(row.preview.expiresAt) <= this.repository.clock()) { this.repository.transition(row.preview.id, 'expired', { error: 'gitops.expired' }); continue; }
        try { this.repository.applyApproval(context.profileId, gitApprovalSchema.parse(await client.submitGit(row.submission))); }
        catch (error) {
          if (error instanceof RelayError && !error.retryable && ['invalid', 'denied', 'expired', 'conflict'].includes(error.code)) {
            this.repository.transition(row.preview.id, error.code === 'expired' ? 'expired' : 'failed', { error: `relay.${error.code}` });
          } else throw error;
        }
      }
      if (row.reportPending && row.executionId && row.result) {
        try {
          await client.reportGit(row.preview.id, row.executionId, row.result);
          this.repository.transition(row.preview.id, row.state, { reportPending: false });
        } catch (error) {
          if (error instanceof RelayError && !error.retryable && ['invalid', 'denied', 'conflict'].includes(error.code)) {
            this.repository.transition(row.preview.id, row.state, { reportPending: false });
            this.repository.event(row.preview.id, 'report-refused');
          } else throw error;
        }
      }
    }
    const requests = await client.listGit(); context.assertCurrent();
    if (requests.length > 100) throw appError(400, 'governance.invalid');
    for (const request of requests) {
      if (request.fromDeviceId !== context.deviceId && request.reviewerDeviceId !== context.deviceId) throw appError(400, 'governance.invalid');
      this.repository.applyApproval(context.profileId, gitApprovalSchema.parse(request));
    }
  }
  private recoverable(id: string) {
    if (!this.devices.state().desktopAvailable) throw appError(400, 'device.desktopRequired');
    const row = this.repository.get(id);
    if (!['unknown', 'partial'].includes(row.state)) return this.owned(id);
    return row;
  }
  audit(id: string) { this.recoverable(id); return this.repository.audit(id); }
  async acknowledge(id: string) {
    const row = this.recoverable(id);
    if (!['unknown', 'partial'].includes(row.state) || this.running.has(id)) throw appError(409, 'gitops.state');
    let details;
    try { details = await this.engine.details(row.plan.directory); await this.engine.recover(row.plan); }
    catch (error) { throw appError(409, gitFailureCode(error)); }
    this.repository.transition(id, row.state, { fenceAcknowledged: true, error: null });
    this.repository.event(id, `acknowledged:${details.snapshot.head ?? 'unborn'}`);
    return this.view(this.repository.record(id));
  }
  async stop() { this.closing = true; await Promise.allSettled(this.running.values()); }
}
