import { useCallback, useEffect, useRef, useState } from 'react';
import { FileCode2, GitBranch, GitCommitHorizontal, RefreshCw, ShieldCheck } from 'lucide-react';
import { LocalizedError, createTranslator, type Locale } from '../../shared/i18n';
import type { DeviceState } from '../../shared/devices';
import { GIT_OPERATION_KINDS, gitOperationSchema, type GitDetails, type GitDiff, type GitDiffInput, type GitOperation, type GitPreview } from '../../shared/git';
import type { GitChange, Project } from '../../shared/types';
import { errorMessage, gitApi } from '../api';
import { isNetworkOnline } from '../device-ui';
import { gitDiagnosticKey, gitOperationStateKey, gitWriteBlockReason, hasCurrentGovernance, isConflict, isStaged, isUnstaged } from '../git-ui';
import { formatDate, useAction, useBeforeUnload, useNow, type GovernanceController } from '../hooks';
import { GitReview } from '../components/GitReview';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Loading, Notice, SectionHeading } from '../components/ui';
import { useLocale, useT } from '../i18n';
import { gitMessages } from '../locales/panels-git';
import { GitRequests } from './GitRequests';

const changeLabel = (change: GitChange, locale: Locale) => {
  const t = createTranslator(gitMessages, locale);
  if (isConflict(change)) return t('conflict');
  if (change.index === '?' || change.worktree === '?') return t('untracked');
  const labels: Record<string, string> = { M: t('modified'), A: t('added'), D: t('deleted'), R: t('renamed'), C: t('copied'), T: t('typeChanged') };
  return [change.index.trim() ? t('stagedChange', { change: labels[change.index] ?? change.index }) : '', change.worktree.trim() ? labels[change.worktree] ?? change.worktree : ''].filter(Boolean).join(' / ') || t('changed');
};

