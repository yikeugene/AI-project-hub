import { useEffect, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { messagePayloadSchema, type CachedSnapshot, type DeviceState, type MemoryField, type MessagePayload } from '../../shared/devices';
import { LocalizedError } from '../../shared/i18n';
import { getMemoryLabels, MEMORY_FIELDS } from '../../shared/types';
import { deviceApi } from '../api';
import { canUseNetwork, proposalChanges, shortDeviceId } from '../device-ui';
import { formatDate, useAction, useBeforeUnload } from '../hooks';
import { useLocale, useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { ChangePreview } from './ChangePreview';
import { Button, ConfirmDialog, ErrorNotice, Field, Modal, Notice } from './ui';

export interface ComposeTarget { toDeviceId: string; snapshot?: CachedSnapshot }
export function MessageComposer({ target, state, onClose, onSent, onDirtyChange, onBusyChange }: { target: ComposeTarget; state: DeviceState; onClose: () => void; onSent: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const t = useT(shellCatalog); const locale = useLocale();
  const memoryLabels = getMemoryLabels(locale);
  // The chosen snapshot is deliberately frozen for the lifetime of this draft.
  const [snapshot] = useState(target.snapshot);
  const [text, setText] = useState('');
  const [selectedNext, setSelectedNext] = useState(false);
  const [nextAction, setNextAction] = useState(snapshot?.project?.nextAction ?? '');
  const [selectedFields, setSelectedFields] = useState<MemoryField[]>([]);
  const [memory, setMemory] = useState<Partial<Record<MemoryField, string>>>(snapshot?.project?.memory ?? {});
  const [outgoing, setOutgoing] = useState<MessagePayload | null>(null);
  const [discard, setDiscard] = useState(false);
  const action = useAction();
  const dirty = !!text || selectedNext || selectedFields.length > 0;
  const recipient = state.devices.find(device => device.id === target.toDeviceId);
  const canSend = canUseNetwork(state) && !!recipient && !recipient.revokedAt && target.toDeviceId !== state.localDevice.id;
  const availableFields = MEMORY_FIELDS.filter(field => snapshot?.project && Object.hasOwn(snapshot.project.memory, field));
  useBeforeUnload(dirty || action.busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(action.busy); }, [action.busy, onBusyChange]);
  const requestClose = () => { if (action.busy) return; if (dirty) setDiscard(true); else onClose(); };
  const preview = (event: FormEvent) => {
    event.preventDefault(); action.setError('');
    const payload = snapshot?.project ? {
      schemaVersion: 1, kind: 'proposal', text, projectId: snapshot.projectId, baseRevision: snapshot.project.revision,
      changes: proposalChanges(snapshot, selectedNext ? nextAction : undefined, Object.fromEntries(selectedFields.map(field => [field, memory[field] ?? ''])), locale),
    } : { schemaVersion: 1, kind: 'message', text };
    const parsed = messagePayloadSchema.safeParse(payload);
    if (!parsed.success) { action.setError(new LocalizedError(shellCatalog, snapshot ? 'composer.invalidProposal' : 'composer.invalidMessage')); return; }
    setOutgoing(parsed.data);
  };
  const send = async () => {
    if (!outgoing || !canSend) return;
    const result = await action.run(() => deviceApi.send({ toDeviceId: target.toDeviceId, payload: outgoing }));
    if (result.ok) { setText(''); setSelectedNext(false); setSelectedFields([]); onDirtyChange(false); await onSent(); onClose(); }
  };
  const recipientDescription = t('composer.recipient', { name: recipient?.name ?? t('composer.unknownDevice'), id: shortDeviceId(target.toDeviceId) });
  const [beforeRecipient, afterRecipient] = t('composer.recipient', { name: '{name}', id: target.toDeviceId }).split('{name}');
  return <><Modal title={t(snapshot ? 'composer.propose' : 'composer.sendMessage')} description={recipientDescription} onClose={requestClose} wide={!!snapshot} className="message-composer"><form onSubmit={preview} aria-label={t('composer.draft')}><div className="modal-body form-stack">
    {!canSend && <Notice warning>{t('composer.unavailable')}</Notice>}
    <Notice>{t('composer.cloudNotice')}</Notice>
    {snapshot?.project && <><div className="proposal-source"><strong>{snapshot.project.name}</strong><span>{t('composer.source', { revision: snapshot.project.revision, version: snapshot.version })}</span><span>{t('composer.dates', { published: formatDate(snapshot.publishedAt, true, locale), received: formatDate(snapshot.receivedAt, true, locale) })}</span></div><p className="field-hint">{t('composer.fieldsHint')}</p>
      <label className="check-field"><input type="checkbox" checked={selectedNext} disabled={action.busy} onChange={event => { setSelectedNext(event.target.checked); setOutgoing(null); }} /><span>{t('composer.proposeNext')}</span></label>
      {selectedNext && <Field label={t('composer.suggestedNext')}><textarea maxLength={2000} rows={3} value={nextAction} disabled={action.busy} onChange={event => { setNextAction(event.target.value); setOutgoing(null); }} /></Field>}
      {availableFields.map(field => <div className="proposal-field" key={field}><label className="check-field"><input type="checkbox" checked={selectedFields.includes(field)} disabled={action.busy} onChange={event => { setSelectedFields(MEMORY_FIELDS.filter(key => key === field ? event.target.checked : selectedFields.includes(key))); setOutgoing(null); }} /><span>{t('composer.proposeField', { field: memoryLabels[field] })}</span></label>{selectedFields.includes(field) && <Field label={t('composer.suggestedField', { field: memoryLabels[field] })}><textarea maxLength={20000} rows={4} value={memory[field] ?? ''} disabled={action.busy} onChange={event => { setMemory(current => ({ ...current, [field]: event.target.value })); setOutgoing(null); }} /></Field>}</div>)}
      {!availableFields.length && <p className="field-hint">{t('composer.noMemory')}</p>}
    </>}
    <Field label={t(snapshot ? 'composer.explanation' : 'composer.message')} required={!snapshot}><textarea required={!snapshot} maxLength={10000} rows={5} value={text} disabled={action.busy} onChange={event => { setText(event.target.value); setOutgoing(null); }} placeholder={t(snapshot ? 'composer.explanationPlaceholder' : 'composer.messagePlaceholder')} /></Field>
    {!state.enabled && <p className="field-hint">{t('composer.paused')}</p>}<ErrorNotice message={action.error} />
  </div><footer className="modal-footer"><Button onClick={requestClose} disabled={action.busy}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!canSend || action.busy}>{t(snapshot ? 'composer.previewProposal' : 'composer.reviewMessage')}</Button></footer></form></Modal>
    {outgoing && <Modal title={t('composer.confirmTitle')} onClose={() => { if (!action.busy) setOutgoing(null); }} wide={outgoing.kind === 'proposal'} className="message-review"><div className="modal-body"><p>{beforeRecipient}<strong>{recipient?.name ?? t('composer.unknownDevice')}</strong>{afterRecipient}</p><p className="preserve-lines message-body">{outgoing.text || t('composer.noExplanation')}</p>{outgoing.kind === 'proposal' && snapshot?.project && <><p className="field-hint">{t('composer.revisionHint', { revision: outgoing.baseRevision })}</p><ChangePreview beforeLabel={t('composer.before')} afterLabel={t('composer.after')} changes={[
      ...(outgoing.changes.nextAction !== undefined ? [{ key: 'nextAction', label: t('common.nextAction'), before: snapshot.project.nextAction, after: outgoing.changes.nextAction }] : []),
      ...MEMORY_FIELDS.filter(field => outgoing.changes.memory?.[field] !== undefined).map(field => ({ key: field, label: memoryLabels[field], before: snapshot.project!.memory[field] ?? '', after: outgoing.changes.memory![field]! })),
    ]} /></>}<Notice warning>{t('composer.conflictNotice')}</Notice><ErrorNotice message={action.error} /></div><footer className="modal-footer"><Button disabled={action.busy} onClick={() => setOutgoing(null)}>{t('composer.back')}</Button><Button icon={Send} variant="primary" disabled={!canSend} busy={action.busy} onClick={() => { void send(); }}>{t('composer.confirm')}</Button></footer></Modal>}
    {discard && <ConfirmDialog title={t('app.unsentDraft')} confirmLabel={t('composer.discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}><p>{t('composer.discardDescription')}</p></ConfirmDialog>}
  </>;
}
