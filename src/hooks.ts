import { useCallback, useEffect, useRef, useState } from 'react';
import { api, deviceApi, errorMessage, governanceApi } from './api';
import type { GovernanceState } from '../shared/governance';
import type { DeviceState } from '../shared/devices';
import type { Workspace } from '../shared/types';
import type { DesktopBridge } from '../shared/desktop';
import { DEFAULT_LOCALE, LocalizedError, translate, type Locale } from '../shared/i18n';
import { useLocale } from './i18n';
import { clientMessages } from './locales/client';

export function useWorkspace() {
  const locale = useLocale();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [localeBusy, setLocaleBusy] = useState(false);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const alive = useRef(true);
  const ready = useRef(false);
  const reload = useCallback(async () => {
    if (mutation.current) return;
    const current = ++sequence.current;
    try {
      const next = await api.workspace();
      if (alive.current && sequence.current === current) {
        ready.current = true; setWorkspace(next); setError(null); setLastLoaded(new Date());
      }
    } catch (err) { if (alive.current && sequence.current === current) setError(err); }
    finally { if (alive.current && sequence.current === current) setLoading(false); }
  }, []);
  const updateLocale = useCallback(async (nextLocale: Locale) => {
    if (!ready.current) throw new LocalizedError(clientMessages, 'unavailableWorkspace');
    if (mutation.current) throw new LocalizedError(clientMessages, 'languageBusy');
    mutation.current = true; sequence.current++; setLocaleBusy(true);
    try {
      const settings = await api.settings({ locale: nextLocale });
      if (alive.current) setWorkspace(previous => previous ? { ...previous, settings } : previous);
    } catch (error) {
      // A lost response may follow a successful write. Read back the authoritative setting.
      mutation.current = false;
      await reload();
      throw error;
    } finally {
      mutation.current = false;
      if (alive.current) setLocaleBusy(false);
    }
  }, [reload]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 30_000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); sequence.current++; };
  }, [reload]);
  return { workspace, loading, error: errorMessage(error, locale), reload, lastLoaded, updateLocale, localeBusy };
}

/** Device cache polling is independent of Workspace/Git and never initiates cloud traffic. */
export function useDevices() {
  const locale = useLocale();
  const [state, setState] = useState<DeviceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (mutation.current) return;
    const current = ++sequence.current;
    try {
      const next = await deviceApi.state();
      if (alive.current && current === sequence.current) { setState(next); setError(null); }
    } catch (err) { if (alive.current && current === sequence.current) setError(err); }
    finally { if (alive.current && current === sequence.current) setLoading(false); }
  }, []);
  const update = useCallback(async (operation: () => Promise<DeviceState>) => {
    if (mutation.current) throw new LocalizedError(clientMessages, 'deviceBusy');
    mutation.current = true;
    sequence.current++;
    try {
      const next = await operation();
      // A mutation may target a non-selected group. Only the installation-level read
      // determines which group's management state belongs in the shell.
      const selected = await deviceApi.state();
      if (alive.current) { setState(selected); setError(null); setLoading(false); }
      return next;
    } catch (err) {
      // A lost pairing response may have persisted pairingPending. Recover the local state.
      mutation.current = false;
      await reload();
      throw err;
    } finally { mutation.current = false; }
  }, [reload]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 15_000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; sequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [reload]);
  return { state, loading, error: errorMessage(error, locale), reload, update };
}
export type DeviceController = ReturnType<typeof useDevices>;

