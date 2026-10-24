import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent of the Git tools: a machine needs only the existing .NET Framework
// compiler, never a Git installation, npm addon or compiler downloaded at runtime.
export async function buildForegroundApp(destination) {
  if (process.platform !== 'win32') throw new Error('The foreground helper must be built on Windows.');
  if (!destination || !path.isAbsolute(destination)) throw new Error('An absolute output directory is required.');
  const source = fileURLToPath(new URL('../desktop/foreground-app.cs', import.meta.url));
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = await realpath(path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
  await mkdir(destination, { recursive: true });
  const folder = await lstat(destination);
  if (!folder.isDirectory() || folder.isSymbolicLink()
    || (await realpath(destination)).toLowerCase() !== path.resolve(destination).toLowerCase())
    throw new Error('Foreground helper output must be an ordinary directory, not a link.');
  const executable = path.join(destination, 'foreground-app.exe');
  const previous = await lstat(executable).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('Foreground helper output must be an ordinary file.');
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, [
      '/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', `/out:${executable}`, source,
    ], { cwd: path.dirname(source), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let failed = false, bytes = 0;
    const fail = () => { if (!failed) { failed = true; try { child.kill('SIGKILL'); } catch {} } };
    const timer = setTimeout(fail, 30000);
    const count = data => { bytes += data.length; if (bytes > 65536) fail(); };
    child.stdout.on('data', count); child.stderr.on('data', count);
    child.stdout.once('error', fail); child.stderr.once('error', fail); child.once('error', fail);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failed) resolve(); else reject(new Error('Foreground helper compilation failed.'));
    });
  });
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('An absolute output directory is required.');
  await buildForegroundApp(process.argv[2]);
}
