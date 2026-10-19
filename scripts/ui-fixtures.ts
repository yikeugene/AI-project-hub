// Creates only new, isolated fixtures. Never scans the user's other projects.
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { readGitSnapshot } from '../server/git.js';
import { EMPTY_MEMORY } from '../shared/types.js';

const exec = promisify(execFile);
const root = resolve('.local', `fixtures-${randomUUID().slice(0, 8)}`);
await mkdir(root, { recursive: true });
const store = new Store(resolve('.local/verification/hub.sqlite'));
const samples = [
  { name: 'Local Lens', category: 'AI 工具', stage: 'MVP 驗證', priority: 'high' as const, status: 'active' as const, days: 0, next: '驗證中文文件的引用來源', description: '驗證工作區範例：本機文件檢索與來源追溯。', checkpoint: '已接好文件匯入和向量搜尋；接下來驗證中文分段的引用準確度。' },
  { name: 'Prompt Studio', category: '開發工具', stage: '介面開發', priority: 'normal' as const, status: 'active' as const, days: 2, next: '完成 prompt 版本比較', description: '驗證工作區範例：管理可重用的 prompts 與測試案例。', checkpoint: '版本儲存已完成，比較介面仍需要 keyboard navigation。' },
  { name: 'Signal Notes', category: '個人生產力', stage: '資料層', priority: 'high' as const, status: 'active' as const, days: 20, next: '確認本機索引的增量更新策略', description: '驗證工作區範例：把零散的研究筆記整理成可搜尋的資料庫。', checkpoint: 'SQLite schema 已定案；上次停在索引更新的設計選擇。' },
  { name: 'Tiny Automations', category: '開發工具', stage: '設計中', priority: 'low' as const, status: 'planning' as const, days: 5, next: '列出第一個安全的自動化流程', description: '驗證工作區範例：不依賴雲端的個人工作流程。', checkpoint: '先做白名單檔案整理，不加入任意 shell 執行。' },
  { name: 'Reading Room', category: '個人生產力', stage: '暫停', priority: 'backlog' as const, status: 'paused' as const, days: 35, next: '', description: '驗證工作區範例：離線閱讀清單與摘錄。', checkpoint: '閱讀清單可以使用；等待有空再做瀏覽器整合。' },
];
try {
  for (const sample of samples) {
    let path = join(root, sample.name); await mkdir(path); path = await realpath(path);
    await writeFile(join(path, 'README.md'), `# ${sample.name}\n\nDisposable UI verification fixture only.\n`);
    await exec('git', ['init', '--initial-branch=main'], { cwd: path });
    await exec('git', ['add', 'README.md'], { cwd: path });
    const date = new Date(Date.now() - sample.days * 86400000).toISOString();
    await exec('git', ['-c', 'user.name=Hub Test', '-c', 'user.email=hub-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', `Add ${sample.name} checkpoint`], { cwd: path, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (sample.days === 0) await writeFile(join(path, 'notes.txt'), 'Working tree change for verification.');
    const p = store.createProject({ path, ...sample, nextAction: sample.next });
    store.saveMemory(p.id, p.revision, { ...EMPTY_MEMORY, overview: sample.description, status: sample.checkpoint, architecture: 'TypeScript、SQLite；資料保留在本機。', completed: '基本資料模型與第一輪測試。', decisions: '不加入雲端帳號或強制 API 依賴。', nextActions: sample.next });
    store.saveObservation(p.id, await readGitSnapshot(path), null);
    if (sample.next) store.createTask(p.id, { title: sample.next, priority: sample.priority, status: sample.days === 0 ? 'doing' : 'todo' });
    if (sample.days === 0) {
      store.createTask(p.id, { title: '基本文件匯入流程', status: 'done' });
      store.createTask(p.id, { title: '大型 PDF 的文字抽取', status: 'blocked', detail: '需要確認可接受的記憶體用量。', priority: 'normal' });
    }
  }
  console.log(`Verification fixtures: ${root}\nDatabase: ${resolve('.local/verification/hub.sqlite')}\nStart the verification profile on port 4318. Production remains untouched.`);
} finally { store.close(); }
