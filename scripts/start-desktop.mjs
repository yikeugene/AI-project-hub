import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(root, 'release', 'win-unpacked', 'AI Project Hub.exe');
if (process.platform !== 'win32' || !existsSync(executable)) {
  console.error('找不到已打包的 Windows 桌面版。開發環境請先執行 npm run pack:desktop，或直接開啟已交付的 portable / Setup .exe。');
  process.exitCode = 1;
} else {
  const child = spawn(executable, process.argv.slice(2), { detached: true, stdio: 'ignore', windowsHide: false });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref();
}