/** Reads cached policy/status only. Cloud refresh and mutations are explicit user actions. */
export function useGovernance(profileId: string | null) {
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<{ scope: string | null; state: GovernanceState } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0);
  const scope = useRef(profileId); scope.current = profileId;
  const mutation = useRef(false);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (mutation.current || !alive.current || scope.current !== profileId) return;
    const current = ++sequence.current;
    const expectedScope = profileId;
    if (!expectedScope) { setSnapshot(null); setError(null); setLoading(false); return; }
    try {
      const state = await governanceApi.state(expectedScope);
      if (alive.current && sequence.current === current && scope.current === expectedScope) {
        setSnapshot({ scope: expectedScope, state }); setError(null);
      }
    } catch (err) {
      if (alive.current && sequence.current === current && scope.current === expectedScope) { setSnapshot(null); setError(err); }
    } finally { if (alive.current && sequence.current === current && scope.current === expectedScope) setLoading(false); }
  }, [profileId]);
  const update = useCallback(async (operation: () => Promise<GovernanceState>) => {
    if (mutation.current || !alive.current || scope.current !== profileId || !profileId) throw new LocalizedError(clientMessages, 'deviceBusy');
    mutation.current = true; sequence.current++;
    const expectedScope = profileId;
    try {
      const state = await operation();
      if (alive.current && scope.current === expectedScope) { setSnapshot({ scope: expectedScope, state }); setError(null); setLoading(false); }
      return state;
    } catch (err) {
      mutation.current = false;
      if (scope.current === expectedScope) await reload();
      throw err;
    } finally { mutation.current = false; }
  }, [profileId, reload]);
  useEffect(() => {
    alive.current = true; setSnapshot(null); setError(null); setLoading(true);
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 15_000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; sequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [reload]);
  return { state: snapshot?.scope === profileId ? snapshot.state : null, loading, error: errorMessage(error, locale), reload, update };
}
export type GovernanceController = ReturnType<typeof useGovernance>;

/** A clock only updates labels/expiry checks; it never performs or approves an operation. */
export function useNow(interval = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, interval);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [interval]);
  return now;
}

/** Call with a stable, scoped loader; an old device/box response cannot replace a new one. */
export function useDeviceResource<T>(load: () => Promise<T>) {
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<{ load: typeof load; data: T | null; error: unknown; loading: boolean } | null>(null);
  const sequence = useRef(0);
  const scope = useRef(load); scope.current = load;
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!alive.current || scope.current !== load) return;
    const current = ++sequence.current;
    const valid = () => alive.current && scope.current === load && current === sequence.current;
    try {
      const data = await load();
      if (valid()) setSnapshot({ load, data, error: null, loading: false });
    } catch (error) {
      if (valid()) setSnapshot(previous => ({ load, data: previous?.load === load ? previous.data : null, error, loading: false }));
    }
  }, [load]);
  useEffect(() => {
    alive.current = true;
    setSnapshot({ load, data: null, error: null, loading: true });
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 15_000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; sequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [load, reload]);
  const current = snapshot?.load === load ? snapshot : null;
  return { data: current?.data ?? null, loading: current?.loading ?? true, error: errorMessage(current?.error, locale), reload };
}

export function useAction(scope?: unknown) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);
  const owner = useRef(scope); owner.current = scope;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setError(null); }, [scope]);
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (running.current || !alive.current) return { ok: false };
    const expected = owner.current;
    running.current = true;
    setBusy(true); setError(null);
    try { return { ok: true, value: await action() }; }
    catch (err) { if (alive.current && owner.current === expected) setError(err); return { ok: false }; }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }, []);
  return { busy, error: errorMessage(error, locale), setError, run };
}

export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
}

export function formatDate(value: string | null | undefined, includeTime = false, locale: Locale = DEFAULT_LOCALE) {
  if (!value) return translate(clientMessages, locale, 'noRecord');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return translate(clientMessages, locale, 'unknownDate');
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', ...(includeTime ? { hour: '2-digit', minute: '2-digit' } as const : {}), ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) }).format(date);
}
export function relativeDate(value: string | null | undefined, locale: Locale = DEFAULT_LOCALE) {
  if (!value) return translate(clientMessages, locale, 'noActivity');
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return translate(clientMessages, locale, 'unknownDate');
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  if (days < 30) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
  return formatDate(value, false, locale);
}
export function desktopBridge(): DesktopBridge | undefined { return typeof window === 'undefined' ? undefined : window.hubDesktop; }

export async function copyText(text: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) { await bridge.writeClipboard(text); return; }
  if (!navigator.clipboard?.writeText) throw new LocalizedError(clientMessages, 'clipboard');
  await navigator.clipboard.writeText(text);
}

/** false means the native save dialog was canceled, not that the draft was saved. */
export async function downloadText(text: string, filename: string, mime = 'text/markdown;charset=utf-8'): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge) return bridge.saveText({ filename, text });
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  try { document.body.append(anchor); anchor.click(); }
  finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return true;
}
