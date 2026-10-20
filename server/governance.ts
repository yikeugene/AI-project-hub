import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { AuthorizedGovernance, DeviceService, GovernanceContext } from './devices.js';
import { HttpError, appError } from './validation.js';
import { isErrorCode, translateError, type ErrorCode } from '../shared/messages.js';
import { governancePolicySchema, deviceStatusPublicationSchema, remoteDeviceStatusSchema, statusSharingPolicySchema } from '../shared/governance.js';
import type { AppActivity, DeviceRole, DeviceStatusPublication, GovernancePolicy, GovernanceState, StatusSharingPolicy, StatusSharingPreview } from '../shared/governance.js';

type Row = Record<string, string | number | null>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptySharing = (): StatusSharingPolicy => ({ activity: false, projects: [] });
export class GovernanceService {
  private running?: Promise<GovernanceState>;
  private closed = false;
  private mode: AppActivity['mode'] = 'foreground';
  private recent: AppActivity['operations'] = [];
  private syncGit?: (client: AuthorizedGovernance, context: GovernanceContext) => Promise<void>;
  constructor(readonly store: Store, readonly devices: DeviceService) {}
  onRefresh(callback: (client: AuthorizedGovernance, context: GovernanceContext) => Promise<void>) { this.syncGit = callback; }
  setActivityMode(mode: AppActivity['mode']) { this.mode = mode; }
  record(kind: 'scan' | 'sync' | 'git', state: AppActivity['operations'][number]['state']) {
    this.recent = [{ kind, state, at: this.devices.repository.now() }, ...this.recent].slice(0, 10);
  }
  private row(profileId: string): Row {
    this.store.db.prepare('INSERT OR IGNORE INTO governance_profiles(profile_id) VALUES(?)').run(profileId);
    return this.store.db.prepare('SELECT * FROM governance_profiles WHERE profile_id=?').get(profileId) as Row;
  }
  sharing(profileId: string) { return statusSharingPolicySchema.parse(JSON.parse(String(this.row(profileId).sharing_json))); }
  cachedPolicy(profileId: string): GovernancePolicy | null {
    const value = this.row(profileId).policy_json;
    return value ? governancePolicySchema.parse(JSON.parse(String(value))) : null;
  }
  state(): GovernanceState {
    const device = this.devices.state(), profile = this.devices.repository.profile();
    if (!profile?.networkId || profile.pairingPending) return { available: false, policy: null, error: null, sharing: emptySharing(), statuses: [] };
    const row = this.row(profile.id), policy = this.cachedPolicy(profile.id);
    const error = typeof row.error_code === 'string' && isErrorCode(row.error_code) ? translateError(row.error_code, this.store.getSettings().locale) : null;
    const statuses = (JSON.parse(String(row.statuses_json)) as unknown[]).map(value => remoteDeviceStatusSchema.parse(value))
      .filter(status => !!this.devices.repository.activeDevice(profile.id, status.deviceId))
      .map(status => ({ ...status, projects: status.projects.filter(project => status.deviceId === profile.deviceId
        ? this.devices.repository.policy(profile.id, project.projectId).enabled
        : this.devices.repository.snapshots(profile.id, status.deviceId).some(snapshot => snapshot.projectId === project.projectId && snapshot.project !== null)) }));
    return { available: device.desktopAvailable && !!profile.enabled && !!policy && policy.epoch > 0 && policy.roles.some(role => role.role === 'admin') && !error,
      policy, error, sharing: this.sharing(profile.id), statuses };
  }
  private profile() {
    const profile = this.devices.repository.profile();
    if (!this.devices.state().desktopAvailable) throw appError(400, 'device.desktopRequired');
    if (!profile?.networkId || profile.pairingPending) throw appError(409, 'device.pairRequired');
    return profile;
  }
  async refresh(): Promise<GovernanceState> {
    if (this.closed) return this.state();
    if (this.running) return this.running;
    const profile = this.devices.repository.profile();
    if (!profile?.networkId || !profile.enabled || !this.devices.state().desktopAvailable) return this.state();
    this.running = this.devices.withGovernance(async (client, context) => {
      const policy = governancePolicySchema.parse(await client.policy());
      if (policy.networkId !== context.networkId || policy.deviceId !== context.deviceId) throw appError(400, 'governance.invalid');
      context.assertCurrent(); this.row(context.profileId);
      this.store.db.prepare('UPDATE governance_profiles SET policy_json=?,error_code=NULL WHERE profile_id=?').run(JSON.stringify(policy), context.profileId);
      if (!policy.roles.some(role => role.role === 'admin') || policy.epoch < 1) throw appError(409, 'governance.upgrade');
      await this.syncGit?.(client, context);
      context.assertCurrent();
      // Always rebuild immediately before sending; never replay a withdrawn field from disk.
      let publication: DeviceStatusPublication | null;
      let tooLarge = false;
      try { publication = this.reconcile(context.profileId); }
      catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'governance.large') throw error;
        tooLarge = true; publication = this.reconcile(context.profileId, true);
      }
      if (publication) {
        await client.publishStatus(publication); context.assertCurrent();
        this.store.db.prepare('UPDATE governance_profiles SET status_sent_version=MAX(status_sent_version,?) WHERE profile_id=?').run(publication.version, context.profileId);
      }
      const statuses = (await client.statuses()).map(value => remoteDeviceStatusSchema.parse(value));
      context.assertCurrent();
      this.store.db.prepare('UPDATE governance_profiles SET statuses_json=?,error_code=? WHERE profile_id=?')
        .run(JSON.stringify(statuses), tooLarge ? 'governance.large' : null, context.profileId);
    }).catch(error => {
      if (this.devices.repository.profile()?.id === profile.id) {
        const code: ErrorCode = error instanceof HttpError && error.code ? error.code : 'relay.unavailable';
        this.row(profile.id);
        this.store.db.prepare('UPDATE governance_profiles SET error_code=? WHERE profile_id=?').run(code, profile.id);
      }
    }).then(() => this.state()).finally(() => { this.running = undefined; });
    return this.running;
  }
  async setRole(deviceId: string, role: DeviceRole) {
    await this.devices.withGovernance(client => client.setRole(deviceId, role));
    return this.refresh();
  }
  private normalizePolicy(policy: StatusSharingPolicy): StatusSharingPolicy {
    const parsed = statusSharingPolicySchema.parse(policy);
    if (new Set(parsed.projects.map(project => project.projectId)).size !== parsed.projects.length) throw appError(400, 'governance.previewChanged');
    return { activity: parsed.activity, projects: parsed.projects.filter(project => project.git || project.tasks).sort((a, b) => a.projectId.localeCompare(b.projectId)) };
  }
  private projection(profileId: string, policy: StatusSharingPolicy, strict = false): Omit<DeviceStatusPublication, 'version'> {
    const profile = this.devices.repository.profile(profileId)!;
    const tasks = this.store.listTasks(), projects = this.store.listProjects();
    const selected = policy.projects.flatMap(selection => {
      const project = projects.find(value => value.id === selection.projectId);
      const shared = project && this.devices.repository.policy(profileId, project.id).enabled && !!this.devices.repository.preview(project.id, this.devices.repository.policy(profileId, project.id)).project;
      if (!shared || !project) { if (strict) throw appError(409, 'governance.share'); return []; }
      const unavailable = !!project.gitError || !project.git?.isRepo;
      const counts = { todo: 0, doing: 0, blocked: 0, done: 0 };
      for (const task of tasks) if (task.projectId === project.id) counts[task.status]++;
      return [{ projectId: project.id, name: project.name,
        git: selection.git ? { branch: unavailable ? null : project.git!.branch, changedCount: unavailable ? 0 : project.git!.changedCount,
          stagedCount: unavailable ? 0 : project.git!.stagedCount, conflictCount: unavailable ? 0 : project.git!.conflictCount,
          observedAt: project.git?.observedAt ?? null, unavailable } : null,
        tasks: selection.tasks ? counts : null }];
    });
    const sync: AppActivity['sync'] = !profile.enabled ? 'paused' : profile.connection === 'syncing' ? 'syncing' : profile.connection === 'online' ? 'online' : profile.connection === 'error' || profile.connection === 'revoked' || profile.connection === 'locked' ? 'error' : 'idle';
    return { activity: policy.activity ? { mode: this.mode, sync, lastSyncAt: profile.lastSyncAt, operations: this.recent } : null, projects: selected };
  }
  previewSharing(input: StatusSharingPolicy): StatusSharingPreview {
    const profile = this.profile(), policy = this.normalizePolicy(input);
    const projection = this.projection(profile.id, policy, true);
    const publication = deviceStatusPublicationSchema.parse({ version: 1, ...projection });
    const bytes = Buffer.byteLength(JSON.stringify(publication), 'utf8');
    if (bytes > 8192) throw appError(413, 'governance.large');
    return { policy, publication, bytes, digest: hash({ profile: profile.id, policy, projects: projection.projects.map(project => ({ projectId: project.projectId, name: project.name })) }) };
  }
  saveSharing(policy: StatusSharingPolicy, digest: string) {
    const profile = this.profile(), preview = this.previewSharing(policy);
    if (preview.digest !== digest) throw appError(409, 'governance.previewChanged');
    this.row(profile.id);
    this.store.db.prepare('UPDATE governance_profiles SET sharing_json=? WHERE profile_id=?').run(JSON.stringify(preview.policy), profile.id);
    this.reconcile(profile.id);
    return this.state();
  }
  private reconcile(profileId: string, withdraw = false): DeviceStatusPublication | null {
    const row = this.row(profileId);
    const data = withdraw ? { activity: null, projects: [] } : this.projection(profileId, this.sharing(profileId));
    const payload = JSON.stringify(data);
    if (!row.status_payload && data.activity === null && !data.projects.length) return null;
    const changed = row.status_payload !== payload;
    const version = Number(row.status_version) + (changed ? 1 : 0);
    const publication = deviceStatusPublicationSchema.parse({ version, ...data });
    if (Buffer.byteLength(JSON.stringify(publication), 'utf8') > 8192) throw appError(413, 'governance.large');
    if (changed) this.store.db.prepare('UPDATE governance_profiles SET status_version=?,status_payload=? WHERE profile_id=?').run(version, payload, profileId);
    return version > Number(row.status_sent_version) ? publication : null;
  }
  async stop() { this.closed = true; await this.running; }
}
