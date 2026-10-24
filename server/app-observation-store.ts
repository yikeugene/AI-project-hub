import type { Store } from './db.js';
import { appError } from './validation.js';

export interface AppObservationMetadata {
  enabled: boolean; revision: number; sequence: number; pendingWithdrawal: number | null;
}
/** Only consent/ordering metadata belongs on disk. Never add application names or payloads here. */
export class AppObservationStore {
  constructor(readonly store: Store) {}
  get(profileId: string): AppObservationMetadata {
    this.store.db.prepare('INSERT OR IGNORE INTO app_observation_profiles(profile_id) VALUES(?)').run(profileId);
    const row = this.store.db.prepare('SELECT * FROM app_observation_profiles WHERE profile_id=?').get(profileId)!;
    return { enabled: !!row.enabled, revision: Number(row.revision), sequence: Number(row.sequence), pendingWithdrawal: row.pending_withdrawal === null ? null : Number(row.pending_withdrawal) };
  }
  private next(profileId: string): number {
    const current = this.get(profileId);
    if (!Number.isSafeInteger(current.sequence + 1)) throw appError(409, 'governance.invalid');
    this.store.db.prepare('UPDATE app_observation_profiles SET sequence=sequence+1 WHERE profile_id=?').run(profileId);
    return current.sequence + 1;
  }
  allocate(profileId: string): number { return this.store.transaction(() => this.next(profileId)); }
  private withdrawal(profileId: string): number | null {
    const current = this.get(profileId);
    if (!current.sequence || current.pendingWithdrawal !== null) return current.pendingWithdrawal;
    const sequence = this.next(profileId);
    this.store.db.prepare('UPDATE app_observation_profiles SET pending_withdrawal=? WHERE profile_id=?').run(sequence, profileId);
    return sequence;
  }
  withdraw(profileId: string) { return this.store.transaction(() => this.withdrawal(profileId)); }
  save(profileId: string, enabled: boolean): AppObservationMetadata {
    return this.store.transaction(() => {
      this.get(profileId);
      this.store.db.prepare('UPDATE app_observation_profiles SET enabled=?,revision=revision+1 WHERE profile_id=?').run(Number(enabled), profileId);
      if (!enabled) this.withdrawal(profileId);
      return this.get(profileId);
    });
  }
  acknowledgeWithdrawal(profileId: string, sequence: number) {
    this.store.db.prepare('UPDATE app_observation_profiles SET pending_withdrawal=NULL WHERE profile_id=? AND pending_withdrawal=?').run(profileId, sequence);
  }
  forget(profileId: string) { this.store.db.prepare('DELETE FROM app_observation_profiles WHERE profile_id=?').run(profileId); }
}
