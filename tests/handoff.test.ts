import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { buildHandoff, exportHandoff, MAX_STATE_BYTES, previewPastedSharedState, previewSharedState } from '../server/handoff.js';
import { EMPTY_MEMORY } from '../shared/types.js';

let dir: string, store: Store;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-handoff-'))); store = new Store(':memory:'); });
afterEach(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

describe('cross-agent handoff', () => {
  it('keeps JSON, user text, byte hashes and filenames stable across output languages', () => {
    const created = store.createProject({ path: dir, name: 'User project 專案', nextAction: 'User next step' });
    const p = store.saveMemory(created.id, created.revision, { ...EMPTY_MEMORY, notes: '原樣 notes {count}' });
    const en = buildHandoff(p, [], 'chatgpt-desktop');
    const zh = buildHandoff(p, [], 'chatgpt-desktop', 'zh-TW');
    expect(en.markdown).toContain('## Project memory'); expect(zh.markdown).toContain('## 專案記憶');
    for (const output of [en, zh]) expect(output.markdown).toContain('原樣 notes {count}');
    expect(zh.filename).toBe(en.filename);
    expect(zh.state).toEqual({ ...en.state, exportedAt: zh.state.exportedAt });
    expect(Object.keys(zh.state)).toEqual(['schemaVersion', 'projectId', 'projectName', 'exportedAt', 'memory', 'nextAction']);
    const json = JSON.stringify(en.state);
    const before = previewPastedSharedState(p, json), after = previewPastedSharedState(p, json, 'zh-TW');
    expect(after.hash).toBe(before.hash); expect(after.state).toEqual(before.state); expect(after.source).toBe('貼上的 JSON');
  });
  it('labels facts, notes, suggestions, and never claims to transfer conversations', () => {
    const p = store.createProject({ path: dir, name: '工具' });
    const result = buildHandoff(p, [], 'codex');
    expect(result.markdown).toContain('Target: Codex'); expect(result.markdown).toContain('does not include the previous agent');
    expect(result.markdown).toContain('Observed facts'); expect(result.markdown).toContain('rule-based suggestion');
    expect(result.state.schemaVersion).toBe(1);
  });
  it.each(['claude-desktop', 'chatgpt-desktop'] as const)('gives %s an honest, self-contained JSON return template', (target) => {
    const p = store.createProject({ path: dir, name: '工具 "quoted"', nextAction: 'Review attachments' });
    const result = buildHandoff(p, [], target, 'zh-TW');
    expect(result.markdown).toContain(`交接對象：${target === 'claude-desktop' ? 'Claude Desktop' : 'ChatGPT Desktop'}`);
    expect(result.markdown).toContain('不代表你能存取本機檔案');
    expect(result.markdown).toContain('過往對話');
    expect(result.markdown).toContain('索取相關附件');
    expect(result.markdown).toContain('使用者仍需手動貼上並傳送');
    expect(result.markdown).toContain('只更新 memory 與 nextAction');
    expect(result.markdown).toContain('保留 schemaVersion、projectId、projectName、exportedAt 的原值');
    expect(result.markdown).toContain('不要嘗試寫入本機 state.json');
    expect(result.markdown).not.toContain('再檢查目前 repository 的實際狀態');
    const template = result.markdown.split('## JSON 回傳範本\n')[1];
    expect(previewPastedSharedState(p, template).state).toEqual(result.state);
    expect(result.markdown).toContain('不要覆寫 AGENTS.md、CLAUDE.md');
    expect(result.markdown).toContain('沒有檔案或執行工具時，明確註記尚未驗證');
  });
  it('preserves AGENTS.md, CLAUDE.md and agent-edited state on repeat export', async () => {
    const p = store.createProject({ path: dir, name: '工具' });
    await writeFile(join(dir, 'AGENTS.md'), 'existing agents instructions'); await writeFile(join(dir, 'CLAUDE.md'), 'existing claude instructions');
    const first = await exportHandoff(p, [], 'claude'); expect(first.stateCreated).toBe(true);
    const initial = await previewSharedState(p);
    const updated = { ...initial.state, memory: { ...EMPTY_MEMORY, status: 'agent checkpoint' } };
    await writeFile(initial.source, JSON.stringify(updated));
    const second = await exportHandoff(p, [], 'generic'); expect(second.stateCreated).toBe(false);
    expect(second.files[0]).not.toBe(first.files[0]);
    const preview = await previewSharedState(p); expect(preview.state.memory.status).toBe('agent checkpoint'); expect(preview.hash).not.toBe(initial.hash);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('existing agents instructions');
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('existing claude instructions');
  });
  it('rejects foreign project state, injected fields and oversized files', async () => {
    const p = store.createProject({ path: dir, name: 'tool' });
    await exportHandoff(p, [], 'generic'); const preview = await previewSharedState(p);
    await writeFile(preview.source, JSON.stringify({ ...preview.state, command: 'do not run' }));
    await expect(previewSharedState(p)).rejects.toThrow(/format does not match/);
    await writeFile(preview.source, JSON.stringify({ ...preview.state, projectId: '00000000-0000-4000-8000-000000000000' }));
    await expect(previewSharedState(p)).rejects.toThrow(/another project/);
    await writeFile(preview.source, 'x'.repeat(1024 * 1024 + 1));
    await expect(previewSharedState(p)).rejects.toThrow(/1 MB/);
  });
  it('refuses exporting through a junction or directory symlink', async context => {
    const outside = join(dir, 'other'); await mkdir(outside);
    try { await symlink(outside, join(dir, '.ai-project-hub'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    const p = store.createProject({ path: dir, name: 'tool' });
    await expect(exportHandoff(p, [], 'generic')).rejects.toThrow(/symlink|junction/);
    expect(await readdir(outside)).toEqual([]);
  });
  it('reports a missing shared state without creating files', async () => {
    const p = store.createProject({ path: dir, name: 'tool' });
    await expect(previewSharedState(p)).rejects.toThrow(/has not been created/);
  });
  it('keeps file imports raw JSON only and preserves byte hashes including BOM', async () => {
    const p = store.createProject({ path: dir, name: 'tool' });
    await exportHandoff(p, [], 'generic');
    const original = await previewSharedState(p);
    const text = '﻿' + JSON.stringify(original.state) + '\r\n';
    await writeFile(original.source, text);
    expect((await previewSharedState(p)).hash).toBe(createHash('sha256').update(text).digest('hex'));
    await writeFile(original.source, '```json\n' + JSON.stringify(original.state) + '\n```');
    await expect(previewSharedState(p)).rejects.toThrow(/not valid JSON/);
  });
});

describe('pasted shared-state parser', () => {
  it.each(['raw', 'json', 'JSON', 'unlabelled', 'crlf'] as const)('accepts only a complete %s JSON document and hashes exact input', async (format) => {
    const p = store.createProject({ path: join(dir, 'offline-project'), name: '工具' });
    const state = buildHandoff(p, [], 'claude-desktop').state;
    const json = JSON.stringify({ ...state, memory: { ...EMPTY_MEMORY, notes: 'Quotes " and literal ``` backticks' } });
    const text = format === 'raw' ? ` ﻿${json}\n `
      : format === 'crlf' ? `\r\n\`\`\`json\r\n${json}\r\n\`\`\`\r\n`
      : ` \n\`\`\`${format === 'unlabelled' ? '' : format}\n${json}\n\`\`\` \n`;
    const preview = previewPastedSharedState(p, text);
    expect(preview.state).toEqual(JSON.parse(json));
    expect(preview.source).toBe('Pasted JSON');
    expect(preview.hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(preview.hash).not.toBe(previewPastedSharedState(p, json).hash);
    expect(await readdir(dir)).toEqual([]);
  });
  it.each([
    '', 'not json', 'null', '[]', '{}',
    'Here is the JSON:\n%s', '%s\nSome explanation',
    '```javascript\n%s\n```', '```json\n%s', '```json %s```',
    '```json\n%s\n```\n```json\n%s\n```',
    '```json\n%s\n```\nmore text', 'before\n```json\n%s\n```',
  ])('rejects malformed, partial or prose-wrapped input (%s)', (format) => {
    const p = store.createProject({ path: dir, name: 'tool' });
    const json = JSON.stringify(buildHandoff(p, []).state);
    expect(() => previewPastedSharedState(p, format.replaceAll('%s', json))).toThrow();
  });
  it('applies strict schema, field lengths and project identity to pasted JSON', () => {
    const p = store.createProject({ path: dir, name: 'tool' });
    const state = buildHandoff(p, []).state;
    const invalid = [
      { ...state, command: 'never execute' },
      { ...state, memory: { ...EMPTY_MEMORY, command: 'never execute' } },
      { ...state, memory: { status: 'missing fields' } },
      { ...state, memory: { ...EMPTY_MEMORY, status: 42 } },
      { ...state, memory: { ...EMPTY_MEMORY, notes: 'x'.repeat(20_001) } },
      { ...state, nextAction: 'x'.repeat(2_001) },
      { ...state, schemaVersion: 2 },
      { ...state, exportedAt: 'yesterday' },
    ];
    for (const value of invalid) expect(() => previewPastedSharedState(p, JSON.stringify(value))).toThrow(/format does not match/);
    expect(() => previewPastedSharedState(p, JSON.stringify({ ...state, projectId: '00000000-0000-4000-8000-000000000000' }))).toThrow(/another project/);
  });
  it('bounds exact UTF-8 bytes, not character count, before parsing', () => {
    const p = store.createProject({ path: dir, name: 'tool' });
    const json = JSON.stringify(buildHandoff(p, []).state);
    const limit = json + ' '.repeat(MAX_STATE_BYTES - Buffer.byteLength(json));
    expect(previewPastedSharedState(p, limit).state.projectId).toBe(p.id);
    expect(() => previewPastedSharedState(p, limit + ' ')).toThrow(/1 MB/);
    expect(() => previewPastedSharedState(p, '中'.repeat(Math.ceil(MAX_STATE_BYTES / 3)))).toThrow(/1 MB/);
    expect(() => previewPastedSharedState(p, `\`\`\`json\n${limit}\n\`\`\``)).toThrow(/1 MB/);
  });
});
