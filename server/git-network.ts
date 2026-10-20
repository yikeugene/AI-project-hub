import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitRemote } from '../shared/git.ts';
import { GitOperationError } from './git-errors.ts';
import { configKey, OID, text, value, type GitView, type Repository } from './git-repository.ts';
import { runGitProcess } from './git-process.ts';

export interface RemoteTarget { name: string; branch: string; url: string; ref: string; trackingRef: string }
export function httpsEndpoint(input: string): string {
  if (input.length > 2048 || /[\s\x00-\x1f\x7f]/.test(input)) throw new GitOperationError('unsafe');
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new GitOperationError('unsupported'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) throw new GitOperationError('unsupported', 'Only HTTPS remotes without embedded credentials are supported.');
  return parsed.href;
}
function safeDisplayUrl(input: string): string {
  try { const url = new URL(input); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048); }
  catch { return 'Unsupported remote'; }
}
export function remotes(repo: Repository): GitRemote[] {
  const result: GitRemote[] = [];
  for (const [key, values] of repo.config) {
    const match = /^remote\.(.+)\.url$/.exec(key);
    if (!match) continue;
    let supported = values.length === 1;
    try { httpsEndpoint(values[0]); } catch { supported = false; }
    result.push({ name: match[1], url: safeDisplayUrl(values[0]), supported });
  }
  return result;
}
export function remoteFor(repo: Repository, name: string, branch: string, push: boolean): RemoteTarget {
  const urls = repo.config.get(configKey(`remote.${name}.${push && value(repo.config, `remote.${name}.pushurl`) ? 'pushurl' : 'url'}`));
  if (!urls || urls.length !== 1) throw new GitOperationError('unsupported', 'Exactly one remote endpoint is required.');
  for (const [key, helpers] of repo.config) {
    if (/^credential(?:\..+)?\.helper$/.test(key) && helpers.some(helper => helper && !['manager', 'manager-core'].includes(helper))) throw new GitOperationError('unsupported', 'Custom credential helpers are not supported.');
  }
  return { name, branch, url: httpsEndpoint(urls[0]), ref: `refs/heads/${branch}`, trackingRef: `refs/remotes/${name}/${branch}` };
}
function options(repo: Repository, view: GitView): { args: string[]; env: NodeJS.ProcessEnv } {
  const credential = repo.tools.credential;
  if (credential && /["\r\n\0]/.test(credential)) throw new GitOperationError('unsafe');
  const quotedCredential = credential?.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const credentials = credential ? ['-c', `credential.helper=!exec '${quotedCredential}'`] : [];
  return {
    args: [...view.args, '-c', 'protocol.https.allow=always', '-c', 'http.sslVerify=true', '-c', 'http.followRedirects=false', '-c', 'http.proxy=', '-c', 'http.extraHeader=',
      '-c', 'credential.helper=', ...credentials, '-c', 'credential.interactive=never', '-c', 'credential.modalPrompt=false', '-c', 'credential.useHttpPath=true',
      '-c', 'fetch.writeCommitGraph=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'push.followTags=false',
      ...(process.platform === 'win32' ? ['-c', 'http.sslBackend=schannel'] : [])],
    env: { ...view.env, GIT_ALLOW_PROTOCOL: 'https', GCM_HTTP_TIMEOUT: '30' },
  };
}
export async function advertised(repo: Repository, view: GitView, target: RemoteTarget): Promise<string | null> {
  const safe = options(repo, view);
  const result = await runGitProcess(repo.tools, [...safe.args, 'ls-remote', '--exit-code', '--refs', '--', target.url, target.ref], {
    cwd: view.root, env: safe.env, timeoutMs: 45_000, maxOutputBytes: 64 * 1024,
  });
  if (result.code === 2 && result.stdout.length === 0) return null;
  if (result.code) throw new GitOperationError('failed', 'The remote could not be verified.');
  const records = text(result.stdout).split(/\r?\n/).filter(Boolean);
  if (records.length !== 1) throw new GitOperationError('unsafe');
  const [oid, ref] = records[0].split('\t');
  if (!OID.test(oid) || ref !== target.ref) throw new GitOperationError('unsafe');
  return oid;
}
export async function fetchObjects(repo: Repository, view: GitView, target: RemoteTarget, oid: string): Promise<void> {
  const safe = options(repo, view);
  const result = await runGitProcess(repo.tools, [...safe.args, 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=', '--', target.url, oid], {
    cwd: view.root, env: safe.env, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
  });
  if (result.code) throw new GitOperationError('failed', 'Fetching the approved object was refused.');
}
export async function verifyPushGuard(repo: Repository, view: GitView, target: RemoteTarget, source: string, old: string | null): Promise<void> {
  if (!repo.tools.hooks) throw new GitOperationError('unavailable');
  const manifest = path.join(view.root, 'guard-probe.json'), receipt = path.join(view.root, 'guard-probe.receipt'), input = path.join(view.root, 'guard-probe.input');
  const nonce = randomBytes(32).toString('hex'), expectedOld = old ?? '0'.repeat(source.length);
  await writeFile(manifest, JSON.stringify({ url: target.url, source, targetRef: target.ref, old: expectedOld, receipt, nonce }), { flag: 'wx', mode: 0o600 });
  await writeFile(input, `${source} ${source} ${target.ref} ${expectedOld}\n`, { flag: 'wx', mode: 0o600 });
  const result = await runGitProcess(repo.tools, [...view.args, '-c', `core.hooksPath=${repo.tools.hooks}`, 'hook', 'run', 'pre-push', `--to-stdin=${input}`, '--', target.url, target.url], {
    cwd: view.root, env: { ...view.env, HUB_GIT_PUSH_GUARD: manifest }, maxOutputBytes: 64 * 1024,
  });
  if (result.code || await readFile(receipt, 'utf8').catch(() => '') !== nonce) throw new GitOperationError('unsupported', 'Git cannot run the packaged negotiated-ref push guard.');
}
export async function pushApproved(repo: Repository, view: GitView, target: RemoteTarget, source: string, old: string | null): Promise<void> {
  if (!repo.tools.hooks) throw new GitOperationError('unavailable');
  const manifest = path.join(view.root, 'push-guard.json'), receipt = path.join(view.root, 'push-guard.receipt');
  const nonce = randomBytes(32).toString('hex');
  await writeFile(manifest, JSON.stringify({ url: target.url, source, targetRef: target.ref, old: old ?? '0'.repeat(source.length), receipt, nonce }), { flag: 'wx', mode: 0o600 });
  const safe = options(repo, view);
  let result;
  try {
    result = await runGitProcess(repo.tools, [...safe.args, '-c', `core.hooksPath=${repo.tools.hooks}`, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--', target.url, `${source}:${target.ref}`], {
      cwd: view.root, env: { ...safe.env, HUB_GIT_PUSH_GUARD: manifest }, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof GitOperationError && error.code === 'unknown') throw error;
    throw new GitOperationError('unknown', 'The push result must be reconciled before another write.');
  }
  const ran = await readFile(receipt, 'utf8').catch(() => '');
  if (result.code || ran !== nonce) {
    if (!ran && result.code) throw new GitOperationError('stale', 'The negotiated remote did not match the approval, or the push was refused before sending.');
    throw new GitOperationError('unknown', 'The push result must be reconciled before another write.');
  }
}
