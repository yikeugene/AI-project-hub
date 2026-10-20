import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { MarkdownImportError, parseSummaryMarkdown } from '../shared/markdown-import.js';
import type { MarkdownImportApplyInput, MarkdownImportField, MarkdownImportPreview } from '../shared/markdown-import.js';
import { getMemoryLabels, MEMORY_FIELDS } from '../shared/types.js';
import { coreTranslator } from '../shared/locales/core.js';
import type { ChangeEntry } from '../shared/devices.js';
import type { Store } from './db.js';
import type { DeviceService } from './devices.js';
import { appError, HttpError, memorySchema, revisionSchema } from './validation.js';

type SharingReader = Pick<DeviceService, 'groupSharing'>;
const fields: readonly MarkdownImportField[] = ['nextAction', ...MEMORY_FIELDS];
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const previewInput = z.object({ text: z.string() }).strict();
const applyInput = previewInput.extend({
  projectId: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), revision: revisionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
}).strict();

function prepare(store: Store, text: string, devices?: SharingReader, expectedProjectId?: string) {
  // Hash the supplied UTF-8 text before the parser handles BOMs, CRLFs or wrappers.
  const rawHash = hash(text);
  let parsed;
  try { parsed = parseSummaryMarkdown(text); }
  catch (error) {
    if (error instanceof MarkdownImportError) throw appError(error.code === 'markdown.large' ? 413 : 400, error.code, error.params);
    throw error;
  }
  if (expectedProjectId !== undefined && parsed.source.projectId !== expectedProjectId) throw appError(409, 'markdown.targetMismatch');
  const project = (() => {
    try { return store.getProject(parsed.source.projectId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) throw appError(404, 'markdown.targetMissing');
      throw error;
    }
  })();
  const locale = store.getSettings().locale, labels = getMemoryLabels(locale), t = coreTranslator(locale);
  // Explicit field order also makes consent independent of parser/object insertion order.
  const patch = fields.flatMap(field => {
    const value = field === 'nextAction' ? parsed.patch.nextAction : parsed.patch.memory[field];
    return value !== undefined && value.trim() ? [{ field, value }] : [];
  });
  const changes: ChangeEntry[] = patch.flatMap(({ field, value }) => {
    const before = field === 'nextAction' ? project.nextAction : project.memory[field];
    return before === value ? [] : [{ key: field, label: field === 'nextAction' ? t('device.nextAction') : labels[field], before, after: value }];
  });
  // groupSharing is a pure read. Aggregate workspace/snapshot getters reconcile
  // publications and must not be used by either phase of a local text import.
  const policy = devices?.groupSharing(project.id);
  const groups = [...(policy?.groups ?? [])].sort((a, b) => a.group.id.localeCompare(b.group.id));
  const sharing = groups.flatMap(({ group, preview }) => {
    if (!preview.policy.enabled) return [];
    const affected = fields.filter(field => changes.some(change => change.key === field)
      && (field === 'nextAction' || preview.policy.memoryFields.includes(field)));
    return affected.length ? [{ profileId: group.id, label: group.label, fields: affected, paused: !group.enabled }] : [];
  });
  const digest = hash(JSON.stringify({
    hash: rawHash, projectId: project.id, revision: project.revision, patch,
    changes: changes.map(({ key, before, after }) => ({ key, before, after })),
    sharing: { digest: policy?.digest ?? null, enabled: groups.map(({ group }) => ({ profileId: group.id, enabled: group.enabled })) },
  }));
  const preview: MarkdownImportPreview = {
    projectId: project.id, projectName: project.name, revision: project.revision, source: parsed.source,
    hash: rawHash, digest, changes, skipped: parsed.skipped, sharing,
    sourceRevisionDiffers: parsed.source.revision !== project.revision, canApply: changes.length > 0,
  };
  return { preview, project, patch };
}

export function previewMarkdownImport(store: Store, text: string, devices?: SharingReader): MarkdownImportPreview {
  return prepare(store, text, devices).preview;
}

export function applyMarkdownImport(store: Store, input: MarkdownImportApplyInput, devices?: SharingReader) {
  return store.transaction(() => {
    const { preview, project, patch } = prepare(store, input.text, devices, input.projectId);
    if (preview.hash !== input.hash || preview.revision !== input.revision || preview.digest !== input.digest) throw appError(409, 'markdown.changed');
    if (!preview.canApply) throw appError(409, 'markdown.noChanges');
    const memory = { ...project.memory };
    let nextAction = project.nextAction;
    for (const { field, value } of patch) {
      if (field === 'nextAction') nextAction = value;
      else memory[field] = value;
    }
    // saveMemory owns no transaction: memory + nextAction change in one update,
    // without touching project files, policies, publications or sync workers.
    return store.saveMemory(project.id, project.revision, memorySchema.parse(memory), nextAction);
  });
}

export function markdownImportRouter(store: Store, devices?: SharingReader) {
  const router = Router();
  router.post('/preview', (req, res) => {
    const { text } = previewInput.parse(req.body);
    res.json(previewMarkdownImport(store, text, devices));
  });
  router.post('/apply', (req, res) => {
    res.json(applyMarkdownImport(store, applyInput.parse(req.body), devices));
  });
  return router;
}
