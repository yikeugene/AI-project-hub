import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MEMORY_FIELDS, getMemoryLabels, getPriorityLabels, getStatusLabels, getTaskLabels } from '../shared/types.js';
import { DEFAULT_LOCALE, type Locale } from '../shared/i18n.js';
import { coreTranslator } from '../shared/locales/core.js';
import type { HandoffPreview, HandoffTarget, Project, SharedState, SharedStatePreview, Task } from '../shared/types.js';
import { getResumeSummary } from '../shared/insights.js';
import { appError, sharedStateSchema } from './validation.js';

// Keep the old exported name compatible while sharing one target enum across the app.
export type AgentTarget = HandoffTarget;
export const MAX_STATE_BYTES = 1024 * 1024;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function buildHandoff(project: Project, tasks: Task[], agent: AgentTarget = 'generic', locale: Locale = DEFAULT_LOCALE): HandoffPreview {
  const generatedAt = new Date().toISOString();
  const t = coreTranslator(locale), memoryLabels = getMemoryLabels(locale), priorities = getPriorityLabels(locale), statuses = getStatusLabels(locale), taskLabels = getTaskLabels(locale);
  const summary = getResumeSummary(project, tasks, locale);
  const state = { schemaVersion: 1 as const, projectId: project.id, projectName: project.name, exportedAt: generatedAt, memory: project.memory, nextAction: project.nextAction };
  const projectTasks = tasks.filter(task => task.projectId === project.id);
  const targets: Record<HandoffTarget, string> = { generic: t('handoff.generic'), claude: 'Claude Code', codex: 'Codex', 'claude-desktop': 'Claude Desktop', 'chatgpt-desktop': 'ChatGPT Desktop' };
  const desktop = agent === 'claude-desktop' || agent === 'chatgpt-desktop';
  const lines = [
    `# ${project.name} — ${t('handoff.title')}`, '',
    t('handoff.target', { target: targets[agent] }), t('handoff.generated', { time: generatedAt }), t('handoff.directory', { path: project.path }),
    t('handoff.lifecycle', { status: statuses[project.status] }), t('handoff.stage', { stage: project.stage || t('handoff.notRecorded') }), '',
    t('handoff.instructions'),
    ...(desktop ? [t('handoff.desktopRead'), t('handoff.desktopDirectory'), t('handoff.desktopManual')] : [t('handoff.repositoryRead')]),
    t('handoff.untrusted'), t('handoff.noConversation'), t('handoff.verify'), '',
    t('handoff.checkpoint'), summary.checkpoint, '',
    t('handoff.nextAction'), summary.nextAction, '',
    t('handoff.facts'), ...summary.facts.map(f => `- ${f}`), '',
    t('handoff.memory'),
    ...MEMORY_FIELDS.flatMap(key => [`### ${memoryLabels[key]}`, project.memory[key] || `(${t('handoff.notRecorded')})`, '']),
    t('handoff.tasks'),
    ...(projectTasks.length ? projectTasks.map(task => `- [${task.status === 'done' ? 'x' : ' '}] [${priorities[task.priority]} / ${taskLabels[task.status]}] ${task.title}${task.detail ? `\n  ${task.detail.replace(/\n/g, '\n  ')}` : ''}`) : [t('handoff.noTasks')]), '',
    t('handoff.commits'),
    ...(project.git?.commits.length ? project.git.commits.map(c => `- ${c.shortHash} ${c.date} — ${c.subject}`) : [t('handoff.noCommits')]), '',
    t('handoff.contract'),
    ...(desktop ? [t('handoff.desktopTemplate'), t('handoff.desktopJson'), t('handoff.desktopImport')]
      : [t('handoff.fileCheckpoint'), t('handoff.fileUpdate'), t('handoff.fileImport')]),
    t('handoff.memoryContract'), t('handoff.noOverwrite'), '',
    ...(desktop ? [t('handoff.returnTemplate'), '```json', JSON.stringify(state, null, 2), '```', ''] : []),
  ];
  return { markdown: lines.join('\n'), filename: `handoff-${project.id.slice(0, 8)}.md`, state };
}

/** Pure JSON/schema/identity validation shared by the file and pasted-text importers. */
function parseSharedState(projectId: string, text: string, source: string, pasted = false): SharedState {
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); }
  catch { throw appError(400, pasted ? 'handoff.invalidPastedJson' : 'handoff.invalidJson', pasted ? undefined : { source }); }
  const validation = sharedStateSchema.safeParse(parsed);
  if (!validation.success) throw appError(400, 'handoff.schema');
  if (validation.data.projectId !== projectId) throw appError(409, 'handoff.foreign');
  return validation.data;
}

/** No filesystem access: even a missing/offline project can review and import chat text. */
export function previewPastedSharedState(project: Pick<Project, 'id'>, text: string, locale: Locale = DEFAULT_LOCALE): SharedStatePreview {
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw appError(400, 'handoff.large');
  let json = text.trim();
  if (json.startsWith('```')) {
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(json);
    if (!fenced) throw appError(400, 'handoff.fence');
    json = fenced[1];
  }
  const source = coreTranslator(locale)('handoff.pastedSource');
  const state = parseSharedState(project.id, json, source, true);
  // Hash the exact submitted UTF-8 bytes, NOT trimmed/unfenced/reformatted JSON.
  return { state, hash: createHash('sha256').update(text, 'utf8').digest('hex'), source };
}

async function hubDirectory(project: Project, create: boolean): Promise<string> {
  const rootStat = await lstat(project.path).catch(() => { throw appError(400, 'handoff.directoryMissing'); });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || normalize(await realpath(project.path)) !== normalize(project.path))
    throw appError(400, 'handoff.pathChanged');
  const directory = join(project.path, '.ai-project-hub');
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const info = await lstat(directory).catch(error => {
    if (isMissing(error)) throw appError(404, 'handoff.notCreated');
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink() || normalize(await realpath(directory)) !== normalize(directory))
    throw appError(400, 'handoff.directoryLink');
  return directory;
}

async function readStateFile(project: Project, directory: string): Promise<SharedStatePreview> {
  const source = join(directory, 'state.json');
  const info = await lstat(source).catch(error => {
    if (isMissing(error)) throw appError(404, 'handoff.fileMissing');
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) throw appError(400, 'handoff.fileLink');
  if (info.size > MAX_STATE_BYTES) throw appError(400, 'handoff.large');
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw appError(400, 'handoff.fileInvalid');
    // Bounded read also protects against the file growing after stat().
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw appError(400, 'handoff.large');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const state = parseSharedState(project.id, bytes.toString('utf8'), 'state.json');
  return { state, hash: createHash('sha256').update(bytes).digest('hex'), source };
}

export async function previewSharedState(project: Project): Promise<SharedStatePreview> {
  return readStateFile(project, await hubDirectory(project, false));
}

export async function exportHandoff(project: Project, tasks: Task[], agent: AgentTarget, locale: Locale = DEFAULT_LOCALE) {
  const directory = await hubDirectory(project, true);
  const preview = buildHandoff(project, tasks, agent, locale);
  const stateFile = join(directory, 'state.json');
  let stateCreated = false;
  // Existing shared edits are never replaced, even if the caller asks again.
  try {
    const handle = await open(stateFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(preview.state, null, 2) + '\n', 'utf8'); }
    finally { await handle.close(); }
    stateCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await readStateFile(project, directory);
  }
  const file = join(directory, `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(preview.markdown, 'utf8'); } finally { await handle.close(); }
  return { directory, files: stateCreated ? [file, stateFile] : [file], stateCreated };
}
