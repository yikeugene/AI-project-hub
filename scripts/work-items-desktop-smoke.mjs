import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const flag = process.argv.indexOf('--executable');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('Provide --executable with the isolated packaged build.');
const executable = resolve(process.argv[flag + 1]);
if (!existsSync(executable)) throw new Error('Build executable not found.');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'work-items-desktop-'));
const dataDir = join(work, 'data'), projectPath = join(work, 'project');
await mkdir(projectPath);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, clipboardBefore, clipboardUsed;
const errors = [], report = { executable, work, checks: [], skippedChecks: [] };
const allowUnavailableClipboard = process.argv.includes('--allow-unavailable-clipboard');
const checked = message => { report.checks.push(message); console.log('PASS:', message); };
async function launch() {
  desktop = await _electron.launch({ executablePath: executable, args: ['--data-dir', dataDir], env, timeout: 45000 });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.hubDesktop && !!document.querySelector('.main-content'));
  return page;
}
async function quit() {
  if (!desktop) return;
  const closed = desktop.waitForEvent('close');
  await desktop.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('quit');
    if (!item) throw new Error('Native quit action missing');
    item.click();
  });
  await closed; desktop = undefined;
}
async function api(page, path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const workspace = await (await fetch('/api/workspace')).json();
    const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': workspace.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }, { path, method, body });
}
async function apply(page, item, action) {
  const response = await api(page, `/work-items/${item.id}/actions`, 'POST', { commandId: randomUUID(), expectedRevision: item.revision, action });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data.item;
}
try {
  let page = await launch();
  assert.equal((await fetch(new URL('/api/workspace', page.url()))).status, 401);
  checked('Packaged work-item routes retain the desktop session-secret protection');
  const project = await api(page, '/projects', 'POST', { path: projectPath, name: 'Work-item desktop smoke' });
  assert.equal(project.status, 201);
  const created = await api(page, `/projects/${project.data.id}/work-items`, 'POST', { commandId: randomUUID(), brief: {
    title: 'Preserve the next check', goal: 'Show a validation message', nonGoals: 'No redesign', acceptanceCriteria: ['Empty input shows a message'], firstCheck: 'Submit an empty input',
  } });
  assert.equal(created.status, 200); let item = created.data.item;
  item = await apply(page, item, { type: 'confirm' });
  const preview = await api(page, `/work-items/${item.id}/brief`); assert.equal(preview.status, 200);
  await page.reload();
  await page.getByRole('button', { name: 'Open Preserve the next check', exact: true }).click();
  await page.getByRole('button', { name: 'Preview task brief', exact: true }).click();
  assert.equal(await page.locator('.work-preview-text').inputValue(), preview.data.markdown);
  clipboardBefore = await desktop.evaluate(({ clipboard }) => clipboard.readText()); clipboardUsed = preview.data.markdown;
  await page.getByRole('button', { name: 'Copy task brief', exact: true }).click();
  await page.locator('.work-preview .inline-success').waitFor();
  let clipboardAfter = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    clipboardAfter = await desktop.evaluate(({ clipboard }) => clipboard.readText());
    if (clipboardAfter === clipboardUsed) break;
    await page.waitForTimeout(50);
  }
  if (clipboardAfter !== clipboardUsed && allowUnavailableClipboard) {
    report.skippedChecks.push('Native clipboard could not retain text in this desktop session; actual clipboard round-trip is not verified.');
    console.log('SKIP:', report.skippedChecks.at(-1));
  } else {
    assert.ok(clipboardAfter === clipboardUsed, 'Native clipboard must match the current brief; clipboard contents are not logged.');
    checked('The actual native clipboard retains the exact confirmed brief');
  }
  assert.equal((await api(page, `/work-items/${item.id}`)).data.item.phase, 'ready');
  checked('Copying a brief does not mark the work item handed off');
  item = await apply(page, item, { type: 'dispatch', previewHash: preview.data.hash });
  const eventsBefore = (await api(page, `/work-items/${item.id}`)).data.events;
  await page.reload(); await page.getByText('Preserve the next check', { exact: true }).first().waitFor();
  await page.screenshot({ path: join(work, 'pending-work-item.png') });
  await desktop.evaluate(({ clipboard }, { used, before }) => { if (clipboard.readText() === used) clipboard.writeText(before); }, { used: clipboardUsed, before: clipboardBefore });
  clipboardBefore = undefined;
  await quit(); page = await launch();
  const recovered = await api(page, `/work-items/${item.id}`);
  assert.deepEqual(recovered.data.item, item); assert.deepEqual(recovered.data.events, eventsBefore);
  checked('Real packaged restart preserves pending work and does not replay its handoff');
  item = await apply(page, item, { type: 'startReview', resultNote: 'Inspected the returned result' });
  item = await apply(page, item, { type: 'recordCheck', role: 'self', outcome: 'pass', note: 'Checked the code', source: 'self', version: item.version, submissionId: item.currentSubmissionId });
  const premature = await api(page, `/work-items/${item.id}/actions`, 'POST', { commandId: randomUUID(), expectedRevision: item.revision, action: { type: 'complete' } });
  assert.equal(premature.status, 409);
  item = await apply(page, item, { type: 'recordCheck', role: 'partner', outcome: 'pass', note: 'Partner tested the form in person', source: 'in_person', version: item.version, submissionId: item.currentSubmissionId });
  assert.equal(item.phase, 'review');
  item = await apply(page, item, { type: 'complete' }); assert.equal(item.phase, 'done');
  checked('Both checks and explicit completion are enforced in the packaged runtime');
  item = await apply(page, item, { type: 'revise', kind: 'reopen', reason: 'A new result needs verification' });
  assert.equal(item.version, 2); assert.deepEqual(item.checks, { self: null, partner: null });
  checked('Reopening invalidates old checks without erasing the prior records');
  assert.deepEqual(errors, []);
  await quit();
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Work-item desktop smoke report: ${join(work, 'report.json')}`);
} finally {
  if (desktop) {
    if (clipboardBefore !== undefined) await desktop.evaluate(({ clipboard }, { used, before }) => { if (clipboard.readText() === used) clipboard.writeText(before); }, { used: clipboardUsed, before: clipboardBefore }).catch(() => {});
    await quit().catch(async () => { await desktop?.close(); });
  }
}