type Props = {
  project: Project; devices: DeviceState | null; governance: GovernanceController; active: boolean;
  onChange: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
};
export function GitPanel({ project, devices, governance, active, onChange, onDirtyChange, onBusyChange }: Props) {
  const locale = useLocale(); const t = useT(gitMessages); const now = useNow();
  const [details, setDetails] = useState<GitDetails | null>(null);
  const [readBusy, setReadBusy] = useState(true);
  const [readError, setReadError] = useState<unknown>(null);
  const [diffInput, setDiffInput] = useState<GitDiffInput | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<unknown>(null);
  const [kind, setKind] = useState<GitOperation['kind']>('stage');
  const [unstagedPaths, setUnstagedPaths] = useState<string[]>([]);
  const [stagedPaths, setStagedPaths] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [identityEdited, setIdentityEdited] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [remote, setRemote] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [preview, setPreview] = useState<(GitPreview & { profileId: string }) | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [submitConfirm, setSubmitConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [requestBusy, setRequestBusy] = useState(false);
  const action = useAction(devices?.profileId);
  const readSequence = useRef(0); const diffSequence = useRef(0); const planSequence = useRef(0);
  const alive = useRef(true);
  const profileScope = devices?.profileId ?? null;
  const scopeRef = useRef(profileScope); scopeRef.current = profileScope;
  const busy = action.busy || requestBusy || readBusy || diffBusy;
  const dirty = !!preview || !!message || identityEdited || !!newBranch || !!targetBranch || !!remote || !!remoteBranch || !!unstagedPaths.length || !!stagedPaths.length;
  useBeforeUnload(dirty || busy);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; readSequence.current++; diffSequence.current++; planSequence.current++; }; }, []);
  useEffect(() => { planSequence.current++; setPreview(null); setSubmitConfirm(false); setReviewer(''); }, [profileScope]);

  const readDetails = useCallback(async (): Promise<GitDetails | null> => {
    const sequence = ++readSequence.current;
    diffSequence.current++; setDiff(null); setDiffInput(null); setDiffBusy(false); setDiffError(null);
    setReadBusy(true); setReadError(null); setDetails(null);
    try {
      const next = await gitApi.details(project.id);
      if (!alive.current || sequence !== readSequence.current) return null;
      setDetails(next);
      setUnstagedPaths(paths => paths.filter(path => next.snapshot.changes.some(change => change.path === path && isUnstaged(change))));
      setStagedPaths(paths => paths.filter(path => next.snapshot.changes.some(change => change.path === path && isStaged(change))));
      return next;
    } catch (error) { if (alive.current && sequence === readSequence.current) setReadError(error); return null; }
    finally { if (alive.current && sequence === readSequence.current) setReadBusy(false); }
  }, [project.id]);
  useEffect(() => { if (active) void readDetails(); }, [active, readDetails]);
  useEffect(() => { if (details && !identityEdited) { setAuthorName(details.identity.name); setAuthorEmail(details.identity.email); } }, [details, identityEdited]);

  const git = details?.snapshot;
  const governanceValid = hasCurrentGovernance(governance.state, devices) && !governance.error;
  const canManage = governanceValid && isNetworkOnline(devices);
  const writeBlockReason = gitWriteBlockReason(devices, governance.state, governance.loading, !!governance.error);
  const canWrite = canManage && !!git?.isRepo && !readError && !readBusy && !details?.unsupportedReasons.length && !details?.operationState && !git.conflictCount;
  const reviewers = governanceValid ? (governance.state?.policy?.roles ?? []).filter(role => role.role === 'admin' && (role.deviceId === devices?.localDevice.id || devices?.devices.some(device => device.id === role.deviceId && !device.revokedAt))) : [];
  const reviewerValid = reviewers.some(item => item.deviceId === reviewer);
  const previewExpired = !!preview && (preview.profileId !== profileScope || Date.parse(preview.expiresAt) <= now);
  const invalidate = () => { planSequence.current++; setPreview(null); setSubmitConfirm(false); setSubmitted(false); setStaleNotice(false); action.setError(null); };
  const clearDraft = () => {
    invalidate(); setMessage(''); setIdentityEdited(false); setAuthorName(details?.identity.name ?? ''); setAuthorEmail(details?.identity.email ?? '');
    setNewBranch(''); setTargetBranch(''); setRemote(''); setRemoteBranch(''); setStagedPaths([]); setUnstagedPaths([]); setReviewer('');
  };
  const togglePath = (path: string, source: 'index' | 'worktree', checked: boolean) => {
    invalidate(); const setter = source === 'index' ? setStagedPaths : setUnstagedPaths;
    setter(paths => checked ? [...paths, path] : paths.filter(value => value !== path));
  };
  const readDiff = async (input: GitDiffInput) => {
    const sequence = ++diffSequence.current;
    setDiffInput(input); setDiff(null); setDiffError(null); setDiffBusy(true);
    try { const next = await gitApi.diff(project.id, input); if (alive.current && sequence === diffSequence.current) setDiff(next); }
    catch (error) { if (alive.current && sequence === diffSequence.current) setDiffError(error); }
    finally { if (alive.current && sequence === diffSequence.current) setDiffBusy(false); }
  };
  const operation = (): GitOperation => {
    switch (kind) {
      case 'stage': return { kind, paths: unstagedPaths };
      case 'unstage': return { kind, paths: stagedPaths };
      case 'commit': return { kind, message, authorName, authorEmail };
      case 'createBranch': return { kind, branch: newBranch };
      case 'switchBranch': return { kind, branch: targetBranch };
      case 'fetch': case 'pull': case 'push': return { kind, remote, branch: remoteBranch };
    }
  };
  const validOperation = gitOperationSchema.safeParse(operation());
  const prepare = async () => {
    if (!profileScope || !canWrite || busy) return;
    invalidate(); const sequence = ++planSequence.current; const scope = profileScope;
    const result = await action.run(async () => {
      const parsed = gitOperationSchema.safeParse(operation());
      if (!parsed.success) throw new LocalizedError(gitMessages, 'invalidOperation');
      return gitApi.preview(scope, project.id, parsed.data);
    });
    if (!alive.current || sequence !== planSequence.current || scopeRef.current !== scope) return;
    if (result.ok) setPreview({ ...result.value, profileId: scope });
    else { setStaleNotice(true); await readDetails(); }
  };
  const submit = async () => {
    if (!preview || preview.profileId !== profileScope || !canWrite || !reviewerValid || Date.parse(preview.expiresAt) <= Date.now() || busy) return;
    const captured = preview; const scope = captured.profileId; const sequence = ++planSequence.current;
    const result = await action.run(() => gitApi.submit(scope, captured.id, reviewer, captured.digest));
    if (!alive.current || sequence !== planSequence.current || scopeRef.current !== scope) return;
    setSubmitConfirm(false); setPreview(null); setRequestVersion(value => value + 1);
    if (result.ok) { clearDraft(); setSubmitted(true); }
    else { setStaleNotice(true); await readDetails(); }
  };
  const afterExecution = async () => { invalidate(); await Promise.all([readDetails(), onChange()]); };

  const fileList = (source: 'index' | 'worktree') => {
    const files = git?.changes.filter(source === 'index' ? isStaged : isUnstaged) ?? [];
    const selected = source === 'index' ? stagedPaths : unstagedPaths;
    return <section className="git-file-section"><h3>{t(source === 'index' ? 'stagedFiles' : 'worktreeChanges')} <span className="count-label">{files.length}</span></h3>
      <p className="field-hint">{t('selected', { count: selected.length })}</p>
      {files.length ? <ul className="git-file-list">{files.map((change, index) => <li key={`${index}:${change.path}`} className={diffInput?.path === change.path && diffInput.source === source ? 'selected' : ''}>
        <label className="git-file-choice"><input type="checkbox" checked={selected.includes(change.path)} disabled={!canWrite || busy || isConflict(change) || (!selected.includes(change.path) && selected.length >= 200)} aria-label={t('selectFile', { path: change.path })} onChange={event => togglePath(change.path, source, event.target.checked)} /><span><code className="preserve-lines">{change.path}</code>{change.originalPath && <small className="preserve-lines">{t('renameFrom', { path: change.originalPath })}</small>}<small>{changeLabel(change, locale)}</small></span></label>
        <button type="button" className="icon-button" aria-label={t('viewDiff', { path: change.path })} title={t('viewDiff', { path: change.path })} disabled={readBusy || action.busy || requestBusy} onClick={() => { void readDiff({ path: change.path, source }); }}><FileCode2 size={16} aria-hidden="true" /></button>
      </li>)}</ul> : <p className="quiet-empty">{t(source === 'index' ? 'noStaged' : 'cleanWorktree')}</p>}
    </section>;
  };

  return <section className="git-panel">
    <SectionHeading title={t('title')} subtitle={git ? t('lastChecked', { date: formatDate(git.observedAt, true, locale) }) : t('notChecked')}><Button icon={RefreshCw} busy={readBusy} disabled={action.busy || requestBusy || diffBusy} onClick={() => { invalidate(); void readDetails(); }}>{t('refresh')}</Button></SectionHeading>
    <ErrorNotice message={errorMessage(readError, locale)} />
    {writeBlockReason && <Notice warning><p>{t(writeBlockReason)}</p><p className="field-hint">{t('writeRequirements')}</p></Notice>}
    <ErrorNotice message={governance.error || governance.state?.error || ''} />
    {readBusy ? <Loading label={t('loading')} /> : !git ? <EmptyState compact icon={GitBranch} title={t('unavailableTitle')} description={t('unavailableDescription')} /> : !git.isRepo ? <EmptyState compact icon={GitBranch} title={t('notRepoTitle')} description={t('notRepoDescription')} /> : <>
      <p className="git-workflow"><ShieldCheck size={17} aria-hidden="true" />{t('workflow')}</p>
      <div className="git-summary"><div className="git-branch"><GitBranch size={20} aria-hidden="true" /><div><span className="muted">{t('branch')}</span><strong>{git.branch || t('detachedHead')}</strong></div></div><dl><div><dt>{t('changes')}</dt><dd>{git.changedCount}</dd></div><div><dt>{t('untracked')}</dt><dd>{git.untrackedCount}</dd></div><div><dt>{t('staged')}</dt><dd>{git.stagedCount}</dd></div><div><dt>{t('conflict')}</dt><dd>{git.conflictCount}</dd></div></dl></div>
      <p className="field-hint">{t('upstream')}: {details?.upstream ?? t('noUpstream')} · {t('aheadBehind', { ahead: details?.ahead ?? t('unknownCount'), behind: details?.behind ?? t('unknownCount') })}</p>
      {!!git.conflictCount && <Notice warning>{t('conflictNotice', { count: git.conflictCount })}</Notice>}
      {details?.operationState && <Notice warning>{t('operationState', { state: t(gitOperationStateKey(details.operationState)) })}</Notice>}
      {!!details?.unsupportedReasons.length && <Notice warning>{t('unsupported')}<ul>{details.unsupportedReasons.map((reason, index) => <li key={index}>{t(gitDiagnosticKey(reason))}</li>)}</ul></Notice>}
      <div className="git-inspection"><div className="git-file-sections">{fileList('worktree')}{fileList('index')}<p className="field-hint">{t('selectionLimit')}</p></div>
        <section className="git-diff"><h3>{t('diffTitle')}</h3><p className="field-hint">{t('diffLocal')}</p>
          {diffInput && <p className="git-diff-caption"><strong>{t('diffSource', { source: t(diffInput.source) })}</strong><code className="preserve-lines">{diffInput.path}</code></p>}
          <ErrorNotice message={errorMessage(diffError, locale)} />{diffBusy ? <Loading label={t('diffLoading')} /> : diff ? <>{diff.binary && <Notice>{t('binary')}</Notice>}{diff.truncated && <Notice warning>{t('truncated')}</Notice>}<pre className="git-diff-text" tabIndex={0} aria-label={t('diffTitle')}>{diff.text || t('diffNoText')}</pre></> : !diffError && <p className="quiet-empty">{t('diffEmpty')}</p>}
        </section></div>
      <section className="git-action-section"><Field label={t('operation')}><select value={kind} disabled={busy} onChange={event => { invalidate(); setKind(event.target.value as GitOperation['kind']); }}>{GIT_OPERATION_KINDS.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field>
        <fieldset className="git-action-fields" disabled={!canWrite || busy}><legend className="sr-only">{t('operation')}</legend>
          {kind === 'commit' && <><p className="field-hint">{t('commitHint')}</p><Field label={t('commitMessage')} required><textarea rows={3} maxLength={10000} value={message} onChange={event => { invalidate(); setMessage(event.target.value); }} /></Field><div className="form-grid"><Field label={t('authorName')} required><input maxLength={200} value={authorName} onChange={event => { invalidate(); setIdentityEdited(true); setAuthorName(event.target.value); }} /></Field><Field label={t('authorEmail')} required><input type="email" maxLength={254} value={authorEmail} onChange={event => { invalidate(); setIdentityEdited(true); setAuthorEmail(event.target.value); }} /></Field></div><p className="field-hint">{t('identityHint')}</p></>}
          {(kind === 'createBranch' || kind === 'switchBranch') && <><p className="field-hint">{t('branchHint')}</p>{kind === 'createBranch' ? <Field label={t('newBranch')} required><input value={newBranch} maxLength={256} onChange={event => { invalidate(); setNewBranch(event.target.value); }} /></Field> : <Field label={t('targetBranch')} required><select value={targetBranch} onChange={event => { invalidate(); setTargetBranch(event.target.value); }}><option value="">{t('chooseBranch')}</option>{git.branches.filter(branch => branch !== git.branch).map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></Field>}</>}
          {(kind === 'fetch' || kind === 'pull' || kind === 'push') && <>{kind === 'pull' && <Notice>{t('pullHint')}</Notice>}{kind === 'push' && <Notice>{t('pushHint')}</Notice>}<div className="form-grid"><Field label={t('remote')} required><select value={remote} onChange={event => { invalidate(); setRemote(event.target.value); }}><option value="">{t('chooseRemote')}</option>{details?.remotes.map(item => <option key={item.name} value={item.name} disabled={!item.supported}>{item.name} — {item.supported ? item.url : t('remoteUnsupported')}</option>)}</select></Field><Field label={t('remoteBranch')} required><input value={remoteBranch} maxLength={256} onChange={event => { invalidate(); setRemoteBranch(event.target.value); }} /></Field></div>{!details?.remotes.some(item => item.supported) && <p className="field-hint">{t('noRemote')}</p>}</>}
          {(kind === 'stage' || kind === 'unstage') && <p className="field-hint">{t('selected', { count: kind === 'stage' ? unstagedPaths.length : stagedPaths.length })}</p>}
        </fieldset>
        <div className="device-toolbar"><Button variant="primary" icon={ShieldCheck} busy={action.busy} disabled={!canWrite || busy || !validOperation.success} onClick={() => { void prepare(); }}>{t('prepare')}</Button><Button disabled={busy || !dirty} onClick={clearDraft}>{t('resetDraft')}</Button></div>
      </section>
      {preview && <section className="git-preview"><h3>{t('previewTitle')}</h3><Notice warning>{t('previewPrivacy')}</Notice><p className="field-hint">{t('requestId', { id: preview.id })}</p><GitReview summary={preview.summary} digest={preview.digest} expiresAt={preview.expiresAt} />
        <Field label={t('reviewer')} required><select value={reviewerValid ? reviewer : ''} disabled={busy} onChange={event => { setReviewer(event.target.value); setSubmitConfirm(false); }}><option value="">{t('chooseReviewer')}</option>{reviewers.map(item => { const local = item.deviceId === devices?.localDevice.id; const name = local ? devices!.localDevice.name : devices?.devices.find(device => device.id === item.deviceId)?.name ?? item.deviceId; return <option key={item.deviceId} value={item.deviceId}>{t(local ? 'selfReviewer' : 'deviceOption', { name, id: item.deviceId })}</option>; })}</select></Field>
        {!reviewers.length && <Notice warning>{t('noReviewer')}</Notice>}{previewExpired && <Notice warning>{t('previewExpired')}</Notice>}
        <div className="device-toolbar"><Button variant="primary" disabled={!canWrite || busy || !reviewerValid || previewExpired} onClick={() => { action.setError(null); setSubmitConfirm(true); }}>{t('submit')}</Button><Button disabled={busy} onClick={invalidate}>{t('dismissPreview')}</Button></div>
      </section>}
      {submitted && <p className="inline-success" role="status"><ShieldCheck size={16} aria-hidden="true" />{t('submitted')}</p>}
      {staleNotice && <Notice warning>{t('previewStale')}</Notice>}
      {!submitConfirm && <ErrorNotice message={action.error} />}
      <section className="detail-section"><h3><GitCommitHorizontal size={17} aria-hidden="true" />{t('recentCommits')}</h3><p className="field-hint">{t('commitTimeHint')}</p>{git.commits.length ? <div className="commit-list">{git.commits.map(commit => <div className="commit-row" key={commit.hash}><GitCommitHorizontal size={16} aria-hidden="true" /><code title={commit.hash}>{commit.shortHash}</code><strong>{commit.subject}</strong><time dateTime={commit.date}>{formatDate(commit.date, true, locale)}</time></div>)}</div> : <p className="quiet-empty">{t('noCommits')}</p>}</section>
    </>}
    <GitRequests key={`${project.id}:${profileScope}`} projectId={project.id} profileId={profileScope} canManage={canManage} canExecute={canWrite} canRecover={!!devices?.desktopAvailable} blocked={action.busy || readBusy || diffBusy} version={requestVersion} onBusyChange={setRequestBusy} onExecuted={afterExecution} />
    <p className="field-hint">{t('readonlyHint')}</p>
    {submitConfirm && preview && <ConfirmDialog title={t('submitTitle')} confirmLabel={t('submitConfirm')} busy={action.busy} confirmDisabled={!canWrite || !reviewerValid || previewExpired} error={action.error} onClose={() => setSubmitConfirm(false)} onConfirm={() => { void submit(); }}><p>{t('submitDescription')}</p><p className="preserve-lines">{t('reviewer')}: <strong>{reviewer}</strong></p><GitReview summary={preview.summary} digest={preview.digest} expiresAt={preview.expiresAt} /><Notice warning>{t('previewPrivacy')}</Notice></ConfirmDialog>}
  </section>;
}
