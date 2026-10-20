import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildGitTools(destination) {
  if (process.platform !== 'win32') throw new Error('The packaged Git supervisor must be built on Windows.');
  const source = fileURLToPath(new URL('../desktop/git-host.cs', import.meta.url));
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = await realpath(path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Git tool output must not be a link.');
  const host = path.join(destination, 'git-host.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', `/out:${host}`, source], {
      cwd: path.dirname(source), stdio: 'pipe', shell: false, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Git helper compilation failed: ${output}`)));
  });
  await mkdir(path.join(destination, 'hooks'), { recursive: true });
  await cp(host, path.join(destination, 'hooks', 'pre-push.exe'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination || !path.isAbsolute(destination)) throw new Error('An absolute output directory is required.');
  await buildGitTools(destination);
}
