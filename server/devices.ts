import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getMemoryLabels, MEMORY_FIELDS } from '../shared/types.js';
import { formatSharedSummary } from '../shared/shared-summary.js';
import { coreTranslator } from '../shared/locales/core.js';
import { translateError, type ErrorCode } from '../shared/messages.js';
import { deviceNameSchema, groupLabelSchema, messagePayloadSchema, pairInputSchema, pairResultSchema, PROFILE_HEADER, relayMessageSchema, sharePolicySchema, tokenSchema } from '../shared/devices.js';
import type { ApplyProposalInput, ComposeMessageInput, DeviceGroup, DeviceState, GroupShareInput, GroupSharingPreview, Invitation, MessageDecision, MessageView, PairAttempt, PairInput, ProposalPayload, ProposalPreview, SharePolicy, SharedWorkspaceState, SummaryDownload } from '../shared/devices.js';
import type { Store } from './db.js';
import { DeviceStore, payloadHash, type RelayProfile } from './device-store.js';
import { HttpError, appError, memorySchema, revisionSchema } from './validation.js';
import { RelayError, type RelayFactory, type SecureCodec } from './relay.js';
import { createSupabaseRelay, validateRelayConfiguration } from './supabase-relay.js';
import { SyncWorker, syncError, type SyncSession } from './sync.js';
import type { GovernanceRelay } from '../shared/governance.js';
import type { AppObservationRelay } from '../shared/app-observation.js';

export type AuthorizedGovernance = { [K in keyof GovernanceRelay]: GovernanceRelay[K] extends (token: string, ...args: infer A) => infer R ? (...args: A) => R : never };
export interface GovernanceContext { profileId: string; networkId: string; deviceId: string; assertCurrent(): void }
export type AuthorizedAppObservation = { [K in keyof AppObservationRelay]: AppObservationRelay[K] extends (token: string, ...args: infer A) => infer R ? (...args: A) => R : never };
export interface AppObservationContext extends GovernanceContext { signal: AbortSignal }

const uuid = z.string().uuid();
const confirmation = z.object({ confirm: z.literal(true) }).strict();
const policyInput = sharePolicySchema.omit({ projectId: true });
const attemptSchema = z.object({ attemptId: uuid, deviceId: uuid, deviceToken: tokenSchema, inviteToken: tokenSchema, name: deviceNameSchema }).strict();
const credentialsSchema = z.object({ token: tokenSchema, attempt: attemptSchema.optional() }).strict();
export interface DeviceOptions { mode?: 'web' | 'desktop'; codec?: SecureCodec; relayFactory?: RelayFactory; clock?: () => number }

interface ProfileControl {
  generation: number; busy: boolean; operations: Set<Promise<unknown>>; controllers: Set<AbortController>;
}
const groupPolicyInput = policyInput.extend({ profileId: uuid }).strict();
const groupPoliciesInput = z.object({ policies: z.array(groupPolicyInput).max(1000) }).strict();
const groupSaveInput = groupPoliciesInput.extend({ digest: tokenSchema, confirm: z.literal(true) }).strict();
const downloadInput = z.object({ profileId: uuid, ownerDeviceId: uuid, projectId: uuid, version: revisionSchema }).strict();

