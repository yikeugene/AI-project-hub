import { useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, CheckSquare2, Clock3, FileText, GitBranch, LayoutDashboard, Pencil, Trash2 } from 'lucide-react';
import { getResumeSummary } from '../../shared/insights';
import type { Capabilities, DesktopCapabilities, Project, Task } from '../../shared/types';
import { formatDate } from '../hooks';
import { useLocale, useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { GitPanel } from '../panels/GitPanel';
import { HandoffPanel } from '../panels/HandoffPanel';
import { MemoryPanel } from '../panels/MemoryPanel';
import { TasksPanel } from '../panels/TasksPanel';
import { ProjectForm, RemoveProjectDialog } from './ProjectForm';
import { QuickActions } from './QuickActions';
import { Button, ConfirmDialog, Modal, PriorityBadge, StatusBadge } from './ui';
type DetailTab = 'overview' | 'tasks' | 'git' | 'memory' | 'handoff';
const tabs = [{ id: 'overview', labelKey: 'detail.overview', icon: LayoutDashboard }, { id: 'tasks', labelKey: 'detail.tasks', icon: CheckSquare2 }, { id: 'git', labelKey: 'detail.git', icon: GitBranch }, { id: 'memory', labelKey: 'detail.memory', icon: BookOpen }, { id: 'handoff', labelKey: 'detail.handoff', icon: FileText }] as const;

export function ProjectDetail({ project, projects, tasks, capabilities, desktopApps, onClose, onChange, initialTab = 'overview' }: { project: Project; projects: Project[]; tasks: Task[]; capabilities: Capabilities; desktopApps: DesktopCapabilities; onClose: () => void; onChange: () => Promise<void>; initialTab?: DetailTab }) {
  const t = useT(shellCatalog); const locale = useLocale();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [handoffDirty, setHandoffDirty] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffVisited, setHandoffVisited] = useState(initialTab === 'handoff');
  const [discard, setDiscard] = useState(false);
  const busy = memoryBusy || handoffBusy;
  const resume = getResumeSummary(project, tasks, locale);
  const selectTab = (next: DetailTab) => { if (busy) return; if (next === 'handoff') setHandoffVisited(true); setTab(next); };
  const close = () => { if (busy) return; if (memoryDirty || handoffDirty) setDiscard(true); else onClose(); };
  const ownTasks = tasks.filter(task => task.projectId === project.id);
  return <>
    <Modal title={project.name} description={project.path} onClose={close} wide className="project-detail">
      <div className="detail-meta"><div><StatusBadge status={project.status} /><PriorityBadge priority={project.priority} /><span className="detail-category">{project.category || t('common.uncategorized')}{project.stage ? ` / ${project.stage}` : ''}</span></div><div><Button variant="ghost" icon={Pencil} disabled={busy} onClick={() => setEditing(true)}>{t('detail.edit')}</Button><Button variant="ghost" icon={Trash2} disabled={busy || memoryDirty || handoffDirty} title={t(memoryDirty || handoffDirty ? 'detail.resolveDrafts' : 'detail.removeRecord')} onClick={() => setRemoving(true)}>{t('common.remove')}</Button></div></div>
      <nav className="detail-tabs" aria-label={t('detail.navigation')}>{tabs.map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} disabled={busy} onClick={() => selectTab(item.id)}><item.icon size={16} />{t(item.labelKey)}{item.id === 'tasks' && ownTasks.length > 0 && <span className="tab-count">{ownTasks.filter(task => task.status !== 'done').length}</span>}{((item.id === 'memory' && memoryDirty) || (item.id === 'handoff' && handoffDirty)) && <span className="unsaved-dot" aria-label={t('common.unsaved')} />}</button>)}</nav>
      <div className="detail-content">
        {tab === 'overview' && <div className="overview-panel"><div className="overview-intro"><div><h3>{t('detail.resume')}</h3><p>{project.description || t('detail.noDescription')}</p></div><span className="revision-label">{t('detail.revision', { revision: project.revision })}</span></div><QuickActions project={project} capabilities={capabilities} desktopApps={desktopApps} />
          <div className="resume-checkpoint"><div className="resume-title"><Clock3 size={18} /><h3>{t('detail.checkpoint')}</h3><button className="text-button subtle-link" onClick={() => selectTab('memory')}>{t('detail.editMemory')}<ArrowUpRight size={14} /></button></div><p className="preserve-lines">{resume.checkpoint}</p></div>
          <div className="resume-next"><span className="next-icon"><ArrowRight size={20} /></span><div><h3>{t('detail.next')}</h3><p className="preserve-lines">{resume.nextAction}</p></div></div>
          <section className="detail-section"><h3>{t('detail.facts')}</h3><ul className="fact-list">{resume.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul><p className="field-hint">{t('detail.factsHint')}</p></section>
          {project.memory.blockers && <section className="detail-section blockers-note"><h3>{t('detail.blockers')}</h3><p className="preserve-lines">{project.memory.blockers}</p></section>}
          <div className="overview-bottom"><span>{t('detail.joined', { date: formatDate(project.createdAt, false, locale) })}</span><Button icon={FileText} onClick={() => selectTab('handoff')}>{t('detail.prepareHandoff')}</Button></div>
        </div>}
        {tab === 'tasks' && <TasksPanel projects={projects} tasks={tasks} projectId={project.id} onChange={onChange} />}
        {tab === 'git' && <GitPanel project={project} onChange={onChange} />}
        <div hidden={tab !== 'memory'}><MemoryPanel project={project} onChange={onChange} onDirtyChange={setMemoryDirty} onBusyChange={setMemoryBusy} /></div>
        {handoffVisited && <div hidden={tab !== 'handoff'}><HandoffPanel project={project} tasks={tasks} desktopApps={desktopApps} memoryDirty={memoryDirty} memoryBusy={memoryBusy} onChange={onChange} onDirtyChange={setHandoffDirty} onBusyChange={setHandoffBusy} /></div>}
      </div>
    </Modal>
    {editing && <ProjectForm project={project} categories={[...new Set(projects.map(p => p.category).filter(Boolean))]} onClose={() => setEditing(false)} onSaved={onChange} />}
    {removing && <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} onRemoved={async () => { await onChange(); onClose(); }} />}
    {discard && <ConfirmDialog title={t('detail.unsaved')} confirmLabel={t('detail.discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}>{memoryDirty && <p>{t('detail.discardMemory')}</p>}{handoffDirty && <p>{t('detail.discardHandoff')}</p>}</ConfirmDialog>}
  </>;
}
