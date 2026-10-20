import { appError } from './validation.js';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { GitChange, GitCommit, GitSnapshot } from '../shared/types.ts';
import { canonicalDirectory } from './discovery.ts';
import { findTrustedExecutable, isWithinDirectory, runCommand } from './commands.ts';

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Repo configuration must not turn a read into a helper, network request, or index write. */
export const GIT_READ_ONLY_ARGS = [
  '--no-pager', '--no-optional-locks',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.askPass=', '-c', 'credential.helper=',
  '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
  '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never',
  '-c', 'log.showSignature=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
] as const;

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    // Also removes GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_EXEC_PATH, GIT_DIR,
    // GIT_WORK_TREE, alternate object stores, injected -c options and tracing.
    if (!/^GIT_/i.test(key) && !/^(GCM_INTERACTIVE|LC_ALL|LANG)$/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    // Git for Windows understands /dev/null, but rejects Node's \\.\\nul device path.
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_ALLOW_PROTOCOL: '',
    GCM_INTERACTIVE: 'Never', LC_ALL: 'C', LANG: 'C',
  };
}

interface ParsedStatus {
  branch: string | null; head: string | null; changes: GitChange[];
  changedCount: number; untrackedCount: number; stagedCount: number; conflictCount: number;
}
function statusPath(record: string, fieldsBeforePath: number): { status: string; file: string } {
  const fields: string[] = [];
  let remaining = record;
  for (let i = 0; i < fieldsBeforePath; i++) {
    const separator = remaining.indexOf(' ');
    if (separator < 0) throw appError(400, 'git.status');
    fields.push(remaining.slice(0, separator));
    remaining = remaining.slice(separator + 1);
  }
  if (!remaining || !/^[.MTADRCU]{2}$/.test(fields[1] ?? '')) throw appError(400, 'git.status');
  return { status: fields[1].replaceAll('.', ' '), file: remaining };
}

/** Porcelain v2 -z paths are literal UTF-8, not C-quoted strings. Renames occupy two records. */
export function parseGitStatus(output: string, includeOriginalPath = false): ParsedStatus {
  const records = output.split('\0');
  const changes: GitChange[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  let sawBranch = false;
  let sawHead = false;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length);
      if (value !== '(initial)' && !HASH.test(value)) throw appError(400, 'git.head');
      head = value === '(initial)' ? null : value;
      sawHead = true;
    } else if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length);
      branch = value === '(detached)' ? null : value;
      sawBranch = true;
    } else if (record.startsWith('# ')) {
      continue;
    } else if (record.startsWith('? ')) {
      if (record.length === 2) throw appError(400, 'git.emptyPath');
      changes.push({ path: record.slice(2), index: '?', worktree: '?' });
    } else if (record.startsWith('! ')) {
      continue;
    } else if (/^[12u] /.test(record)) {
      const { status, file } = statusPath(record, record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10);
      changes.push({ path: file, index: status[0], worktree: status[1] });
      if (record[0] === '2') {
        if (!records[++i]) throw appError(400, 'git.rename');
        if (includeOriginalPath) changes[changes.length - 1].originalPath = records[i];
      }
    } else {
      throw appError(400, 'git.record');
    }
  }
  if (!sawHead || !sawBranch) throw appError(400, 'git.branch');
  const conflictCount = changes.filter((change) => CONFLICTS.has(change.index + change.worktree)).length;
  return {
    branch, head, changes, changedCount: changes.length,
    untrackedCount: changes.filter((change) => change.index === '?').length,
    stagedCount: changes.filter((change) => ![' ', '?'].includes(change.index) && !CONFLICTS.has(change.index + change.worktree)).length,
    conflictCount,
  };
}

