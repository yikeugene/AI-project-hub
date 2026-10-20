import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Link2, Monitor, Pause, Play, RefreshCw, Save, ShieldCheck, Unplug, UserMinus } from 'lucide-react';
import type { Project } from '../../shared/types';
import type { DeviceGroup, DeviceRecord, Invitation, PairInput } from '../../shared/devices';
import { deviceApi } from '../api';
import { canSyncGroup, getConnectionLabels, devicePresence, isNetworkOnline, shortDeviceId } from '../device-ui';
import { copyText, formatDate, useAction, useBeforeUnload, type DeviceController, type GovernanceController } from '../hooks';
import { hasCurrentGovernance } from '../git-ui';
import { GovernanceSettings } from './GovernanceSettings';
import { GroupSharingSettings } from './GroupSharingSettings';
import { Button, ConfirmDialog, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { deviceMessages } from '../locales/panels-devices';
import { groupMessages } from '../locales/panels-groups';

type Confirmation = { kind: 'pair'; input: PairInput } | { kind: 'resume' | 'pause' | 'disconnect'; group: DeviceGroup } | { kind: 'revoke'; group: DeviceGroup; device: DeviceRecord };
export function DeviceSettings({ devices, governance, projects, onDirtyChange, onBusyChange }: { devices: DeviceController; governance?: GovernanceController; projects: Project[]; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const locale = useLocale(); const t = useT(deviceMessages); const g = useT(groupMessages); const connectionLabels = getConnectionLabels(locale);
  const { state, update } = devices;
  const [name, setName] = useState(state?.localDevice.name ?? '');
  const [originalName, setOriginalName] = useState(state?.localDevice.name ?? '');
  const [url, setUrl] = useState(''); const [publishableKey, setPublishableKey] = useState(''); const [code, setCode] = useState(''); const [joinLabel, setJoinLabel] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pendingGroup, setPendingGroup] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [invitation, setInvitation] = useState<{ profileId: string; value: Invitation } | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<keyof typeof deviceMessages.en | ''>('');
  const [labelSaved, setLabelSaved] = useState(false);
  const [sharingDirty, setSharingDirty] = useState(false); const [sharingBusy, setSharingBusy] = useState(false);
  const [governanceDirty, setGovernanceDirty] = useState(false); const [governanceBusy, setGovernanceBusy] = useState(false);
  const action = useAction(); const nameAction = useAction(); const copyAction = useAction();
  const profileRef = useRef(state?.profileId); profileRef.current = state?.profileId;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const nameDirty = name !== originalName;
  const labelsDirty = (state?.groups ?? []).some(group => labels[group.id] !== undefined && labels[group.id] !== group.label);
  const dirty = nameDirty || labelsDirty || !!url || !!publishableKey || !!code || !!joinLabel || sharingDirty || governanceDirty;
  const busy = action.busy || nameAction.busy || copyAction.busy || sharingBusy || governanceBusy;
  useBeforeUnload(dirty || busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (state && !nameDirty) { setName(state.localDevice.name); setOriginalName(state.localDevice.name); } }, [state?.localDevice.name, nameDirty]);
  useEffect(() => { setInvitation(null); setCopied(false); setConfirmation(null); }, [state?.profileId]);
  useEffect(() => {
    if (!invitation) return;
    const remaining = Date.parse(invitation.value.expiresAt) - Date.now();
    const timer = window.setTimeout(() => { setInvitation(null); setCopied(false); setMessage('invitationExpired'); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [invitation]);
  if (!state) return <section className="panel device-settings"><SectionHeading title={t('title')} subtitle={t('unavailableSubtitle')} /><ErrorNotice message={devices.error} />{devices.loading ? <Loading label={t('loading')} /> : <Button onClick={() => { void devices.reload(); }}>{t('retry')}</Button>}</section>;
  const selectedGroup = state.groups.find(group => group.id === state.profileId);
  const online = isNetworkOnline(state);
  const admin = hasCurrentGovernance(governance?.state, state) && !governance?.error && governance?.state?.policy?.role === 'admin';
  const enabledControls = state.desktopAvailable && !busy;
  const mutationBlocked = sharingDirty || governanceDirty;
  const clearDrafts = () => { setUrl(''); setPublishableKey(''); setCode(''); setJoinLabel(''); setLabels({}); setName(state.localDevice.name); setOriginalName(state.localDevice.name); setSharingDirty(false); setGovernanceDirty(false); setDraftVersion(value => value + 1); };
  const selectGroup = async (profileId: string, discard = false) => {
    if (busy || !state.groups.some(group => group.id === profileId)) return;
    const result = await action.run(() => update(() => deviceApi.selectGroup(profileId)));
    if (result.ok && alive.current) { if (discard) clearDrafts(); setPendingGroup(null); setMessage(''); setLabelSaved(false); }
  };
  const askGroup = (profileId: string) => { if (busy || profileId === state.profileId) return; action.setError(null); if (dirty) setPendingGroup(profileId); else void selectGroup(profileId); };
  const execute = async () => {
    if (!confirmation || busy) return;
    const captured = confirmation;
    if (captured.kind !== 'pair' && !state.groups.some(group => group.id === captured.group.id)) return;
    const result = await action.run(() => update(() => {
      switch (captured.kind) {
        case 'pair': return deviceApi.pair(captured.input);
        case 'resume': return deviceApi.connection(captured.group.id, true);
        case 'pause': return deviceApi.connection(captured.group.id, false);
        case 'disconnect': return deviceApi.disconnect(captured.group.id);
        case 'revoke': return deviceApi.revoke(captured.group.id, captured.device.id);
      }
    }));
    if (result.ok && alive.current) {
      if (captured.kind === 'pair') { setUrl(''); setPublishableKey(''); setCode(''); setJoinLabel(''); setDraftVersion(value => value + 1); }
      if (captured.kind === 'disconnect' || captured.kind === 'pause') setInvitation(null);
      setConfirmation(null); setLabelSaved(false);
      setMessage(captured.kind === 'disconnect' ? 'disconnected' : captured.kind === 'pause' ? 'paused' : captured.kind === 'pair' ? 'paired' : captured.kind === 'revoke' ? 'deviceRevoked' : 'resumed');
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    const result = await nameAction.run(() => update(() => deviceApi.rename(name.trim())));
    if (result.ok && alive.current) { setOriginalName(result.value.localDevice.name); setName(result.value.localDevice.name); setMessage('nameSaved'); }
  };
  const askPair = (event: FormEvent) => {
    event.preventDefault(); if (!enabledControls || mutationBlocked) return; action.setError(null);
    // Pairing never implicitly saves a dirty device-name draft or renames existing memberships.
    setConfirmation({ kind: 'pair', input: { url: url.trim(), publishableKey: publishableKey.trim(), name: state.localDevice.name, code: code.trim(), ...(joinLabel.trim() ? { label: joinLabel.trim() } : {}), confirm: true } });
  };
  const ask = (value: Confirmation) => { action.setError(null); setMessage(''); setLabelSaved(false); setConfirmation(value); };
  const invite = async () => {
    if (!selectedGroup || !online || busy) return;
    const profileId = selectedGroup.id; setCopied(false);
    const result = await action.run(() => deviceApi.invitation(profileId));
    if (result.ok && alive.current && profileRef.current === profileId) setInvitation({ profileId, value: result.value });
  };
  const visibleInvitation = invitation?.profileId === state.profileId ? invitation.value : null;
  return <section className="panel device-settings" aria-label={t('settingsLabel')}>
    <SectionHeading title={t('title')} subtitle={t('subtitle')}><span className="badge status-archived">{!state.paired && !state.enabled ? t('defaultOff') : connectionLabels[state.connection]}</span></SectionHeading>
    <ErrorNotice message={devices.error} />{!state.desktopAvailable && <Notice warning>{t('unavailable')}</Notice>}
    <div className="device-settings-grid"><form className="device-name-form form-stack" onSubmit={event => { void rename(event); }} aria-label={t('nameFormLabel')}><Field label={t('nameLabel')} hint={t('nameHint')} required><input required maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field><span className="device-id">{t('deviceId', { id: state.installationId })}</span><div><Button type="submit" icon={Save} busy={nameAction.busy} disabled={!nameDirty || !name.trim() || busy}>{t('saveName')}</Button></div><ErrorNotice message={nameAction.error} /></form><div className="device-connection"><h3><ShieldCheck size={17} />{t('connectionTitle')}</h3><p>{t('connectionDescription')}</p><p>{t('transportBefore')}<strong>{t('notE2E')}</strong>{t('transportAfter')}</p></div></div>
    <section className="device-settings-section group-management"><SectionHeading title={g('title')} subtitle={g('subtitle')} />
      {!state.groups.length ? <p className="quiet-empty">{g('none')}</p> : <><Field label={g('management')}><select value={state.profileId ?? ''} disabled={busy} onChange={event => askGroup(event.target.value)}>{!state.profileId && <option value="" disabled>{g('management')}</option>}{state.groups.map(group => <option key={group.id} value={group.id}>{group.label} ({shortDeviceId(group.id)})</option>)}</select></Field><ul className="joined-groups">{state.groups.map(group => <li key={group.id} className={`joined-group ${group.id === state.profileId ? 'selected' : ''}`}>
        <div className="joined-group-heading"><strong>{group.label}</strong><span className="badge status-archived">{group.pairingPending ? g('pending') : connectionLabels[group.connection]}</span><Button disabled={busy || group.id === state.profileId} onClick={() => askGroup(group.id)}>{g(group.id === state.profileId ? 'managed' : 'manage')}</Button></div>
        <p className="device-id">{g('identity', { id: group.id })}<br />{g('membership', { id: group.deviceId })}<br />{group.url}</p>
        <form className="group-label-form" onSubmit={event => { event.preventDefault(); const value = (labels[group.id] ?? group.label).trim(); if (!value || busy) return; setLabelSaved(false); void action.run(async () => { await update(() => deviceApi.labelGroup(group.id, value)); if (alive.current) { setLabels(previous => { const next = { ...previous }; delete next[group.id]; return next; }); setLabelSaved(true); } }); }}><Field label={g('label')} hint={g('labelHint')}><input required maxLength={120} value={labels[group.id] ?? group.label} disabled={busy} onChange={event => setLabels(previous => ({ ...previous, [group.id]: event.target.value }))} /></Field><Button type="submit" icon={Save} disabled={busy || !labels[group.id]?.trim() || labels[group.id] === group.label}>{g('saveLabel')}</Button></form>
        <div className="device-toolbar">{group.pairingPending ? <Button icon={RefreshCw} disabled={!enabledControls || mutationBlocked} onClick={() => { void action.run(async () => { const result = await update(() => deviceApi.retryPair(group.id)); if (result.paired && alive.current) { setMessage('pairRecovered'); setDraftVersion(value => value + 1); } }); }}>{t('retryPair')}</Button> : <><Button icon={group.enabled ? Pause : Play} disabled={!enabledControls || !group.paired || group.connection === 'revoked' || group.connection === 'locked'} onClick={() => ask({ kind: group.enabled ? 'pause' : 'resume', group })}>{t(group.enabled ? 'pause' : 'resume')}</Button><Button icon={RefreshCw} disabled={!enabledControls || !canSyncGroup(group)} onClick={() => { void action.run(() => update(() => deviceApi.sync(group.id))); }}>{t('sync')}</Button></>}<Button icon={Unplug} disabled={!enabledControls || mutationBlocked} onClick={() => ask({ kind: 'disconnect', group })}>{t(group.pairingPending ? 'discardPair' : 'disconnect')}</Button></div>
        {group.pairingPending && <Notice warning>{t('pairingPending')}</Notice>}<p className="field-hint">{g('lastSync', { date: formatDate(group.lastSyncAt, true, locale) })}</p><ErrorNotice message={group.lastError ?? ''} />
      </li>)}</ul></>}
    </section>
    {selectedGroup && state.paired && <section className="device-settings-section"><SectionHeading title={t('networkTitle')} subtitle={g('groupContext', { label: selectedGroup.label, id: selectedGroup.id })} /><p className="field-hint">{t('lastSync', { date: formatDate(state.lastSyncAt, true, locale), count: state.queuedCount })}</p>
      <div className="paired-devices">{state.devices.filter(device => device.id !== state.localDevice.id).map(device => <div className="paired-device" key={device.id}><Monitor size={18} /><div><strong>{device.name}</strong><span className="device-id" title={device.id}>{shortDeviceId(device.id)} · {devicePresence(device, undefined, locale)}</span><small>{t('lastSeen', { date: formatDate(device.lastSeenAt, true, locale) })}</small></div><Button icon={UserMinus} disabled={!online || !admin || busy || !!device.revokedAt} onClick={() => ask({ kind: 'revoke', group: selectedGroup, device })}>{t(device.revokedAt ? 'revoked' : 'revoke')}</Button></div>)}</div>
      <div className="device-toolbar"><Button icon={Link2} disabled={!online || busy} onClick={() => { void invite(); }}>{t('createInvitation')}</Button><span className="field-hint">{t('invitationHint')}</span></div>
      {visibleInvitation && <div className="invitation-panel"><h3>{t('inviteTitle')}</h3><p className="field-hint">{t('invitationExpiry', { date: formatDate(visibleInvitation.expiresAt, true, locale) })}</p><dl><div><dt>{t('projectUrl')}</dt><dd>{visibleInvitation.url}</dd></div><div><dt>{t('publishableKey')}</dt><dd>{visibleInvitation.publishableKey}</dd></div><div><dt>{t('pairingCode')}</dt><dd className="invitation-code">{visibleInvitation.code}</dd></div></dl><div className="device-toolbar"><Button icon={copied ? Check : Copy} busy={copyAction.busy} disabled={busy} onClick={() => { const captured = visibleInvitation; void copyAction.run(async () => { await copyText(t('invitationClipboard', { url: captured.url, key: captured.publishableKey, code: captured.code, date: formatDate(captured.expiresAt, true, locale) })); if (alive.current) setCopied(true); }); }}>{t(copied ? 'invitationCopied' : 'copyInvitation')}</Button><Button disabled={busy} onClick={() => { setInvitation(null); setCopied(false); }}>{t('hideInvitation')}</Button></div><ErrorNotice message={copyAction.error} /></div>}
    </section>}
    <section className="device-settings-section"><SectionHeading title={g(state.groups.length ? 'join' : 'joinFirst')} subtitle={t('pairSubtitle')} /><p className="field-hint">{g('joinHint')}</p>{mutationBlocked && <Notice>{g('joinBlocked')}</Notice>}
      <form className="pairing-form form-stack" aria-label={t('pairingLabel')} onSubmit={askPair}><Field label={g('joinLabel')} hint={g('joinLabelHint')}><input maxLength={120} value={joinLabel} disabled={!enabledControls} onChange={event => setJoinLabel(event.target.value)} /></Field><div className="form-grid"><Field label={t('supabaseUrl')} required hint={t('supabaseHint')}><input type="url" required maxLength={250} placeholder="https://your-project.supabase.co" value={url} disabled={!enabledControls} onChange={event => setUrl(event.target.value)} autoComplete="off" spellCheck={false} /></Field><Field label={t('publishableKey')} required hint={t('keyHint')}><input required type="password" minLength={20} maxLength={2048} value={publishableKey} disabled={!enabledControls} onChange={event => setPublishableKey(event.target.value)} autoComplete="off" spellCheck={false} /></Field></div><Field label={t('pairingCode')} required hint={t('codeHint')}><input required type="password" pattern="[a-f0-9]{64}" minLength={64} maxLength={64} value={code} disabled={!enabledControls} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} /></Field><div><Button type="submit" icon={Link2} disabled={!enabledControls || mutationBlocked}>{t('checkPair')}</Button></div></form>
    </section>
    {!confirmation && !pendingGroup && <ErrorNotice message={action.error} />}{message && <p className="inline-success" role="status"><Check size={15} />{t(message)}</p>}{labelSaved && <p className="inline-success" role="status"><Check size={15} />{g('labelSaved')}</p>}
    <GroupSharingSettings key={`sharing:${draftVersion}`} projects={projects} groups={state.groups} enabled={state.desktopAvailable} blocked={action.busy || nameAction.busy || copyAction.busy || governanceBusy} onDirtyChange={setSharingDirty} onBusyChange={setSharingBusy} onChange={devices.reload} />
    {governance && <GovernanceSettings key={`governance:${state.profileId}:${draftVersion}`} governance={governance} devices={state} projects={projects} blocked={action.busy || nameAction.busy || copyAction.busy || sharingBusy} onDirtyChange={setGovernanceDirty} onBusyChange={setGovernanceBusy} onChange={devices.reload} />}
    {pendingGroup && <ConfirmDialog title={g('switchTitle')} confirmLabel={g('switchConfirm')} danger busy={action.busy} error={action.error} confirmDisabled={nameAction.busy || copyAction.busy || sharingBusy || governanceBusy} onClose={() => setPendingGroup(null)} onConfirm={() => { void selectGroup(pendingGroup, true); }}><p>{g('switchDescription')}</p></ConfirmDialog>}
    {confirmation && <ConfirmDialog title={confirmation.kind === 'pair' ? t('pairConfirmTitle') : confirmation.kind === 'resume' ? t('resumeConfirmTitle') : confirmation.kind === 'pause' ? t('pauseConfirmTitle') : confirmation.kind === 'disconnect' ? g('leaveTitle') : t('revokeConfirmTitle')} confirmLabel={confirmation.kind === 'pair' ? t('pairConfirm') : confirmation.kind === 'resume' ? t('resumeConfirm') : confirmation.kind === 'pause' ? t('pauseConfirm') : confirmation.kind === 'disconnect' ? g('leaveConfirm') : t('revokeConfirm')} danger={confirmation.kind === 'disconnect' || confirmation.kind === 'revoke'} busy={action.busy} error={action.error} confirmDisabled={!state.desktopAvailable || (confirmation.kind !== 'pair' && !state.groups.some(group => group.id === confirmation.group.id)) || (confirmation.kind === 'revoke' && (!online || !admin || confirmation.group.id !== state.profileId))} onClose={() => setConfirmation(null)} onConfirm={() => { void execute(); }}>
      {confirmation.kind !== 'pair' && <p>{g('groupContext', { label: confirmation.group.label, id: confirmation.group.id })}</p>}
      {confirmation.kind === 'pair' && <><p>{t('pairBeforeName')}<strong>{confirmation.input.name}</strong>{t('pairBeforeUrl')}<span className="preserve-lines">{confirmation.input.url}</span>{t('pairAfterUrl')}</p><p>{t('pairBeforeAudience')}<strong>{t('allDevices')}</strong>{t('pairAfterAudience')}</p></>}
      {confirmation.kind === 'resume' && <p>{t('resumeDescription')}</p>}{(confirmation.kind === 'pair' || confirmation.kind === 'resume') && <Notice warning>{t('connectionWarning')}</Notice>}{confirmation.kind === 'pause' && <p>{t('pauseDescription')}</p>}
      {confirmation.kind === 'disconnect' && <><p>{g('leaveDescription')}</p><Notice warning>{t('disconnectWarning')}</Notice></>}
      {confirmation.kind === 'revoke' && <><p>{t('revokeBeforeName')}<strong>{confirmation.device.name}</strong>{t('revokeAfterName', { id: confirmation.device.id })}</p><Notice warning>{t('revokeWarning')}</Notice></>}
    </ConfirmDialog>}
  </section>;
}
