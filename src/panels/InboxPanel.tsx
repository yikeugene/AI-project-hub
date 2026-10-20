import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Inbox, MessageSquare, RefreshCw, Send, X } from 'lucide-react';
import { MEMORY_FIELDS, getMemoryLabels, type Project } from '../../shared/types';
import { translateError } from '../../shared/messages';
import type { Decision, DeviceState, MemoryField, MessageView, ProposalPreview } from '../../shared/devices';
import { deviceApi } from '../api';
import { canUseNetwork, getDecisionLabels, getDeliveryLabels, isNetworkOnline, shortDeviceId } from '../device-ui';
import { formatDate, useAction, useBeforeUnload, useDeviceResource } from '../hooks';
import { ChangePreview } from '../components/ChangePreview';
import type { ComposeTarget } from '../components/MessageComposer';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { inboxMessages } from '../locales/panels-inbox';

export function InboxPanel({ box, state, projects, onCompose, onChange, onBusyChange }: { box: 'inbox' | 'sent'; state: DeviceState; projects: Project[]; onCompose: (target: ComposeTarget) => void; onChange: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const locale = useLocale(); const t = useT(inboxMessages); const memoryLabels = getMemoryLabels(locale);
  const decisionLabels = getDecisionLabels(locale); const deliveryLabels = getDeliveryLabels(locale);
  const load = useCallback(() => state.profileId ? deviceApi.messages(state.profileId, box) : Promise.resolve([]), [state.profileId, box]);
  const { data, error, loading, reload } = useDeviceResource(load);
  const [selectedId, setSelectedId] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [preview, setPreview] = useState<(ProposalPreview & { profileId: string }) | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'accept' | 'reject'; profileId: string; messageId: string } | null>(null);
  const [message, setMessage] = useState<Decision | ''>('');
  const action = useAction(state.profileId);
  const sequence = useRef(0);
  const scope = useRef(state.profileId); scope.current = state.profileId;
  const alive = useRef(true);
  const records = data ?? [];
  const selected = records.find(item => item.id === selectedId) ?? records[0];
  const recipients = state.devices.filter(device => device.id !== state.localDevice.id && !device.revokedAt);
  const recipient = recipients.find(device => device.id === recipientId) ?? recipients[0];
  const localProject = preview ? projects.find(project => project.id === preview.projectId) : null;
  const previewChanges = preview?.changes.map(change => ({ ...change, label: change.key === 'nextAction' ? t('nextAction') : Object.hasOwn(memoryLabels, change.key) ? memoryLabels[change.key as MemoryField] : change.label })) ?? [];
  const stale = !!preview && (preview.profileId !== state.profileId || !localProject || localProject.revision !== preview.revision || selected?.hash !== preview.hash || selected?.id !== preview.messageId);
  const expired = !!selected && Date.parse(selected.expiresAt) <= Date.now();
  const canDecide = !!state.profileId && box === 'inbox' && selected?.payload.kind === 'proposal' && !selected.result;
  useBeforeUnload(action.busy);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  useEffect(() => { if (state.lastSyncAt) void reload(); }, [state.lastSyncAt, reload]);
  useEffect(() => { sequence.current++; setPreview(null); setConfirm(null); setMessage(''); action.setError(''); }, [state.profileId, selected?.id, action.setError]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const deviceName = (id: string) => id === state.localDevice.id ? t('localDevice', { name: state.localDevice.name }) : state.devices.find(device => device.id === id)?.name ?? t('unknownDevice');
  const readPreview = async () => {
    if (!selected || !state.profileId || action.busy) return;
    const requestId = ++sequence.current; const profileId = state.profileId;
    setPreview(null); setMessage('');
    const result = await action.run(() => deviceApi.preview(profileId, selected.id));
    if (result.ok && alive.current && scope.current === profileId && requestId === sequence.current) setPreview({ ...result.value, profileId });
  };
  const finish = async (operation: () => Promise<MessageView>, success: Decision) => {
    const profileId = state.profileId; if (!profileId) return;
    const result = await action.run(async () => {
      const response = await operation();
      if (alive.current && scope.current === profileId) await Promise.all([reload(), onChange()]);
      return response;
    });
    if (result.ok && alive.current && scope.current === profileId) { setConfirm(null); setPreview(null); setMessage(result.value.result ? result.value.result.status : success); }
  };
  return <section className="panel inbox-panel" aria-label={box === 'inbox' ? t('inboxLabel') : t('sentLabel')}><SectionHeading title={box === 'inbox' ? t('inboxTitle') : t('sentTitle')} subtitle={t('subtitle')}><Button icon={RefreshCw} disabled={loading || action.busy} onClick={() => { void reload(); }}>{t('reload')}</Button></SectionHeading>
    <div className="message-compose-bar"><Field label={t('recipient')}><select value={recipient?.id ?? ''} disabled={!recipients.length || action.busy} onChange={event => setRecipientId(event.target.value)}>{!recipients.length && <option value="">{t('noDevices')}</option>}{recipients.map(device => <option key={device.id} value={device.id}>{t('recipientOption', { name: device.name, id: shortDeviceId(device.id) })}</option>)}</select></Field><Button icon={MessageSquare} disabled={!recipient || !canUseNetwork(state) || action.busy} onClick={() => { if (recipient) onCompose({ toDeviceId: recipient.id }); }}>{t('compose')}</Button></div>
    {!state.enabled && <Notice>{t('paused')}</Notice>}<ErrorNotice message={error} />
    {loading ? <Loading label={t('loading')} /> : !selected ? <EmptyState icon={box === 'inbox' ? Inbox : Send} title={box === 'inbox' ? t('inboxEmpty') : t('sentEmpty')} description={state.paired ? t('pairedHint') : t('unpairedHint')} /> : <div className="message-layout"><nav className="message-list" aria-label={t('listLabel')}>{records.map(item => <button key={item.id} className={`message-list-item ${selected.id === item.id ? 'selected' : ''}`} disabled={action.busy} aria-pressed={selected.id === item.id} onClick={() => setSelectedId(item.id)}><span className="message-kind">{item.payload.kind === 'proposal' ? <ArrowLeftRight size={14} /> : <MessageSquare size={14} />}{item.payload.kind === 'proposal' ? t('proposal') : t('textMessage')}</span><strong>{deviceName(box === 'inbox' ? item.fromDeviceId : item.toDeviceId)}</strong><p>{item.payload.text || t('noExplanation')}</p><small>{formatDate(item.createdAt, true, locale)}</small><span className="message-list-status">{box === 'sent' ? deliveryLabels[item.delivery] : t('received')} · {item.result ? decisionLabels[item.result.status] : item.payload.kind === 'proposal' ? t('pending') : t('unread')}</span></button>)}</nav>
      <article className="message-detail"><header><h3>{selected.payload.kind === 'proposal' ? t('proposal') : t('textMessage')}</h3><p>{box === 'inbox' ? t('from') : t('to')} <strong>{deviceName(box === 'inbox' ? selected.fromDeviceId : selected.toDeviceId)}</strong><span className="device-id">{box === 'inbox' ? selected.fromDeviceId : selected.toDeviceId}</span></p></header>
        <dl className="message-lifecycle"><div><dt>{t('delivery')}</dt><dd>{deliveryLabels[selected.delivery]}{selected.receivedAt && <small>{formatDate(selected.receivedAt, true, locale)}</small>}</dd></div><div><dt>{t('result')}</dt><dd>{selected.result ? decisionLabels[selected.result.status] : expired ? t('expiredResult') : selected.payload.kind === 'proposal' ? t('awaitingComputer') : t('awaitingRead')}{selected.result && <small>{formatDate(selected.result.at, true, locale)}</small>}</dd></div><div><dt>{t('createdExpires')}</dt><dd>{formatDate(selected.createdAt, true, locale)}<small>{formatDate(selected.expiresAt, true, locale)}</small></dd></div></dl>
        <ErrorNotice message={selected.error ?? ''} /><p className="preserve-lines message-body">{selected.payload.text || t('noExplanation')}</p>
        {selected.payload.kind === 'proposal' && <><p className="field-hint">{t('projectId', { id: selected.payload.projectId })}<br />{t('sourceRevision', { revision: selected.payload.baseRevision })}</p><details className="requested-changes"><summary>{t('requestedFields')}</summary>{selected.payload.changes.nextAction !== undefined && <section><h4>{t('nextAction')}</h4><p className="preserve-lines">{selected.payload.changes.nextAction || t('clearRequested')}</p></section>}{MEMORY_FIELDS.filter(field => selected.payload.kind === 'proposal' && selected.payload.changes.memory?.[field] !== undefined).map(field => <section key={field}><h4>{memoryLabels[field]}</h4><p className="preserve-lines">{selected.payload.kind === 'proposal' && (selected.payload.changes.memory![field] || t('clearRequested'))}</p></section>)}</details></>}
        {box === 'sent' && <Notice>{t('deliveryBoundary')}</Notice>}
        {box === 'inbox' && selected.payload.kind === 'message' && !selected.result && <Button icon={Check} busy={action.busy} onClick={() => { void finish(() => deviceApi.read(state.profileId!, selected.id), 'read'); }}>{t('markRead')}</Button>}
        {canDecide && <><div className="device-toolbar"><Button icon={ArrowLeftRight} disabled={action.busy} busy={action.busy} onClick={() => { void readPreview(); }}>{t('preview')}</Button><Button icon={X} disabled={action.busy} onClick={() => { action.setError(''); setConfirm({ kind: 'reject', profileId: state.profileId!, messageId: selected.id }); }}>{t('reject')}</Button></div><p className="field-hint">{t('decisionHint')}</p></>}
        {preview && preview.messageId === selected.id && <div className="shared-preview proposal-preview"><div className="shared-preview-heading"><strong>{t('previewTitle', { name: preview.projectName })}</strong><span>{t('localRevision', { revision: preview.revision })}</span></div>{(!preview.canApply || stale || expired) && <Notice warning>{stale ? t('stale') : (preview.reasonCode ? translateError(preview.reasonCode, locale, preview.reasonParams) : preview.reason) || (expired ? t('expired') : t('cannotApply'))}</Notice>}<ChangePreview changes={previewChanges} afterLabel={t('afterLabel')} /><div className="shared-footer"><Button onClick={() => setPreview(null)} disabled={action.busy}>{t('closePreview')}</Button><Button variant="primary" disabled={!preview.canApply || stale || expired || !isNetworkOnline(state) || !canDecide || action.busy} onClick={() => { action.setError(''); setConfirm({ kind: 'accept', profileId: preview.profileId, messageId: selected.id }); }}>{t('accept')}</Button></div>{!isNetworkOnline(state) && <Notice>{t('onlineRequired')}</Notice>}</div>}
        {!confirm && <ErrorNotice message={action.error} />}{message && <p role="status" className="inline-success"><Check size={15} />{decisionLabels[message]}</p>}
      </article></div>}
    {confirm && selected && <ConfirmDialog title={confirm.kind === 'accept' ? t('acceptTitle') : t('rejectTitle')} confirmLabel={confirm.kind === 'accept' ? t('acceptConfirm') : t('rejectConfirm')} danger={confirm.kind === 'reject'} busy={action.busy} error={action.error} confirmDisabled={!canDecide || confirm.profileId !== state.profileId || confirm.messageId !== selected.id || (confirm.kind === 'accept' && (!preview?.canApply || stale || expired || !isNetworkOnline(state)))} onClose={() => setConfirm(null)} onConfirm={() => {
      if (!canDecide || confirm.profileId !== state.profileId || confirm.messageId !== selected.id) return;
      if (confirm.kind === 'reject') void finish(() => deviceApi.reject(confirm.profileId, confirm.messageId), 'rejected');
      else if (preview && !stale && preview.canApply && !expired && isNetworkOnline(state)) void finish(() => deviceApi.accept(confirm.profileId, confirm.messageId, { hash: preview.hash, revision: preview.revision, confirm: true }), 'applied');
    }}>{confirm.kind === 'accept' ? <><p>{t('acceptBeforeName')}<strong>{preview?.projectName}</strong>{t('acceptAfterName', { revision: preview?.revision ?? '' })}</p><Notice warning>{t('acceptWarning')}</Notice></> : <p>{t('rejectDescription')}</p>}</ConfirmDialog>}
  </section>;
}
