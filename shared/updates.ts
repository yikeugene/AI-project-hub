export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
export type UpdateUnavailableReason = 'unconfigured' | 'development' | 'portable' | 'unpacked' | 'custom-data-dir' | 'unsupported-platform';
export interface UpdateState {
  revision: number;
  status: UpdateStatus;
  currentVersion: string;
  releaseUrl: string | null;
  reason?: UpdateUnavailableReason;
  latestVersion?: string;
  progress?: number;
  error?: string;
}
export interface ReleaseSource { owner: string; repo: string }

export function releaseUrl(source: ReleaseSource | null): string | null {
  if (!source || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(source.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(source.repo) || source.repo === '.' || source.repo === '..') return null;
  return `https://github.com/${source.owner}/${source.repo}/releases/latest`;
}

export function isNewerStable(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[A-Za-z0-9.-]+)?$/.exec(value);
    if (!match) return null;
    const parts = match.slice(1, 4).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const next = parse(candidate), old = parse(current);
  if (!next || !old) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== old[i]) return next[i] > old[i];
  return false;
}
