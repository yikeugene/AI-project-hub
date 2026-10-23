/** Disposable local-memory preview. No real user database, credentials or external relay. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHubRuntime } from '../server/runtime.js';

const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.local'), { recursive: true });
const work = await mkdtemp(join(root, '.local', 'memory-ui-'));
const runtime = await createHubRuntime({ mode: 'web', port: 4321, dataDir: join(work, 'data'), assetDirectory: join(root, 'dist'), enablePolling: false,
  appOptions: { capabilities: async () => ({ folder: false, vscode: false, claude: false, codex: false }), desktopCapabilities: async () => ({ claude: false, chatgpt: false }) },
});
runtime.store.updateSettings({ locale: 'zh-TW', refreshSeconds: 0 });
for (const [name, directory] of [['本機記憶驗證專案', 'memory'], ['另一個隔離專案', 'other']]) {
  const path = join(work, directory); await mkdir(path);
  const project = runtime.store.createProject({ path, name, description: '隔離驗證資料，不會修改你的專案。', nextAction: '保留原本的專案下一步' });
  runtime.store.saveMemory(project.id, project.revision, { ...project.memory, overview: '原本的專案概覽', notes: '保留這份私人筆記' });
}
console.log(`Isolated memory preview: ${runtime.origin}`);
console.log(`Disposable data: ${work}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await runtime.stop(); process.exit(0); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
