import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getMemoryLabels } from '../shared/types.js';
import { coreTranslator } from '../shared/locales/core.js';
import { translateError, type ErrorCode } from '../shared/messages.js';
import { deviceNameSchema, messagePayloadSchema, pairInputSchema, pairResultSchema, relayMessageSchema, sharePolicySchema, tokenSchema } from '../shared/devices.js';
import type { ApplyProposalInput, ComposeMessageInput, DeviceState, Invitation, MessageDecision, MessageView, PairAttempt, PairInput, ProposalPayload, ProposalPreview, SharePolicy } from '../shared/devices.js';
import type { Store } from './db.js';
import { DeviceStore, payloadHash, type RelayProfile } from './device-store.js';
import { HttpError, appError, memorySchema, revisionSchema } from './validation.js';
import { RelayError, type RelayFactory, type SecureCodec } from './relay.js';
import { createSupabaseRelay, validateRelayConfiguration } from './supabase-relay.js';
import { SyncWorker, syncError, type SyncSession } from './sync.js';
import type { GovernanceRelay } from '../shared/governance.js';

export type AuthorizedGovernance = { [K in keyof GovernanceRelay]: GovernanceRelay[K] extends (token: string, ...args: infer A) => infer R ? (...args: A) => R : never };
export interface GovernanceContext { profileId: string; networkId: string; deviceId: string; assertCurrent(): void }

const uuid = z.string().uuid();
const confirmation = z.object({ confirm: z.literal(true) }).strict();
const policyInput = sharePolicySchema.omit({ projectId: true });
const attemptSchema = z.object({ attemptId: uuid, deviceId: uuid, deviceToken: tokenSchema, inviteToken: tokenSchema, name: deviceNameSchema }).strict();
const credentialsSchema = z.object({ token: tokenSchema, attempt: attemptSchema.optional() }).strict();
export interface DeviceOptions { mode?: 'web' | 'desktop'; codec?: SecureCodec; relayFactory?: RelayFactory; clock?: () => number }

