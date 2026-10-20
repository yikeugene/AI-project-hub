import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import type { DeviceState } from '../../shared/devices';
import type { GitApproval } from '../../shared/git';
import { gitApi } from '../api';
import { isNetworkOnline } from '../device-ui';
import { approvalDisplayState, hasCurrentGovernance } from '../git-ui';
import { formatDate, useAction, useBeforeUnload, useDeviceResource, useNow, type GovernanceController } from '../hooks';
import { GitReview, GitStateBadge } from '../components/GitReview';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { gitMessages } from '../locales/panels-git';

export function GitApprovalPanel({ devices, governance, onDirtyChange, onBusyChange }: {
  devices: DeviceState; governance: GovernanceController; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(gitMessages); const locale = useLocale(); const now = useNow();
  const load = useCallback(() => gitApi.approvals(devices.profileId), [devices.profileId]);
  const approvals = useDeviceResource(load);
  const action = useAction(devices.profileId);
  const [decision, setDecision] = useState<{ profileId: string; approval: GitApproval; choice: 'approved' | 'rejected' } | null>(null);
  const scope = useRef(devices.profileId); scope.current = devices.profileId;
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => { onDirtyChange(!!decision); }, [decision, onDirtyChange]);
  useBeforeUnload(!!decision || action.busy);
  const validPolicy = hasCurrentGovernance(governance.state, devices) && !governance.error;
  const canDecide = !!devices.profileId && validPolicy && isNetworkOnline(devices) && governance.state?.policy?.role === 'admin' && !approvals.error;
  const eligible = (approval: GitApproval) => canDecide && approval.reviewerDeviceId === devices.localDevice.id && approvalDisplayState(approval, now) === 'pending';
  const current = decision && approvals.data?.find(item => item.id === decision.approval.id && item.digest === decision.approval.digest);
  const currentEligible = decision?.profileId === devices.profileId && !!current && eligible(current);
  const name = (id: string) => id === devices.localDevice.id ? devices.localDevice.name : devices.devices.find(device => device.id === id)?.name ?? id;
  const open = (approval: GitApproval, choice: 'approved' | 'rejected') => {
    if (!eligible(approval) || action.busy) return;
    action.setError(null); setSaved(false); setReason(''); setDecision({ profileId: devices.profileId!, approval, choice });
  };
  const confirm = async () => {
    if (!decision || !currentEligible || action.busy || Date.parse(decision.approval.expiresAt) <= Date.now()) return;
    const captured = decision;
    const result = await action.run(() => gitApi.decide(captured.profileId, captured.approval.id, captured.approval.digest, captured.choice, reason));
    if (!alive.current || scope.current !== captured.profileId) return;
    if (result.ok) { setDecision(null); setReason(''); setSaved(true); }
    await Promise.all([approvals.reload(), governance.reload()]);
  };
  return <section className="panel git-approval-panel">
    <SectionHeading title={t('approvalTitle')} subtitle={t('approvalSubtitle')}><Button icon={RefreshCw} disabled={action.busy || approvals.loading} onClick={() => { void Promise.all([approvals.reload(), governance.reload()]); }}>{t('approvalRefresh')}</Button></SectionHeading>
    <Notice>{t('workflow')}</Notice>
    {!validPolicy && <Notice warning>{t('writeUnavailable')}</Notice>}
    <ErrorNotice message={governance.error || governance.state?.error || ''} /><ErrorNotice message={approvals.error} />
    {!decision && <ErrorNotice message={action.error} />}
    <p className="field-hint">{t('approvalUnavailable')}</p>
    {saved && <p className="inline-success" role="status"><ShieldCheck size={16} aria-hidden="true" />{t('decisionSaved')}</p>}
    {approvals.loading ? <Loading /> : !approvals.data?.length ? <EmptyState icon={ShieldCheck} title={t('approvalEmpty')} description={t('approvalEmptyHint')} /> : <ol className="git-request-list">{approvals.data.map(approval => <li className="git-request" key={approval.id}>
      <div className="git-request-heading"><h3>{approval.summary.projectName} — {t(approval.summary.kind)}</h3><GitStateBadge state={approvalDisplayState(approval, now)} /></div>
      <p className="field-hint">{t('requestId', { id: approval.id })}</p><p className="field-hint">{t('approvalFrom', { name: name(approval.fromDeviceId), id: approval.fromDeviceId })}</p><p className="field-hint">{t('approvalReviewer', { name: name(approval.reviewerDeviceId), id: approval.reviewerDeviceId })}</p><p className="field-hint">{t('expires', { date: formatDate(approval.expiresAt, true, locale) })}</p>
      {approval.fromDeviceId === devices.localDevice.id && approval.reviewerDeviceId === devices.localDevice.id && <Notice>{t('selfApproval')}</Notice>}
      <details className="git-request-details"><summary>{t('requestDetails')}</summary><GitReview summary={approval.summary} digest={approval.digest} expiresAt={approval.expiresAt} />{approval.reason && <p className="preserve-lines">{t('reason')}: {approval.reason}</p>}{approval.approvedBy && <p className="field-hint">{t('approvedBy', { id: approval.approvedBy })}</p>}{approval.result && <p className="field-hint">{t('resultCode', { code: approval.result.code })}</p>}</details>
      {approval.state === 'pending' && <div className="device-toolbar"><Button variant="primary" icon={ShieldCheck} disabled={!eligible(approval) || action.busy} onClick={() => open(approval, 'approved')}>{t('approve')}</Button><Button disabled={!eligible(approval) || action.busy} onClick={() => open(approval, 'rejected')}>{t('reject')}</Button></div>}
    </li>)}</ol>}
    {decision && <ConfirmDialog title={t(decision.choice === 'approved' ? 'approveTitle' : 'rejectTitle')} confirmLabel={t(decision.choice === 'approved' ? 'approveConfirm' : 'rejectConfirm')} danger={decision.choice === 'rejected'} busy={action.busy} confirmDisabled={!currentEligible} error={action.error} onClose={() => setDecision(null)} onConfirm={() => { void confirm(); }}>
      <p className="field-hint">{t('requestId', { id: decision.approval.id })}</p><p>{t('approvalFrom', { name: name(decision.approval.fromDeviceId), id: decision.approval.fromDeviceId })}</p><GitReview summary={decision.approval.summary} digest={decision.approval.digest} expiresAt={decision.approval.expiresAt} />
      <Notice warning>{t('approvalWarning')}</Notice>{decision.approval.fromDeviceId === devices.localDevice.id && <Notice>{t('selfApproval')}</Notice>}
      <Field label={t('decisionReason')}><textarea rows={3} maxLength={1000} value={reason} disabled={action.busy} onChange={event => setReason(event.target.value)} /></Field>
      {!currentEligible && <Notice warning>{t('decisionStale')}</Notice>}
    </ConfirmDialog>}
  </section>;
}
