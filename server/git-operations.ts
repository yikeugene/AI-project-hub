import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitDiffInputSchema, gitOperationSchema, gitReviewSummarySchema, type GitDetails, type GitDiff, type GitDiffInput, type GitExecutionResult, type GitOperation, type GitReviewSummary } from '../shared/git.ts';
import { parseGitStatus, readGitSnapshot } from './git.ts';
import { GitOperationError } from './git-errors.ts';
import { advertised, fetchObjects, pushApproved, remoteFor, remotes, verifyPushGuard, type RemoteTarget } from './git-network.ts';
import { acknowledgeRepositoryFence, headCommands, hasNativeSymrefs, lockIndex, prepareRefTransaction, withRepositoryLock, type RefCommand, type RefTransaction } from './git-locks.ts';
import { startGitProcess, runGitProcess } from './git-process.ts';
import { boundedFile, captureAttributes, createGitView, digest, enabled, exists, freezeFile, literalPath, MAX_FILE_BYTES, MAX_TOTAL_BYTES, objectId, OID, openRepository, rawGit, readSnapshot, serializeIndex, text, treeId, value, type AttributeFiles, type FrozenFile, type GitView, type IndexEntry, type Repository } from './git-repository.ts';

export { GitOperationError } from './git-errors.ts';
export interface PreparedGitOperation {
  version: 1;
  id: string;
  projectId: string;
  projectName: string;
  preparedAt: string;
  directory: string;
  repositoryKey: string;
  operation: GitOperation;
  summary: GitReviewSummary;
  fingerprint: string;
  state: {
    identity: string; head: string | null; symbolicHead: string | null; index: string; refs: string; config: string; worktrees: string;
  };
  files: FrozenFile[];
  attributes: AttributeFiles;
  entries: IndexEntry[];
  targetEntries: IndexEntry[];
  target: string | null;
  targetRef: string | null;
  remote: RemoteTarget | null;
  remoteOld: string | null;
  trackingOld: string | null;
  tree: string | null;
  commit: string | null;
  commitContent: string | null;
}
const attempted = new Set<string>();
function blankAttributes(): AttributeFiles { return { files: [], info: null, global: null, exclude: null, globalExclude: null }; }
function emptyDetails(snapshot: GitDetails['snapshot']): GitDetails { return { snapshot, remotes: [], upstream: null, ahead: null, behind: null, operationState: null, unsupportedReasons: [], identity: { name: '', email: '' } }; }

export async function readGitDetails(directory: string): Promise<GitDetails> {
  let repo: Repository;
  try { repo = await openRepository(directory); }
  catch (error) {
    const snapshot = await readGitSnapshot(directory);
    return { ...emptyDetails(snapshot), unsupportedReasons: snapshot.isRepo ? [error instanceof GitOperationError ? error.code : 'unavailable'] : [] };
  }
  let attributes: AttributeFiles;
  try { attributes = await captureAttributes(repo, repo.entries.map(entry => entry.path)); }
  catch { attributes = blankAttributes(); repo.unsupported.push('attributes'); }
  let snapshot: GitDetails['snapshot'];
  try {
    snapshot = repo.unsupported.some(reason => ['objectLayout', 'partialClone', 'refStorage', 'attributes'].includes(reason))
      ? await readGitSnapshot(directory) : await readSnapshot(repo, attributes);
  } catch { snapshot = await readGitSnapshot(directory); repo.unsupported.push('unavailable'); }
  const fallback = (): GitDetails => ({ ...emptyDetails(snapshot), remotes: remotes(repo), operationState: repo.operationState,
    unsupportedReasons: [...new Set([...repo.unsupported, 'unavailable'])], identity: { name: value(repo.config, 'user.name') ?? '', email: value(repo.config, 'user.email') ?? '' } });
  let view: GitView;
  try { view = await createGitView(repo, attributes); } catch { return fallback(); }
  try {
    if (!await hasNativeSymrefs(repo, view)) repo.unsupported.push('nativeSymrefs');
    try { await checkAttributes(view, [...repo.entries.map(entry => entry.path), ...snapshot.changes.map(change => change.path)]); }
    catch { repo.unsupported.push('customHelpers'); }
    const branch = repo.symbolicHead?.startsWith('refs/heads/') ? repo.symbolicHead.slice(11) : null;
    const remote = branch && value(repo.config, `branch.${branch}.remote`);
    const merge = branch && value(repo.config, `branch.${branch}.merge`);
    const upstream = remote && merge?.startsWith('refs/heads/') ? remote === '.' ? merge : `refs/remotes/${remote}/${merge.slice(11)}` : null;
    const upstreamOid = upstream && repo.refs.find(ref => ref.name === upstream)?.oid;
    let ahead: number | null = null, behind: number | null = null;
    if (repo.head && upstreamOid) {
      const result = await view.git(['rev-list', '--left-right', '--count', `${repo.head}...${upstreamOid}`], undefined, true);
      if (!result.code) { const counts = text(result.stdout).trim().split(/\s+/).map(Number); if (counts.length === 2 && counts.every(Number.isSafeInteger)) [ahead, behind] = counts; }
    }
    return { snapshot, remotes: remotes(repo), upstream, ahead, behind, operationState: repo.operationState, unsupportedReasons: [...new Set(repo.unsupported)], identity: { name: value(repo.config, 'user.name') ?? '', email: value(repo.config, 'user.email') ?? '' } };
  } catch { return fallback(); }
  finally { await view.dispose().catch(() => undefined); }
}

