import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { PROFILE_HEADER } from '../shared/devices.js';
import { APP_OBSERVATION_INTERVAL_MS, appObservationCapabilitySchema, appObservationPolicySchema, appObservationPublicationSchema, appObservationSchema, remoteAppObservationSchema } from '../shared/app-observation.js';
import type { AppObservation, AppObservationPolicy, AppObservationPreview, AppObservationProblem, AppObservationState, RemoteAppObservation } from '../shared/app-observation.js';
import type { Store } from './db.js';
import type { AppObservationContext, DeviceService } from './devices.js';
import type { AppObservationSource } from './app-observation-source.js';
import { AppObservationStore } from './app-observation-store.js';
import { appError, HttpError } from './validation.js';

interface Cache {
  generation: number; capability: AppObservationState['capability']; problem: AppObservationProblem;
  local: AppObservation | null; statuses: RemoteAppObservation[]; nextCapabilityCheck: number;
  controller?: AbortController;
}
export interface AppObservationOptions { source?: AppObservationSource; autoRefresh?: boolean }
interface Capture { epoch: number; controller: AbortController; promise: Promise<AppObservation> }
const emptyCache = (): Cache => ({ generation: 0, capability: 'unknown', problem: null, local: null, statuses: [], nextCapabilityCheck: 0 });

