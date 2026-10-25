/** Disposable manual-work preview: no user data, model calls, credentials, Git commands or relay traffic. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHubRuntime } from '../server/runtime.js';
import { WorkItems } from '../server/work-items.js';
import type { WorkAction, WorkBrief, WorkItem } from '../shared/work-items.js';

const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'work-items-ui-'));
const runtime = await createHubRuntime({ mode: 'web', port: 4324, dataDir: join(work, 'data'), assetDirectory: join(root, 'dist'), enablePolling: false,
  deviceOptions: { enablePolling: false },
  appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }),
    readGit: async () => ({ isRepo: false, branch: null, head: null, branches: [], commits: [], changes: [], changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0, lastCommitAt: null, observedAt: new Date().toISOString() }) },
});
runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
const items = new WorkItems(runtime.store);
function apply(item: WorkItem, action: WorkAction) { return items.apply(item.id, { commandId: randomUUID(), expectedRevision: item.revision, action }).item; }
async function project(name: string, directory: string) { const path = join(work, directory); await mkdir(path); return runtime.store.createProject({ path, name, description: '隔離驗證資料，不是你的真實專案。' }); }
function draft(projectId: string, brief: WorkBrief) { return items.createDraft(projectId, { commandId: randomUUID(), brief }).item; }
function sent(item: WorkItem) { item = apply(item, { type: 'confirm' }); return apply(item, { type: 'dispatch', previewHash: items.preview(item.id).hash }); }
const registration = await project('校園活動報名（隔離測試）', 'registration');
sent(draft(registration.id, { title: '讓報名表顯示必填提示', goal: '姓名留空時顯示提示，不改原本的報名流程。', nonGoals: '不新增帳號登入、不重新設計整張表單。', acceptanceCriteria: ['姓名留空會出現清楚提示', '填妥姓名後仍能送出'], firstCheck: '打開報名頁，不填姓名直接送出。' }));
const notes = await project('課堂筆記整理（隔離測試）', 'notes');
apply(draft(notes.id, { title: '替筆記加上課程篩選', goal: '讓使用者只看某一門課的筆記。', nonGoals: '不新增全文搜尋。', acceptanceCriteria: ['選擇課程只顯示該課筆記', '選擇全部能還原清單'], firstCheck: '選擇一門已有兩則筆記的課程。' }), { type: 'confirm' });
const library = await project('圖書館預約工具（隔離測試）', 'library');
let review = sent(draft(library.id, { title: '在預約前顯示時段摘要', goal: '確認預約前能看到日期與時段。', nonGoals: '不修改後端預約規則。', acceptanceCriteria: ['確認畫面有日期與起訖時間', '返回上一步仍保留選擇'], firstCheck: '選一個時段，進入確認畫面核對日期與時間。' }));
review = apply(review, { type: 'startReview', resultNote: '已檢查程式，待搭檔操作測試。' });
apply(review, { type: 'recordCheck', role: 'self', outcome: 'pass', note: '日期與時段顯示正確，沒有改動預約規則。', source: 'self', version: review.version, submissionId: review.currentSubmissionId! });
let waiting = sent(draft(library.id, { title: '確認測試環境的使用權限', goal: '取得測試帳戶後驗證預約流程。', nonGoals: '', acceptanceCriteria: ['測試帳戶可進入預約頁'], firstCheck: '收到審批後，用測試帳戶進入預約頁。' }));
waiting = apply(waiting, { type: 'setHold', hold: { kind: 'waiting', reason: '等待管理員核准測試帳戶', resumeAction: '收到核准訊息後確認可登入', until: null } });
console.log(`Isolated work-items preview: ${runtime.origin}`);
console.log(`Disposable data: ${work}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await runtime.stop(); process.exit(0); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
