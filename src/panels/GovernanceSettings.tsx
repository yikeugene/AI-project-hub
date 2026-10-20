import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DeviceState } from '../../shared/devices';
import type { DeviceRole, StatusSharingPolicy, StatusSharingPreview } from '../../shared/governance';
import type { Project } from '../../shared/types';
import { governanceApi } from '../api';
import { isNetworkOnline } from '../device-ui';
import { canonicalSharing, hasCurrentGovernance } from '../git-ui';
import { useAction, type GovernanceController } from '../hooks';
import { Button, ConfirmDialog, ErrorNotice, Loading, Notice, SectionHeading } from '../components/ui';
import { useT } from '../i18n';
import { governanceMessages } from '../locales/panels-governance';

const emptyPolicy: StatusSharingPolicy = { activity: false, projects: [] };
export function GovernanceSettings({ governance, devices, projects, blocked, onDirtyChange, onBusyChange, onChange }: {
  governance: GovernanceController; devices: DeviceState; projects: Project[]; blocked: boolean;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; onChange: () => Promise<void>;
}) {
  const t = useT(governanceMessages); const action = useAction();
  const [roleChange, setRoleChange] = useState<{ id: string; name: string; role: DeviceRole } | null>(null);
  const [draft, setDraft] = useState<StatusSharingPolicy | null>(null);
  const [preview, setPreview] = useState<{ value: StatusSharingPreview; identities: string } | null>(null);
  const [confirmSharing, setConfirmSharing] = useState(false);
  const [notice, setNotice] = useState<'roleSaved' | 'refreshSaved' | 'saved' | ''>('');
  const sequence = useRef(0); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const saved = governance.state?.sharing ?? emptyPolicy;
  const policy = draft ?? saved;
  const dirty = (!!draft && canonicalSharing(draft) !== canonicalSharing(saved)) || !!preview;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  const verified = hasCurrentGovernance(governance.state, devices) && !governance.error;
  // Local consent must remain editable while offline or an oversized publication is withdrawn.
  const enabled = devices.desktopAvailable && devices.paired && !devices.pairingPending
    && governance.state?.policy?.networkId === devices.networkId
    && governance.state.policy.deviceId === devices.localDevice.id;
  const admin = verified && isNetworkOnline(devices) && governance.state?.policy?.role === 'admin';
  const baseShared = new Set(devices.sharing.filter(item => item.enabled).map(item => item.projectId));
  // Consent binds project identities, not continuously changing task counts or timestamps.
  const identities = JSON.stringify(projects.filter(project => baseShared.has(project.id)).map(project => ({ id: project.id, name: project.name })).sort((a, b) => a.id.localeCompare(b.id)));
  const previewStale = !!preview && (preview.identities !== identities || canonicalSharing(preview.value.policy) !== canonicalSharing(policy));
  const invalidate = () => { sequence.current++; setPreview(null); setConfirmSharing(false); setNotice(''); action.setError(null); };
  const setProjectField = (projectId: string, field: 'git' | 'tasks', value: boolean) => {
    invalidate();
    const existing = policy.projects.find(item => item.projectId === projectId) ?? { projectId, git: false, tasks: false };
    setDraft({ ...policy, projects: [...policy.projects.filter(item => item.projectId !== projectId), { ...existing, [field]: value }].filter(item => item.git || item.tasks) });
  };
  const refresh = async () => {
    const result = await action.run(() => governance.update(governanceApi.refresh));
    if (result.ok && alive.current) setNotice('refreshSaved');
  };
  const saveRole = async () => {
    if (!roleChange || !admin || blocked || action.busy) return;
    const captured = roleChange;
    const result = await action.run(() => governance.update(() => governanceApi.role(captured.id, captured.role)));
    if (!alive.current) return;
    if (result.ok) { setRoleChange(null); setNotice('roleSaved'); await onChange(); }
  };
  const prepareSharing = async () => {
    if (!enabled || blocked || action.busy) return;
    invalidate(); const current = ++sequence.current;
    const captured = { activity: policy.activity, projects: policy.projects.filter(item => baseShared.has(item.projectId) && (item.git || item.tasks)) };
    const result = await action.run(() => governanceApi.previewSharing(captured));
    if (result.ok && alive.current && current === sequence.current) { setDraft(result.value.policy); setPreview({ value: result.value, identities }); }
  };
  const saveSharing = async () => {
    if (!preview || previewStale || !enabled || blocked || action.busy) return;
    const captured = preview.value; const current = ++sequence.current;
    const result = await action.run(() => governance.update(() => governanceApi.saveSharing(captured.policy, captured.digest)));
    if (!alive.current || current !== sequence.current) return;
    setConfirmSharing(false); setPreview(null);
    if (result.ok) { setDraft(null); setNotice('saved'); await onChange(); }
    // Failure leaves the choices intact, but never reuses the consent digest.
  };
  const roles = governance.state?.policy?.roles ?? [];
  const deviceName = (id: string) => id === devices.localDevice.id ? devices.localDevice.name : devices.devices.find(device => device.id === id)?.name ?? id;
  return <>
    <section className="device-settings-section governance-settings">
      <SectionHeading title={t('title')} subtitle={t('subtitle')}><Button icon={RefreshCw} disabled={blocked || action.busy || !isNetworkOnline(devices)} busy={action.busy} onClick={() => { void refresh(); }}>{t('refresh')}</Button></SectionHeading>
      <ErrorNotice message={governance.error || governance.state?.error || ''} />
      {governance.loading ? <Loading label={t('loading')} /> : !verified ? <Notice warning>{t('unavailable')}</Notice> : <>
        <p className="governance-role"><ShieldCheck size={16} aria-hidden="true" /><strong>{t('currentRole', { role: t(governance.state!.policy!.role) })}</strong><span className="field-hint">{t('policyVersion', { epoch: governance.state!.policy!.epoch })}</span></p>
        <ul className="governance-role-list">{roles.map(item => <li key={item.deviceId}><div><strong>{deviceName(item.deviceId)}</strong>{item.deviceId === devices.localDevice.id && <span className="field-hint"> {t('thisDevice')}</span>}<span className="device-id">{item.deviceId}</span></div><span className="badge status-archived"><ShieldCheck size={13} aria-hidden="true" />{t(item.role)}</span><Button disabled={!admin || blocked || action.busy} onClick={() => { action.setError(null); setNotice(''); setRoleChange({ id: item.deviceId, name: deviceName(item.deviceId), role: item.role === 'admin' ? 'member' : 'admin' }); }}>{t(item.role === 'admin' ? 'assignMember' : 'assignAdmin')}</Button></li>)}</ul>
      </>}
      <p className="field-hint">{t('adminOnly')}</p>
    </section>
    <section className="device-settings-section status-sharing-settings">
      <SectionHeading title={t('statusTitle')} subtitle={t('statusSubtitle')} />
      <Notice>{t('privacy')}</Notice>
      <label className="check-field"><input type="checkbox" checked={policy.activity} disabled={!enabled || blocked || action.busy} onChange={event => { invalidate(); setDraft({ ...policy, activity: event.target.checked }); }} /><span>{t('activity')}</span></label><p className="field-hint">{t('activityHint')}</p>
      <h3>{t('projects')}</h3><p className="field-hint">{t('baseShareRequired')}</p>
      {!projects.length ? <p className="quiet-empty">{t('noProjects')}</p> : <ul className="status-project-fields">{projects.map(project => {
        const fields = policy.projects.find(item => item.projectId === project.id);
        const shared = baseShared.has(project.id);
        return <li key={project.id}><div><strong>{project.name}</strong><span className="field-hint">{t(shared ? 'baseShared' : 'baseUnshared')}</span></div><fieldset disabled={!enabled || !shared || blocked || action.busy}><legend className="sr-only">{project.name}</legend><label className="check-field"><input type="checkbox" checked={shared && !!fields?.git} onChange={event => setProjectField(project.id, 'git', event.target.checked)} /><span>{t('git')}</span></label><label className="check-field"><input type="checkbox" checked={shared && !!fields?.tasks} onChange={event => setProjectField(project.id, 'tasks', event.target.checked)} /><span>{t('tasks')}</span></label></fieldset></li>;
      })}</ul>}
      <p className="field-hint">{t('withdrawal')}</p><div className="device-toolbar"><Button disabled={!enabled || blocked || action.busy} busy={action.busy} onClick={() => { void prepareSharing(); }}>{t('preview')}</Button>{dirty && <span className="field-hint">{t('unsaved')}</span>}</div>
      {preview && <div className="sharing-preview"><h3>{t('previewTitle')}</h3><Notice warning>{t('audience')}</Notice><p className="field-hint">{t('previewHint', { bytes: preview.value.bytes })}</p><pre className="safe-object" tabIndex={0} aria-label={t('outgoing')}>{JSON.stringify({ policy: preview.value.policy, publication: preview.value.publication }, null, 2)}</pre>{previewStale && <Notice warning>{t('changed')}</Notice>}<Button variant="primary" disabled={!enabled || blocked || action.busy || previewStale} onClick={() => { action.setError(null); setConfirmSharing(true); }}>{t('save')}</Button></div>}
      {!roleChange && !confirmSharing && <ErrorNotice message={action.error} />}{notice && <p className="inline-success" role="status"><Check size={15} aria-hidden="true" />{t(notice)}</p>}
    </section>
    {roleChange && <ConfirmDialog title={t('roleTitle')} confirmLabel={t('roleConfirm')} busy={action.busy} confirmDisabled={!admin || blocked} error={action.error} onClose={() => setRoleChange(null)} onConfirm={() => { void saveRole(); }}><p>{t('roleDescription', { name: roleChange.name, id: roleChange.id, role: t(roleChange.role) })}</p><Notice warning>{t('roleWarning')}</Notice></ConfirmDialog>}
    {confirmSharing && preview && <ConfirmDialog title={t('confirmTitle')} confirmLabel={t('confirm')} busy={action.busy} confirmDisabled={!enabled || blocked || previewStale} error={action.error} onClose={() => setConfirmSharing(false)} onConfirm={() => { void saveSharing(); }}><p>{t('confirmHint')}</p><Notice warning>{t('audience')}</Notice><pre className="safe-object" tabIndex={0} aria-label={t('outgoing')}>{JSON.stringify({ policy: preview.value.policy, projects: preview.value.publication.projects.map(project => ({ projectId: project.projectId, name: project.name })) }, null, 2)}</pre>{previewStale && <Notice warning>{t('changed')}</Notice>}</ConfirmDialog>}
  </>;
}