/** Names exist only in these bounded memory caches, never in local persistence or an activity log. */
export class AppObservationService {
  readonly repository: AppObservationStore;
  private caches = new Map<string, Cache>();
  private signatures = new Map<string, string>();
  private running = new Map<string, Promise<AppObservationState>>();
  private queued = new Set<string>();
  private epoch = 0;
  private capture?: Capture;
  private latest: { epoch: number; completedAt: number; observation: AppObservation } | null = null;
  private sessionActive = false;
  private unavailableAt: string;
  private closed = false;
  private unsubscribe: () => void;
  constructor(readonly store: Store, readonly devices: DeviceService, private options: AppObservationOptions = {}) {
    this.repository = new AppObservationStore(store);
    this.unavailableAt = devices.repository.now();
    for (const profile of devices.repository.profiles()) this.signatures.set(profile.id, this.signature(profile.id));
    this.unsubscribe = devices.onProfileChange(profileId => this.profileChanged(profileId));
  }
  private now() { return this.devices.repository.clock(); }
  private collectorAvailable() {
    try { return !this.closed && this.devices.state().desktopAvailable && !!this.options.source?.available(); } catch { return false; }
  }
  private cache(profileId: string) {
    let cache = this.caches.get(profileId);
    if (!cache) {
      cache = emptyCache(); this.caches.set(profileId, cache);
      // Local attached groups already have a bounded UI contract; do not retain detached caches indefinitely.
      for (const key of this.caches.keys()) if (!this.devices.repository.profile(key)?.attached && !this.running.has(key)) this.caches.delete(key);
    }
    return cache;
  }
  private signature(profileId: string) {
    const profile = this.devices.repository.profile(profileId);
    if (!profile) return '';
    const revoked = profile.connection === 'revoked' || !!this.devices.repository.devices(profileId).find(device => device.id === profile.deviceId)?.revokedAt;
    return JSON.stringify([profile.attached, profile.enabled, profile.networkId, profile.deviceId, profile.pairingPending, profile.connection === 'locked', revoked,
      this.devices.appObservationReady(profileId), this.collectorAvailable()]);
  }
  private invalidateCapture() {
    this.epoch++; this.latest = null; this.capture?.controller.abort();
    for (const cache of this.caches.values()) cache.local = null;
  }
  private invalidateProfile(profileId: string, clearReceived = false) {
    const cache = this.cache(profileId);
    cache.generation++; cache.controller?.abort(); cache.local = null;
    if (clearReceived) cache.statuses = [];
    cache.nextCapabilityCheck = 0;
  }
  private profileChanged(profileId: string, schedule = true) {
    if (this.closed) return;
    const profile = this.devices.repository.profile(profileId), signature = this.signature(profileId);
    const cache = this.caches.get(profileId);
    if (cache) cache.statuses = cache.statuses.filter(value => !!this.devices.repository.activeDevice(profileId, value.deviceId));
    if (this.signatures.get(profileId) === signature) return;
    this.signatures.set(profileId, signature);
    if (!this.devices.appObservationReady(profileId) || !this.collectorAvailable()) this.unavailableAt = this.devices.repository.now();
    this.invalidateCapture(); this.invalidateProfile(profileId, true);
    const revoked = profile?.connection === 'revoked' || (profile && this.devices.repository.devices(profileId).some(device => device.id === profile.deviceId && !!device.revokedAt));
    if (!profile?.attached || revoked) {
      this.repository.forget(profileId); this.caches.delete(profileId); this.queued.delete(profileId); return;
    }
    if (profile.networkId && !profile.pairingPending) this.repository.withdraw(profileId);
    if (schedule && this.devices.appObservationReady(profileId)) this.kick(profileId);
  }
  private kick(profileId: string) {
    if (this.closed || this.options.autoRefresh === false) return;
    if (this.running.has(profileId)) { this.queued.add(profileId); return; }
    queueMicrotask(() => { if (!this.closed) void this.refresh(profileId).catch(() => {}); });
  }
  private profile(profileId: string) {
    if (this.closed) throw appError(503, 'device.closing');
    const profile = this.devices.assertAttachedProfile(profileId);
    if (!profile.networkId || profile.pairingPending) throw appError(409, 'device.pairRequired');
    return profile;
  }
  state(profileId: string | null = null): AppObservationState {
    const base: AppObservationState = { profileId, policy: { enabled: false }, revision: 0,
      collectorAvailable: this.collectorAvailable(), sessionAvailable: this.sessionActive,
      capability: 'unknown', pendingWithdrawal: false, local: null, statuses: [], problem: null };
    if (this.closed || !profileId) return base;
    const profile = this.devices.repository.profile(profileId);
    if (!profile?.attached || !profile.networkId || profile.pairingPending) return base;
    const revoked = profile.connection === 'revoked' || this.devices.repository.devices(profileId).some(device => device.id === profile.deviceId && !!device.revokedAt);
    if (revoked) { this.profileChanged(profileId, false); return { ...base, problem: 'connection' }; }
    // Observing readiness loss may only cancel/clear work here; a GET must never schedule collection.
    this.profileChanged(profileId, false);
    const metadata = this.repository.get(profileId), cache = this.cache(profileId);
    const statuses = cache.statuses.filter(value => !!this.devices.repository.activeDevice(profileId, value.deviceId));
    return { ...base, policy: { enabled: metadata.enabled }, revision: metadata.revision,
      capability: cache.capability, pendingWithdrawal: metadata.pendingWithdrawal !== null,
      local: metadata.enabled && profile.enabled && this.sessionActive ? cache.local : null,
      statuses, problem: cache.problem ?? (!profile.enabled ? 'connection' : metadata.enabled && !base.collectorAvailable ? 'collector-unavailable' : metadata.enabled && !this.sessionActive ? 'session-unavailable' : null) };
  }
  previewSharing(profileId: string, input: AppObservationPolicy): AppObservationPreview {
    const profile = this.profile(profileId), policy = appObservationPolicySchema.parse(input);
    const metadata = this.repository.get(profileId);
    const digest = createHash('sha256').update(JSON.stringify({ profileId, networkId: profile.networkId, deviceId: profile.deviceId, policy, revision: metadata.revision })).digest('hex');
    return { policy, revision: metadata.revision, digest, fields: ['name', 'observedAt'] };
  }
  saveSharing(profileId: string, policy: AppObservationPolicy, digest: string): AppObservationState {
    const preview = this.previewSharing(profileId, policy);
    if (preview.digest !== digest) throw appError(409, 'governance.previewChanged');
    if (preview.policy.enabled) {
      this.devices.requiredProfile(profileId);
      if (!this.collectorAvailable()) throw appError(400, 'device.desktopRequired');
    }
    this.repository.save(profileId, preview.policy.enabled);
    this.invalidateCapture(); this.invalidateProfile(profileId);
    const profile = this.devices.repository.profile(profileId)!;
    const cache = this.cache(profileId);
    cache.statuses = cache.statuses.filter(value => value.deviceId !== profile.deviceId);
    this.kick(profileId);
    return this.state(profileId);
  }
  setSessionAvailable(active: boolean) {
    if (this.closed || active === this.sessionActive) return;
    this.sessionActive = active; this.unavailableAt = this.devices.repository.now();
    this.invalidateCapture();
    for (const profile of this.devices.repository.profiles()) {
      this.invalidateProfile(profile.id, !active);
      if (profile.networkId && !profile.pairingPending) this.repository.withdraw(profile.id);
      if (this.devices.appObservationReady(profile.id)) this.kick(profile.id);
    }
  }
  private async sample(context: AppObservationContext): Promise<AppObservation> {
    for (let retry = 0; retry < 3; retry++) {
      context.assertCurrent();
      if (!this.sessionActive || !this.collectorAvailable()) return { name: null, observedAt: this.unavailableAt };
      if (this.latest?.epoch === this.epoch && this.now() >= this.latest.completedAt && this.now() - this.latest.completedAt < APP_OBSERVATION_INTERVAL_MS) return this.latest.observation;
      const epoch = this.epoch;
      let flight = this.capture;
      if (!flight) {
        const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
        const started = this.now();
        flight = { epoch, controller, promise: Promise.resolve(null as unknown as AppObservation) };
        const owned = flight;
        owned.promise = Promise.resolve().then(() => {
          if (signal.aborted || epoch !== this.epoch || !this.sessionActive) throw appError(409, 'proposal.connectionChanged');
          return this.options.source!.sample(signal);
        }).then(value => {
          if (signal.aborted || epoch !== this.epoch || this.closed || !this.sessionActive) throw appError(409, 'proposal.connectionChanged');
          context.assertCurrent();
          const parsed = appObservationSchema.safeParse(value);
          const observed = parsed.success ? Date.parse(parsed.data.observedAt) : NaN;
          const observation = parsed.success && observed >= started - 1000 && observed <= this.now() + 30000
            ? parsed.data : { name: null, observedAt: this.devices.repository.now() };
          this.latest = { epoch, completedAt: this.now(), observation };
          return observation;
        }).finally(() => { if (this.capture === owned) this.capture = undefined; });
        this.capture = owned;
      }
      try {
        const observation = await flight.promise;
        context.assertCurrent();
        if (flight.epoch === this.epoch && this.sessionActive) return observation;
      } catch (error) {
        context.assertCurrent();
        if (flight.epoch === this.epoch) throw error;
      }
    }
    return { name: null, observedAt: this.devices.repository.now() };
  }
  async refresh(profileId: string, force = false): Promise<AppObservationState> {
    this.profile(profileId);
    this.profileChanged(profileId, false);
    const cache = this.cache(profileId);
    if (!this.devices.appObservationReady(profileId)) return this.state(profileId);
    const existing = this.running.get(profileId);
    if (existing) {
      if (force && cache.controller?.signal.aborted) { await existing; return this.closed ? this.state(profileId) : this.refresh(profileId, true); }
      return existing;
    }
    if (!force && cache.capability === 'unsupported' && this.now() < cache.nextCapabilityCheck) return this.state(profileId);
    const generation = cache.generation, controller = new AbortController(); cache.controller = controller;
    const revision = this.repository.get(profileId).revision;
    const work = this.devices.withAppObservation(profileId, async (client, context) => {
      const guard = () => {
        context.assertCurrent();
        if (this.closed || cache.generation !== generation || this.repository.get(profileId).revision !== revision) throw appError(409, 'proposal.connectionChanged');
      };
      const capability = await client.capability(); guard();
      if (!capability) {
        cache.capability = 'unsupported'; cache.problem = 'upgrade-required'; cache.local = null; cache.statuses = [];
        cache.nextCapabilityCheck = this.now() + 60000; return;
      }
      const identity = appObservationCapabilitySchema.parse(capability);
      if (identity.networkId !== context.networkId || identity.deviceId !== context.deviceId) throw appError(400, 'relay.invalid');
      cache.capability = 'supported'; cache.problem = null;
      const withdrawal = this.repository.get(profileId).pendingWithdrawal;
      if (withdrawal !== null) {
        await client.publish({ protocol: 1, sequence: withdrawal, observation: null }); guard();
        this.repository.acknowledgeWithdrawal(profileId, withdrawal);
      }
      if (this.repository.get(profileId).enabled) {
        const observation = this.sessionActive && this.collectorAvailable()
          ? await this.sample(context) : { name: null, observedAt: this.unavailableAt };
        guard();
        const publication = appObservationPublicationSchema.parse({ protocol: 1, sequence: this.repository.allocate(profileId), observation });
        guard(); await client.publish(publication); guard(); cache.local = observation;
      }
      const returned = await client.statuses(); guard();
      if (returned.length > 100) throw appError(400, 'relay.invalid');
      const seen = new Set<string>();
      const statuses = returned.map(value => remoteAppObservationSchema.parse(value)).filter(value => {
        if (seen.has(value.deviceId)) throw appError(400, 'relay.invalid'); seen.add(value.deviceId);
        return !!this.devices.repository.activeDevice(profileId, value.deviceId);
      });
      cache.statuses = statuses.map(value => {
        const previous = cache.statuses.find(old => old.deviceId === value.deviceId);
        if (previous && previous.sequence > value.sequence) return previous;
        if (previous && previous.sequence === value.sequence && JSON.stringify(previous.observation) !== JSON.stringify(value.observation)) throw appError(400, 'relay.invalid');
        return value;
      });
    }, controller.signal).catch(error => {
      if (this.closed || cache.generation !== generation || controller.signal.aborted) return;
      cache.local = null;
      if (error instanceof HttpError && error.code === 'relay.conflict') cache.problem = 'conflict';
      else if (error instanceof HttpError && error.code === 'relay.invalid') cache.problem = 'invalid';
      else cache.problem = 'connection';
    }).then(() => this.state(profileId)).finally(() => {
      if (cache.controller === controller) cache.controller = undefined;
      this.running.delete(profileId);
      if (this.queued.delete(profileId)) this.kick(profileId);
    });
    this.running.set(profileId, work);
    return work;
  }
  async stop() {
    if (this.closed) return;
    this.closed = true; this.unsubscribe(); this.invalidateCapture(); this.queued.clear();
    for (const cache of this.caches.values()) cache.controller?.abort();
    await Promise.allSettled([...this.running.values(), ...(this.capture ? [this.capture.promise] : [])]);
    this.caches.clear(); this.latest = null;
  }
}

const confirmed = z.object({ confirm: z.literal(true) }).strict();
const profileId = (request: Request) => z.string().uuid().parse(request.get(PROFILE_HEADER));
export function appObservationRouter(service: AppObservationService) {
  const router = Router();
  router.get('/app-observation', (req, res) => res.json(service.state(req.get(PROFILE_HEADER) === undefined ? null : profileId(req))));
  router.post('/app-observation/refresh', async (req, res) => { confirmed.parse(req.body); res.json(await service.refresh(profileId(req), true)); });
  router.post('/app-observation/sharing/preview', (req, res) => {
    const input = z.object({ policy: appObservationPolicySchema }).strict().parse(req.body);
    res.json(service.previewSharing(profileId(req), input.policy));
  });
  router.post('/app-observation/sharing', (req, res) => {
    const input = confirmed.extend({ policy: appObservationPolicySchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(service.saveSharing(profileId(req), input.policy, input.digest));
  });
  return router;
}
