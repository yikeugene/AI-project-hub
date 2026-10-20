import { z } from 'zod';
import { sharedProjectSchema, type SharedProject, type SummaryDownload } from './devices.js';
import { DEFAULT_LOCALE, type Locale } from './i18n.js';
import { getMemoryLabels, getPriorityLabels, getStatusLabels, MEMORY_FIELDS } from './types.js';

const timestamp = z.string().datetime({ offset: true }).nullable();
const sourceSchema = z.object({
  profileId: z.string().uuid(), groupLabel: z.string().max(400), ownerDeviceId: z.string().uuid(), ownerName: z.string().max(80),
  projectId: z.string().uuid(), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), pending: z.boolean(),
  publishedAt: timestamp, receivedAt: timestamp, lastSyncAt: timestamp,
}).strict();
export type SharedSummarySource = z.infer<typeof sourceSchema>;
const inline = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
function block(value: string) {
  // Shared text is data, not executable HTML/Markdown. A content-specific fence cannot be closed by its body.
  const longest = Math.max(0, ...(value.match(/~+/g) ?? []).map(run => run.length));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}
function filename(name: string, projectId: string, version: number) {
  let stem = Array.from(name.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '-')).slice(0, 80).join('').replace(/[. ]+$/g, '').trim();
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `summary-${stem || 'project'}`;
  return `${stem}-${projectId.slice(0, 8)}-v${version}.md`;
}

/** Only the strict allowlisted projection and provenance enter this formatter; never a local Project or handoff. */
export function formatSharedSummary(project: SharedProject, source: SharedSummarySource, locale: Locale = DEFAULT_LOCALE): SummaryDownload {
  const shared = sharedProjectSchema.parse(project), metadata = sourceSchema.parse(source);
  const labels = locale === 'zh-TW' ? {
    summary: '共享專案摘要', group: '來源群組', owner: '擁有裝置', project: '專案識別碼', version: '共享版本', revision: '專案修訂',
    state: '發布狀態', pending: '待同步（此版本尚未確認發布）', acknowledged: '已確認的共享版本', published: '發布確認時間', received: '快取接收時間',
    synced: '群組上次同步', unknown: '尚無記錄', status: '狀態', priority: '優先級', stage: '階段', next: '下一步行動', memory: '已共享記憶欄位',
    note: '唯讀共享摘要，並非實際檔案。離線快取可能不是最新內容；已下載的副本不會被遠端收回。',
  } : {
    summary: 'Shared project summary', group: 'Source group', owner: 'Owner device', project: 'Project ID', version: 'Shared version', revision: 'Project revision',
    state: 'Publication state', pending: 'Pending sync (this version is not acknowledged as published)', acknowledged: 'Acknowledged shared version', published: 'Publication acknowledgement', received: 'Cache received',
    synced: 'Group last synced', unknown: 'Not recorded', status: 'Status', priority: 'Priority', stage: 'Stage', next: 'Next action', memory: 'Shared memory fields',
    note: 'Read-only shared summary, not actual files. Offline cache may not be current; downloaded copies cannot be recalled remotely.',
  };
  const memoryLabels = getMemoryLabels(locale), statusLabels = getStatusLabels(locale), priorityLabels = getPriorityLabels(locale);
  const lines = [`# ${inline(shared.name)}`, '', labels.summary, '',
    `- ${labels.group}: ${inline(metadata.groupLabel)} (${metadata.profileId})`,
    `- ${labels.owner}: ${inline(metadata.ownerName)} (${metadata.ownerDeviceId})`,
    `- ${labels.project}: ${metadata.projectId}`, `- ${labels.version}: ${metadata.version}`, `- ${labels.revision}: ${shared.revision}`,
    `- ${labels.state}: ${metadata.pending ? labels.pending : labels.acknowledged}`,
    `- ${labels.published}: ${(metadata.pending ? null : metadata.publishedAt) ?? labels.unknown}`,
    `- ${labels.received}: ${metadata.receivedAt ?? labels.unknown}`, `- ${labels.synced}: ${metadata.lastSyncAt ?? labels.unknown}`, '',
    `- ${labels.status}: ${statusLabels[shared.status]}`, `- ${labels.priority}: ${priorityLabels[shared.priority]}`, `- ${labels.stage}: ${inline(shared.stage)}`, '',
    `## ${labels.next}`, '', block(shared.nextAction), '', `## ${labels.memory}`, ''];
  for (const field of MEMORY_FIELDS) if (shared.memory[field] !== undefined) lines.push(`### ${memoryLabels[field]}`, '', block(shared.memory[field]!), '');
  lines.push(labels.note, '');
  return { filename: filename(shared.name, metadata.projectId, metadata.version), text: lines.join('\n') };
}
