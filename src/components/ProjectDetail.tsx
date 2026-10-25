import { useState } from 'react';
import { BookOpen, CheckSquare2, ClipboardCheck, FileText, GitBranch, LayoutDashboard, Pencil, Star, Trash2 } from 'lucide-react';
import type { Capabilities, DesktopCapabilities, Project, Task } from '../../shared/types';
import type { DeviceState } from '../../shared/devices';
import { formatDate, useBeforeUnload, type GovernanceController } from '../hooks';
import { useLocale, useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { resumptionMessages } from '../locales/resumption';
import { workItemMessages } from '../locales/work-items';
import { GitPanel } from '../panels/GitPanel';
import { HandoffPanel } from '../panels/HandoffPanel';
import { MemoryPanel } from '../panels/MemoryPanel';
import { QuickWrapUpPanel } from '../panels/QuickWrapUpPanel';
import { TasksPanel } from '../panels/TasksPanel';
import { WorkItemsPanel } from '../panels/WorkItemsPanel';
import { ProjectForm, RemoveProjectDialog } from './ProjectForm';
import { QuickActions } from './QuickActions';
import { ResumeCard } from './ResumeCard';
import { Button, ConfirmDialog, ErrorNotice, Modal, PriorityBadge, StatusBadge } from './ui';
export type DetailTab = 'workItems' | 'overview' | 'wrapup' | 'tasks' | 'git' | 'memory' | 'handoff';
const tabs = [{ id: 'workItems', icon: CheckSquare2 }, { id: 'overview', labelKey: 'detail.overview', icon: LayoutDashboard }, { id: 'wrapup', icon: ClipboardCheck }, { id: 'tasks', labelKey: 'detail.tasks', icon: CheckSquare2 }, { id: 'git', labelKey: 'detail.git', icon: GitBranch }, { id: 'memory', labelKey: 'detail.memory', icon: BookOpen }, { id: 'handoff', labelKey: 'detail.handoff', icon: FileText }] as const;

export function ProjectDetail({ project, projects, tasks, capabilities, desktopApps, devices, governance, onClose, onChange, initialTab = 'workItems', focused = false, focusBusy = false, focusError, onToggleFocus }: { project: Project; projects: Project[]; tasks: Task[]; capabilities: Capabilities; desktopApps: DesktopCapabilities; devices: DeviceState | null; governance: GovernanceController; onClose: () => void; onChange: () => Promise<void>; initialTab?: DetailTab; focused?: boolean; focusBusy?: boolean; focusError?: string; onToggleFocus?: (id: string) => void }) {
  const t = useT(shellCatalog); const r = useT(resumptionMessages); const w = useT(workItemMessages); const locale = useLocale();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [wrapUpDirty, setWrapUpDirty] = useState(false);
  const [wrapUpBusy, setWrapUpBusy] = useState(false);
  const [workDirty, setWorkDirty] = useState(false);
  const [workBusy, setWorkBusy] = useState(false);
  const [workVisited, setWorkVisited] = useState(initialTab === 'workItems');
  const [handoffDirty, setHandoffDirty] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffVisited, setHandoffVisited] = useState(initialTab === 'handoff');
  const [gitDirty, setGitDirty] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitVisited, setGitVisited] = useState(initialTab === 'git');
  const [discard, setDiscard] = useState(false);
  const busy = memoryBusy || wrapUpBusy || workBusy || handoffBusy || gitBusy;
  const dirty = memoryDirty || wrapUpDirty || workDirty || handoffDirty || gitDirty;
  useBeforeUnload(dirty || busy);
  // Visited editors remain mounted across tabs, so changing tabs never discards a draft.
  const selectTab = (next: DetailTab) => { if (busy) return; if (next === 'workItems') setWorkVisited(true); if (next === 'handoff') setHandoffVisited(true); if (next === 'git') setGitVisited(true); setTab(next); };
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  const ownTasks = tasks.filter(task => task.projectId === project.id);
  return <>
    <Modal title={project.name} description={project.path} onClose={close} wide className="project-detail">
      <div className="detail-meta"><div><StatusBadge status={project.status} /><PriorityBadge priority={project.priority} /><span className="detail-category">{project.category || t('common.uncategorized')}{project.stage ? ` / ${project.stage}` : ''}</span></div><div>
        {onToggleFocus && <Button variant="ghost" icon={Star} className="focus-toggle" aria-pressed={focused} disabled={busy || focusBusy} onClick={() => onToggleFocus(project.id)}>{r(focused ? 'focusRemove' : 'focusAdd')}</Button>}
        <Button variant="ghost" icon={Pencil} disabled={busy || wrapUpDirty || workDirty} title={wrapUpDirty ? r('resolveWrapUp') : undefined} onClick={() => setEditing(true)}>{t('detail.edit')}</Button><Button variant="ghost" icon={Trash2} disabled={busy || dirty} title={t(dirty ? 'detail.resolveDrafts' : 'detail.removeRecord')} onClick={() => setRemoving(true)}>{t('common.remove')}</Button>
      </div></div>
      <ErrorNotice message={focusError} />
      <nav className="detail-tabs" aria-label={t('detail.navigation')}>{tabs.map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} disabled={busy} onClick={() => selectTab(item.id)}><item.icon size={16} />{item.id === 'workItems' ? w('title') : item.id === 'wrapup' ? r('wrapUpTab') : t(item.labelKey)}{item.id === 'tasks' && ownTasks.length > 0 && <span className="tab-count">{ownTasks.filter(task => task.status !== 'done').length}</span>}{((item.id === 'workItems' && workDirty) || (item.id === 'memory' && memoryDirty) || (item.id === 'wrapup' && wrapUpDirty) || (item.id === 'handoff' && handoffDirty) || (item.id === 'git' && gitDirty)) && <span className="unsaved-dot" aria-label={t('common.unsaved')} />}</button>)}</nav>
      <div className="detail-content">
        {workVisited && <div hidden={tab !== 'workItems'}><WorkItemsPanel projects={projects} projectId={project.id} onDirtyChange={setWorkDirty} onBusyChange={setWorkBusy} /></div>}
        {tab === 'overview' && <div className="overview-panel"><div className="overview-intro"><h3>{t('detail.resume')}</h3><span className="revision-label">{t('detail.revision', { revision: project.revision })}</span></div>
          <ResumeCard project={project} tasks={tasks} onWrapUp={() => selectTab('wrapup')} onMemory={() => selectTab('memory')} />
          <QuickActions project={project} capabilities={capabilities} desktopApps={desktopApps} />
          <div className="overview-bottom"><span>{t('detail.joined', { date: formatDate(project.createdAt, false, locale) })}</span><Button icon={FileText} onClick={() => selectTab('handoff')}>{t('detail.prepareHandoff')}</Button></div>
        </div>}
        <div hidden={tab !== 'wrapup'}><QuickWrapUpPanel project={project} blocked={memoryDirty || memoryBusy || handoffDirty || handoffBusy || editing} onChange={onChange} onDirtyChange={setWrapUpDirty} onBusyChange={setWrapUpBusy} /></div>
        {tab === 'tasks' && <TasksPanel projects={projects} tasks={tasks} projectId={project.id} onChange={onChange} />}
        {gitVisited && <div hidden={tab !== 'git'}><GitPanel project={project} devices={devices} governance={governance} active={tab === 'git'} onChange={onChange} onDirtyChange={setGitDirty} onBusyChange={setGitBusy} /></div>}
        <div hidden={tab !== 'memory'}><MemoryPanel project={project} importBlocked={handoffDirty || handoffBusy || editing} blockedMessage={wrapUpDirty || wrapUpBusy ? r('resolveWrapUp') : undefined} onChange={onChange} onDirtyChange={setMemoryDirty} onBusyChange={setMemoryBusy} /></div>
        {handoffVisited && <div hidden={tab !== 'handoff'}><HandoffPanel project={project} tasks={tasks} desktopApps={desktopApps} memoryDirty={memoryDirty || wrapUpDirty} memoryBusy={memoryBusy || wrapUpBusy} onChange={onChange} onDirtyChange={setHandoffDirty} onBusyChange={setHandoffBusy} /></div>}
      </div>
    </Modal>
    {editing && <ProjectForm project={project} categories={[...new Set(projects.map(p => p.category).filter(Boolean))]} onClose={() => setEditing(false)} onSaved={onChange} />}
    {removing && <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} onRemoved={async () => { await onChange(); onClose(); }} />}
    {discard && <ConfirmDialog title={t('detail.unsaved')} confirmLabel={t('detail.discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}>{workDirty && <p>{w('dirtyDescription')}</p>}{memoryDirty && <p>{t('detail.discardMemory')}</p>}{wrapUpDirty && <p>{r('wrapUpLeaveDescription')}</p>}{handoffDirty && <p>{t('detail.discardHandoff')}</p>}{gitDirty && <p>{t('detail.discardGit')}</p>}</ConfirmDialog>}
  </>;
}