export async function readGitDiff(directory: string, input: GitDiffInput): Promise<GitDiff> {
  const parsed = gitDiffInputSchema.safeParse(input);
  if (!parsed.success) throw new GitOperationError('invalid');
  input = parsed.data; literalPath(input.path);
  const repo = await openRepository(directory);
  let attributes: AttributeFiles;
  try { attributes = await captureAttributes(repo, [input.path]); } catch { attributes = blankAttributes(); }
  const view = await createGitView(repo, attributes);
  try {
    const snapshot = parseGitStatus(text((await view.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-ahead-behind'])).stdout), true);
    const change = snapshot.changes.find(change => change.path === input.path || change.originalPath === input.path);
    const paths = [...new Set([input.path, change?.path, change?.originalPath].filter((entry): entry is string => Boolean(entry)))];
    for (const filename of paths) {
      literalPath(filename);
      const entry = repo.entries.find(entry => entry.path === filename);
      if (entry) {
        const size = await view.git(['cat-file', '-s', entry.oid]);
        if (Number(text(size.stdout).trim()) > MAX_FILE_BYTES) return { ...input, text: '', binary: false, truncated: true };
      }
      if (input.source === 'index' && repo.head) {
        const old = text((await view.git(['ls-tree', '-z', repo.head, '--', filename])).stdout);
        const oid = /^\d+ (?:blob|commit) ([a-f0-9]+)\t/.exec(old)?.[1];
        if (oid && Number(text((await view.git(['cat-file', '-s', oid])).stdout).trim()) > MAX_FILE_BYTES) return { ...input, text: '', binary: false, truncated: true };
      }
      if (input.source === 'worktree') {
        const info = await lstat(path.join(repo.directory, ...filename.split('/'))).catch(() => null);
        if (info && info.size > MAX_FILE_BYTES) return { ...input, text: '', binary: false, truncated: true };
      }
    }
    let commands: string[];
    if (change?.index === '?' && input.source === 'worktree') {
      await freezeFile(repo.directory, input.path);
      commands = ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', path.join(repo.directory, ...input.path.split('/'))];
    } else {
      commands = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', ...(input.source === 'index' ? ['--cached'] : []), '--', ...paths];
    }
    const child = await startGitProcess(repo.tools, [...view.args, ...commands], { cwd: view.root, env: view.env, readOnly: true, maxOutputBytes: 256 * 1024 });
    child.end(); const result = await child.result;
    if (result.timedOut || result.code > 1 && !result.limited) throw new GitOperationError('failed');
    let output = result.stdout.toString('utf8');
    const binary = /^Binary files .* differ$/m.test(output) || /^GIT binary patch$/m.test(output);
    // no-index headers contain local filenames; the UI only needs relative paths.
    if (change?.index === '?') output = output.split(repo.directory.replaceAll('\\', '/')).join('').split(repo.directory).join('');
    return { ...input, text: output, binary, truncated: result.limited };
  } finally { await view.dispose(); }
}

async function refName(view: GitView, name: string): Promise<string> {
  if (!name || name.startsWith('-') || name === 'HEAD' || name.length > 256) throw new GitOperationError('invalid');
  const ref = `refs/heads/${name}`;
  if ((await view.git(['check-ref-format', ref], undefined, true)).code) throw new GitOperationError('invalid');
  return ref;
}
function zero(repo: Repository): string { return '0'.repeat(repo.format === 'sha1' ? 40 : 64); }
function branch(repo: Repository): string | null { return repo.symbolicHead?.startsWith('refs/heads/') ? repo.symbolicHead.slice(11) : null; }
async function treeEntries(view: GitView, oid: string): Promise<IndexEntry[]> {
  const result = await view.git(['ls-tree', '-r', '-z', '--full-tree', oid]);
  return text(result.stdout).split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !OID.test(match[3])) throw new GitOperationError('unsupported', 'Symlinks and submodules are read-only.');
    literalPath(match[4]); return { mode: match[1], oid: match[3], path: match[4] };
  });
}
async function checkAttributes(view: GitView, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const attributes = text((await view.git(['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding', 'ident'], paths.join('\0') + '\0')).stdout).split('\0');
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    if (!['unspecified', 'unset'].includes(attributes[i + 2])) throw new GitOperationError('unsupported', 'Filters, encodings and ident conversion are read-only.');
  }
}
async function frozenBlob(view: GitView, file: FrozenFile): Promise<string | null> {
  if (file.bytes === null) return null;
  return text((await view.git(['hash-object', '--stdin', '--path', file.path], Buffer.from(file.bytes, 'base64'))).stdout).trim();
}
function fileMode(repo: Repository, file: FrozenFile): string | null {
  if (file.bytes === null) return null;
  return enabled(value(repo.config, 'core.filemode')) ? file.mode : repo.entries.find(entry => entry.path === file.path)?.mode ?? '100644';
}
async function cleanFiles(repo: Repository, view: GitView, files: FrozenFile[]): Promise<void> {
  for (const file of files) {
    const entry = repo.entries.find(entry => entry.path === file.path);
    if (!entry || file.bytes === null || fileMode(repo, file) !== entry.mode || await frozenBlob(view, file) !== entry.oid) throw new GitOperationError('unsafe', 'A clean index and worktree are required.');
  }
}
async function verifyTargetAttributes(repo: Repository, view: GitView, entries: IndexEntry[], attributes: AttributeFiles): Promise<void> {
  const files: FrozenFile[] = [];
  for (const entry of entries.filter(entry => entry.path === '.gitattributes' || entry.path.endsWith('/.gitattributes'))) {
    const contents = await view.git(['cat-file', 'blob', entry.oid], undefined, false, 1024 * 1024);
    files.push({ path: entry.path, bytes: contents.stdout.toString('base64'), mode: entry.mode });
  }
  const targetView = await createGitView(repo, { ...attributes, files }, true);
  try { await writeFile(targetView.indexPath, serializeIndex(repo, entries)); await checkAttributes(targetView, entries.map(entry => entry.path)); }
  finally { await targetView.dispose(); }
}
async function worktrees(repo: Repository): Promise<string> {
  return text((await rawGit(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout);
}
async function createPlan(repo: Repository, requested: GitOperation, context: { projectId: string; projectName: string }, id: string, preparedAt: string): Promise<PreparedGitOperation> {
  const parse = gitOperationSchema.safeParse(requested);
  if (!parse.success || !context.projectId || !context.projectName) throw new GitOperationError('invalid');
  let operation = parse.data;
  if (repo.unsupported.length || repo.operationState) throw new GitOperationError('unsupported', 'This repository configuration is read-only.');
  if (process.platform === 'win32' && !repo.tools.host) throw new GitOperationError('unavailable');
  for (const entry of repo.entries) literalPath(entry.path);
  if (repo.refs.find(ref => ref.name === repo.symbolicHead)?.symbolic) throw new GitOperationError('unsupported');
  if (process.platform === 'win32' && new Set(repo.entries.map(entry => entry.path.toLowerCase())).size !== repo.entries.length) throw new GitOperationError('unsupported');
  const attributes = await captureAttributes(repo, [...repo.entries.map(entry => entry.path), ...('paths' in operation ? operation.paths : [])]);
  const snapshot = await readSnapshot(repo, attributes);
  if (snapshot.conflictCount) throw new GitOperationError('unsupported');
  if (snapshot.head !== repo.head || snapshot.branch !== branch(repo)) throw new GitOperationError('stale');
  let paths = 'paths' in operation ? [...new Set(operation.paths.map(literalPath))].sort() : [];
  for (const change of snapshot.changes) {
    if (change.originalPath && (paths.includes(change.path) || paths.includes(change.originalPath))) paths.push(change.path, change.originalPath);
  }
  paths = [...new Set(paths)].sort();
  if (paths.length > 200) throw new GitOperationError('unsupported');
  if ('paths' in operation) operation = { ...operation, paths };
  if (operation.kind === 'stage') for (const filename of paths) {
    if (!repo.entries.some(entry => entry.path === filename) && !snapshot.changes.some(change => change.path === filename || change.originalPath === filename)) {
      throw new GitOperationError('invalid', 'Ignored or absent paths cannot be staged by this operation.');
    }
  }
  const clean = operation.kind === 'switchBranch' || operation.kind === 'pull';
  if (clean && snapshot.changedCount !== 0) throw new GitOperationError('unsafe', 'A clean index and worktree are required.');
  if (clean && (!repo.head || !branch(repo))) throw new GitOperationError('unsupported');
  const names = clean ? repo.entries.map(entry => entry.path) : paths;
  if (names.length > 5000) throw new GitOperationError('unsupported');
  const files: FrozenFile[] = [];
  let total = 0;
  for (const name of names) {
    const file = await freezeFile(repo.directory, name, enabled(value(repo.config, 'core.filemode')));
    total += file.bytes?.length ?? 0;
    if (total > MAX_TOTAL_BYTES) throw new GitOperationError('unsupported');
    files.push(file);
  }
  const view = await createGitView(repo, attributes, true);
  let target: string | null = null, targetRef: string | null = null, remote: RemoteTarget | null = null, remoteOld: string | null = null, trackingOld: string | null = null;
  let tree: string | null = null, commit: string | null = null, commitContent: string | null = null;
  let targetEntries: IndexEntry[] = [];
  let entries = repo.entries.map(entry => ({ ...entry }));
  const worktreeState = await worktrees(repo);
  try {
    if (!await hasNativeSymrefs(repo, view)) throw new GitOperationError('unsupported', 'This Git version lacks required native symbolic-ref transactions.');
    await checkAttributes(view, [...new Set([...repo.entries.map(entry => entry.path), ...paths])]);
    if (clean) await cleanFiles(repo, view, files);
    if (operation.kind === 'stage') {
      for (const file of files) {
        const oid = await frozenBlob(view, file);
        if (!oid && !repo.entries.some(entry => entry.path === file.path) && !snapshot.changes.some(change => change.originalPath === file.path)) throw new GitOperationError('invalid');
        entries = entries.filter(entry => entry.path !== file.path);
        if (oid) entries.push({ path: file.path, oid, mode: fileMode(repo, file)! });
      }
    } else if (operation.kind === 'unstage') {
      targetEntries = repo.head ? await treeEntries(view, repo.head) : [];
      for (const filename of paths) {
        const headEntry = targetEntries.find(entry => entry.path === filename);
        entries = entries.filter(entry => entry.path !== filename);
        if (headEntry) entries.push(headEntry);
      }
    } else if (operation.kind === 'commit') {
      if (!branch(repo)) throw new GitOperationError('unsupported', 'A local branch is required for committing.');
      if (/[<>\x00-\x1f\x7f]/.test(operation.authorName) || /[<>\x00-\x1f\x7f]/.test(operation.authorEmail)) throw new GitOperationError('invalid');
      if (!snapshot.stagedCount) throw new GitOperationError('invalid', 'There are no staged changes.');
      tree = treeId(repo.format, entries);
      const timestamp = `${Math.floor(Date.parse(preparedAt) / 1000)} +0000`;
      const identity = `${operation.authorName} <${operation.authorEmail}> ${timestamp}`;
      commitContent = `tree ${tree}\n${repo.head ? `parent ${repo.head}\n` : ''}author ${identity}\ncommitter ${identity}\n\n${operation.message}\n`;
      commit = objectId(repo.format, 'commit', Buffer.from(commitContent));
      target = commit; targetRef = repo.symbolicHead;
    } else if (operation.kind === 'createBranch' || operation.kind === 'switchBranch') {
      targetRef = await refName(view, operation.branch);
      if (!repo.head) throw new GitOperationError('invalid');
      const existing = repo.refs.find(ref => ref.name === targetRef);
      if (operation.kind === 'createBranch') {
        if (existing) throw new GitOperationError('invalid', 'The branch already exists.');
        target = repo.head;
      } else {
        if (!existing || existing.symbolic || targetRef === repo.symbolicHead) throw new GitOperationError('invalid');
        if (worktreeState.split('\0').includes(`branch ${targetRef}`)) throw new GitOperationError('busy', 'The target branch is already checked out.');
        target = existing.oid;
      }
    } else {
      await refName(view, operation.branch);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation.remote)) throw new GitOperationError('invalid');
      remote = remoteFor(repo, operation.remote, operation.branch, operation.kind === 'push');
      if ((await view.git(['check-ref-format', remote.trackingRef], undefined, true)).code) throw new GitOperationError('invalid');
      const tracking = repo.refs.find(ref => ref.name === remote!.trackingRef);
      if (tracking?.symbolic) throw new GitOperationError('unsupported');
      trackingOld = tracking?.oid ?? null;
      if (operation.kind === 'pull') {
        if (!repo.head || !trackingOld || !branch(repo)) throw new GitOperationError('invalid');
        if (value(repo.config, `branch.${branch(repo)}.remote`) !== operation.remote || value(repo.config, `branch.${branch(repo)}.merge`) !== remote.ref) throw new GitOperationError('invalid', 'Pull requires the current branch tracking target.');
        target = trackingOld; targetRef = repo.symbolicHead;
        const ancestor = await view.git(['merge-base', '--is-ancestor', repo.head, target], undefined, true);
        if (ancestor.code) throw new GitOperationError('unsafe', 'Only fast-forward pulls are supported.');
        if (target === repo.head) throw new GitOperationError('invalid');
      } else {
        remoteOld = await advertised(repo, view, remote);
        if (operation.kind === 'fetch') {
          if (!remoteOld) throw new GitOperationError('invalid', 'The advertised branch does not exist.');
          target = remoteOld; targetRef = remote.trackingRef;
          if (target === trackingOld) throw new GitOperationError('invalid');
          if (trackingOld && !(await view.git(['cat-file', '-e', `${target}^{commit}`], undefined, true)).code
            && (await view.git(['merge-base', '--is-ancestor', trackingOld, target], undefined, true)).code) throw new GitOperationError('unsafe', 'Fetching would rewind the tracking ref.');
        } else {
          if (!repo.head || repo.head === remoteOld || !repo.tools.hooks) throw new GitOperationError('invalid');
          target = repo.head; targetRef = remote.ref;
          await verifyPushGuard(repo, view, remote, repo.head, remoteOld);
          if (remoteOld) {
            const have = await view.git(['cat-file', '-e', `${remoteOld}^{commit}`], undefined, true);
            if (have.code) throw new GitOperationError('unsafe', 'Fetch and review the remote branch before pushing.');
            if ((await view.git(['merge-base', '--is-ancestor', remoteOld, repo.head], undefined, true)).code) throw new GitOperationError('unsafe', 'A non-fast-forward push is not supported.');
          }
        }
      }
    }
    if (clean) {
      targetEntries = await treeEntries(view, target!);
      for (const entry of targetEntries) await freezeFile(repo.directory, entry.path, enabled(value(repo.config, 'core.filemode')));
      await verifyTargetAttributes(repo, view, targetEntries, attributes);
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    if ((operation.kind === 'stage' || operation.kind === 'unstage') && JSON.stringify(entries) === JSON.stringify(repo.entries)) throw new GitOperationError('invalid', 'The selection would not change the index.');
    const state = { identity: repo.identity, head: repo.head, symbolicHead: repo.symbolicHead, index: repo.indexDigest, refs: digest(JSON.stringify(repo.refs)), config: repo.configDigest, worktrees: digest(worktreeState) };
    const summary = gitReviewSummarySchema.parse({
      projectName: context.projectName, kind: operation.kind, paths, branch: branch(repo), head: repo.head, target,
      remoteUrl: remote?.url ?? null, targetRef, changedCount: snapshot.changedCount, stagedCount: snapshot.stagedCount,
      message: operation.kind === 'commit' ? operation.message : null,
      authorName: operation.kind === 'commit' ? operation.authorName : null, authorEmail: operation.kind === 'commit' ? operation.authorEmail : null,
    });
    const fingerprint = digest(JSON.stringify({ state, files, attributes, operation, remote, remoteOld, trackingOld, target, targetRef, entries, targetEntries }));
    return { version: 1, id, projectId: context.projectId, projectName: context.projectName, preparedAt, directory: repo.directory, repositoryKey: repo.key, operation, summary, fingerprint, state, files, attributes, entries, targetEntries, target, targetRef, remote, remoteOld, trackingOld, tree, commit, commitContent };
  } finally { await view.dispose(); }
}

export async function prepareGitOperation(directory: string, operation: GitOperation, context: { projectId: string; projectName: string }): Promise<PreparedGitOperation> {
  const repo = await openRepository(directory);
  return await createPlan(repo, operation, context, randomUUID(), new Date().toISOString());
}
async function validate(plan: PreparedGitOperation): Promise<Repository> {
  if (plan?.version !== 1 || !/^[a-f0-9-]{36}$/.test(plan.id) || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || !Number.isFinite(Date.parse(plan.preparedAt))) throw new GitOperationError('invalid');
  const repo = await openRepository(plan.directory);
  if (repo.key !== plan.repositoryKey) throw new GitOperationError('stale');
  let fresh: PreparedGitOperation;
  try { fresh = await createPlan(repo, plan.operation, { projectId: plan.projectId, projectName: plan.projectName }, plan.id, plan.preparedAt); }
  catch (error) { if (error instanceof GitOperationError && ['unsupported', 'unsafe', 'invalid'].includes(error.code)) throw new GitOperationError('stale'); throw error; }
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new GitOperationError('stale');
  return repo;
}
export async function validateGitOperation(plan: PreparedGitOperation): Promise<void> { await validate(plan); }
export async function acknowledgeGitOperation(plan: PreparedGitOperation): Promise<void> {
  if (plan?.version !== 1 || !/^[a-f0-9-]{36}$/.test(plan.id)) throw new GitOperationError('invalid');
  const repo = await openRepository(plan.directory);
  if (repo.key !== plan.repositoryKey || repo.identity !== plan.state.identity) throw new GitOperationError('stale');
  await acknowledgeRepositoryFence(repo, plan.id);
}
function lockCommands(repo: Repository, plan: PreparedGitOperation, updating: boolean): RefCommand[] {
  const commands = headCommands(repo);
  const put = (command: RefCommand) => { const previous = commands.findIndex(entry => entry.ref === command.ref); if (previous >= 0) commands[previous] = command; else commands.push(command); };
  switch (plan.operation.kind) {
    case 'createBranch': put(updating ? { kind: 'create', ref: plan.targetRef!, next: plan.target! } : { kind: 'verify', ref: plan.targetRef!, old: zero(repo) }); break;
    case 'switchBranch':
      put({ kind: 'verify', ref: plan.targetRef!, old: plan.target! });
      if (updating) put({ kind: 'symref-update', ref: 'HEAD', old: repo.symbolicHead!, next: plan.targetRef! });
      break;
    case 'pull':
      put({ kind: 'verify', ref: plan.remote!.trackingRef, old: plan.target! });
      if (updating) put({ kind: 'update', ref: repo.symbolicHead!, old: repo.head!, next: plan.target! });
      break;
    case 'commit': if (updating) put({ kind: 'update', ref: repo.symbolicHead!, old: repo.head ?? zero(repo), next: plan.commit! }); break;
    case 'fetch': put(updating ? { kind: 'update', ref: plan.targetRef!, old: plan.trackingOld ?? zero(repo), next: plan.target! } : { kind: 'verify', ref: plan.targetRef!, old: plan.trackingOld ?? zero(repo) }); break;
  }
  return commands;
}
async function mutation(repo: Repository, view: GitView, args: string[], input?: Buffer | string): Promise<Buffer> {
  const result = await runGitProcess(repo.tools, [...view.args, ...args], { cwd: view.root, env: view.env, maxOutputBytes: 1024 * 1024 }, input);
  if (result.code) throw new GitOperationError('failed');
  return result.stdout;
}
async function verifyIndex(view: GitView, entries: IndexEntry[]): Promise<void> {
  const expected = Buffer.from(entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join(''));
  if (!(await view.git(['ls-files', '--stage', '-z'])).stdout.equals(expected)) throw new GitOperationError('unknown');
}
async function stage(repo: Repository, view: GitView, plan: PreparedGitOperation, guard: () => Promise<void>): Promise<void> {
  if (plan.operation.kind === 'stage') for (const file of plan.files) {
    if (file.bytes === null) continue;
    await guard();
    const oid = text(await mutation(repo, view, ['hash-object', '-w', '--stdin', '--path', file.path], Buffer.from(file.bytes, 'base64'))).trim();
    if (oid !== plan.entries.find(entry => entry.path === file.path)?.oid) throw new GitOperationError('unknown');
  }
  const input = plan.summary.paths.map(filename => {
    const entry = plan.entries.find(entry => entry.path === filename);
    return entry ? `${entry.mode} ${entry.oid}\t${filename}\0` : `0 ${zero(repo)}\t${filename}\0`;
  }).join('');
  await mutation(repo, view, ['update-index', '-z', '--index-info'], input);
  await verifyIndex(view, plan.entries);
}

export async function executeGitOperation(plan: PreparedGitOperation, options: { authorize: () => Promise<void>; onStarting: () => void }): Promise<GitExecutionResult> {
  if (!options || typeof options.authorize !== 'function' || typeof options.onStarting !== 'function') throw new GitOperationError('invalid');
  const initial = await openRepository(plan.directory);
  if (initial.key !== plan.repositoryKey) throw new GitOperationError('stale');
  return await withRepositoryLock(initial, plan.id, async lock => {
    if (attempted.has(plan.id)) throw new GitOperationError('stale', 'This execution attempt has already been used.');
    let repo = await validate(plan);
    const nativeLocks = [path.join(repo.gitDir, 'index.lock'), path.join(repo.gitDir, 'HEAD.lock'), path.join(repo.commonDir, 'packed-refs.lock'),
      ...[repo.symbolicHead, plan.targetRef, plan.remote?.trackingRef].filter((ref): ref is string => Boolean(ref?.startsWith('refs/'))).map(ref => path.join(repo.commonDir, `${ref}.lock`))];
    for (const filename of nativeLocks) if (await exists(filename)) throw new GitOperationError('busy');
    attempted.add(plan.id);
    await options.authorize();
    const index = await lockIndex(repo);
    let transaction: RefTransaction | undefined;
    let view: GitView | undefined;
    let started = false, mutationStarted = false, retain = false, hasError = false;
    let failure: unknown;
    let execution: GitExecutionResult | undefined;
    const uncertain = async (error?: unknown) => {
      retain ||= !(error instanceof GitOperationError) || error.processExitUnverified;
      await lock.fence(!retain);
      if (started) execution = { status: 'unknown', code: 'git.unknown', head: null };
      else { hasError = true; failure = new GitOperationError('unknown'); }
    };
    try {
      const updating = ['createBranch', 'switchBranch', 'pull'].includes(plan.operation.kind);
      transaction = await prepareRefTransaction(repo, lockCommands(repo, plan, updating));
      repo = await validate(plan);
      view = await createGitView(repo, plan.attributes, plan.operation.kind !== 'switchBranch' && plan.operation.kind !== 'pull');
      if (plan.operation.kind === 'switchBranch' || plan.operation.kind === 'pull') {
        await writeFile(view.indexPath, serializeIndex(repo));
        if ((await view.git(['update-index', '--refresh'], undefined, true)).code) throw new GitOperationError('stale');
      }
      const mutationWindow = ['fetch', 'push'].includes(plan.operation.kind) ? 70_000 : ['switchBranch', 'pull'].includes(plan.operation.kind) ? 25_000 : 5_000;
      await transaction.assertPrepared(mutationWindow);
      await options.onStarting(); started = true;
      await transaction.assertPrepared(mutationWindow);
      switch (plan.operation.kind) {
        case 'stage': case 'unstage':
          mutationStarted = true;
          await stage(repo, view, plan, () => transaction!.assertPrepared(20_000));
          await transaction.assertPrepared(5_000);
          await index.install((await boundedFile(view.indexPath, MAX_TOTAL_BYTES))!, () => transaction!.assertPrepared(5_000));
          await transaction.abort(); transaction = undefined;
          break;
        case 'commit': {
          mutationStarted = true;
          const tree = text(await mutation(repo, view, ['write-tree'])).trim();
          if (tree !== plan.tree) throw new GitOperationError('unknown');
          const operation = plan.operation, date = `${Math.floor(Date.parse(plan.preparedAt) / 1000)} +0000`;
          view.env = { ...view.env, GIT_AUTHOR_NAME: operation.authorName, GIT_AUTHOR_EMAIL: operation.authorEmail, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: operation.authorName, GIT_COMMITTER_EMAIL: operation.authorEmail, GIT_COMMITTER_DATE: date };
          const commit = text(await mutation(repo, view, ['-c', 'commit.gpgSign=false', 'commit-tree', '--no-gpg-sign', tree, ...(repo.head ? ['-p', repo.head] : [])], `${operation.message}\n`)).trim();
          if (commit !== plan.commit) throw new GitOperationError('unknown');
          await transaction.abort(); transaction = undefined;
          transaction = await prepareRefTransaction(repo, lockCommands(repo, plan, true));
          await transaction.commit(); transaction = undefined;
          break;
        }
        case 'createBranch':
          mutationStarted = true;
          await transaction.commit(); transaction = undefined;
          break;
        case 'switchBranch': case 'pull':
          mutationStarted = true;
          await mutation(repo, view, ['read-tree', '-m', '-u', repo.head!, plan.target!]);
          await verifyIndex(view, plan.targetEntries);
          await transaction.assertPrepared(5_000);
          await index.install((await boundedFile(view.indexPath, MAX_TOTAL_BYTES))!, () => transaction!.assertPrepared(5_000));
          await transaction.commit(); transaction = undefined;
          break;
        case 'fetch': {
          mutationStarted = true;
          await fetchObjects(repo, view, plan.remote!, plan.target!);
          if ((await view.git(['cat-file', '-e', `${plan.target}^{commit}`], undefined, true)).code || await exists(path.join(view.gitDir, 'shallow'))) throw new GitOperationError('unsafe');
          const connectivity = await view.git(['rev-list', '--objects', '--missing=print', plan.target!]);
          if (/^\?/m.test(text(connectivity.stdout))) throw new GitOperationError('unsafe');
          if (plan.trackingOld && (await view.git(['merge-base', '--is-ancestor', plan.trackingOld, plan.target!], undefined, true)).code) throw new GitOperationError('unsafe', 'The fetched branch would rewind the tracking ref.');
          await transaction.abort(); transaction = undefined;
          transaction = await prepareRefTransaction(repo, lockCommands(repo, plan, true));
          await transaction.commit(); transaction = undefined;
          break;
        }
        case 'push':
          mutationStarted = true;
          await pushApproved(repo, view, plan.remote!, plan.target!, plan.remoteOld);
          await transaction.abort(); transaction = undefined;
          break;
      }
      const after = await openRepository(repo.directory);
      const expectedHead = plan.operation.kind === 'commit' ? plan.commit : plan.operation.kind === 'switchBranch' || plan.operation.kind === 'pull' ? plan.target : repo.head;
      if (after.head !== expectedHead) throw new GitOperationError('unknown');
      execution = { status: 'succeeded', code: 'git.succeeded', head: after.head };
    } catch (error) {
      const unknown = error instanceof GitOperationError && error.code === 'unknown';
      if (unknown) await uncertain(error);
      if (!started) { hasError = true; failure = error; }
      else if (plan.operation.kind === 'push' && error instanceof GitOperationError && error.code === 'stale') {
        execution = { status: 'failed', code: 'git.failed', head: repo.head };
      } else if (mutationStarted) {
        await lock.fence(!retain);
        const head = await rawGit(repo, ['rev-parse', '--verify', 'HEAD'], true).then(result => OID.test(text(result.stdout).trim()) ? text(result.stdout).trim() : null).catch(() => null);
        execution = { status: unknown ? 'unknown' : 'partial', code: unknown ? 'git.unknown' : 'git.partial', head };
      } else execution = { status: 'failed', code: 'git.failed', head: repo.head };
    } finally {
      try { await transaction?.abort(); } catch (error) { await uncertain(error); }
      try { await index.release(retain); } catch { await uncertain(); }
      if (!retain) await view?.dispose().catch(() => undefined);
    }
    if (hasError) throw failure;
    return execution!;
  });
}
