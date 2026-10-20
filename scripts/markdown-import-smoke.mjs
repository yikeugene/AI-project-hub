import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function fillBlock(markdown, heading, value) {
  const lines = markdown.split('\n'), start = lines.indexOf(heading);
  assert.ok(start >= 0, `Missing fixture heading: ${heading}`);
  let open = start + 1;
  while (lines[open] === '') open++;
  const fence = /^(~{3,})text$/.exec(lines[open])?.[1];
  assert.ok(fence, 'Expected a generated text fence.');
  const close = lines.indexOf(fence, open + 1);
  assert.ok(close > open);
  return [...lines.slice(0, open + 1), value, ...lines.slice(close)].join('\n');
}

/** Runs only inside the disposable packaged desktop smoke; no production hook or IPC is added. */
export async function verifyMarkdownImport({ page, desktop, work, ownRow, ownSummary, checked }) {
  const workspace = () => page.evaluate(async () => (await fetch('/api/workspace')).json());
  const request = (path, body, method = 'POST') => page.evaluate(async ({ path, body, method }) => {
    const current = await (await fetch('/api/workspace')).json();
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': current.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { path, body, method });
  const importDialog = page.locator('.markdown-import-dialog');
  const source = importDialog.locator('.markdown-import-input');
  const fileInput = importDialog.locator('.markdown-import-file');
  const openImport = async () => {
    await page.locator('.markdown-import-open').click();
    await importDialog.waitFor();
  };
  const preview = async () => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/markdown-import/preview' && response.request().method() === 'POST');
    await importDialog.locator('.markdown-import-preview-button').click();
    return pending;
  };
  const review = async () => {
    await importDialog.locator('.markdown-import-confirm-button').click();
    const dialog = page.locator('.confirm-dialog'); await dialog.waitFor(); return dialog;
  };
  const closeImport = () => importDialog.locator('.icon-button').first().click();

  await ownRow.click();
  const downloadPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/shared-workspace/download' && response.request().method() === 'POST');
  await page.locator('.markdown-prompt-open').click();
  const download = await downloadPending;
  assert.equal(download.status(), 200);
  assert.deepEqual(download.request().postDataJSON(), { profileId: ownSummary.profileId, ownerDeviceId: ownSummary.ownerDeviceId, projectId: ownSummary.projectId, version: ownSummary.version });
  const template = (await download.json()).text;
  const promptDialog = page.locator('.markdown-prompt-dialog'); await promptDialog.waitFor();
  const prompt = await promptDialog.locator('.markdown-prompt-text').inputValue();
  assert.ok(prompt.includes(template));
  const before = await workspace(), original = before.projects.find(project => project.id === ownSummary.projectId);
  assert.ok(original); assert.equal(prompt.includes(original.path), false);
  for (const [field, value] of Object.entries(original.memory)) if (field !== 'status' && value.trim()) assert.equal(template.includes(value), false);
  await promptDialog.locator('.markdown-prompt-copy').click();
  await promptDialog.getByRole('status').waitFor();
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), prompt);
  assert.equal(await promptDialog.locator('.markdown-prompt-text').getAttribute('readonly'), '');
  await promptDialog.locator('.icon-button').first().click();
  await promptDialog.waitFor({ state: 'detached' });
  checked('AI fill prompt revalidates the selected snapshot and copies exactly the previewed allowlisted template through native clipboard, without private local context');

  const blank = fillBlock(fillBlock(template, '## 下一步行動', ' \t\n'), '### 目前開發狀態', '\n');
  const blankPath = join(work, 'blank-summary.md'); await writeFile(blankPath, blank);
  await openImport(); await fileInput.setInputFiles(blankPath);
  await page.waitForFunction(text => document.querySelector('.markdown-import-input')?.value === text, blank);
  const blankResponse = await preview(); assert.equal(blankResponse.status(), 200);
  assert.equal((await blankResponse.json()).canApply, false);
  if (await importDialog.locator('.markdown-import-confirm-button').count()) assert.equal(await importDialog.locator('.markdown-import-confirm-button').isDisabled(), true);
  let current = (await workspace()).projects.find(project => project.id === original.id);
  assert.equal(current.revision, original.revision); assert.deepEqual(current.memory, original.memory);
  const retainedText = await source.inputValue();
  await fileInput.setInputFiles([]); assert.equal(await source.inputValue(), retainedText);
  await fileInput.setInputFiles({ name: 'invalid-utf8.md', mimeType: 'text/markdown', buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await importDialog.getByRole('alert').first().waitFor(); assert.equal(await source.inputValue(), retainedText);
  await fileInput.setInputFiles({ name: 'too-large.md', mimeType: 'text/markdown', buffer: Buffer.alloc(1024 * 1024 + 1, 65) });
  await importDialog.getByRole('alert').first().waitFor(); assert.equal(await source.inputValue(), retainedText);
  checked('Sandboxed Markdown file selection preserves blank fields and existing drafts on picker cancellation, rejects invalid UTF-8 and oversize files, and performs no write for an empty template');

  const nextAction = '核對 Markdown 匯入後的本機資料。';
  const status = '  依提供資料整理的隔離驗證狀態\n\n保留內容中的空白。  ';
  const filled = fillBlock(fillBlock(template, '## 下一步行動', nextAction), '### 目前開發狀態', status);
  const raw = '﻿' + filled.replaceAll('\n', '\r\n');
  const inputPath = join(work, 'filled-summary.md'); await writeFile(inputPath, raw);
  await fileInput.setInputFiles(inputPath);
  await page.waitForFunction(() => document.querySelector('.markdown-import-input')?.value.startsWith('﻿#'));
  const previewResponse = await preview(); assert.equal(previewResponse.status(), 200);
  assert.equal(previewResponse.request().postDataJSON().text, raw);
  const captured = await previewResponse.json();
  assert.equal(captured.projectId, original.id); assert.equal(captured.canApply, true);
  assert.deepEqual(captured.changes.filter(change => change.before !== change.after).map(change => change.key).sort(), ['nextAction', 'status']);
  let confirmation = await review();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await workspace()).projects.find(project => project.id === original.id).revision, original.revision);
  confirmation = await review();
  const appliedPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/markdown-import/apply' && response.request().method() === 'POST');
  await confirmation.getByRole('button', { name: '確認匯入', exact: true }).click();
  const appliedResponse = await appliedPending; assert.equal(appliedResponse.status(), 200);
  assert.deepEqual(appliedResponse.request().postDataJSON(), { text: raw, projectId: captured.projectId, revision: captured.revision, hash: captured.hash, digest: captured.digest, confirm: true });
  await importDialog.locator('.markdown-import-success').waitFor();
  const after = await workspace(); current = after.projects.find(project => project.id === original.id);
  assert.equal(current.revision, original.revision + 1); assert.equal(current.nextAction, nextAction);
  assert.deepEqual(current.memory, { ...original.memory, status });
  for (const field of ['id', 'name', 'path', 'description', 'category', 'status', 'priority', 'stage']) assert.equal(current[field], original[field]);
  assert.deepEqual(after.tasks, before.tasks); assert.equal(await readFile(inputPath, 'utf8'), raw);
  await page.screenshot({ path: join(work, 'desktop-markdown-import.png'), fullPage: true });
  await closeImport(); await importDialog.waitFor({ state: 'detached' });
  checked('BOM/CRLF Markdown is previewed with exact original text, canceled confirmation is inert, and explicit import updates only nonblank memory/next action once while preserving metadata, tasks and source file');

  const staleText = fillBlock(filled, '## 下一步行動', '這份過期預覽不能被套用。');
  await writeFile(inputPath, staleText);
  await openImport(); await fileInput.setInputFiles(inputPath);
  await page.waitForFunction(text => document.querySelector('.markdown-import-input')?.value === text, staleText);
  const stalePreview = await preview(); assert.equal(stalePreview.status(), 200);
  assert.equal((await stalePreview.json()).sourceRevisionDiffers, true);
  const external = await request(`/api/projects/${current.id}/memory`, { revision: current.revision, memory: { ...current.memory, notes: `${current.memory.notes}\nExternal local edit` } }, 'PUT');
  assert.equal(external.status, 200);
  confirmation = await review();
  const staleApplyPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/markdown-import/apply' && response.request().method() === 'POST');
  await confirmation.getByRole('button', { name: '確認匯入', exact: true }).click();
  assert.equal((await staleApplyPending).status(), 409);
  const guarded = (await workspace()).projects.find(project => project.id === original.id);
  assert.equal(guarded.nextAction, nextAction); assert.equal(guarded.memory.notes, external.data.memory.notes);
  // A conflict invalidates the captured preview and closes its confirmation automatically.
  await importDialog.getByRole('alert').first().waitFor();
  await confirmation.waitFor({ state: 'detached' });
  await closeImport();
  const discard = page.locator('.confirm-dialog'); await discard.waitFor();
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await source.inputValue(), staleText);
  await closeImport();
  await page.locator('.confirm-dialog').getByRole('button', { name: '捨棄草稿', exact: true }).click();
  await importDialog.waitFor({ state: 'detached' });
  checked('An old source revision is disclosed, a local edit after preview rejects confirmation with 409, and dismissing an unimported Markdown draft requires an explicit discard');

  // A device-service failure must not block the independent local import entry.
  await page.route('**/api/devices', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated device service failure' }) }));
  try {
    await page.reload();
    await page.locator('.main-nav').getByRole('button', { name: '共享工作區', exact: true }).click();
    await page.locator('.markdown-import-open').waitFor();
    assert.equal(await page.locator('.markdown-import-open').isEnabled(), true);
    await openImport(); await closeImport(); await importDialog.waitFor({ state: 'detached' });
  } finally {
    await page.unroute('**/api/devices'); await page.reload();
    await page.locator('.main-nav').getByRole('button', { name: '共享工作區', exact: true }).click();
  }
  checked('Local Markdown import remains accessible when device state is unavailable, without changing Electron filesystem permissions or requiring a group connection');
}
