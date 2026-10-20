import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Eye, FolderKanban, RefreshCw } from 'lucide-react';
import type { DeviceGroup, DeviceState, SharedWorkspaceItem, SharedWorkspaceState } from '../../shared/devices';
import { getMemoryLabels, MEMORY_FIELDS } from '../../shared/types';
import { buildMarkdownFillPrompt } from '../../shared/markdown-import';
import { deviceApi } from '../api';
import { getConnectionLabels, sharedWorkspaceKey, shortDeviceId, workspaceItems } from '../device-ui';
import { downloadText, formatDate, useAction, useBeforeUnload, useDeviceResource } from '../hooks';
import { useLocale, useT } from '../i18n';
import { workspaceMessages } from '../locales/panels-workspace';
import { markdownImportMessages } from '../locales/markdown-import';
import { MarkdownPromptDialog } from '../components/MarkdownPromptDialog';
import { Button, EmptyState, ErrorNotice, Field, Loading, Notice, PriorityBadge, SectionHeading, StatusBadge } from '../components/ui';

type Props = { state: DeviceState; refreshVersion: number; onSettings: () => void; onBusyChange: (busy: boolean) => void; onRefreshReady?: (reload: (() => Promise<void>) | null) => void };

/** All-group cache browsing is independent of the shell's selected management profile. */
export function SharedWorkspacePanel({ state, refreshVersion, onSettings, onBusyChange, onRefreshReady }: Props) {
  // A membership removal immediately hides old data, even before a read completes.
  const membershipScope = JSON.stringify(state.groups.map(group => [group.id, group.paired, group.connection === 'revoked']));
  const load = useCallback(() => deviceApi.workspace(), [membershipScope]);
  const resource = useDeviceResource(load);
  const refreshAfterImport = useCallback(() => resource.reload(true), [resource.reload]);
  useEffect(() => { onRefreshReady?.(refreshAfterImport); return () => onRefreshReady?.(null); }, [onRefreshReady, refreshAfterImport]);
  const [profileId, setProfileId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  useEffect(() => { if (refreshVersion) void resource.reload(); }, [refreshVersion, resource.reload]);
  const groups = (resource.data?.groups ?? state.groups).filter(group => state.groups.some(current => current.id === group.id && current.connection !== 'revoked'));
  const filter = groups.some(group => group.id === profileId) ? profileId : '';
  const items = workspaceItems(resource.data?.items ?? [], groups, filter, query);
  const selected = items.find(item => sharedWorkspaceKey(item) === selectedKey) ?? items[0];
  return <SharedWorkspaceView data={{ groups, items }} selected={selected} profileId={filter} query={query} loading={resource.loading} error={resource.error}
    onFilter={setProfileId} onSearch={setQuery} onSelect={item => setSelectedKey(sharedWorkspaceKey(item))} onReload={resource.reload} onSettings={onSettings} onBusyChange={onBusyChange} />;
}

/** Presentational boundary also makes readonly/escaping/identity behavior testable without cloud access. */
export function SharedWorkspaceView({ data, selected, profileId, query, loading, error, onFilter, onSearch, onSelect, onReload, onSettings, onBusyChange }: {
  data: SharedWorkspaceState; selected?: SharedWorkspaceItem; profileId: string; query: string; loading: boolean; error: string;
  onFilter: (id: string) => void; onSearch: (text: string) => void; onSelect: (item: SharedWorkspaceItem) => void; onReload: () => Promise<void>; onSettings: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT(workspaceMessages); const mt = useT(markdownImportMessages); const locale = useLocale();
  const [saved, setSaved] = useState(false);
  const [prompt, setPrompt] = useState<{ scope: object; text: string; filename: string } | null>(null);
  const [promptCopyBusy, setPromptCopyBusy] = useState(false);
  const group = data.groups.find(item => item.id === selected?.profileId);
  const visible = !!selected && !!group?.paired && group.connection !== 'revoked' && data.items.some(item => sharedWorkspaceKey(item) === sharedWorkspaceKey(selected) && item.version === selected.version);
  const scope = visible && !loading && !error && selected ? `${sharedWorkspaceKey(selected)}:${selected.version}:${group?.deviceId}` : '';
  // Keep an identity token, not just a string: remove/re-add of the same selection also invalidates in-flight work.
  const scopeRef = useRef({ value: scope });
  if (scopeRef.current.value !== scope) scopeRef.current = { value: scope };
  const downloadAction = useAction(scopeRef.current); const promptAction = useAction(scopeRef.current);
  const operation = useRef(false);
  const busy = downloadAction.busy || promptAction.busy || promptCopyBusy;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => { setSaved(false); setPrompt(null); }, [scope]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useBeforeUnload(busy);
  const partial = data.groups.some(item => item.connection === 'error' || !!item.lastError);
  const download = async () => {
    if (!selected || !scope || operation.current || busy) return;
    operation.current = true;
    const captured = selected; const expected = scopeRef.current;
    const current = () => alive.current && scopeRef.current === expected;
    setSaved(false);
    const result = await downloadAction.run(async () => {
      // Recheck full identity, visibility, and version with the service at the click.
      const summary = await deviceApi.downloadSummary({ profileId: captured.profileId, ownerDeviceId: captured.ownerDeviceId, projectId: captured.projectId, version: captured.version });
      if (!current()) return false;
      return downloadText(summary.text, summary.filename);
    });
    if (current() && result.ok && result.value) setSaved(true);
    operation.current = false;
    if (current() && !result.ok) await onReload();
  };
  const preparePrompt = async () => {
    if (!selected || !scope || operation.current || busy) return;
    operation.current = true;
    const captured = selected; const expected = scopeRef.current;
    const current = () => alive.current && scopeRef.current === expected;
    setPrompt(null); setSaved(false);
    const result = await promptAction.run(async () => {
      // Use only a freshly validated shared download, never the full local project or combined groups.
      const summary = await deviceApi.downloadSummary({ profileId: captured.profileId, ownerDeviceId: captured.ownerDeviceId, projectId: captured.projectId, version: captured.version });
      if (!current()) return null;
      return { scope: expected, text: buildMarkdownFillPrompt(summary.text, locale), filename: summary.filename };
    });
    if (current() && result.ok && result.value) setPrompt(result.value);
    operation.current = false;
    if (current() && !result.ok) await onReload();
  };
  return <div className="shared-workspace-panel">
    <section className="panel remote-device-heading"><SectionHeading title={t('title')} subtitle={t('subtitle')}><Button icon={RefreshCw} disabled={loading || busy} onClick={() => { void onReload(); }}>{t('reload')}</Button></SectionHeading>
      <div className="shared-workspace-filters"><Field label={t('groupFilter')}><select value={profileId} disabled={busy} onChange={event => onFilter(event.target.value)}><option value="">{t('allGroups')}</option>{data.groups.map(group => <option key={group.id} value={group.id}>{t('groupOption', { label: group.label, id: shortDeviceId(group.id) })}</option>)}</select></Field><Field label={t('search')}><input type="search" value={query} maxLength={500} disabled={busy} placeholder={t('searchPlaceholder')} onChange={event => onSearch(event.target.value)} /></Field></div>
      {partial && <Notice warning>{t('partial')}</Notice>}
      {data.groups.filter(item => item.lastError).map(item => <div key={item.id}><p className="field-hint">{t('groupOption', { label: item.label, id: shortDeviceId(item.id) })}</p><ErrorNotice message={item.lastError ?? ''} /></div>)}
      <ErrorNotice message={error} /><ErrorNotice message={downloadAction.error} onDismiss={() => downloadAction.setError(null)} /><ErrorNotice message={promptAction.error} onDismiss={() => promptAction.setError(null)} />{error && !!data.items.length && <Notice warning>{t('cacheError')}</Notice>}
    </section>
    {loading ? <section className="panel"><Loading label={t('loading')} /></section> : error && !data.items.length ? <section className="panel"><EmptyState icon={FolderKanban} title={t('unavailable')} description={t('unavailableHint')}><Button onClick={() => { void onReload(); }}>{t('reload')}</Button></EmptyState></section> : !data.groups.length ? <section className="panel"><EmptyState icon={FolderKanban} title={t('noGroups')} description={t('noGroupsHint')}><Button onClick={onSettings}>{t('settings')}</Button></EmptyState></section> : !selected ? <section className="panel"><EmptyState icon={FolderKanban} title={t(profileId || query ? 'noMatches' : 'empty')} description={t(profileId || query ? 'noMatchesHint' : 'emptyHint')}>{profileId || query ? <Button onClick={() => { onFilter(''); onSearch(''); }}>{t('clear')}</Button> : <Button onClick={onSettings}>{t('settings')}</Button>}</EmptyState></section> : <div className="remote-project-layout shared-workspace-layout">
      <nav className="panel remote-project-list" aria-label={t('list')}><h2>{t('summaryCount', { count: data.items.length })}</h2>{data.items.map(item => <button type="button" key={sharedWorkspaceKey(item)} className={`remote-project-item ${sharedWorkspaceKey(item) === sharedWorkspaceKey(selected) ? 'selected' : ''}`} disabled={busy} onClick={() => onSelect(item)} aria-pressed={sharedWorkspaceKey(item) === sharedWorkspaceKey(selected)}><strong>{item.project.name}</strong><span>{t('groupOption', { label: item.groupLabel, id: shortDeviceId(item.profileId) })}</span><span>{item.ownerName} ({shortDeviceId(item.ownerDeviceId)})</span><small>{t(item.owned ? item.pending ? 'pending' : 'sent' : 'cached')}</small><small>{t('version', { version: item.version })}</small></button>)}</nav>
      <section className="panel remote-project-detail shared-workspace-detail" aria-label={t('detail')}><SharedSummaryDetail item={selected} group={group} />
        <div className="remote-proposal-footer"><p className="field-hint">{t('downloadHint')}</p><div className="shared-summary-actions"><Button className="markdown-prompt-open" icon={Copy} busy={promptAction.busy} disabled={busy || !scope} onClick={() => { void preparePrompt(); }}>{mt('promptOpen')}</Button><Button icon={Download} busy={downloadAction.busy} disabled={busy || !scope} onClick={() => { void download(); }}>{t('download')}</Button></div></div>
        {saved && <p className="inline-success" role="status"><Check size={15} aria-hidden="true" />{t('downloaded')}</p>}
      </section>
    </div>}
    {prompt && scope && prompt.scope === scopeRef.current && <MarkdownPromptDialog text={prompt.text} filename={prompt.filename} isCurrent={() => alive.current && prompt.scope === scopeRef.current && !!scopeRef.current.value} onClose={() => setPrompt(null)} onBusyChange={setPromptCopyBusy} />}
  </div>;
}

export function SharedSummaryDetail({ item, group }: { item: SharedWorkspaceItem; group?: DeviceGroup }) {
  const t = useT(workspaceMessages); const locale = useLocale(); const memoryLabels = getMemoryLabels(locale); const connectionLabels = getConnectionLabels(locale);
  return <><SectionHeading title={item.project.name} subtitle={t(item.owned ? 'owned' : 'remote')}><span className="readonly-label"><Eye size={14} aria-hidden="true" />{t('readonly')}</span></SectionHeading>
    <div className="remote-project-meta"><StatusBadge status={item.project.status} /><PriorityBadge priority={item.project.priority} /><span>{item.project.stage || t('noStage')}</span></div>
    <dl className="snapshot-meta shared-source-meta"><div><dt>{t('group')}</dt><dd>{item.groupLabel}<small className="device-id">{t('groupId', { id: item.profileId })}</small></dd></div><div><dt>{t('owner')}</dt><dd>{item.ownerName}<small className="device-id">{t('ownerId', { id: item.ownerDeviceId })}</small></dd></div><div><dt>{t('projectId')}</dt><dd className="device-id">{item.projectId}</dd></div><div><dt>{t('versions')}</dt><dd>{item.version} / {item.project.revision}</dd></div><div><dt>{t('published')}</dt><dd>{item.owned && item.pending ? t('notPublished') : formatDate(item.publishedAt, true, locale)}</dd></div><div><dt>{t('received')}</dt><dd>{formatDate(item.receivedAt, true, locale)}</dd></div><div><dt>{t('lastSync')}</dt><dd>{formatDate(item.lastSyncAt, true, locale)}</dd></div>{group && <div><dt>{t('connection')}</dt><dd>{connectionLabels[group.connection]}</dd></div>}</dl>
    <p className="field-hint">{t(item.owned ? item.pending ? 'pending' : 'sent' : 'cached')}</p><Notice warning={item.pending || group?.connection !== 'online'}>{t(item.owned && item.pending ? 'pendingNotice' : 'cachedNotice')}</Notice>
    <div className="remote-next-action"><h3>{t('nextAction')}</h3><p className="preserve-lines">{item.project.nextAction || t('notFilled')}</p></div>
    <div className="remote-memory"><h3>{t('memory')}</h3>{MEMORY_FIELDS.filter(field => Object.hasOwn(item.project.memory, field)).map(field => <section key={field}><h4>{memoryLabels[field]}</h4><p className="preserve-lines">{item.project.memory[field] || t('sharedEmpty')}</p></section>)}{!Object.keys(item.project.memory).length && <p className="field-hint">{t('noMemory')}</p>}</div>
  </>;
}
