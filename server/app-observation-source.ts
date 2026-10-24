import type { AppObservation } from '../shared/app-observation.js';

export interface AppObservationSource {
  /** Capability inspection must not run a process or sample the user's desktop. */
  available(): boolean;
  /** Only called after saved consent and an authenticated, supported channel. */
  sample(signal: AbortSignal): Promise<AppObservation>;
}
