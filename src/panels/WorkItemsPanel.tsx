import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Plus, RefreshCw } from 'lucide-react';
import type { Project } from '../../shared/types';
import type { WorkItem } from '../../shared/work-items';
import { workItemApi } from '../api';
import { WorkItemEditor } from '../components/WorkItemEditor';
import { Button, EmptyState, ErrorNotice, Field, Loading, StatusBadge } from '../components/ui';
import { useNow, useDeviceResource } from '../hooks';
import { useLocale, useT } from '../i18n';
import { workItemMessages } from '../locales/work-items';
import { groupWorkItems, workNextAction, type WorkBucket } from '../work-items';

export function WorkItemsList({ items, projects, projectId = '', focusIds = [], now = Date.now(), disabled = false, onOpen }: { items: WorkItem[]; projects: Project[]; projectId?: string; focusIds?: readonly string[]; now?: number; disabled?: boolean; onOpen: (item: WorkItem) => void }) {
  const t = useT(workItemMessages); const locale = useLocale();
  const groups = groupWorkItems(items, projectId, focusIds, now);
  const list = (bucket: WorkBucket) => <ul className="work-item-list">{groups[bucket].map(item => {
    const project = projects.find(candidate => candidate.id === item.projectId);
    return <li key={item.id}><button className="work-item-row" disabled={disabled} onClick={() => onOpen(item)} aria-label={t('open', { title: item.brief.title || item.brief.goal || t('untitled') })}>
      <span className="work-row-context"><span>{project?.name ?? item.projectId}</span>{project && (project.status === 'paused' || project.status === 'archived') && <StatusBadge status={project.status} />}<span className={`badge work-phase-${item.phase}`}>{t(`phase_${item.phase}`)}</span>{item.hold && <span>{t(`hold_${item.hold.kind}`)}</span>}</span>
      <strong className="work-row-title">{item.brief.title || t('untitled')}</strong>
      <span className="work-row-goal preserve-lines">{item.brief.goal || t('emptyField')}</span>
      <span className="work-row-next"><span>{t('nextAction')}</span><strong className="preserve-lines">{workNextAction(item, locale, now)}</strong></span>
      {(item.phase === 'awaiting_return' || item.phase === 'review') && <span className="work-row-first-check"><span>{t('firstCheck')}</span><span className="preserve-lines">{item.brief.firstCheck || t('emptyField')}</span></span>}
    </button></li>;
  })}</ul>;
  return <div className="work-lanes">
    {(['actionable', 'returning'] as const).map(bucket => <section key={bucket} className={`panel work-lane work-lane-${bucket}`} aria-label={t(bucket)}><h2>{t(bucket)}</h2>{groups[bucket].length ? list(bucket) : <p className="work-lane-empty">{t(bucket === 'actionable' ? 'actionableEmpty' : 'returningEmpty')}</p>}</section>)}
    {(['held', 'completed'] as const).map(bucket => <details key={bucket} className="work-archive"><summary>{t(bucket)} <span>{groups[bucket].length}</span></summary>{list(bucket)}</details>)}
  </div>;
}

interface Selection { key: number; item?: WorkItem; projectId?: string; sourceWorkItemId?: string }
export interface WorkItemsPanelProps {
  projects: Project[];
  projectId?: string;
  focusIds?: readonly string[];
  onAddProject?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}
/** Both home and project detail open the same editor; this panel never writes project memory. */
export function WorkItemsPanel({ projects, projectId, focusIds = [], onAddProject, onDirtyChange, onBusyChange }: WorkItemsPanelProps) {
  const t = useT(workItemMessages); const now = useNow();
  const loader = useCallback(() => workItemApi.list(projectId), [projectId]);
  const resource = useDeviceResource(loader);
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [committed, setCommitted] = useState<Record<string, WorkItem>>({});
  const sequence = useRef(0);
  useEffect(() => {
    // Project deletion is intentional; paused/archived projects are never removed here.
    setCommitted(previous => Object.fromEntries(Object.entries(previous).filter(([, item]) => projects.some(project => project.id === item.projectId))));
  }, [projects]);
  const localIds = new Set(projects.map(project => project.id));
  const merged = new Map((resource.data?.items ?? []).filter(item => localIds.has(item.projectId)).map(item => [item.id, item]));
  for (const item of Object.values(committed)) if (localIds.has(item.projectId) && (!merged.has(item.id) || merged.get(item.id)!.revision < item.revision)) merged.set(item.id, item);
  const items = [...merged.values()];
  const activeProjectId = projectId ?? filter;
  const selectedItem = selection?.item ? merged.get(selection.item.id) ?? selection.item : undefined;
  const open = (item?: WorkItem, source?: WorkItem) => {
    setSelection({ key: ++sequence.current, item, projectId: source?.projectId ?? (activeProjectId || undefined), sourceWorkItemId: source?.id });
  };
  const saved = async (latest: WorkItem) => {
    setCommitted(previous => ({ ...previous, [latest.id]: latest }));
    setSelection(previous => previous ? { ...previous, item: latest } : previous);
    await resource.reload(true);
  };
  return <section className="work-items-panel" aria-label={t('title')}>
    <div className="work-panel-heading"><div><h2>{t('title')}</h2><p>{t('subtitle')}</p></div><div className="work-actions"><Button icon={RefreshCw} aria-label={t('refresh')} disabled={!!selection} onClick={() => { void resource.reload(); }}>{t('refresh')}</Button><Button variant="primary" icon={Plus} disabled={!projects.length || !!selection} onClick={() => open()}>{t('add')}</Button></div></div>
    {!projectId && <div className="work-filter"><Field label={t('project')}><select value={filter} disabled={!!selection} onChange={event => setFilter(event.target.value)}><option value="">{t('allProjects')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field></div>}
    <ErrorNotice message={resource.error} />
    {resource.loading && !items.length ? <Loading /> : !items.some(item => !activeProjectId || item.projectId === activeProjectId) ? <div className="panel"><EmptyState icon={ClipboardCheck} title={t('emptyTitle')} description={t('emptyDescription')}>{projects.length ? <Button variant="primary" icon={Plus} disabled={!!selection} onClick={() => open()}>{t('add')}</Button> : onAddProject && <Button icon={Plus} onClick={onAddProject}>{t('addProject')}</Button>}</EmptyState></div> : <WorkItemsList items={items} projects={projects} projectId={activeProjectId} focusIds={focusIds} now={now} disabled={!!selection} onOpen={item => open(item)} />}
    {selection && <WorkItemEditor key={selection.key} projects={projects} item={selectedItem} projectId={selection.projectId} sourceWorkItemId={selection.sourceWorkItemId} onClose={() => setSelection(null)} onSaved={saved} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} onNewFrom={item => open(undefined, item)} />}
  </section>;
}
