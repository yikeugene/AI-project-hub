import { useState, type FormEvent } from 'react';
import { FolderOpen, FolderPlus, Save } from 'lucide-react';
import { PRIORITIES, getPriorityLabels, PROJECT_STATUSES, getStatusLabels, type Project } from '../../shared/types';
import { api, type ProjectInput } from '../api';
import { useAction, useBeforeUnload } from '../hooks';
import { useLocale, useT } from '../i18n';
import { shellCatalog } from '../locales/shell';
import { Button, ConfirmDialog, ErrorNotice, Field, Modal, Notice } from './ui';

export function ProjectForm({ project, categories, onClose, onSaved }: { project?: Project; categories: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT(shellCatalog); const locale = useLocale();
  const statusLabels = getStatusLabels(locale); const priorityLabels = getPriorityLabels(locale);
  const [initial] = useState<ProjectInput>(() => ({ path: project?.path ?? '', name: project?.name ?? '', description: project?.description ?? '', category: project?.category ?? '', status: project?.status ?? 'active', priority: project?.priority ?? 'normal', stage: project?.stage ?? '', nextAction: project?.nextAction ?? '' }));
  const [revision] = useState(project?.revision ?? 0);
  const [form, setForm] = useState(initial);
  const [discard, setDiscard] = useState(false);
  const action = useAction(); const choosing = useAction();
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useBeforeUnload(dirty);
  const busy = action.busy || choosing.busy;
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  const set = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setForm(current => ({ ...current, [key]: value }));
  const chooseDirectory = async () => {
    const bridge = window.hubDesktop;
    if (!bridge || project) return;
    const result = await choosing.run(() => bridge.chooseDirectory());
    if (result.ok && result.value !== null) set('path', result.value);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = await action.run(async () => {
      if (project) { const { path: _path, ...input } = form; await api.updateProject(project.id, revision, input); }
      else await api.createProject({ ...form, path: form.path.trim(), name: form.name.trim() });
      await onSaved();
    });
    if (result.ok) onClose();
  };
  return <>
    <Modal title={t(project ? 'detail.edit' : 'form.addTitle')} description={t(project ? 'form.editDescription' : 'form.addDescription')} onClose={close}>
      <form onSubmit={event => { void submit(event); }}>
        <div className="modal-body form-stack"><ErrorNotice message={action.error} /><ErrorNotice message={choosing.error} />
          <div className="path-picker"><Field label={t('form.folder')} required={!project} hint={t(project ? 'form.fixedPath' : 'form.pathHint')}><input required maxLength={4096} value={form.path} onChange={e => set('path', e.target.value)} readOnly={!!project} disabled={busy} placeholder="C:\Projects\my-app" autoComplete="off" spellCheck={false} /></Field>{window.hubDesktop && !project && <Button icon={FolderOpen} disabled={action.busy} busy={choosing.busy} onClick={() => { void chooseDirectory(); }}>{t('common.chooseFolder')}</Button>}</div>
          <Field label={t('form.name')} required={!!project} hint={!project ? t('form.nameHint') : undefined}><input value={form.name} onChange={e => set('name', e.target.value)} required={!!project} maxLength={120} placeholder={t('form.namePlaceholder')} /></Field>
          <Field label={t('form.description')}><textarea value={form.description} onChange={e => set('description', e.target.value)} rows={2} maxLength={2000} placeholder={t('form.descriptionPlaceholder')} /></Field>
          <div className="form-grid"><Field label={t('form.category')}><input value={form.category} onChange={e => set('category', e.target.value)} list="project-categories" maxLength={80} placeholder={t('form.categoryPlaceholder')} /><datalist id="project-categories">{categories.map(category => <option key={category} value={category} />)}</datalist></Field><Field label={t('form.stage')}><input value={form.stage} onChange={e => set('stage', e.target.value)} maxLength={160} placeholder={t('form.stagePlaceholder')} /></Field></div>
          <div className="form-grid"><Field label={t('form.status')}><select value={form.status} onChange={e => set('status', e.target.value as ProjectInput['status'])}>{PROJECT_STATUSES.map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></Field><Field label={t('form.priority')}><select value={form.priority} onChange={e => set('priority', e.target.value as ProjectInput['priority'])}>{PRIORITIES.map(priority => <option key={priority} value={priority}>{priorityLabels[priority]}</option>)}</select></Field></div>
          <Field label={t('common.nextAction')} hint={t('form.nextHint')}><textarea value={form.nextAction} onChange={e => set('nextAction', e.target.value)} rows={2} maxLength={2000} placeholder={t('form.nextPlaceholder')} /></Field>
        </div>
        <footer className="modal-footer"><Button onClick={close} disabled={busy}>{t('common.cancel')}</Button><Button type="submit" variant="primary" icon={project ? Save : FolderPlus} busy={action.busy} disabled={choosing.busy}>{t(project ? 'form.save' : 'form.add')}</Button></footer>
      </form>
    </Modal>
    {discard && <ConfirmDialog title={t('form.discardTitle')} confirmLabel={t('form.discard')} danger onClose={() => setDiscard(false)} onConfirm={onClose}><p>{t('form.discardDescription')}</p></ConfirmDialog>}
  </>;
}

export function RemoveProjectDialog({ project: currentProject, onClose, onRemoved }: { project: Project; onClose: () => void; onRemoved: () => Promise<void> }) {
  const t = useT(shellCatalog);
  const [project] = useState(currentProject);
  const action = useAction();
  const [beforeName, afterName] = t('form.removeDescription').split('{name}');
  return <ConfirmDialog title={t('form.removeTitle')} danger confirmLabel={t('form.remove')} busy={action.busy} error={action.error} onClose={onClose} onConfirm={() => { void action.run(async () => { await api.removeProject(project); await onRemoved(); onClose(); }); }}>
    <p>{beforeName}<strong>{project.name}</strong>{afterName}</p><Notice>{t('form.removeSafety')}</Notice><p className="path-text">{project.path}</p>
  </ConfirmDialog>;
}
