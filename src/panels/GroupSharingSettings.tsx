import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { DeviceGroup, GroupShareInput, GroupSharingPreview, MemoryField, SharedPreview } from '../../shared/devices';
import { MEMORY_FIELDS, getMemoryLabels, type Project } from '../../shared/types';
import { translateError } from '../../shared/messages';
import { deviceApi, errorMessage } from '../api';
import { canonicalGroupPolicies, groupSharePolicies, shortDeviceId } from '../device-ui';
import { useAction } from '../hooks';
import { useLocale, useT } from '../i18n';
import { sharingMessages } from '../locales/panels-sharing';
import { Button, ConfirmDialog, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';

const targetSet = (groups: DeviceGroup[]) => JSON.stringify(groups.filter(group => group.paired && !group.pairingPending && group.connection !== 'revoked').map(group => group.id).sort());
export function GroupSharingSettings({ projects, groups, enabled, blocked, onDirtyChange, onBusyChange, onChange }: {
  projects: Project[]; groups: DeviceGroup[]; enabled: boolean; blocked: boolean; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; onChange: () => Promise<void>;
}) {
  const locale = useLocale(); const t = useT(sharingMessages);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [current, setCurrent] = useState<GroupSharingPreview | null>(null);
  const [policies, setPolicies] = useState<GroupShareInput[]>([]);
  const [preview, setPreview] = useState<GroupSharingPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pendingProject, setPendingProject] = useState<string | null>(null);
  const [deselect, setDeselect] = useState<string | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [readVersion, setReadVersion] = useState(0);
  const [loadedTargets, setLoadedTargets] = useState('');
  const action = useAction(projectId); const sequence = useRef(0); const alive = useRef(true);
  const scopeRef = useRef(projectId); scopeRef.current = projectId;
  const project = projects.find(item => item.id === projectId);
  const targets = targetSet(groups);
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const targetsChanged = !!current && loadedTargets !== targets;
  const dirty = !!current && (canonicalGroupPolicies(policies) !== canonicalGroupPolicies(groupSharePolicies(current)) || !!preview);
  const busy = readBusy || action.busy;
  const stale = !!preview && (preview.projectId !== projectId || preview.revision !== project?.revision || targetsChanged || canonicalGroupPolicies(groupSharePolicies(preview)) !== canonicalGroupPolicies(policies));
  const previewInvalid = !!preview?.groups.some(item => item.preview.error || item.preview.errorCode);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    const request = ++sequence.current; const expectedTargets = targetsRef.current;
    setCurrent(null); setPolicies([]); setPreview(null); setConfirm(false); setSaved(false); setReadError(null); setReadBusy(!!projectId);
    if (projectId) void deviceApi.groupSharing(projectId).then(result => {
      if (alive.current && request === sequence.current && scopeRef.current === projectId) { setCurrent(result); setPolicies(groupSharePolicies(result)); setLoadedTargets(expectedTargets); }
    }).catch(error => { if (alive.current && request === sequence.current) setReadError(error); }).finally(() => { if (alive.current && request === sequence.current) setReadBusy(false); });
    return () => { sequence.current++; };
  }, [projectId, readVersion]);
  const invalidate = () => { sequence.current++; setPreview(null); setConfirm(false); setSaved(false); action.setError(null); };
  const change = (profileId: string, update: Partial<GroupShareInput>) => { invalidate(); setPolicies(value => value.map(policy => policy.profileId === profileId ? { ...policy, ...update } : policy)); };
  const readAgain = () => { setReloadConfirm(false); setReadVersion(value => value + 1); };
  const prepare = async () => {
    if (!current || !project || !enabled || blocked || busy || targetsChanged) return;
    invalidate(); const request = ++sequence.current; const expected = projectId; const expectedTargets = targets;
    const captured = policies.map(policy => ({ ...policy, memoryFields: [...policy.memoryFields] }));
    const result = await action.run(() => deviceApi.previewGroupSharing(expected, captured));
    if (result.ok && alive.current && request === sequence.current && scopeRef.current === expected && targetsRef.current === expectedTargets) setPreview(result.value);
  };
  const save = async () => {
    if (!preview || stale || previewInvalid || !enabled || blocked || busy) return;
    const captured = preview; const expectedTargets = targets; const request = ++sequence.current;
    const result = await action.run(async () => {
      const next = await deviceApi.saveGroupSharing(captured.projectId, groupSharePolicies(captured), captured.digest);
      if (alive.current && scopeRef.current === captured.projectId) await onChange();
      return next;
    });
    if (!alive.current || request !== sequence.current || scopeRef.current !== captured.projectId || targetsRef.current !== expectedTargets) return;
    // A rejected or lost response never leaves a reusable consent digest.
    setPreview(null); setConfirm(false);
    if (result.ok) { setCurrent(result.value); setPolicies(groupSharePolicies(result.value)); setSaved(true); }
  };
  const previewError = (value: SharedPreview) => value.errorCode ? translateError(value.errorCode, locale, value.errorParams) : value.error ?? '';
  const changeKind = (profileId: string, selected: boolean) => selected ? current?.groups.find(item => item.group.id === profileId)?.preview.policy.enabled ? 'retained' : 'added' : current?.groups.find(item => item.group.id === profileId)?.preview.policy.enabled ? 'withdrawn' : 'unchanged';
  return <section className="device-settings-section sharing-settings" aria-label={t('label')}><SectionHeading title={t('title')} subtitle={t('subtitle')} />
    {!enabled && <p className="field-hint">{t('disabled')}</p>}
    {!projects.length ? <p className="quiet-empty">{t('noProjects')}</p> : <><Field label={t('projectLabel')}><select value={project ? projectId : ''} disabled={busy || blocked} onChange={event => { if (dirty) setPendingProject(event.target.value); else setProjectId(event.target.value); }}><option value="" disabled>{t('chooseProject')}</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <ErrorNotice message={errorMessage(readError, locale)} />{!!readError && <Button disabled={busy || blocked} onClick={readAgain}>{t('retry')}</Button>}
      {readBusy ? <Loading label={t('loading')} /> : current && project && <><h3>{t('groups')}</h3><p className="field-hint">{t('groupsHint')}</p><p className="field-hint">{t('summaryHint')}</p>
        {targetsChanged && <Notice warning>{t('targetChanged')}</Notice>}
        {!current.groups.length && <p className="quiet-empty">{t('noGroups')}</p>}
        <div className="group-sharing-list">{current.groups.map(({ group, preview: stored }) => {
          const policy = policies.find(item => item.profileId === group.id);
          if (!policy) return null;
          return <section className="sharing-policy group-sharing-policy" key={group.id}>
            <label className="check-field"><input type="checkbox" checked={policy.enabled} disabled={!enabled || blocked || busy || targetsChanged} onChange={event => { if (!event.target.checked && stored.policy.enabled) setDeselect(group.id); else change(group.id, { enabled: event.target.checked }); }} /><span>{t('groupChoice', { label: group.label, id: shortDeviceId(group.id) })}</span></label>
            <p className="field-hint">{group.url}</p>
            <details className="group-memory-selection"><summary>{t('groupFields', { label: group.label })}</summary><MemoryShareFields fields={policy.memoryFields} disabled={!enabled || !policy.enabled || blocked || busy || targetsChanged} onChange={memoryFields => change(group.id, { memoryFields })} /></details>
            {(stored.error || stored.errorCode) && <Notice warning>{previewError(stored)} {t('errorHint')}</Notice>}
            <details className="current-sharing"><summary>{t('savedPolicy', { status: stored.policy.enabled ? t('shared') : t('unshared') })}</summary><p className="field-hint">{t('currentHint', { bytes: stored.bytes })}</p><pre className="safe-object" tabIndex={0} aria-label={t('currentLabel')}>{JSON.stringify(stored.project, null, 2)}</pre></details>
          </section>;
        })}</div>
        <div className="device-toolbar"><Button disabled={!enabled || blocked || busy || targetsChanged || !current.groups.length} busy={action.busy} onClick={() => { void prepare(); }}>{t('preview')}</Button><Button disabled={blocked || busy} onClick={() => { if (dirty) setReloadConfirm(true); else readAgain(); }}>{t('reloadPolicies')}</Button><span className="field-hint">{t(dirty ? 'unsaved' : 'confirmationRequired')}</span></div>
        {preview && <div className="sharing-preview"><h3>{t('fullPreview')}</h3><p>{t('audience')}<strong>{t('allDevices')}</strong></p>{preview.groups.map(({ group, preview: value }) => <section className="group-preview" key={group.id}><h4>{t('groupSummary', { label: group.label, id: shortDeviceId(group.id), change: t(changeKind(group.id, value.policy.enabled)) })}</h4>{(value.error || value.errorCode) && <Notice warning>{previewError(value)}</Notice>}<p className="field-hint">{t('previewHint', { bytes: value.bytes })}</p><pre className="safe-object" tabIndex={0} aria-label={t('previewLabel')}>{JSON.stringify(value.project, null, 2)}</pre>{changeKind(group.id, value.policy.enabled) === 'withdrawn' && <Notice warning>{t('withdrawWarning')}</Notice>}</section>)}{stale && <Notice warning>{t('stale')}</Notice>}<Button variant="primary" disabled={!enabled || busy || blocked || stale || previewInvalid} onClick={() => { action.setError(null); setConfirm(true); }}>{t('confirm')}</Button></div>}
        {saved && <p className="inline-success" role="status"><Check size={15} aria-hidden="true" />{t('saved')}</p>}
      </>}
    </>}
    {!confirm && <ErrorNotice message={action.error} />}
    {confirm && preview && <ConfirmDialog title={t('confirmGroupsTitle')} confirmLabel={t('confirmGroups')} busy={action.busy} confirmDisabled={!enabled || blocked || stale || previewInvalid} error={action.error} onClose={() => setConfirm(false)} onConfirm={() => { void save(); }}><p><strong>{project?.name}</strong>{t('shareDescription')}</p><ul>{preview.groups.map(({ group, preview: value }) => <li key={group.id}>{t('groupSummary', { label: group.label, id: shortDeviceId(group.id), change: t(changeKind(group.id, value.policy.enabled)) })}</li>)}</ul><Notice warning>{t('warning')}</Notice></ConfirmDialog>}
    {deselect && <ConfirmDialog title={t('deselectTitle')} confirmLabel={t('deselectConfirm')} danger onClose={() => setDeselect(null)} onConfirm={() => { change(deselect, { enabled: false }); setDeselect(null); }}><p>{t('deselectDescription')}</p></ConfirmDialog>}
    {pendingProject !== null && <ConfirmDialog title={t('switchTitle')} confirmLabel={t('switchConfirm')} danger onClose={() => setPendingProject(null)} onConfirm={() => { setProjectId(pendingProject); setPendingProject(null); }}><p>{t('switchDescription')}</p></ConfirmDialog>}
    {reloadConfirm && <ConfirmDialog title={t('unsaved')} confirmLabel={t('reloadPolicies')} danger onClose={() => setReloadConfirm(false)} onConfirm={readAgain}><p>{t('switchDescription')}</p></ConfirmDialog>}
  </section>;
}

export function MemoryShareFields({ fields, disabled, onChange }: { fields: MemoryField[]; disabled: boolean; onChange: (fields: MemoryField[]) => void }) {
  const t = useT(sharingMessages); const labels = getMemoryLabels(useLocale());
  const all = MEMORY_FIELDS.every(field => fields.includes(field));
  return <fieldset className="memory-share-fields" disabled={disabled}><legend>{t('memoryLegend')}</legend><label className="check-field memory-share-all"><input type="checkbox" checked={all} aria-checked={fields.length > 0 && !all ? 'mixed' : all} ref={input => { if (input) input.indeterminate = fields.length > 0 && !all; }} onChange={event => onChange(event.target.checked ? [...MEMORY_FIELDS] : [])} /><span>{t('selectAll')}</span></label>{MEMORY_FIELDS.map(field => <label className="check-field" key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => onChange(MEMORY_FIELDS.filter(key => key === field ? event.target.checked : fields.includes(key)))} /><span>{labels[field]}</span></label>)}</fieldset>;
}
