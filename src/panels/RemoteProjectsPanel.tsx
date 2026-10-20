import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Eye, FolderKanban, MessageSquare, RefreshCw } from 'lucide-react';
import type { DeviceRecord, DeviceState } from '../../shared/devices';
import { MEMORY_FIELDS, getMemoryLabels } from '../../shared/types';
import { deviceApi } from '../api';
import { canUseNetwork, devicePresence, snapshotKey } from '../device-ui';
import { formatDate, useDeviceResource, type GovernanceController } from '../hooks';
import { RemoteDeviceActivity, RemoteProjectStatus } from '../components/RemoteStatus';
import type { ComposeTarget } from '../components/MessageComposer';
import { Button, EmptyState, ErrorNotice, Loading, Notice, PriorityBadge, SectionHeading, StatusBadge } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { remoteMessages } from '../locales/panels-remote';

/** Remote records never enter ProjectDetail or the local Project/Workspace collection. */
export function RemoteProjectsPanel({ device, state, governance, onCompose }: { device: DeviceRecord; state: DeviceState; governance: GovernanceController; onCompose: (target: ComposeTarget) => void }) {
  const locale = useLocale(); const t = useT(remoteMessages); const memoryLabels = getMemoryLabels(locale);
  const load = useCallback(() => deviceApi.projects(device.id), [device.id]);
  const { data, loading, error, reload } = useDeviceResource(load);
  const [projectId, setProjectId] = useState('');
  useEffect(() => { if (state.lastSyncAt) void reload(); }, [state.lastSyncAt, reload]);
  const snapshots = (data ?? []).filter(snapshot => snapshot.ownerDeviceId === device.id && snapshot.project !== null);
  const selected = snapshots.find(snapshot => snapshot.projectId === projectId) ?? snapshots[0];
  const canSend = canUseNetwork(state) && !device.revokedAt;
  const status = !device.revokedAt && state.paired ? governance.state?.statuses.find(item => item.deviceId === device.id) : undefined;
  return <div className="remote-projects-panel">
    <section className="panel remote-device-heading"><SectionHeading title={device.name} subtitle={t('ownerDevice', { id: device.id })}><span className="readonly-label"><Eye size={15} />{t('remoteReadonly')}</span></SectionHeading><div className="device-toolbar"><span className="field-hint">{t('presence', { presence: devicePresence(device, undefined, locale), date: formatDate(device.lastSeenAt, true, locale) })}</span><Button icon={MessageSquare} disabled={!canSend} onClick={() => onCompose({ toDeviceId: device.id })}>{t('send')}</Button><Button icon={RefreshCw} onClick={() => { void Promise.all([reload(), governance.reload()]); }} disabled={loading}>{t('reload')}</Button></div><Notice>{t('boundary')}{' '}{!state.enabled || state.connection !== 'online' ? t('offline') : t('onlineHint')}</Notice><ErrorNotice message={governance.error || governance.state?.error || ''} /><RemoteDeviceActivity status={status} /></section>
    <ErrorNotice message={error ? t('cacheError', { error }) : ''} />
    {loading ? <section className="panel"><Loading label={t('loading')} /></section> : !selected?.project ? <section className="panel"><EmptyState icon={FolderKanban} title={t('emptyTitle')} description={t('emptyDescription')} /></section> : <div className="remote-project-layout"><aside className="panel remote-project-list"><h2>{t('sharedProjects')}</h2>{snapshots.map(snapshot => <button key={snapshotKey(snapshot)} className={`remote-project-item ${snapshot.projectId === selected.projectId ? 'selected' : ''}`} onClick={() => setProjectId(snapshot.projectId)} aria-pressed={snapshot.projectId === selected.projectId}><strong>{snapshot.project!.name}</strong><span>{t('summaryVersion', { version: snapshot.version })}</span><small>{t('published', { date: formatDate(snapshot.publishedAt, true, locale) })}</small></button>)}</aside>
      <section className="panel remote-project-detail" aria-label={t('summaryLabel')}><SectionHeading title={selected.project.name} subtitle={t('owner', { name: device.name })}><span className="readonly-label"><Eye size={14} />{t('readonlyCache')}</span></SectionHeading><div className="remote-project-meta"><StatusBadge status={selected.project.status} /><PriorityBadge priority={selected.project.priority} /><span>{selected.project.stage || t('noStage')}</span></div>
        <dl className="snapshot-meta"><div><dt>{t('publishedLabel')}</dt><dd>{formatDate(selected.publishedAt, true, locale)}</dd></div><div><dt>{t('receivedLabel')}</dt><dd>{formatDate(selected.receivedAt, true, locale)}</dd></div><div><dt>{t('versions')}</dt><dd>{selected.version} / {selected.project.revision}</dd></div></dl><div className="remote-next-action"><h3>{t('nextAction')}</h3><p className="preserve-lines">{selected.project.nextAction || t('notFilled')}</p></div>
        <RemoteProjectStatus project={status?.projects.find(project => project.projectId === selected.projectId)} receivedAt={status?.receivedAt} />
        <div className="remote-memory"><h3>{t('sharedMemory')}</h3>{MEMORY_FIELDS.filter(field => Object.hasOwn(selected.project!.memory, field)).map(field => <section key={field}><h4>{memoryLabels[field]}</h4><p className="preserve-lines">{selected.project!.memory[field] || t('sharedEmpty')}</p></section>)}{!Object.keys(selected.project.memory).length && <p className="field-hint">{t('noMemory')}</p>}</div><div className="remote-proposal-footer"><p className="field-hint">{t('proposalHint')}</p><Button variant="primary" icon={ArrowLeftRight} disabled={!canSend} onClick={() => onCompose({ toDeviceId: device.id, snapshot: selected })}>{t('propose')}</Button></div>
      </section></div>}
  </div>;
}
