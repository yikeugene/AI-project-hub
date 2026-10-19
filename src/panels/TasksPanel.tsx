import { useMemo, useState, type FormEvent } from 'react';
import { Check, CheckSquare2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { PRIORITIES, getPriorityLabels, getTaskLabels, TASK_STATUSES, type Project, type Task, type TaskStatus } from '../../shared/types';
import { api, type TaskInput } from '../api';
import { useLocale, useT } from '../i18n';
import { taskMessages } from '../locales/panels-tasks';
import { useAction, useBeforeUnload } from '../hooks';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, IconButton, Modal, PriorityBadge, SectionHeading } from '../components/ui';

function TaskForm({ task, projectId, projects, onClose, onSaved }: { task?: Task; projectId?: string; projects: Project[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const locale = useLocale(); const t = useT(taskMessages);
  const priorityLabels = getPriorityLabels(locale); const taskLabels = getTaskLabels(locale);
  const [initial] = useState<TaskInput>({ title: task?.title ?? '', detail: task?.detail ?? '', status: task?.status ?? 'todo', priority: task?.priority ?? 'normal' });
  const [baselineTask] = useState(task);
  const [form, setForm] = useState(initial);
  const [selectedProject, setSelectedProject] = useState(task?.projectId ?? projectId ?? projects[0]?.id ?? '');
  const [discard, setDiscard] = useState(false);
  const action = useAction();
  const dirty = JSON.stringify(initial) !== JSON.stringify(form);
  useBeforeUnload(dirty);
  const close = () => { if (!action.busy) { if (dirty) setDiscard(true); else onClose(); } };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const response = await action.run(async () => {
      if (baselineTask) await api.updateTask(baselineTask, { ...form, title: form.title.trim() });
      else await api.createTask(selectedProject, { ...form, title: form.title.trim() });
      await onSaved();
    });
    if (response.ok) onClose();
  };
  return <><Modal title={task ? t('edit') : t('add')} onClose={close}><form onSubmit={event => { void submit(event); }}><div className="modal-body form-stack"><ErrorNotice message={action.error} />
    {!projectId && !task && <Field label={t('project')} required><select required value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>}
    <Field label={t('name')} required><input autoFocus required maxLength={500} value={form.title} onChange={e => setForm(current => ({ ...current, title: e.target.value }))} placeholder={t('namePlaceholder')} /></Field>
    <Field label={t('detail')}><textarea rows={4} maxLength={10000} value={form.detail} onChange={e => setForm(current => ({ ...current, detail: e.target.value }))} placeholder={t('detailPlaceholder')} /></Field>
    <div className="form-grid"><Field label={t('status')}><select value={form.status} onChange={e => setForm(current => ({ ...current, status: e.target.value as TaskInput['status'] }))}>{TASK_STATUSES.map(status => <option key={status} value={status}>{taskLabels[status]}</option>)}</select></Field><Field label={t('priority')}><select value={form.priority} onChange={e => setForm(current => ({ ...current, priority: e.target.value as TaskInput['priority'] }))}>{PRIORITIES.map(priority => <option key={priority} value={priority}>{priorityLabels[priority]}</option>)}</select></Field></div>
  </div><footer className="modal-footer"><Button onClick={close} disabled={action.busy}>{t('cancel')}</Button><Button type="submit" variant="primary" busy={action.busy} disabled={!selectedProject || !form.title.trim()}>{task ? t('save') : t('add')}</Button></footer></form></Modal>{discard && <ConfirmDialog title={t('discardTitle')} confirmLabel={t('discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}><p>{t('discardDescription')}</p></ConfirmDialog>}</>;
}

export function TasksPanel({ projects, tasks, projectId, onChange, onOpenProject }: { projects: Project[]; tasks: Task[]; projectId?: string; onChange: () => Promise<void>; onOpenProject?: (id: string) => void }) {
  const locale = useLocale(); const t = useT(taskMessages);
  const priorityLabels = getPriorityLabels(locale); const taskLabels = getTaskLabels(locale);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('open');
  const [projectFilter, setProjectFilter] = useState('all');
  const [priority, setPriority] = useState('all');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [removing, setRemoving] = useState<Task | null>(null);
  const action = useAction(); const removeAction = useAction();
  const scope = tasks.filter(task => !projectId || task.projectId === projectId);
  const shown = useMemo(() => scope.filter(task => {
    const project = projects.find(p => p.id === task.projectId);
    return (status === 'all' || (status === 'open' ? task.status !== 'done' : task.status === status)) && (projectFilter === 'all' || task.projectId === projectFilter) && (priority === 'all' || task.priority === priority) && `${task.title} ${task.detail} ${project?.name ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }).sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.createdAt.localeCompare(b.createdAt)), [scope, projects, status, projectFilter, priority, query]);
  const updateStatus = (task: Task, next: TaskStatus) => { void action.run(async () => { await api.updateTask(task, { status: next }); await onChange(); }); };
  return <section className={`tasks-panel ${projectId ? 'tasks-embedded' : 'panel'}`}>
    <SectionHeading title={projectId ? t('projectTasks') : t('allTasks')} subtitle={t('counts', { open: scope.filter(task => task.status !== 'done').length, done: scope.filter(task => task.status === 'done').length })}><Button icon={Plus} variant="primary" disabled={!projects.length} onClick={() => setEditing('new')}>{t('add')}</Button></SectionHeading>
    <div className="filter-bar task-filters"><label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label={t('search')} placeholder={t('searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label={t('statusFilter')} value={status} onChange={e => setStatus(e.target.value)}><option value="open">{t('open')}</option><option value="all">{t('allStatuses')}</option>{TASK_STATUSES.map(s => <option key={s} value={s}>{taskLabels[s]}</option>)}</select>{!projectId && <select aria-label={t('projectFilter')} value={projectFilter} onChange={e => setProjectFilter(e.target.value)}><option value="all">{t('allProjects')}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}<select aria-label={t('priorityFilter')} value={priority} onChange={e => setPriority(e.target.value)}><option value="all">{t('allPriorities')}</option>{PRIORITIES.map(p => <option key={p} value={p}>{priorityLabels[p]}</option>)}</select></div>
    <ErrorNotice message={action.error} onDismiss={() => action.setError('')} />
    {shown.length ? <div className="task-list">{shown.map(task => {
      const project = projects.find(p => p.id === task.projectId);
      return <div className={`task-row ${task.status === 'done' ? 'task-completed' : ''}`} key={task.id}>
        <button className={`task-check ${task.status === 'done' ? 'is-checked' : ''}`} aria-label={t(task.status === 'done' ? 'reopenLabel' : 'completeLabel', { title: task.title })} disabled={action.busy} onClick={() => updateStatus(task, task.status === 'done' ? 'todo' : 'done')}>{task.status === 'done' && <Check size={14} />}</button>
        <div className="task-content"><button className="task-title text-button" onClick={() => setEditing(task)}>{task.title}</button>{task.detail && <p className="task-description">{task.detail}</p>}{!projectId && <button className="task-project text-button" onClick={() => onOpenProject?.(task.projectId)}>{project?.name ?? t('unknownProject')}</button>}</div>
        <PriorityBadge priority={task.priority} /><select className={`task-status-select task-${task.status}`} aria-label={t('statusLabel', { title: task.title })} value={task.status} disabled={action.busy} onChange={e => updateStatus(task, e.target.value as TaskStatus)}>{TASK_STATUSES.map(s => <option key={s} value={s}>{taskLabels[s]}</option>)}</select>
        <div className="row-actions"><IconButton icon={Pencil} label={t('editLabel', { title: task.title })} onClick={() => setEditing(task)} /><IconButton icon={Trash2} label={t('deleteLabel', { title: task.title })} onClick={() => { removeAction.setError(''); setRemoving(task); }} /></div>
      </div>;
    })}</div> : <EmptyState icon={CheckSquare2} title={scope.length ? t('noMatches') : t('emptyTitle')} description={scope.length ? t('noMatchesDescription') : projects.length ? t('emptyDescription') : t('noProjects')}>{scope.length > 0 && <Button onClick={() => { setQuery(''); setStatus('all'); setPriority('all'); setProjectFilter('all'); }}>{t('clearFilters')}</Button>}</EmptyState>}
    {editing && <TaskForm task={editing === 'new' ? undefined : editing} projectId={projectId} projects={projects} onClose={() => setEditing(null)} onSaved={onChange} />}
    {removing && <ConfirmDialog title={t('deleteTitle')} danger confirmLabel={t('delete')} busy={removeAction.busy} error={removeAction.error} onClose={() => setRemoving(null)} onConfirm={() => { void removeAction.run(async () => { await api.removeTask(removing); await onChange(); setRemoving(null); }); }}><p>{t('deleteDescription', { title: removing.title })}</p></ConfirmDialog>}
  </section>;
}