/** Four NUL-terminated fields per commit; only Git's inter-record newline is removed. */
export function parseGitLog(output: string): GitCommit[] {
  if (!output) return [];
  const fields = output.split('\0');
  const commits: GitCommit[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const hash = fields[i].replace(/^\r?\n/, '');
    if (!hash && i === fields.length - 1) break;
    const [shortHash, subject, date] = fields.slice(i + 1, i + 4);
    if (!HASH.test(hash) || !shortHash || subject === undefined || !date || Number.isNaN(Date.parse(date))) {
      throw appError(400, 'git.commit');
    }
    commits.push({ hash, shortHash, subject, date });
  }
  return commits;
}

function emptySnapshot(): GitSnapshot {
  return {
    isRepo: false, branch: null, head: null, branches: [], commits: [], changes: [],
    changedCount: 0, untrackedCount: 0, stagedCount: 0, conflictCount: 0,
    lastCommitAt: null, observedAt: new Date().toISOString(),
  };
}

export async function readGitSnapshot(input: string): Promise<GitSnapshot> {
  const directory = await canonicalDirectory(input);
  // rev-parse alone would silently treat every descendant as the ancestor's repository.
  try {
    const marker = await lstat(path.join(directory, '.git'));
    if (marker.isSymbolicLink()) throw appError(400, 'git.link');
    if (!marker.isFile() && !marker.isDirectory()) throw appError(400, 'git.metadata');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptySnapshot();
    throw error;
  }
  const executable = await findTrustedExecutable(process.platform === 'win32' ? ['git.exe'] : ['git'], { excludeDirectory: directory });
  if (!executable) throw appError(400, 'git.unavailable');
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  const filterOverrides: string[] = [];
  const git = async (args: string[], allowNoMatch = false): Promise<string> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw appError(400, 'git.timeout');
    const result = await runCommand(executable, [...GIT_READ_ONLY_ARGS, ...filterOverrides, ...args], {
      cwd: directory, env: gitEnvironment(), timeoutMs: remaining, maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.code !== 0 && !(allowNoMatch && result.code === 1 && !result.stderr)) {
      const detail = result.stderr.trim().slice(0, 500) || `exit code ${result.code}`;
      throw appError(400, 'git.read', { detail });
    }
    return result.stdout;
  };
  const topLevelOutput = await git(['rev-parse', '--show-toplevel']);
  // Remove exactly the protocol newline, not whitespace that belongs to a path.
  const topLevel = await canonicalDirectory(topLevelOutput.replace(/\r?\n$/, ''));
  if (!isWithinDirectory(topLevel, directory) || !isWithinDirectory(directory, topLevel)) return emptySnapshot();
  // Even status can execute a clean/process filter when comparing a tracked file.
  // Discover names only (including config includes), then neutralize every driver.
  // The names remain individual argv values; unusual/oversized names fail closed.
  const filterKeys = await git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], true);
  const drivers = new Set<string>();
  for (const key of filterKeys.split('\0').filter(Boolean)) {
    const name = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key)?.[1];
    if (!name || name.length > 128 || /[=\r\n\0]/.test(name)) throw appError(400, 'git.filter');
    drivers.add(name);
  }
  if (drivers.size > 32) throw appError(400, 'git.filters');
  for (const name of drivers) {
    for (const key of ['clean', 'smudge', 'process']) filterOverrides.push('-c', `filter.${name}.${key}=`);
    filterOverrides.push('-c', `filter.${name}.required=false`);
  }
  const status = parseGitStatus(await git([
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-ahead-behind',
  ]));
  const [branchesOutput, logOutput] = await Promise.all([
    git(['for-each-ref', '--sort=refname', '--format=%(refname:lstrip=2)', 'refs/heads/']),
    status.head ? git([
      'log', '--max-count=12', '--no-show-signature', '--no-decorate', '--no-color',
      '--format=%H%x00%h%x00%s%x00%cI%x00', status.head, '--',
    ]) : Promise.resolve(''),
  ]);
  const commits = parseGitLog(logOutput);
  return {
    isRepo: true, ...status,
    branches: branchesOutput.split(/\r?\n/).filter(Boolean), commits,
    lastCommitAt: commits[0]?.date ?? null, observedAt: new Date().toISOString(),
  };
}