export class DeviceService {
  readonly repository: DeviceStore;
  readonly worker: SyncWorker;
  private generation = 0;
  private closing = false;
  private controlBusy = false;
  private operations = new Set<Promise<unknown>>();
  private controllers = new Set<AbortController>();
  private afterSync?: () => Promise<void>;
  constructor(store: Store, private options: DeviceOptions = {}) {
    this.repository = new DeviceStore(store, options.clock);
    this.worker = new SyncWorker(this.repository, () => this.session(), session => this.current(session), () => this.afterSync?.() ?? Promise.resolve());
  }
  onSynced(callback: () => Promise<void>) { this.afterSync = callback; }
  async withGovernance<T>(action: (client: AuthorizedGovernance, context: GovernanceContext) => Promise<T>): Promise<T> {
    return this.remote(async (session, signal) => {
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
  private locale() { return this.repository.store.getSettings().locale; }
  private available() {
    try { return this.options.mode === 'desktop' && !!this.options.codec?.available(); } catch { return false; }
  }
  private ensureAvailable() {
    if (this.closing) throw appError(503, 'device.closing');
    if (!this.available()) throw appError(400, 'device.desktopRequired');
  }
  private requiredProfile(): RelayProfile {
    if (this.closing) throw appError(503, 'device.closing');
    const profile = this.repository.profile();
    if (!profile?.networkId || profile.pairingPending) throw appError(409, 'device.pairRequired');
    return profile;
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
  private session(): SyncSession | null {
    const profile = this.repository.profile();
    if (this.closing || !profile?.enabled || !profile.networkId || profile.pairingPending || profile.connection === 'revoked') return null;
    if (!this.available()) { this.repository.setConnection(profile.id, 'locked', translateError('device.credentialsUnavailable', this.locale())); return null; }
    let token: string;
    try { token = this.decrypt(profile).token; } catch { return null; }
    return { profile, token, relay: this.factory(profile.configuration), generation: this.generation };
  }
  private current(session: SyncSession) {
    const current = this.repository.profile();
    return !this.closing && session.generation === this.generation && current?.id === session.profile.id && current.enabled && current.networkId === session.profile.networkId;
  }
  private async operation<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) throw appError(503, 'device.closing');
    const controller = new AbortController(); this.controllers.add(controller);
    const promise = action(controller.signal);
    this.operations.add(promise);
    try { return await promise; }
    finally { this.operations.delete(promise); this.controllers.delete(controller); }
  }
  private async remote<T>(action: (session: SyncSession, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ensureAvailable();
    const session = this.session();
    if (!session) throw appError(409, 'device.syncRequired');
    try {
      return await this.operation(async signal => {
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
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.controlBusy) throw appError(409, 'device.busy');
    if (this.closing) throw appError(503, 'device.closing');
    this.controlBusy = true;
    try { return await action(); } finally { this.controlBusy = false; }
  }
  start() { this.worker.start(); }
  async stop() {
    this.closing = true; this.generation++;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([this.worker.stop(), ...this.operations]);
  }
  state(): DeviceState {
    const installation = this.repository.installation(), profile = this.repository.profile();
    return { localDevice: { id: profile?.deviceId ?? installation.id, name: installation.name }, desktopAvailable: this.available(),
      enabled: profile?.enabled ?? false, paired: !!profile?.networkId, pairingPending: profile?.pairingPending ?? false,
      connection: profile?.connection ?? 'unconfigured', configuration: profile?.configuration ?? null, networkId: profile?.networkId ?? null,
      devices: profile ? this.repository.devices(profile.id) : [], sharing: profile ? this.repository.policies(profile.id) : [],
      lastSyncAt: profile?.lastSyncAt ?? null, lastError: profile?.lastError ?? null,
      ...(profile ? this.repository.counts(profile.id) : { queuedCount: 0, inboxCount: 0 }) };
  }
  rename(name: string) { this.repository.rename(deviceNameSchema.parse(name)); return this.state(); }
  async pair(input: PairInput) {
    return this.exclusive(async () => {
      this.ensureAvailable();
      const parsed = pairInputSchema.parse(input);
      if (this.repository.profile()) throw appError(409, 'device.alreadyPaired');
      const configuration = validateRelayConfiguration({ url: parsed.url, publishableKey: parsed.publishableKey });
      const attempt: PairAttempt = { attemptId: randomUUID(), deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex'), inviteToken: parsed.code, name: parsed.name };
      const ciphertext = this.encrypt({ token: attempt.deviceToken, attempt });
      this.repository.rename(parsed.name);
      const profile = this.repository.addProfile(configuration, attempt.deviceId, ciphertext);
      await this.finishPair(profile);
      return this.state();
    });
  }
  async retryPair() {
    return this.exclusive(async () => {
      this.ensureAvailable();
      const profile = this.repository.profile();
      if (!profile?.pairingPending) throw appError(409, 'device.noPendingPair');
      await this.finishPair(profile); return this.state();
    });
  }
  private async finishPair(profile: RelayProfile) {
    const credentials = this.decrypt(profile);
    if (!credentials.attempt || credentials.token !== credentials.attempt.deviceToken) throw appError(409, 'device.incompleteCredentials');
    const generation = this.generation;
    try {
      await this.operation(async signal => {
        const result = pairResultSchema.parse(await this.factory(profile.configuration).pair(credentials.attempt!, signal));
        if (signal.aborted || this.closing || generation !== this.generation || this.repository.profile()?.id !== profile.id) throw new RelayError('aborted', '配對已取消。');
        if (result.device.id !== profile.deviceId || result.device.revokedAt) throw new RelayError('invalid', '配對身分不符。');
        this.repository.finishPairing(profile.id, result.networkId, this.encrypt({ token: credentials.token }), result.device);
        if (this.repository.installation().name !== result.device.name) this.repository.rename(this.repository.installation().name);
      });
    } catch (error) {
      const safe = syncError(error, this.locale());
      if (!this.closing && generation === this.generation && this.repository.profile()?.id === profile.id) this.repository.setConnection(profile.id, 'error', safe.message);
      throw appError(400, 'device.retryPair');
    }
  }
  async enable(enabled: boolean) {
    return this.exclusive(async () => {
      const profile = this.requiredProfile();
      if (enabled) {
        this.ensureAvailable(); this.decrypt(profile);
        if (profile.connection === 'revoked') throw appError(403, 'device.revoked');
      }
      this.generation++; this.repository.setEnabled(profile.id, enabled);
      for (const controller of this.controllers) controller.abort();
      await this.worker.interrupt();
      if (enabled) void this.worker.syncNow();
      return this.state();
    });
  }
  async disconnect() {
    return this.exclusive(async () => {
      this.generation++;
      const profile = this.repository.profile();
      if (profile) this.repository.setEnabled(profile.id, false);
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled([this.worker.interrupt(), ...this.operations]);
      this.repository.detach(); return this.state();
    });
  }
  async invitation(): Promise<Invitation> {
    const code = randomBytes(32).toString('hex');
    return this.remote(async ({ profile, token, relay }, signal) => {
      const result = await relay.createInvite(token, code, signal);
      return { code, expiresAt: z.string().datetime({ offset: true }).parse(result.expiresAt), ...profile.configuration };
    });
  }
  async revoke(deviceId: string) {
    const profile = this.requiredProfile();
    if (deviceId === profile.deviceId) throw appError(400, 'device.selfRevoke');
    await this.remote(async ({ token, relay }, signal) => relay.revokeDevice(token, deviceId, signal));
    const device = this.repository.devices(profile.id).find(value => value.id === deviceId);
    if (device) this.repository.cacheDevices(profile.id, [{ ...device, revokedAt: this.repository.now() }]);
    return this.state();
  }
  async syncNow() {
    this.ensureAvailable();
    const profile = this.requiredProfile();
    if (!profile.enabled) throw appError(409, 'device.paused');
    await this.worker.syncNow(); return this.state();
  }
  previewShare(projectId: string, input?: Omit<SharePolicy, 'projectId'>) {
    const profile = this.repository.profile();
    const policy = input ? sharePolicySchema.parse({ ...input, projectId }) : profile ? this.repository.policy(profile.id, projectId) : { projectId, enabled: false, memoryFields: [] };
    return this.repository.preview(projectId, policy);
  }
  share(projectId: string, input: Omit<SharePolicy, 'projectId'>) {
    this.ensureAvailable();
    const profile = this.requiredProfile();
    return this.repository.setPolicy(profile.id, sharePolicySchema.parse({ ...input, projectId }));
  }
  remoteProjects(owner: string) {
    const profile = this.repository.profile();
    return profile ? this.repository.snapshots(profile.id, owner) : [];
  }
  messages(box: 'inbox' | 'sent') {
    const profile = this.repository.profile();
    return profile ? this.repository.messages(profile.id, box) : [];
  }
  compose(input: ComposeMessageInput) {
    this.ensureAvailable();
    const profile = this.requiredProfile();
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
  private incoming(id: string) {
    const profile = this.requiredProfile(), message = this.repository.message(profile.id, id);
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
  preview(id: string): ProposalPreview {
    const { profile, message } = this.incoming(id);
    if (message.payload.kind !== 'proposal') throw appError(400, 'proposal.notProposal');
    const payload = message.payload, project = this.repository.store.getProject(payload.projectId);
    const changes = [], memoryLabels = getMemoryLabels(this.locale());
    if (payload.changes.nextAction !== undefined) changes.push({ key: 'nextAction', label: coreTranslator(this.locale())('device.nextAction'), before: project.nextAction, after: payload.changes.nextAction });
    for (const [key, after] of Object.entries(payload.changes.memory ?? {})) changes.push({ key, label: memoryLabels[key as keyof typeof memoryLabels], before: project.memory[key as keyof typeof project.memory], after });
    const problem = this.proposalProblem(profile, message, payload);
    const reason = problem ? translateError(problem, this.locale()) : null;
    return { messageId: id, hash: message.hash, projectId: project.id, projectName: project.name, revision: project.revision, baseRevision: payload.baseRevision, changes, canApply: !reason, reason, ...(problem ? { reasonCode: problem } : {}) };
  }
  async accept(id: string, input: ApplyProposalInput) {
    const { profile, message } = this.incoming(id);
    if (message.result?.status === 'applied') return message;
    const parsed = z.object({ hash: tokenSchema, revision: revisionSchema, confirm: z.literal(true) }).strict().parse(input);
    const preview = this.preview(id);
    if (!preview.canApply || preview.hash !== parsed.hash || preview.revision !== parsed.revision) throw appError(409, preview.reasonCode ?? 'proposal.previewChanged');
    const authorizedGeneration = this.generation;
    await this.remote(async ({ token, relay }, signal) => {
      const live = relayMessageSchema.parse(await relay.checkProposal(token, id, message.hash, signal));
      if (live.id !== id || live.hash !== message.hash || live.toDeviceId !== profile.deviceId || live.fromDeviceId !== message.fromDeviceId || payloadHash(live.payload) !== message.hash || live.expiresAt !== message.expiresAt || live.result)
        throw new RelayError('conflict', '請求的來源或內容已變更。');
    });
    return this.repository.store.transaction(() => {
      if (this.closing || authorizedGeneration !== this.generation || this.repository.profile()?.id !== profile.id || !this.repository.profile()?.enabled) throw appError(409, 'proposal.connectionChanged');
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
  decide(id: string, status: 'rejected' | 'read') {
    const { profile, message } = this.incoming(id);
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
  router.get('/devices', (_req, res) => res.json(service.state()));
  router.patch('/devices/local', (req, res) => res.json(service.rename(z.object({ name: deviceNameSchema }).strict().parse(req.body).name)));
  router.post('/devices/pair', async (req, res) => res.json(await service.pair(pairInputSchema.parse(req.body))));
  router.post('/devices/pair/retry', async (req, res) => { empty(req.body); res.json(await service.retryPair()); });
  router.post('/devices/connection', async (req, res) => res.json(await service.enable(z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled)));
  router.post('/devices/disconnect', async (req, res) => { confirmation.parse(req.body); res.json(await service.disconnect()); });
  router.post('/devices/invitation', async (req, res) => { empty(req.body); res.json(await service.invitation()); });
  router.post('/devices/sync', async (req, res) => { empty(req.body); res.json(await service.syncNow()); });
  router.post('/devices/:id/revoke', async (req, res) => { confirmation.parse(req.body); res.json(await service.revoke(id(req.params.id))); });
  router.get('/devices/sharing/:id', (req, res) => res.json(service.previewShare(id(req.params.id))));
  router.post('/devices/sharing/:id/preview', (req, res) => res.json(service.previewShare(id(req.params.id), policyInput.parse(req.body))));
  router.put('/devices/sharing/:id', (req, res) => res.json(service.share(id(req.params.id), policyInput.parse(req.body))));
  router.get('/devices/:id/projects', (req, res) => res.json(service.remoteProjects(id(req.params.id))));
  router.get('/messages', (req, res) => res.json(service.messages(z.enum(['inbox', 'sent']).parse(req.query.box ?? 'inbox'))));
  router.post('/messages', (req, res) => res.status(201).json(service.compose(req.body)));
  router.post('/messages/:id/preview', (req, res) => { empty(req.body); res.json(service.preview(id(req.params.id))); });
  router.post('/messages/:id/accept', async (req, res) => res.json(await service.accept(id(req.params.id), req.body)));
  router.post('/messages/:id/reject', (req, res) => { confirmation.parse(req.body); res.json(service.decide(id(req.params.id), 'rejected')); });
  router.post('/messages/:id/read', (req, res) => { empty(req.body); res.json(service.decide(id(req.params.id), 'read')); });
  return router;
}
