import type { DeviceState } from '../shared/devices';
import type { GitApproval, LocalGitState } from '../shared/git';
import type { GovernanceState, StatusSharingPolicy } from '../shared/governance';
import type { GitChange } from '../shared/types';
import type { GitMessageKey } from './locales/panels-git';

const diagnosticKeys: Record<string, GitMessageKey> = {
  customHelpers: 'reasonCustomHelpers', signing: 'reasonSigning', fsmonitor: 'reasonFsmonitor', specialIndex: 'reasonSpecialIndex',
  partialClone: 'reasonPartialClone', refStorage: 'reasonRefStorage', tls: 'reasonTls', hooks: 'reasonHooks', objectLayout: 'reasonObjectLayout',
  replaceRefs: 'reasonReplaceRefs', indexVersion: 'reasonIndexVersion', conflicts: 'reasonConflicts', specialFiles: 'reasonSpecialFiles',
  indexFlags: 'reasonIndexFlags', indexExtension: 'reasonIndexExtension', attributes: 'reasonAttributes', nativeSymrefs: 'reasonNativeSymrefs',
  unavailable: 'reasonUnavailable', unsafe: 'reasonUnsafe', unsupported: 'reasonUnsupported', failed: 'reasonFailed',
};
export const gitDiagnosticKey = (code: string): GitMessageKey => Object.hasOwn(diagnosticKeys, code) ? diagnosticKeys[code] : 'reasonUnsupported';
const operationStateKeys: Record<string, GitMessageKey> = {
  MERGE_HEAD: 'stateMerge', CHERRY_PICK_HEAD: 'stateCherryPick', REVERT_HEAD: 'stateRevert', REBASE_HEAD: 'stateRebase',
  'rebase-merge': 'stateRebase', 'rebase-apply': 'stateRebase', sequencer: 'stateSequencer', BISECT_LOG: 'stateBisect',
};
export const gitOperationStateKey = (code: string): GitMessageKey => Object.hasOwn(operationStateKeys, code) ? operationStateKeys[code] : 'stateOther';

/** Display gating only. Every mutation is authorized afresh by the backend. */
export function hasCurrentGovernance(state: GovernanceState | null | undefined, devices: DeviceState | null | undefined): boolean {
  return !!state?.available && !!state.policy && !state.error && !!devices?.paired
    && state.policy.networkId === devices.networkId && state.policy.deviceId === devices.localDevice.id;
}
export function approvalDisplayState(approval: GitApproval, now = Date.now()): LocalGitState | 'consumed' {
  if (approval.result) return approval.result.status;
  if ((approval.state === 'pending' || approval.state === 'approved') && Date.parse(approval.expiresAt) <= now) return 'expired';
  return approval.state;
}
export function requestDisplayState(state: LocalGitState, expiresAt: string, now = Date.now()): LocalGitState {
  return (state === 'prepared' || state === 'pending' || state === 'approved') && Date.parse(expiresAt) <= now ? 'expired' : state;
}
export function isConflict(change: GitChange): boolean {
  return change.index === 'U' || change.worktree === 'U' || (change.index === 'A' && change.worktree === 'A') || (change.index === 'D' && change.worktree === 'D');
}
export function isStaged(change: GitChange): boolean { return !isConflict(change) && !!change.index.trim() && change.index !== '?' && change.index !== '!'; }
export function isUnstaged(change: GitChange): boolean { return isConflict(change) || (!!change.worktree.trim() && change.worktree !== '!'); }
export function canonicalSharing(policy: StatusSharingPolicy): string {
  return JSON.stringify({ activity: policy.activity, projects: policy.projects.filter(project => project.git || project.tasks).map(project => ({ projectId: project.projectId, git: project.git, tasks: project.tasks })).sort((a, b) => a.projectId.localeCompare(b.projectId)) });
}
/** Uses relay receipt time, never the time a local cached record was read. */
export function isStatusFresh(receivedAt: string, now = Date.now()): boolean {
  const received = Date.parse(receivedAt);
  return Number.isFinite(received) && received <= now + 30_000 && now - received < 120_000;
}
