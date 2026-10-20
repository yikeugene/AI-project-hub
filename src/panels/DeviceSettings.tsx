import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Link2, Monitor, Pause, Play, RefreshCw, Save, ShieldCheck, Unplug, UserMinus } from 'lucide-react';
import { MEMORY_FIELDS, getMemoryLabels, type Project } from '../../shared/types';
import type { DeviceRecord, Invitation, MemoryField, PairInput, SharedPreview } from '../../shared/devices';
import { deviceApi, errorMessage } from '../api';
import { canUseNetwork, getConnectionLabels, devicePresence, isNetworkOnline, shortDeviceId } from '../device-ui';
import { copyText, formatDate, useAction, useBeforeUnload, type DeviceController, type GovernanceController } from '../hooks';
import { hasCurrentGovernance } from '../git-ui';
import { GovernanceSettings } from './GovernanceSettings';
import { Button, ConfirmDialog, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';
import { LocalizedError } from '../../shared/i18n';
import { translateError } from '../../shared/messages';
import { useLocale, useT } from '../i18n';
import { deviceMessages } from '../locales/panels-devices';
import { sharingMessages } from '../locales/panels-sharing';

type Confirmation = { kind: 'pair'; input: PairInput } | { kind: 'resume' | 'pause' | 'disconnect' } | { kind: 'revoke'; device: DeviceRecord };
export function DeviceSettings({ devices, governance, projects, onDirtyChange, onBusyChange }: { devices: DeviceController; governance?: GovernanceController; projects: Project[]; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const locale = useLocale(); const t = useT(deviceMessages); const connectionLabels = getConnectionLabels(locale);
  const { state, update } = devices;
  const [name, setName] = useState(state?.localDevice.name ?? '');
  const [originalName, setOriginalName] = useState(state?.localDevice.name ?? '');
  const [url, setUrl] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<keyof typeof deviceMessages.en | ''>('');
  const [sharingDirty, setSharingDirty] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [governanceDirty, setGovernanceDirty] = useState(false);
  const [governanceBusy, setGovernanceBusy] = useState(false);
  const action = useAction();
  const nameAction = useAction();
  const copyAction = useAction();
  const nameDirty = name !== originalName;
  const dirty = nameDirty || !!url || !!publishableKey || !!code || sharingDirty || governanceDirty;
  const busy = action.busy || nameAction.busy || copyAction.busy || sharingBusy || governanceBusy;
  useBeforeUnload(dirty || busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (state && !nameDirty) { setName(state.localDevice.name); setOriginalName(state.localDevice.name); }
  }, [state?.localDevice.name, nameDirty]);
  useEffect(() => { setInvitation(null); setCopied(false); }, [state?.networkId]);
  useEffect(() => {
    if (!invitation) return;
    const remaining = Date.parse(invitation.expiresAt) - Date.now();
    const timer = window.setTimeout(() => { setInvitation(null); setCopied(false); setMessage('invitationExpired'); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [invitation]);
  if (!state) return <section className="panel device-settings"><SectionHeading title={t('title')} subtitle={t('unavailableSubtitle')} /><ErrorNotice message={devices.error} />{devices.loading ? <Loading label={t('loading')} /> : <Button onClick={() => { void devices.reload(); }}>{t('retry')}</Button>}</section>;
  const online = isNetworkOnline(state);
  const admin = hasCurrentGovernance(governance?.state, state) && !governance?.error && governance?.state?.policy?.role === 'admin';
  const enabledControls = state.desktopAvailable && !busy;
  const execute = async () => {
    if (!confirmation || busy) return;
    const captured = confirmation;
    const result = await action.run(() => update(() => {
      switch (captured.kind) {
        case 'pair': return deviceApi.pair(captured.input);
        case 'resume': return deviceApi.connection(true);
        case 'pause': return deviceApi.connection(false);
        case 'disconnect': return deviceApi.disconnect();
        case 'revoke': return deviceApi.revoke(captured.device.id);
      }
    }));
    if (result.ok) {
      if (captured.kind === 'pair') { setUrl(''); setPublishableKey(''); setCode(''); setOriginalName(result.value.localDevice.name); setName(result.value.localDevice.name); }
      if (captured.kind === 'disconnect' || captured.kind === 'pause') setInvitation(null);
      setConfirmation(null);
      setMessage(captured.kind === 'disconnect' ? 'disconnected' : captured.kind === 'pause' ? 'paused' : captured.kind === 'pair' ? 'paired' : captured.kind === 'revoke' ? 'deviceRevoked' : 'resumed');
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    const result = await nameAction.run(() => update(() => deviceApi.rename(name.trim())));
    if (result.ok) { setOriginalName(result.value.localDevice.name); setName(result.value.localDevice.name); setMessage('nameSaved'); }
  };
  const askPair = (event: FormEvent) => {
    event.preventDefault(); action.setError('');
    setConfirmation({ kind: 'pair', input: { url: url.trim(), publishableKey: publishableKey.trim(), name: name.trim(), code: code.trim(), confirm: true } });
  };
  const ask = (value: Confirmation) => { action.setError(''); setMessage(''); setConfirmation(value); };
  return <section className="panel device-settings" aria-label={t('settingsLabel')}>
    <SectionHeading title={t('title')} subtitle={t('subtitle')}><span className="badge status-archived">{!state.paired && !state.enabled ? t('defaultOff') : connectionLabels[state.connection]}</span></SectionHeading>
    <ErrorNotice message={devices.error} />
    {!state.desktopAvailable && <Notice warning>{t('unavailable')}</Notice>}
    <div className="device-settings-grid"><form className="device-name-form form-stack" onSubmit={event => { void rename(event); }} aria-label={t('nameFormLabel')}><Field label={t('nameLabel')} hint={t('nameHint')} required><input required maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field><span className="device-id">{t('deviceId', { id: state.localDevice.id })}</span><div><Button type="submit" icon={Save} busy={nameAction.busy} disabled={!nameDirty || !name.trim() || busy}>{t('saveName')}</Button></div><ErrorNotice message={nameAction.error} /></form>
      <div className="device-connection"><h3><ShieldCheck size={17} />{t('connectionTitle')}</h3><p>{t('connectionDescription')}</p><p>{t('transportBefore')}<strong>{t('notE2E')}</strong>{t('transportAfter')}</p></div></div>
    {state.paired ? <div className="device-settings-section"><SectionHeading title={t('networkTitle')} subtitle={state.configuration?.url ?? t('savedPairing')} /><div className="device-toolbar"><span className="connection-label">{connectionLabels[state.connection]}</span><Button icon={state.enabled ? Pause : Play} disabled={!enabledControls || (!state.enabled && !canUseNetwork(state))} onClick={() => ask({ kind: state.enabled ? 'pause' : 'resume' })}>{state.enabled ? t('pause') : t('resume')}</Button><Button icon={RefreshCw} disabled={!enabledControls || !state.enabled || !canUseNetwork(state)} busy={action.busy} onClick={() => { setMessage(''); void action.run(() => update(deviceApi.sync)); }}>{t('sync')}</Button><Button icon={Unplug} disabled={!enabledControls} onClick={() => ask({ kind: 'disconnect' })}>{t('disconnect')}</Button></div><p className="field-hint">{t('lastSync', { date: formatDate(state.lastSyncAt, true, locale), count: state.queuedCount })}</p><ErrorNotice message={state.lastError ?? ''} />
      <div className="paired-devices">{state.devices.filter(device => device.id !== state.localDevice.id).map(device => <div className="paired-device" key={device.id}><Monitor size={18} /><div><strong>{device.name}</strong><span className="device-id" title={device.id}>{shortDeviceId(device.id)} · {devicePresence(device, undefined, locale)}</span><small>{t('lastSeen', { date: formatDate(device.lastSeenAt, true, locale) })}</small></div><Button icon={UserMinus} disabled={!online || !admin || busy || !!device.revokedAt} onClick={() => ask({ kind: 'revoke', device })}>{device.revokedAt ? t('revoked') : t('revoke')}</Button></div>)}</div>
      <div className="device-toolbar"><Button icon={Link2} disabled={!online || busy} onClick={() => { setCopied(false); void action.run(async () => { setInvitation(await deviceApi.invitation()); }); }}>{t('createInvitation')}</Button><span className="field-hint">{t('invitationHint')}</span></div>
      {invitation && <div className="invitation-panel"><h3>{t('inviteTitle')}</h3><p className="field-hint">{t('invitationExpiry', { date: formatDate(invitation.expiresAt, true, locale) })}</p><dl><div><dt>{t('projectUrl')}</dt><dd>{invitation.url}</dd></div><div><dt>{t('publishableKey')}</dt><dd>{invitation.publishableKey}</dd></div><div><dt>{t('pairingCode')}</dt><dd className="invitation-code">{invitation.code}</dd></div></dl><div className="device-toolbar"><Button icon={copied ? Check : Copy} busy={copyAction.busy} onClick={() => { void copyAction.run(async () => { await copyText(t('invitationClipboard', { url: invitation.url, key: invitation.publishableKey, code: invitation.code, date: formatDate(invitation.expiresAt, true, locale) })); setCopied(true); }); }}>{copied ? t('invitationCopied') : t('copyInvitation')}</Button><Button onClick={() => { setInvitation(null); setCopied(false); }} disabled={busy}>{t('hideInvitation')}</Button></div><ErrorNotice message={copyAction.error} /></div>}
    </div> : <div className="device-settings-section"><SectionHeading title={t('pairTitle')} subtitle={t('pairSubtitle')} />
      {state.pairingPending ? <div><Notice warning>{t('pairingPending')}</Notice><div className="device-toolbar"><Button icon={RefreshCw} busy={action.busy} disabled={!enabledControls} onClick={() => { void action.run(async () => { const result = await update(deviceApi.retryPair); if (result.paired) { setUrl(''); setPublishableKey(''); setCode(''); setMessage('pairRecovered'); } }); }}>{t('retryPair')}</Button><Button disabled={!enabledControls} onClick={() => ask({ kind: 'disconnect' })}>{t('discardPair')}</Button></div></div> : <form className="pairing-form form-stack" aria-label={t('pairingLabel')} onSubmit={askPair}><div className="form-grid"><Field label={t('supabaseUrl')} required hint={t('supabaseHint')}><input type="url" required maxLength={250} placeholder="https://your-project.supabase.co" value={url} disabled={!enabledControls} onChange={event => setUrl(event.target.value)} autoComplete="off" spellCheck={false} /></Field><Field label={t('publishableKey')} required hint={t('keyHint')}><input required type="password" minLength={20} maxLength={2048} value={publishableKey} disabled={!enabledControls} onChange={event => setPublishableKey(event.target.value)} autoComplete="off" spellCheck={false} /></Field></div><Field label={t('pairingCode')} required hint={t('codeHint')}><input required type="password" pattern="[a-f0-9]{64}" minLength={64} maxLength={64} value={code} disabled={!enabledControls} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} /></Field><div><Button type="submit" icon={Link2} disabled={!enabledControls || !name.trim()}>{t('checkPair')}</Button></div></form>}
    </div>}
    {!confirmation && <ErrorNotice message={action.error} />}{message && <p className="inline-success" role="status"><Check size={15} />{t(message)}</p>}
    <SharingSettings key={state.networkId ?? 'unpaired'} projects={projects} enabled={canUseNetwork(state)} blocked={action.busy || nameAction.busy || copyAction.busy || governanceBusy} onDirtyChange={setSharingDirty} onBusyChange={setSharingBusy} onChange={devices.reload} />
    {governance && <GovernanceSettings key={`governance:${state.networkId ?? 'unpaired'}`} governance={governance} devices={state} projects={projects} blocked={action.busy || nameAction.busy || copyAction.busy || sharingBusy} onDirtyChange={setGovernanceDirty} onBusyChange={setGovernanceBusy} onChange={devices.reload} />}
    {confirmation && <ConfirmDialog title={confirmation.kind === 'pair' ? t('pairConfirmTitle') : confirmation.kind === 'resume' ? t('resumeConfirmTitle') : confirmation.kind === 'pause' ? t('pauseConfirmTitle') : confirmation.kind === 'disconnect' ? t('disconnectConfirmTitle') : t('revokeConfirmTitle')} confirmLabel={confirmation.kind === 'pair' ? t('pairConfirm') : confirmation.kind === 'resume' ? t('resumeConfirm') : confirmation.kind === 'pause' ? t('pauseConfirm') : confirmation.kind === 'disconnect' ? t('disconnectConfirm') : t('revokeConfirm')} danger={confirmation.kind === 'disconnect' || confirmation.kind === 'revoke'} busy={action.busy} error={action.error} confirmDisabled={!state.desktopAvailable || (confirmation.kind === 'revoke' && (!online || !admin))} onClose={() => setConfirmation(null)} onConfirm={() => { void execute(); }}>
      {confirmation.kind === 'pair' && <><p>{t('pairBeforeName')}<strong>{confirmation.input.name}</strong>{t('pairBeforeUrl')}<span className="preserve-lines">{confirmation.input.url}</span>{t('pairAfterUrl')}</p><p>{t('pairBeforeAudience')}<strong>{t('allDevices')}</strong>{t('pairAfterAudience')}</p></>}
      {confirmation.kind === 'resume' && <p>{t('resumeDescription')}</p>}
      {(confirmation.kind === 'pair' || confirmation.kind === 'resume') && <Notice warning>{t('connectionWarning')}</Notice>}
      {confirmation.kind === 'pause' && <p>{t('pauseDescription')}</p>}
      {confirmation.kind === 'disconnect' && <><p>{t('disconnectDescription')}</p><Notice warning>{t('disconnectWarning')}</Notice></>}
      {confirmation.kind === 'revoke' && <><p>{t('revokeBeforeName')}<strong>{confirmation.device.name}</strong>{t('revokeAfterName', { id: confirmation.device.id })}</p><Notice warning>{t('revokeWarning')}</Notice></>}
    </ConfirmDialog>}
  </section>;
}

function SharingSettings({ projects, enabled, blocked, onDirtyChange, onBusyChange, onChange }: { projects: Project[]; enabled: boolean; blocked: boolean; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; onChange: () => Promise<void> }) {
  const locale = useLocale(); const t = useT(sharingMessages); const memoryLabels = getMemoryLabels(locale);
  const previewError = (snapshot: SharedPreview) => snapshot.errorCode ? translateError(snapshot.errorCode, locale, snapshot.errorParams) : snapshot.error ?? '';
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [current, setCurrent] = useState<SharedPreview | null>(null);
  const [share, setShare] = useState(false);
  const [fields, setFields] = useState<MemoryField[]>([]);
  const [preview, setPreview] = useState<SharedPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [readVersion, setReadVersion] = useState(0);
  const action = useAction();
  const sequence = useRef(0);
  const project = projects.find(item => item.id === projectId);
  const dirty = !!current && (share !== current.policy.enabled || JSON.stringify(fields) !== JSON.stringify(MEMORY_FIELDS.filter(field => current.policy.memoryFields.includes(field))));
  const busy = readBusy || action.busy;
  const stale = !!preview?.project && preview.project.revision !== project?.revision;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    const requestId = ++sequence.current;
    setCurrent(null); setPreview(null); setConfirm(false); setShare(false); setFields([]); setSaved(false); setReadError(null); setReadBusy(!!projectId);
    if (projectId) void deviceApi.sharing(projectId).then(result => {
      if (requestId === sequence.current) { setCurrent(result); setShare(result.policy.enabled); setFields(MEMORY_FIELDS.filter(field => result.policy.memoryFields.includes(field))); }
    }).catch(error => { if (requestId === sequence.current) setReadError(error); }).finally(() => { if (requestId === sequence.current) setReadBusy(false); });
    return () => { sequence.current++; };
  }, [projectId, readVersion]);
  const invalidate = () => { setPreview(null); setConfirm(false); setSaved(false); action.setError(''); };
  const select = (id: string) => { if (blocked || busy) return; if (dirty) setPendingId(id); else setProjectId(id); };
  const fetchPreview = async () => {
    setPreview(null); setSaved(false);
    const result = await action.run(() => deviceApi.previewSharing(projectId, { enabled: share, memoryFields: fields }));
    if (result.ok) setPreview(result.value);
  };
  const save = async () => {
    const captured = preview;
    if (!captured || !enabled || stale || captured.error) return;
    await action.run(async () => {
      const policy = { enabled: captured.policy.enabled, memoryFields: captured.policy.memoryFields };
      const latest = await deviceApi.previewSharing(projectId, policy);
      if (JSON.stringify(latest) !== JSON.stringify(captured)) { setPreview(latest); setConfirm(false); throw new LocalizedError(sharingMessages, 'changed'); }
      const result = await deviceApi.saveSharing(projectId, policy);
      setCurrent(result); setShare(result.policy.enabled); setFields(MEMORY_FIELDS.filter(field => result.policy.memoryFields.includes(field))); setPreview(null); setConfirm(false); setSaved(true);
      await onChange();
    });
  };
  return <section className="device-settings-section sharing-settings" aria-label={t('label')}><SectionHeading title={t('title')} subtitle={t('subtitle')} />
    {!enabled && <p className="field-hint">{t('disabled')}</p>}
    {!projects.length ? <p className="quiet-empty">{t('noProjects')}</p> : <><Field label={t('projectLabel')}><select value={project ? projectId : ''} disabled={busy || blocked} onChange={event => select(event.target.value)}><option value="" disabled>{t('chooseProject')}</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><ErrorNotice message={errorMessage(readError, locale)} />{!!readError && <Button disabled={busy || blocked} onClick={() => setReadVersion(value => value + 1)}>{t('retry')}</Button>}
      {readBusy ? <Loading label={t('loading')} /> : current && project && <><div className="sharing-policy"><label className="check-field"><input type="checkbox" checked={share} disabled={!enabled || blocked || busy} onChange={event => { invalidate(); setShare(event.target.checked); }} /><span>{t('shareProject')}</span></label><p className="field-hint">{t('summaryHint')}</p><fieldset className="memory-share-fields" disabled={!enabled || !share || blocked || busy}><legend>{t('memoryLegend')}</legend>{MEMORY_FIELDS.map(field => <label className="check-field" key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => { invalidate(); setFields(MEMORY_FIELDS.filter(key => key === field ? event.target.checked : fields.includes(key))); }} /><span>{memoryLabels[field]}</span></label>)}</fieldset></div>
      {current.error && <Notice warning>{previewError(current)}{' '}{t('errorHint')}</Notice>}
      <details className="current-sharing"><summary>{t('savedPolicy', { status: current.policy.enabled ? t('shared') : t('unshared') })}</summary><p className="field-hint">{t('currentHint', { bytes: current.bytes })}</p><pre className="safe-object" tabIndex={0} aria-label={t('currentLabel')}>{JSON.stringify(current.project, null, 2)}</pre></details>
      <div className="device-toolbar"><Button disabled={!enabled || blocked || busy} busy={action.busy} onClick={() => { void fetchPreview(); }}>{t('preview')}</Button><span className="field-hint">{dirty ? t('unsaved') : t('confirmationRequired')}</span></div>
      {preview && <div className="sharing-preview">{preview.error && <Notice warning>{previewError(preview)}</Notice>}<h3>{preview.policy.enabled ? t('previewTitle') : t('stopTitle')}</h3><p>{t('audience')}<strong>{t('allDevices')}</strong></p><p className="field-hint">{t('previewHint', { bytes: preview.bytes })}</p><pre className="safe-object" tabIndex={0} aria-label={t('previewLabel')}>{JSON.stringify(preview.project, null, 2)}</pre>{!preview.policy.enabled && <Notice warning>{t('withdrawWarning')}</Notice>}{stale && <Notice warning>{t('stale')}</Notice>}<Button variant="primary" disabled={!enabled || busy || blocked || stale || !!preview.error} onClick={() => { action.setError(''); setConfirm(true); }}>{t('confirm')}</Button></div>}
      {saved && <p className="inline-success" role="status"><Check size={15} />{t('saved')}</p>}</>}
    </>}{!confirm && <ErrorNotice message={action.error} />}
    {confirm && preview && <ConfirmDialog title={preview.policy.enabled ? t('shareConfirmTitle') : t('stopConfirmTitle')} confirmLabel={preview.policy.enabled ? t('shareConfirm') : t('stopConfirm')} danger={!preview.policy.enabled} busy={action.busy} confirmDisabled={!enabled || stale || !!preview.error} error={action.error} onClose={() => setConfirm(false)} onConfirm={() => { void save(); }}><p><strong>{project?.name}</strong>{preview.policy.enabled ? t('shareDescription') : t('stopDescription')}</p><Notice warning>{t('warning')}</Notice></ConfirmDialog>}
    {pendingId && <ConfirmDialog title={t('unsaved')} confirmLabel={t('switchConfirm')} danger onClose={() => setPendingId(null)} onConfirm={() => { setProjectId(pendingId); setPendingId(null); }}><p>{t('switchDescription')}</p></ConfirmDialog>}
  </section>;
}
