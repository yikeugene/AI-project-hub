import { useCallback, useEffect, useRef, useState } from 'react';
import { FileClock, Play, RefreshCw } from 'lucide-react';
import type { GitAuditEvent, GitDetails, GitRequestView } from '../../shared/git';
import { LocalizedError } from '../../shared/i18n';
import { gitApi } from '../api';
import { isRecoverableGitState, requestDisplayState } from '../git-ui';
import { formatDate, useAction, useDeviceResource, useNow } from '../hooks';
import { GitReview, GitStateBadge } from '../components/GitReview';
import { Button, ConfirmDialog, ErrorNotice, Loading, Modal, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { gitMessages, type GitMessageKey } from '../locales/panels-git';

type Confirmation = { kind: 'execute' | 'cancel'; profileId: string; request: GitRequestView } | { kind: 'acknowledge'; profileId: string | null; request: GitRequestView; fresh: GitDetails };
export function GitRequests({ projectId, profileId, canManage, canExecute, canRecover, blocked, version, onBusyChange, onExecuted }: {
  projectId: string; profileId: string | null; canManage: boolean; canExecute: boolean; canRecover: boolean; blocked: boolean; version: number;
  onBusyChange: (busy: boolean) => void; onExecuted: () => Promise<void>;
}) {
  const t = useT(gitMessages); const locale = useLocale(); const now = useNow();
  const load = useCallback(() => gitApi.requests(profileId, projectId), [projectId, profileId]);
  const requests = useDeviceResource(load);
  const action = useAction(profileId);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [audit, setAudit] = useState<{ id: string; events: GitAuditEvent[] } | null>(null);
  const alive = useRef(true);
  const scope = useRef(profileId); scope.current = profileId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => { if (version) void requests.reload(); }, [version, requests.reload]);
  const records = requests.data ?? [];
  const current = confirmation ? records.find(item => item.preview.id === confirmation.request.preview.id && item.preview.digest === confirmation.request.preview.digest) : null;
  const currentState = current ? requestDisplayState(current.state, current.preview.expiresAt, now) : null;
  // Recovery reviews an installation-local fence; it never grants execution permission.
  const canConfirm = !requests.error && !requests.loading && !!current && confirmation?.profileId === profileId && (confirmation?.kind === 'acknowledge'
    ? canRecover && isRecoverableGitState(currentState) && !current.fenceAcknowledged && ackChecked
    : canManage && (confirmation?.kind === 'execute' ? canExecute && currentState === 'approved'
      : currentState === 'pending' || currentState === 'approved' || currentState === 'prepared'));
  const ask = (request: GitRequestView, kind: 'execute' | 'cancel') => { if (blocked || action.busy || !profileId || !canManage) return; action.setError(null); setAcknowledged(false); setConfirmation({ kind, profileId, request }); };
  const inspectRecovery = async (request: GitRequestView) => {
    if (blocked || action.busy || requests.loading || requests.error || !canRecover || !isRecoverableGitState(request.state) || request.fenceAcknowledged) return;
    const capturedScope = profileId;
    setAckChecked(false); setAcknowledged(false);
    const result = await action.run(async () => {
      const fresh = await gitApi.details(projectId);
      if (!fresh.snapshot.isRepo) throw new LocalizedError(gitMessages, 'unavailableDescription');
      return fresh;
    });
    if (result.ok && alive.current && scope.current === capturedScope) setConfirmation({ kind: 'acknowledge', profileId: capturedScope, request, fresh: result.value });
  };
  const execute = async () => {
    if (!confirmation || !canConfirm || blocked || action.busy) return;
    const captured = confirmation;
    const result = await action.run(async () => {
      try {
        // This is the sole execution call in the UI: a click on the confirmation dialog.
        return captured.kind === 'execute' ? await gitApi.execute(captured.profileId, captured.request.preview.id, captured.request.preview.digest)
          : captured.kind === 'cancel' ? await gitApi.cancel(captured.profileId, captured.request.preview.id, captured.request.preview.digest)
          : await gitApi.acknowledge(captured.profileId, captured.request.preview.id);
      } finally {
        if (alive.current && scope.current === captured.profileId) {
          setConfirmation(null); setAckChecked(false);
          // Keep the mutation guard held while authoritative state is read back, even on a lost response.
          await requests.reload();
          if (captured.kind !== 'cancel') await onExecuted();
        }
      }
    });
    if (alive.current && scope.current === captured.profileId && result.ok && captured.kind === 'acknowledge') setAcknowledged(true);
  };
  const readAudit = async (request: GitRequestView) => {
    if (blocked || action.busy) return;
    const capturedScope = profileId;
    const result = await action.run(() => gitApi.audit(capturedScope, request.preview.id));
    if (result.ok && alive.current && scope.current === capturedScope) setAudit({ id: request.preview.id, events: result.value });
  };
  return <section className="git-requests">
    <SectionHeading title={t('requestList')} subtitle={t('requestListHint')}><Button icon={RefreshCw} disabled={blocked || action.busy || requests.loading} onClick={() => { void requests.reload(); }}>{t('reloadRequests')}</Button></SectionHeading>
    <ErrorNotice message={requests.error} />{!confirmation && <ErrorNotice message={action.error} />}
    {acknowledged && <Notice>{t('acknowledged')}</Notice>}
    {requests.loading ? <Loading /> : !records.length ? <p className="quiet-empty">{t('noRequests')}</p> : <ol className="git-request-list">{records.map(request => {
      const state = requestDisplayState(request.state, request.preview.expiresAt, now);
      const disabled = blocked || action.busy || !canManage || !!requests.error;
      return <li className="git-request" key={request.preview.id}><div className="git-request-heading"><strong>{t(request.preview.operation.kind)}</strong><GitStateBadge state={state} /></div>
        <p className="field-hint">{t('requestId', { id: request.preview.id })}</p><p className="field-hint">{t('updated', { date: formatDate(request.updatedAt, true, locale) })} · {t('expires', { date: formatDate(request.preview.expiresAt, true, locale) })}</p>
        {state === 'unknown' && <Notice warning>{t('unknownWarning')}</Notice>}{isRecoverableGitState(state) && request.fenceAcknowledged && <p className="field-hint">{t('acknowledged')}</p>}{state === 'partial' && <Notice warning>{t('partialWarning')}</Notice>}{state === 'stale' && <Notice warning>{t('staleWarning')}</Notice>}
        <ErrorNotice message={request.error ?? ''} />
        <details className="git-request-details"><summary>{t('requestDetails')}</summary><GitReview summary={request.preview.summary} digest={request.preview.digest} expiresAt={request.preview.expiresAt} />
          {request.approval?.approvedBy && <p className="field-hint">{t('approvedBy', { id: request.approval.approvedBy })}</p>}
          {request.approval?.reason && <p className="preserve-lines">{t('reason')}: {request.approval.reason}</p>}
          {request.result && <><p className="field-hint">{t('resultCode', { code: request.result.code })}</p>{request.result.head && <p className="field-hint">{t('resultHead', { head: request.result.head })}</p>}</>}
        </details>
        <div className="device-toolbar">
          {state === 'approved' && <Button icon={Play} variant="primary" disabled={disabled || !canExecute} onClick={() => ask(request, 'execute')}>{t('execute')}</Button>}
          {(state === 'pending' || state === 'approved' || state === 'prepared') && <Button disabled={disabled} onClick={() => ask(request, 'cancel')}>{t('cancel')}</Button>}
          {isRecoverableGitState(state) && !request.fenceAcknowledged && <Button className="git-recovery-inspect" disabled={blocked || action.busy || requests.loading || !canRecover || !!requests.error} onClick={() => { void inspectRecovery(request); }}>{t('inspectUnknown')}</Button>}
          <Button icon={FileClock} disabled={blocked || action.busy} onClick={() => { void readAudit(request); }}>{t('audit')}</Button>
        </div>
      </li>;
    })}</ol>}
    {confirmation && <ConfirmDialog title={t(confirmation.kind === 'execute' ? 'executeTitle' : confirmation.kind === 'cancel' ? 'cancelTitle' : 'acknowledgeTitle')} confirmLabel={t(confirmation.kind === 'execute' ? 'executeConfirm' : confirmation.kind === 'cancel' ? 'cancelConfirm' : 'acknowledgeConfirm')} busy={action.busy} danger={confirmation.kind !== 'execute'} confirmDisabled={!canConfirm || blocked} error={action.error} onClose={() => setConfirmation(null)} onConfirm={() => { void execute(); }}>
      <p className="field-hint">{t('requestId', { id: confirmation.request.preview.id })}</p><GitReview summary={confirmation.request.preview.summary} digest={confirmation.request.preview.digest} expiresAt={confirmation.request.preview.expiresAt} />
      <Notice warning>{t(confirmation.kind === 'execute' ? 'executeWarning' : confirmation.kind === 'cancel' ? 'cancelHint' : confirmation.request.state === 'partial' ? 'partialWarning' : 'unknownWarning')}</Notice>
      {confirmation.kind === 'acknowledge' && <><p>{t('acknowledgeHint')}</p><p>{t('lastChecked', { date: formatDate(confirmation.fresh.snapshot.observedAt, true, locale) })}</p><pre className="safe-object" tabIndex={0}>{JSON.stringify(confirmation.fresh, null, 2)}</pre><label className="check-field"><input type="checkbox" checked={ackChecked} disabled={action.busy} onChange={event => setAckChecked(event.target.checked)} /><span>{t('acknowledgeChecked')}</span></label></>}
    </ConfirmDialog>}
    {audit && <Modal title={t('auditTitle')} description={t('requestId', { id: audit.id })} onClose={() => setAudit(null)}><div className="modal-body">{audit.events.length ? <ol className="git-audit-list">{audit.events.map(event => <li key={event.id}><time dateTime={event.at}>{formatDate(event.at, true, locale)}</time><span>{Object.hasOwn(gitMessages.en, event.state) ? t(event.state as GitMessageKey) : event.state}</span></li>)}</ol> : <p>{t('noAudit')}</p>}</div><footer className="modal-footer"><Button onClick={() => setAudit(null)}>{t('close')}</Button></footer></Modal>}
  </section>;
}