export class DeviceService {
  readonly repository: DeviceStore;
  readonly workers = new Map<string, SyncWorker>();
  private controls = new Map<string, ProfileControl>();
  private closing = false;
  private started = false;
  private afterSync?: (profileId: string) => Promise<void>;
  constructor(store: Store, private options: DeviceOptions = {}) {
    this.repository = new DeviceStore(store, options.clock);
    for (const profile of this.repository.profiles()) this.control(profile.id);
  }
  private control(profileId: string): ProfileControl {
    let control = this.controls.get(profileId);
    if (!control) {
      control = { generation: 0, busy: false, operations: new Set(), controllers: new Set() };
      this.controls.set(profileId, control);
      const worker = new SyncWorker(this.repository, () => this.session(profileId), session => this.current(session), () => this.afterSync?.(profileId) ?? Promise.resolve());
      this.workers.set(profileId, worker);
      if (this.started) worker.start();
    }
    return control;
  }
  onSynced(callback: (profileId: string) => Promise<void>) { this.afterSync = callback; }
  async withGovernance<T>(profileId: string, action: (client: AuthorizedGovernance, context: GovernanceContext) => Promise<T>): Promise<T> {
    return this.remote(profileId, async (session, signal) => {
      const { relay, token, profile } = session;
      const governance = relay.governance;
      if (!governance) throw appError(409, 'governance.upgrade');
      const assertCurrent = () => {
        if (signal.aborted || !this.current(session)) throw appError(409, 'proposal.connectionChanged');
      };
      const checked = async <V>(operation: () => Promise<V>) => { assertCurrent(); const value = await operation(); assertCurrent(); return value; };
      const client: AuthorizedGovernance = {
        policy: () => checked(() => governance.policy(token, signal)),
        setRole: (id, role) => checked(() => governance.setRole(token, id, role, signal)),
        submitGit: request => checked(() => governance.submitGit(token, request, signal)),
        listGit: () => checked(() => governance.listGit(token, signal)),
        getGit: id => checked(() => governance.getGit(token, id, signal)),
        decideGit: (id, digest, decision, reason) => checked(() => governance.decideGit(token, id, digest, decision, reason, signal)),
        cancelGit: (id, digest) => checked(() => governance.cancelGit(token, id, digest, signal)),
        consumeGit: (id, digest, executionId) => checked(() => governance.consumeGit(token, id, digest, executionId, signal)),
        reportGit: (id, executionId, result) => checked(() => governance.reportGit(token, id, executionId, result, signal)),
        publishStatus: status => checked(() => governance.publishStatus(token, status, signal)),
        statuses: () => checked(() => governance.statuses(token, signal)),
      };
      return action(client, { profileId: profile.id, networkId: profile.networkId!, deviceId: profile.deviceId, assertCurrent });
    });
  }
  onProfileChange(listener: (profileId: string) => void) { return this.repository.onProfileChange(listener); }
  appObservationReady(profileId: string): boolean {
    const profile = this.repository.profile(profileId);
    return !this.closing && this.available() && !!profile?.attached && profile.enabled && !!profile.networkId
      && !profile.pairingPending && profile.connection !== 'locked' && !this.revoked(profile);
  }
  async withAppObservation<T>(profileId: string, action: (client: AuthorizedAppObservation, context: AppObservationContext) => Promise<T>, cancellation?: AbortSignal): Promise<T> {
    return this.remote(profileId, async (session, ownSignal) => {
      const signal = cancellation ? AbortSignal.any([ownSignal, cancellation]) : ownSignal;
      const { profile, token } = session, channel = session.relay.appObservation;
      const assertCurrent = () => {
        if (signal.aborted || !this.current(session) || !this.appObservationReady(profileId)) throw appError(409, 'proposal.connectionChanged');
      };
      const checked = async <V>(operation: () => Promise<V>) => { assertCurrent(); const result = await operation(); assertCurrent(); return result; };
      const unavailable = () => { throw appError(409, 'governance.upgrade'); };
      const client: AuthorizedAppObservation = {
        capability: () => checked(() => channel ? channel.capability(token, signal) : Promise.resolve(null)),
        publish: value => checked(() => channel ? channel.publish(token, value, signal) : unavailable()),
        statuses: () => checked(() => channel ? channel.statuses(token, signal) : unavailable()),
      };
      return action(client, { profileId, networkId: profile.networkId!, deviceId: profile.deviceId, signal, assertCurrent });
    });
  }
  private locale() { return this.repository.store.getSettings().locale; }
  private available() {
    try { return this.options.mode === 'desktop' && !!this.options.codec?.available(); } catch { return false; }
  }
  private ensureAvailable() {
    if (this.closing) throw appError(503, 'device.closing');
    if (!this.available()) throw appError(400, 'device.desktopRequired');
  }
  assertAttachedProfile(profileId: string): RelayProfile {
    if (this.closing) throw appError(503, 'device.closing');
    const profile = this.repository.profile(uuid.parse(profileId));
    if (!profile?.attached) throw appError(409, 'device.profileUnavailable');
    return profile;
  }
  private revoked(profile: RelayProfile) {
    return profile.connection === 'revoked' || this.repository.devices(profile.id).some(device => device.id === profile.deviceId && !!device.revokedAt);
  }
  requiredProfile(profileId: string): RelayProfile {
    const profile = this.assertAttachedProfile(profileId);
    if (!profile.networkId || profile.pairingPending) throw appError(409, 'device.pairRequired');
    if (this.revoked(profile)) throw appError(403, 'device.revoked');
    return profile;
  }
  captureProfile(profileId: string): { profile: RelayProfile; assertCurrent(): void } {
    const profile = this.requiredProfile(profileId), generation = this.control(profileId).generation;
    return { profile, assertCurrent: () => {
      const current = this.requiredProfile(profileId);
      if (generation !== this.control(profileId).generation || current.networkId !== profile.networkId || current.deviceId !== profile.deviceId)
        throw appError(409, 'proposal.connectionChanged');
    } };
  }
  private decrypt(profile: RelayProfile) {
    try {
      if (!this.available()) throw new Error('unavailable');
      return credentialsSchema.parse(JSON.parse(this.options.codec!.decrypt(profile.credentials)));
    } catch {
      this.repository.setConnection(profile.id, 'locked', translateError('device.decryptDiagnostic', this.locale()));
      throw appError(409, 'device.decrypt');
    }
  }
  private encrypt(value: z.infer<typeof credentialsSchema>) {
    this.ensureAvailable();
    try { return this.options.codec!.encrypt(JSON.stringify(value)); }
    catch { throw appError(409, 'device.encrypt'); }
  }
  private factory(configuration: RelayProfile['configuration']) { return (this.options.relayFactory ?? createSupabaseRelay)(configuration); }
  private session(profileId: string): SyncSession | null {
    const profile = this.repository.profile(profileId);
    if (this.closing || !profile?.attached || !profile.enabled || !profile.networkId || profile.pairingPending || this.revoked(profile)) return null;
    if (!this.available()) { this.repository.setConnection(profile.id, 'locked', translateError('device.credentialsUnavailable', this.locale())); return null; }
    let token: string;
    try { token = this.decrypt(profile).token; } catch { return null; }
    return { profile, token, relay: this.factory(profile.configuration), generation: this.control(profileId).generation };
  }
  private current(session: SyncSession) {
    if (this.closing) return false;
    const current = this.repository.profile(session.profile.id);
    return session.generation === this.control(session.profile.id).generation && !!current?.attached && current.enabled
      && !this.revoked(current) && current.networkId === session.profile.networkId && current.deviceId === session.profile.deviceId;
  }
  private async operation<T>(profileId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw appError(503, 'device.closing');
    const control = this.control(profileId), controller = new AbortController(); control.controllers.add(controller);
    const promise = Promise.resolve().then(() => action(controller.signal));
    control.operations.add(promise);
    try { return await promise; }
    finally { control.operations.delete(promise); control.controllers.delete(controller); }
  }
  private async remote<T>(profileId: string, action: (session: SyncSession, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ensureAvailable();
    this.requiredProfile(profileId);
    const session = this.session(profileId);
    if (!session) throw appError(409, 'device.syncRequired');
    try {
      return await this.operation(profileId, async signal => {
        if (signal.aborted || !this.current(session)) throw new RelayError('aborted', '同步已暫停。');
        const value = await action(session, signal);
        if (signal.aborted || !this.current(session)) throw new RelayError('aborted', '同步已暫停。');
        return value;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const safe = syncError(error, this.locale());
      if (safe.code === 'unauthorized' && this.current(session)) { this.repository.setEnabled(session.profile.id, false); this.repository.setConnection(session.profile.id, 'revoked', safe.message); }
      throw appError(safe.code === 'conflict' ? 409 : safe.code === 'unauthorized' || safe.code === 'denied' ? 403 : 400, safe.messageCode);
    }
  }
  private async exclusive<T>(profileId: string, action: () => Promise<T>) {
    this.assertAttachedProfile(profileId);
    const control = this.control(profileId);
    if (control.busy) throw appError(409, 'device.busy');
    control.busy = true;
    try { return await action(); } finally { control.busy = false; }
  }
  start() { this.started = true; for (const worker of this.workers.values()) worker.start(); }
  async stop() {
    this.closing = true;
    for (const control of this.controls.values()) {
      control.generation++;
      for (const controller of control.controllers) controller.abort();
    }
    await Promise.allSettled([
      ...[...this.workers.values()].map(worker => worker.stop()),
      ...[...this.controls.values()].flatMap(control => [...control.operations]),
    ]);
  }
  private group(profile: RelayProfile): DeviceGroup {
    return { id: profile.id, label: profile.label, url: profile.configuration.url, networkId: profile.networkId, deviceId: profile.deviceId,
      enabled: profile.enabled, paired: !!profile.networkId, pairingPending: profile.pairingPending, connection: profile.connection,
      lastSyncAt: profile.lastSyncAt, lastError: profile.lastError };
  }
  state(profileId?: string): DeviceState {
    if (this.closing) throw appError(503, 'device.closing');
    const installation = this.repository.installation();
    const selected = this.repository.profile(installation.activeProfile);
    const profile = profileId !== undefined ? this.assertAttachedProfile(profileId) : selected?.attached ? selected : null;
    return { installationId: installation.id, profileId: profile?.id ?? null, groups: this.repository.profiles().map(value => this.group(value)),
      localDevice: { id: profile?.deviceId ?? installation.id, name: installation.name }, desktopAvailable: this.available(),
      enabled: profile?.enabled ?? false, paired: !!profile?.networkId, pairingPending: profile?.pairingPending ?? false,
      connection: profile?.connection ?? 'unconfigured', configuration: profile?.configuration ?? null, networkId: profile?.networkId ?? null,
      devices: profile ? this.repository.devices(profile.id) : [], sharing: profile ? this.repository.policies(profile.id) : [],
      lastSyncAt: profile?.lastSyncAt ?? null, lastError: profile?.lastError ?? null,
      ...(profile ? this.repository.counts(profile.id) : { queuedCount: 0, inboxCount: 0 }) };
  }
  rename(name: string) {
    if (this.closing) throw appError(503, 'device.closing');
    this.repository.rename(deviceNameSchema.parse(name)); return this.state();
  }
  selectGroup(profileId: string) {
    this.assertAttachedProfile(profileId); this.repository.selectProfile(profileId); return this.state(profileId);
  }
  labelGroup(profileId: string, label: string) {
    this.assertAttachedProfile(profileId); this.repository.labelProfile(profileId, groupLabelSchema.parse(label)); return this.state();
  }
  async pair(input: PairInput) {
    this.ensureAvailable();
    const parsed = pairInputSchema.parse(input);
    const configuration = validateRelayConfiguration({ url: parsed.url, publishableKey: parsed.publishableKey });
    const attempt: PairAttempt = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex'), inviteToken: parsed.code, name: parsed.name };
    const ciphertext = this.encrypt({ token: attempt.deviceToken, attempt });
    // Initial setup may name the installation; adding/rejoining a group never renames existing memberships.
    if (!this.repository.store.db.prepare('SELECT id FROM relay_profiles LIMIT 1').get()) this.repository.rename(parsed.name);
    const profile = this.repository.addProfile(configuration, attempt.deviceId, ciphertext, parsed.label);
    return this.exclusive(profile.id, async () => {
      await this.finishPair(profile);
      if (this.started) void this.workers.get(profile.id)!.syncNow();
      return this.state(profile.id);
    });
  }
  async retryPair(profileId: string) {
    return this.exclusive(profileId, async () => {
      this.ensureAvailable();
      const profile = this.assertAttachedProfile(profileId);
      if (!profile.pairingPending) throw appError(409, 'device.noPendingPair');
      await this.finishPair(profile);
      if (this.started) void this.workers.get(profile.id)!.syncNow();
      return this.state(profileId);
    });
  }
  private async finishPair(profile: RelayProfile) {
    const credentials = this.decrypt(profile);
    if (!credentials.attempt || credentials.token !== credentials.attempt.deviceToken) throw appError(409, 'device.incompleteCredentials');
    const control = this.control(profile.id), generation = control.generation;
    try {
      await this.operation(profile.id, async signal => {
        if (signal.aborted || this.closing || generation !== control.generation || !this.repository.profile(profile.id)?.attached) throw new RelayError('aborted', '配對已取消。');
        const result = pairResultSchema.parse(await this.factory(profile.configuration).pair(credentials.attempt!, signal));
        if (signal.aborted || this.closing || generation !== control.generation || !this.repository.profile(profile.id)?.attached) throw new RelayError('aborted', '配對已取消。');
        if (result.device.id !== profile.deviceId || result.device.revokedAt) throw new RelayError('invalid', '配對身分不符。');
        this.repository.finishPairing(profile.id, result.networkId, this.encrypt({ token: credentials.token }), result.device);
      });
    } catch (error) {
      const safe = syncError(error, this.locale());
      if (!this.closing && generation === control.generation && this.repository.profile(profile.id)?.attached) this.repository.setConnection(profile.id, 'error', safe.message);
      throw appError(400, 'device.retryPair');
    }
  }
  async enable(profileId: string, enabled: boolean) {
    return this.exclusive(profileId, async () => {
      const profile = this.requiredProfile(profileId), control = this.control(profileId), worker = this.workers.get(profileId)!;
      if (enabled) { this.ensureAvailable(); this.decrypt(profile); }
      control.generation++; this.repository.setEnabled(profileId, enabled);
      for (const controller of control.controllers) controller.abort();
      await worker.interrupt();
      if (enabled) void worker.syncNow();
      return this.state(profileId);
    });
  }
  async disconnect(profileId: string) {
    return this.exclusive(profileId, async () => {
      const control = this.control(profileId); control.generation++;
      this.repository.setEnabled(profileId, false);
      for (const controller of control.controllers) controller.abort();
      await Promise.allSettled([this.workers.get(profileId)!.stop(), ...control.operations]);
      this.repository.detach(profileId);
      this.workers.delete(profileId);
      return this.state();
    });
  }
  async invitation(profileId: string): Promise<Invitation> {
    const code = randomBytes(32).toString('hex');
    return this.remote(profileId, async ({ profile, token, relay }, signal) => {
      const result = await relay.createInvite(token, code, signal);
      return { code, expiresAt: z.string().datetime({ offset: true }).parse(result.expiresAt), ...profile.configuration };
    });
  }
  async revoke(profileId: string, deviceId: string) {
    const captured = this.captureProfile(profileId), profile = captured.profile;
    uuid.parse(deviceId);
    if (deviceId === profile.deviceId) throw appError(400, 'device.selfRevoke');
    await this.remote(profileId, async ({ token, relay }, signal) => relay.revokeDevice(token, deviceId, signal));
    captured.assertCurrent();
    const device = this.repository.devices(profileId).find(value => value.id === deviceId);
    if (device) this.repository.cacheDevices(profileId, [{ ...device, revokedAt: this.repository.now() }]);
    return this.state(profileId);
  }
  async syncNow(profileId: string) {
    this.ensureAvailable();
    const profile = this.requiredProfile(profileId);
    if (!profile.enabled) throw appError(409, 'device.paused');
    this.control(profileId);
    await this.workers.get(profileId)!.syncNow(); return this.state(profileId);
  }
  async syncAll() {
    this.ensureAvailable();
    const profiles = this.repository.profiles().filter(profile => profile.enabled && profile.networkId && !profile.pairingPending && !this.revoked(profile));
    await Promise.all(profiles.map(profile => { this.control(profile.id); return this.workers.get(profile.id)!.syncNow(); }));
    return this.state();
  }
  previewShare(profileId: string, projectId: string, input?: Omit<SharePolicy, 'projectId'>) {
    this.requiredProfile(profileId);
    const policy = input ? sharePolicySchema.parse({ ...input, projectId }) : this.repository.policy(profileId, projectId);
    return this.repository.preview(projectId, policy);
  }
  share(profileId: string, projectId: string, input: Omit<SharePolicy, 'projectId'>) {
    this.ensureAvailable(); this.requiredProfile(profileId);
    return this.repository.setPolicy(profileId, sharePolicySchema.parse({ ...input, projectId }));
  }
  remoteProjects(profileId: string, owner: string) {
    this.requiredProfile(profileId); return this.repository.snapshots(profileId, uuid.parse(owner));
  }
  messages(profileId: string, box: 'inbox' | 'sent') {
    this.requiredProfile(profileId); return this.repository.messages(profileId, box);
  }
  compose(profileId: string, input: ComposeMessageInput) {
    this.ensureAvailable();
    const profile = this.requiredProfile(profileId);
    const parsed = z.object({ toDeviceId: uuid, payload: messagePayloadSchema }).strict().parse(input);
    if (parsed.toDeviceId === profile.deviceId || !this.repository.activeDevice(profile.id, parsed.toDeviceId)) throw appError(400, 'device.target');
    if (parsed.payload.kind === 'proposal') {
      const payload = parsed.payload;
      const snapshot = this.repository.snapshots(profile.id, parsed.toDeviceId).find(value => value.projectId === payload.projectId);
      if (!snapshot?.project || snapshot.project.revision !== payload.baseRevision) throw appError(409, 'device.snapshotChanged');
      if (Object.keys(payload.changes.memory ?? {}).some(key => !(key in snapshot.project!.memory))) throw appError(400, 'device.unsharedMemory');
    }
    return this.repository.enqueue(profile, { id: randomUUID(), toDeviceId: parsed.toDeviceId, payload: JSON.stringify(parsed.payload), expiresAt: new Date(this.repository.clock() + 7 * 86400000).toISOString() });
  }
  private sharingProfiles() {
    return this.repository.profiles().filter(profile => profile.networkId && !profile.pairingPending && !this.revoked(profile)).sort((a, b) => a.id.localeCompare(b.id));
  }
  groupSharing(projectId: string, policies?: GroupShareInput[]): GroupSharingPreview {
    if (this.closing) throw appError(503, 'device.closing');
    const project = this.repository.store.getProject(uuid.parse(projectId));
    const profiles = this.sharingProfiles();
    const normalize = (policy: SharePolicy): SharePolicy => ({ ...policy, memoryFields: MEMORY_FIELDS.filter(field => policy.memoryFields.includes(field)) });
    const current = profiles.map(profile => ({ profileId: profile.id, ...normalize(this.repository.policy(profile.id, projectId)) }));
    const parsed = policies === undefined ? current : groupPoliciesInput.parse({ policies }).policies;
    const ids = new Set(parsed.map(policy => policy.profileId));
    // Every eligible group is represented, including unchecked targets. Omission is never consent to withdrawal.
    if (ids.size !== parsed.length || profiles.length !== parsed.length || profiles.some(profile => !ids.has(profile.id))) throw appError(409, 'device.sharingChanged');
    for (const policy of parsed) this.requiredProfile(policy.profileId);
    const groups = profiles.map(profile => {
      const selected = parsed.find(policy => policy.profileId === profile.id)!;
      return { group: this.group(profile), preview: this.repository.preview(projectId, normalize({ projectId, enabled: selected.enabled, memoryFields: selected.memoryFields })) };
    });
    const membership = this.repository.profiles().sort((a, b) => a.id.localeCompare(b.id)).map(profile => ({ id: profile.id, networkId: profile.networkId,
      deviceId: profile.deviceId, pairingPending: profile.pairingPending, revoked: this.revoked(profile) }));
    const digest = payloadHash(JSON.stringify({ projectId, revision: project.revision, membership, current,
      targets: groups.map(({ group, preview }) => ({ profileId: group.id, policy: preview.policy })) }));
    return { projectId, revision: project.revision, digest, groups };
  }
  shareGroups(projectId: string, input: { policies: GroupShareInput[]; digest: string; confirm: true }): GroupSharingPreview {
    this.ensureAvailable();
    const parsed = groupSaveInput.parse(input);
    return this.repository.store.transaction(() => {
      const preview = this.groupSharing(projectId, parsed.policies);
      if (preview.digest !== parsed.digest) throw appError(409, 'device.sharingChanged');
      if (preview.groups.some(group => group.preview.error)) throw appError(413, 'device.summaryLarge');
      for (const { group, preview: projection } of preview.groups) this.repository.writePolicy(group.id, projection.policy);
      return this.groupSharing(projectId);
    });
  }
  sharedWorkspace(): SharedWorkspaceState {
    if (this.closing) throw appError(503, 'device.closing');
    const profiles = this.sharingProfiles(), items: SharedWorkspaceState['items'] = [];
    for (const profile of profiles) {
      const groupLabel = profile.label, lastSyncAt = profile.lastSyncAt;
      const own = this.repository.activeDevice(profile.id, profile.deviceId);
      if (own) for (const snapshot of this.repository.ownSnapshots(profile.id)) items.push({ ...snapshot, profileId: profile.id, groupLabel,
        ownerDeviceId: profile.deviceId, ownerName: own.name, owned: true, receivedAt: null, lastSyncAt });
      for (const owner of this.repository.devices(profile.id)) {
        if (owner.id === profile.deviceId || owner.revokedAt) continue;
        for (const snapshot of this.repository.snapshots(profile.id, owner.id)) {
          if (snapshot.project) items.push({ ...snapshot, project: snapshot.project, profileId: profile.id, groupLabel, ownerName: owner.name, owned: false, pending: false, lastSyncAt });
        }
      }
    }
    return { groups: profiles.map(profile => this.group(profile)), items };
  }
  downloadSummary(input: { profileId: string; ownerDeviceId: string; projectId: string; version: number }): SummaryDownload {
    const key = downloadInput.parse(input);
    this.requiredProfile(key.profileId);
    const item = this.sharedWorkspace().items.find(item => item.profileId === key.profileId && item.ownerDeviceId === key.ownerDeviceId && item.projectId === key.projectId);
    if (!item || item.version !== key.version) throw appError(409, 'device.summaryUnavailable');
    const result = formatSharedSummary(item.project, { profileId: item.profileId, groupLabel: item.groupLabel, ownerDeviceId: item.ownerDeviceId, ownerName: item.ownerName,
      projectId: item.projectId, version: item.version, pending: item.pending, publishedAt: item.publishedAt, receivedAt: item.receivedAt, lastSyncAt: item.lastSyncAt }, this.locale());
    if (Buffer.byteLength(result.text, 'utf8') > 1024 * 1024) throw appError(413, 'device.downloadLarge');
    return result;
  }
  private incoming(profileId: string, id: string) {
    const profile = this.requiredProfile(profileId), message = this.repository.message(profile.id, uuid.parse(id));
    if (message.direction !== 'inbox' || message.toDeviceId !== profile.deviceId) throw appError(400, 'device.incomingOnly');
    return { profile, message };
  }
  private proposalProblem(profile: RelayProfile, message: MessageView, payload: ProposalPayload): ErrorCode | null {
    if (message.result) return 'proposal.processed';
    if (Date.parse(message.expiresAt) <= this.repository.clock()) return 'proposal.expired';
    if (!this.repository.activeDevice(profile.id, message.fromDeviceId)) return 'proposal.source';
    const policy = this.repository.policy(profile.id, payload.projectId);
    if (!policy.enabled) return 'proposal.unshared';
    if (Object.keys(payload.changes.memory ?? {}).some(key => !policy.memoryFields.includes(key as typeof policy.memoryFields[number]))) return 'proposal.fields';
    const project = this.repository.store.getProject(payload.projectId);
    if (project.revision !== payload.baseRevision) return 'proposal.conflict';
    return !profile.enabled || !this.available() ? 'proposal.enableSync' : null;
  }
  preview(profileId: string, id: string): ProposalPreview {
    const { profile, message } = this.incoming(profileId, id);
    if (message.payload.kind !== 'proposal') throw appError(400, 'proposal.notProposal');
    const payload = message.payload, project = this.repository.store.getProject(payload.projectId);
    const changes = [], memoryLabels = getMemoryLabels(this.locale());
    if (payload.changes.nextAction !== undefined) changes.push({ key: 'nextAction', label: coreTranslator(this.locale())('device.nextAction'), before: project.nextAction, after: payload.changes.nextAction });
    for (const [key, after] of Object.entries(payload.changes.memory ?? {})) changes.push({ key, label: memoryLabels[key as keyof typeof memoryLabels], before: project.memory[key as keyof typeof project.memory], after });
    const problem = this.proposalProblem(profile, message, payload);
    const reason = problem ? translateError(problem, this.locale()) : null;
    return { messageId: id, hash: message.hash, projectId: project.id, projectName: project.name, revision: project.revision, baseRevision: payload.baseRevision, changes, canApply: !reason, reason, ...(problem ? { reasonCode: problem } : {}) };
  }
  async accept(profileId: string, id: string, input: ApplyProposalInput) {
    const { profile, message } = this.incoming(profileId, id);
    if (message.result?.status === 'applied') return message;
    const parsed = z.object({ hash: tokenSchema, revision: revisionSchema, confirm: z.literal(true) }).strict().parse(input);
    const preview = this.preview(profileId, id);
    if (!preview.canApply || preview.hash !== parsed.hash || preview.revision !== parsed.revision) throw appError(409, preview.reasonCode ?? 'proposal.previewChanged');
    const captured = this.captureProfile(profileId);
    await this.remote(profileId, async ({ token, relay }, signal) => {
      const live = relayMessageSchema.parse(await relay.checkProposal(token, id, message.hash, signal));
      if (live.id !== id || live.hash !== message.hash || live.toDeviceId !== profile.deviceId || live.fromDeviceId !== message.fromDeviceId || payloadHash(live.payload) !== message.hash || live.expiresAt !== message.expiresAt || live.result)
        throw new RelayError('conflict', '請求的來源或內容已變更。');
    });
    return this.repository.store.transaction(() => {
      captured.assertCurrent();
      if (!this.requiredProfile(profileId).enabled) throw appError(409, 'proposal.connectionChanged');
      const current = this.repository.message(profile.id, id);
      if (current.result?.status === 'applied') return current;
      if (current.payload.kind !== 'proposal') throw appError(400, 'proposal.invalid');
      const problem = this.proposalProblem(profile, current, current.payload);
      const project = this.repository.store.getProject(current.payload.projectId);
      if (problem || current.hash !== parsed.hash || project.revision !== parsed.revision) throw appError(409, problem ?? 'proposal.localChanged');
      const changes = current.payload.changes;
      const updated = changes.memory && Object.keys(changes.memory).length
        ? this.repository.store.saveMemory(project.id, project.revision, memorySchema.parse({ ...project.memory, ...changes.memory }), changes.nextAction)
        : this.repository.store.updateProject(project.id, { revision: project.revision, nextAction: changes.nextAction! });
      this.repository.decide(profile.id, id, { status: 'applied', revision: updated.revision, at: this.repository.now() });
      return this.repository.message(profile.id, id);
    });
  }
  decide(profileId: string, id: string, status: 'rejected' | 'read') {
    const { profile, message } = this.incoming(profileId, id);
    if ((status === 'read') !== (message.payload.kind === 'message')) throw appError(400, 'device.decisionInvalid');
    const decision: MessageDecision = { status, revision: null, at: this.repository.now() };
    this.repository.store.transaction(() => this.repository.decide(profile.id, id, decision));
    return this.repository.message(profile.id, id);
  }
}

export function deviceRouter(service: DeviceService) {
  const router = Router();
  const id = (value: unknown) => uuid.parse(value);
  const empty = (body: unknown) => z.object({}).strict().parse(body);
  const scope = (req: import('express').Request) => id(req.get(PROFILE_HEADER));
  router.get('/devices', (req, res) => res.json(service.state(req.get(PROFILE_HEADER) === undefined ? undefined : scope(req))));
  router.patch('/devices/local', (req, res) => res.json(service.rename(z.object({ name: deviceNameSchema }).strict().parse(req.body).name)));
  router.post('/devices/pair', async (req, res) => res.json(await service.pair(pairInputSchema.parse(req.body))));
  router.post('/devices/groups/select', (req, res) => res.json(service.selectGroup(z.object({ profileId: uuid }).strict().parse(req.body).profileId)));
  router.patch('/devices/groups/:id', (req, res) => res.json(service.labelGroup(id(req.params.id), z.object({ label: groupLabelSchema }).strict().parse(req.body).label)));
  router.post('/devices/sync-all', async (req, res) => { empty(req.body); res.json(await service.syncAll()); });
  router.get('/shared-workspace', (_req, res) => res.json(service.sharedWorkspace()));
  router.post('/shared-workspace/download', (req, res) => res.json(service.downloadSummary(downloadInput.parse(req.body))));
  router.get('/devices/group-sharing/:id', (req, res) => res.json(service.groupSharing(id(req.params.id))));
  router.post('/devices/group-sharing/:id/preview', (req, res) => res.json(service.groupSharing(id(req.params.id), groupPoliciesInput.parse(req.body).policies)));
  router.put('/devices/group-sharing/:id', (req, res) => res.json(service.shareGroups(id(req.params.id), groupSaveInput.parse(req.body))));
  router.post('/devices/pair/retry', async (req, res) => { empty(req.body); res.json(await service.retryPair(scope(req))); });
  router.post('/devices/connection', async (req, res) => res.json(await service.enable(scope(req), z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled)));
  router.post('/devices/disconnect', async (req, res) => { confirmation.parse(req.body); res.json(await service.disconnect(scope(req))); });
  router.post('/devices/invitation', async (req, res) => { empty(req.body); res.json(await service.invitation(scope(req))); });
  router.post('/devices/sync', async (req, res) => { empty(req.body); res.json(await service.syncNow(scope(req))); });
  router.post('/devices/:id/revoke', async (req, res) => { confirmation.parse(req.body); res.json(await service.revoke(scope(req), id(req.params.id))); });
  router.get('/devices/sharing/:id', (req, res) => res.json(service.previewShare(scope(req), id(req.params.id))));
  router.post('/devices/sharing/:id/preview', (req, res) => res.json(service.previewShare(scope(req), id(req.params.id), policyInput.parse(req.body))));
  router.put('/devices/sharing/:id', (req, res) => res.json(service.share(scope(req), id(req.params.id), policyInput.parse(req.body))));
  router.get('/devices/:id/projects', (req, res) => res.json(service.remoteProjects(scope(req), id(req.params.id))));
  router.get('/messages', (req, res) => res.json(service.messages(scope(req), z.enum(['inbox', 'sent']).parse(req.query.box ?? 'inbox'))));
  router.post('/messages', (req, res) => res.status(201).json(service.compose(scope(req), req.body)));
  router.post('/messages/:id/preview', (req, res) => { empty(req.body); res.json(service.preview(scope(req), id(req.params.id))); });
  router.post('/messages/:id/accept', async (req, res) => res.json(await service.accept(scope(req), id(req.params.id), req.body)));
  router.post('/messages/:id/reject', (req, res) => { confirmation.parse(req.body); res.json(service.decide(scope(req), id(req.params.id), 'rejected')); });
  router.post('/messages/:id/read', (req, res) => { empty(req.body); res.json(service.decide(scope(req), id(req.params.id), 'read')); });
  return router;
}
