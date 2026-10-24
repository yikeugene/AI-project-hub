import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { AppObservationPolicy, AppObservationPreview, AppObservationProblem } from '../../shared/app-observation';
import type { DeviceState } from '../../shared/devices';
import { LocalizedError } from '../../shared/i18n';
import { ApiError, appObservationApi } from '../api';
import { isNetworkOnline } from '../device-ui';
import { useAction, type AppObservationController } from '../hooks';
import { useT } from '../i18n';
import { appObservationMessages } from '../locales/app-observation';
import { Button, ConfirmDialog, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';

const problemKeys: Record<Exclude<AppObservationProblem, null>, keyof typeof appObservationMessages.en> = {
  'upgrade-required': 'upgradeRequired', connection: 'connectionProblem', invalid: 'invalidProblem', conflict: 'conflict',
  'collector-unavailable': 'collectorUnavailable', 'session-unavailable': 'sessionUnavailable',
};
const off: AppObservationPolicy = { enabled: false };

/** Describes authorized fields, never a fresh or previously collected name. */
export function AppObservationSharingPreview({ preview }: { preview: AppObservationPreview }) {
  const t = useT(appObservationMessages);
  return <div className="app-observation-preview-fields">
    <p>{t(preview.policy.enabled ? 'previewEnable' : 'previewDisable')}</p>
    <p className="field-hint">{t('fieldsHint')}</p>
    <dl className="status-text-list"><div><dt>name</dt><dd>{t('nameField')}</dd></div><div><dt>observedAt</dt><dd>{t('timeField')}</dd></div></dl>
    <Field label={t('digest')} hint={t('revision', { revision: preview.revision })}><input readOnly value={preview.digest} /></Field>
  </div>;
}

export function AppObservationSettings({ observation, devices, blocked, onDirtyChange, onBusyChange }: {
  observation: AppObservationController; devices: DeviceState; blocked: boolean;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(appObservationMessages);
  const identity = JSON.stringify([devices.profileId, devices.networkId, devices.localDevice.id]);
  const [draftIdentity] = useState(identity);
  const scope = useRef(identity); scope.current = identity;
  const action = useAction(identity);
  const [draft, setDraft] = useState<AppObservationPolicy | null>(null);
  const [preview, setPreview] = useState<{ profileId: string; identity: string; value: AppObservationPreview } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'refreshed' | ''>('');
  const sequence = useRef(0); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const state = observation.state?.profileId === devices.profileId ? observation.state : null;
  const saved = state?.policy ?? off;
  const policy = draft ?? saved;
  const dirty = (!!draft && draft.enabled !== saved.enabled) || !!preview;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  const scoped = draftIdentity === identity && !!devices.profileId && !!state;
  const canEnable = scoped && devices.paired && !devices.pairingPending && !!state.collectorAvailable && !observation.error;
  // Neither OS eligibility, session availability, cloud support nor a paused connection can block withdrawal.
  const canChoose = scoped && (saved.enabled || canEnable);
  const canSave = scoped && (!policy.enabled || canEnable);
  const previewStale = !!preview && (preview.identity !== identity || preview.value.policy.enabled !== policy.enabled || preview.value.revision !== state?.revision);
  // Refresh also checks newly installed channel support and sends pending withdrawals.
  // Only the backend decides whether saved consent and source eligibility permit sampling.
  const canRefresh = scoped && !dirty && !devices.pairingPending && isNetworkOnline(devices);
  const group = devices.groups.find(item => item.id === devices.profileId);
  const invalidate = () => { sequence.current++; setPreview(null); setConfirm(false); setNotice(''); action.setError(null); };
  // Do not forward arbitrary backend diagnostics or application names into error notices.
  const safe = async <T,>(operation: () => Promise<T>) => {
    try { return await operation(); }
    catch (error) { throw new LocalizedError(appObservationMessages, error instanceof ApiError && error.status === 409 ? 'conflict' : 'actionError'); }
  };
  const prepare = async () => {
    if (!canSave || blocked || action.busy) return;
    invalidate(); const current = ++sequence.current; const profileId = devices.profileId!; const captured = identity;
    const result = await action.run(() => safe(() => appObservationApi.previewSharing(profileId, { enabled: policy.enabled })));
    if (result.ok && alive.current && current === sequence.current && scope.current === captured) {
      setDraft(result.value.policy); setPreview({ profileId, identity: captured, value: result.value });
    }
  };
  const save = async () => {
    if (!preview || previewStale || !canSave || blocked || action.busy) return;
    const captured = preview; const current = ++sequence.current;
    const result = await action.run(() => safe(() => observation.update(() => appObservationApi.saveSharing(captured.profileId, captured.value.policy, captured.value.digest))));
    if (!alive.current || current !== sequence.current || scope.current !== captured.identity) return;
    // A digest is never reused after an attempted save, including a lost response.
    setConfirm(false); setPreview(null);
    if (result.ok) { setDraft(null); setNotice('saved'); }
  };
  const refresh = async () => {
    if (!canRefresh || blocked || action.busy) return;
    const profileId = devices.profileId!; const captured = identity; setNotice('');
    const result = await action.run(() => safe(() => observation.update(() => appObservationApi.refresh(profileId))));
    if (result.ok && alive.current && scope.current === captured) setNotice('refreshed');
  };
  return <section className="device-settings-section app-observation-settings" aria-label={t('title')}>
    <SectionHeading title={t('title')} subtitle={t('subtitle')} />
    {group && <p className="field-hint">{t('group', { label: group.label, id: group.id })}</p>}
    <Notice>{t('privacy')}</Notice>
    <label className="check-field"><input type="checkbox" checked={policy.enabled} disabled={!canChoose || blocked || action.busy} onChange={event => { invalidate(); setDraft({ enabled: event.target.checked }); }} /><span>{t('enabled')}</span></label>
    <p className="field-hint">{t('fieldsHint')}</p><p className="field-hint">{t('selfHint')}</p>
    <Notice warning>{t('audience')}</Notice>
    {!devices.profileId || !devices.paired ? <p className="field-hint">{t('noGroup')}</p> : observation.loading && <Loading label={t('loading')} />}
    {state && <>
      {(!state.collectorAvailable || state.problem === 'collector-unavailable') && <Notice warning>{t('collectorUnavailable')}</Notice>}
      {(!state.sessionAvailable || state.problem === 'session-unavailable') && <Notice>{t('sessionUnavailable')}</Notice>}
      {state.capability === 'unsupported' || state.problem === 'upgrade-required' ? <Notice warning>{t('upgradeRequired')}</Notice> : state.capability === 'unknown' && <Notice>{t('capabilityUnknown')}</Notice>}
      {state.problem && !['upgrade-required', 'collector-unavailable', 'session-unavailable'].includes(state.problem) && <Notice warning>{t(problemKeys[state.problem])}</Notice>}
      {state.pendingWithdrawal && <Notice warning>{t('pendingWithdrawal')}</Notice>}
      {!isNetworkOnline(devices) && <p className="field-hint">{t('paused')}</p>}
    </>}
    {observation.error && <><ErrorNotice message={t('readError')} /><Button disabled={blocked || action.busy} onClick={() => { void observation.reload(); }}>{t('retry')}</Button></>}
    <p className="field-hint">{t('withdrawal')}</p>
    <div className="device-toolbar"><Button disabled={!canSave || blocked || action.busy} busy={action.busy} onClick={() => { void prepare(); }}>{t('preview')}</Button>{dirty && <span className="field-hint">{t('unsaved')}</span>}</div>
    {preview && <div className="sharing-preview"><h3>{t('previewTitle')}</h3><AppObservationSharingPreview preview={preview.value} />{previewStale && <Notice warning>{t('conflict')}</Notice>}<Button variant="primary" disabled={!canSave || blocked || action.busy || previewStale} onClick={() => { action.setError(null); setConfirm(true); }}>{t('save')}</Button></div>}
    <div className="device-toolbar"><Button icon={RefreshCw} disabled={!canRefresh || blocked || action.busy} onClick={() => { void refresh(); }}>{t('refresh')}</Button></div><p className="field-hint">{t('refreshHint')}</p>
    {!confirm && <ErrorNotice message={action.error} />}{notice && <p className="inline-success" role="status"><Check size={15} aria-hidden="true" />{t(notice)}</p>}
    {confirm && preview && <ConfirmDialog title={t('confirmTitle')} confirmLabel={t('confirm')} busy={action.busy} confirmDisabled={!canSave || blocked || previewStale} error={action.error} onClose={() => setConfirm(false)} onConfirm={() => { void save(); }}>
      {group && <p>{t('group', { label: group.label, id: group.id })}</p>}<Notice warning>{t('audience')}</Notice><AppObservationSharingPreview preview={preview.value} /><p className="field-hint">{t('withdrawal')}</p>{previewStale && <Notice warning>{t('conflict')}</Notice>}
    </ConfirmDialog>}
  </section>;
}
