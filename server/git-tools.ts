import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitOperationError } from './git-errors.ts';
import { isWithinDirectory } from './commands.ts';

export interface GitTools { git: string; execPath: string; binPaths: string[]; credential: string | null; host: string | null; hooks: string | null }

async function ordinaryFile(filename: string): Promise<string | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    await access(filename);
    return await realpath(filename);
  } catch { return null; }
}

export async function resolveGitTools(): Promise<GitTools> {
  if (process.platform !== 'win32') {
    for (const root of ['/usr', '/usr/local', '/opt/homebrew']) {
      const git = await ordinaryFile(path.join(root, 'bin/git'));
      if (git) return { git, execPath: path.join(root, 'libexec/git-core'), binPaths: [path.join(root, 'bin'), '/usr/bin', '/bin'], credential: null, host: null, hooks: null };
    }
    throw new GitOperationError('unavailable');
  }
  const roots = [...new Set([
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs/Git')] : []),
  ])];
  for (const root of roots) {
    const git = await ordinaryFile(path.join(root, 'cmd/git.exe'));
    if (!git || !isWithinDirectory(git, root)) continue;
    const execPath = await realpath(path.join(root, 'mingw64/libexec/git-core')).catch(() => null);
    if (!execPath || !isWithinDirectory(execPath, root)) continue;
    const foundCredential = await ordinaryFile(path.join(root, 'mingw64/bin/git-credential-manager.exe'));
    const credential = foundCredential && isWithinDirectory(foundCredential, root) ? foundCredential : null;
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packaged = resources && process.versions.electron ? path.join(resources, 'git-tools') : null;
    let toolDirectory: string;
    if (packaged && await ordinaryFile(path.join(packaged, 'git-host.exe'))) toolDirectory = packaged;
    else if (typeof __dirname === 'string') toolDirectory = path.join(__dirname, 'git-tools');
    else toolDirectory = fileURLToPath(new URL('../.desktop-build/app/git-tools/', import.meta.url));
    const host = await ordinaryFile(path.join(toolDirectory, 'git-host.exe'));
    const hook = await ordinaryFile(path.join(toolDirectory, 'hooks/pre-push.exe'));
    return {
      git, execPath, credential, host, hooks: hook ? path.dirname(hook) : null,
      binPaths: [path.join(root, 'cmd'), path.join(root, 'mingw64/bin'), path.join(root, 'usr/bin'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')],
    };
  }
  throw new GitOperationError('unavailable');
}

export function isolatedGitEnvironment(tools: GitTools, originalConfig = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'HOME', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME']) {
    const actual = Object.keys(process.env).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    if (actual && process.env[actual]) env[key] = process.env[actual];
  }
  return {
    ...env, PATH: tools.binPaths.join(path.delimiter), GIT_EXEC_PATH: tools.execPath,
    ...(!originalConfig ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' } : {}),
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', GIT_ALLOW_PROTOCOL: '', GIT_LITERAL_PATHSPECS: '1',
    GCM_INTERACTIVE: 'Never', GCM_GUI_PROMPT: '0', GCM_CREDENTIAL_STORE: process.platform === 'win32' ? 'wincred' : 'secretservice',
    LC_ALL: 'C', LANG: 'C',
  };
}
