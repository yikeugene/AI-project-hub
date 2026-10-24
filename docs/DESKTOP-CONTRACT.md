# v0.2 implementation contract

Parent owns shared/types.ts/shared/desktop.ts, server/runtime.ts/server/index.ts, desktop/**, packaging/scripts/package, runtime/security tests and docs. Backend agent owns server/app.ts/server/handoff.ts/server/desktop-apps.ts, API/handoff tests and new desktop-apps tests. UI agent owns src/** (including api/hooks), no shared/server/package edits. Coordinate type changes through parent.

## Shared types now available

`HandoffTarget`: generic | claude | codex | claude-desktop | chatgpt-desktop, `HANDOFF_TARGETS` const.
`DesktopApp`: claude | chatgpt, `DesktopCapabilities`: Record<DesktopApp,boolean>.
Existing LaunchAction/Capabilities stay unchanged (old CLI), no breakage to existing launcher tests.
Workspace.environment adds required `mode:'web'|'desktop'`, `desktopApps:DesktopCapabilities`, version becomes APP_VERSION='0.2.0'. No persisted settings changes necessary.

## Native bridge (parent implements)

window.hubDesktop from shared/desktop.ts (available only native Electron):
- chooseDirectory(): Promise<string|null> (cancel returns null)
- saveText({filename,text}): Promise<boolean> (true saved, false canceled; failures reject)
- writeClipboard(text:string): Promise<void>
Max text <=1MiB UTF-8; save filename basename .md/.json/.txt only; OS save dialog confirmation. UI must catch rejections, never read clipboard automatically. Use navigator.clipboard / browser download as web fallback.

## Backend additions (backend agent implements)

AppOptions extends `mode?:'web'|'desktop'`, `desktopCapabilities?:()=>Promise<DesktopCapabilities>`, `openDesktopApp?:(app:DesktopApp)=>Promise<void>`; existing signatures remain.
GET /api/workspace: includes environment fields above.
POST /api/desktop-apps/:app/open with JSON `{}` -> `{ok:true}`. Validate app exact enum; launch request only (do not promise app visible or context transferred). No cwd or project assumptions for desktop app.
Handoff endpoints accept central HANDOFF_TARGETS (default generic for backwards compatibility); UI defaults claude-desktop.
POST /api/projects/:id/shared-state/paste/preview `{text:string}` -> SharedStatePreview. source is descriptive text '貼上的 JSON'; hash computed over exact text bytes (incl fences). Bound to 1MiB text + existing strict schema and projectId.
POST /api/projects/:id/shared-state/paste/import `{text,hash,revision,confirm:true}` -> Project. Parse/revalidate/hash again then store.saveMemory; imports only memory+nextAction. Reject wrong id, unknown keys, oversized, malformed, preview mismatch. All existing API csrf protections retained.
Accept raw JSON or one complete outer ```json ... ``` block (case-insensitive json optional), not arbitrary prose/multiple blocks. UI captures text+revision when preview requested, invalidates paste preview on any edit; submit the exact captured text/hash/revision. Preserve file-based preview/import APIs.
Desktop handoff explicitly says no filesystem/conversation access implied, ask for attachments if needed, embed valid full state JSON template and ask AI to return updated memory/nextAction preserving identity. No claims of actions not actually done.

## Windows app discovery (backend agent)
Get-StartApps exact Name 'Claude'/'ChatGPT'; use returned AppID, NOT hardcode. Local read-only probe yielded displayName ChatGPT with AppID OpenAI.Codex_2p2nqsd0c76g0!App and Claude with Claude_pzs8sxrjxfjjc!Claude. These are evidence, NOT constants to hardcode. Fixed PowerShell command only, shell:false, UTF8, timeout/buffer bounded; discovery cached briefly. Reject ambiguous exact matches rather than guessing. Launch trusted explorer.exe with ONE argument shell:AppsFolder\\<validated discovered AppID>, no user-controlled command. Only native Windows in v0.2; other platforms false and clear error. Tests inject process calls, NEVER open external apps or inspect private chats.

## UI changes (UI agent)
- Primary desktop targets Claude Desktop / ChatGPT Desktop. CLI buttons & handoff targets under clearly advanced optgroup/details. Existing folder/VSCode remain useful.
- Copy + open selected installed desktop app after explicit click, preserve copy success if launch fails, remind user paste/send manually. Not a protocol integration.
- Paste returned JSON area -> before/after diff -> explicit confirm import. Existing file sharing under advanced section, preserve guards.
- Native chooseDirectory button next to path input in ScanDialog and ProjectForm when bridge exists.
- Native clipboard & save helpers handle errors and canceled saves. No generic native IPC.
- Settings distinguish native desktop mode, registered chat apps, legacy CLI tools. Pass environment.desktopApps where needed.
- Existing drafts and unsaved guards must remain. Native window close will honor beforeunload via parent confirmation.

## Parent runtime/shell
createHubRuntime options: dataDir?, assetDirectory, port? (0 native), mode?, desktopSecret?; returns origin,store,refreshAll,stop. Extra session-secret guard applies before ALL Express/static requests, in addition to existing protections. Web entry retains dev middleware optionally; Electron uses production bundled frontend. Electron main owns random secret, injects only exact own origin from own webContents via isolated session request hook. No secret in renderer/URL. NodeIntegration false/contextIsolation true/sandbox true, permission/navigation denial, native IPC top-frame validation. Same %LOCALAPPDATA%/AIProjectHub/hub.sqlite; the original v0.2 host change required no data migration.

## v0.8 independent current-app observation

- The original HelpTool foreground/background status still means its own visible/minimized window mode, not OS focus or another program's identity.
- A separate per-group, default-off consent uses profile-bound state/preview/save routes under `/api/app-observation`. Drafts/previews/reads never start native collection; preview digest binds consent revision and network/device identity.
- Native main injects the fixed `process.resourcesPath/app-observation/foreground-app.exe` adapter once per runtime. Lock/unlock and suspend/resume gates are separate from Hub window visibility; hiding to tray does not revoke saved current-app consent.
- The helper queries only the active window's single process basename and a UTC time. No title, document, URL, PID/path payload, input hooks, screen capture or process list. There is no arbitrary helper path/command IPC or renderer-native collection entrypoint.
- SQLite schema v6 adds only consent/revision/ordering/withdrawal metadata. Names and observation payloads live only in bounded local memory; they never enter SQLite, outbox, audit or the existing recent activity list. Cloud storage is one latest observation per device, not a usage history.
- Existing governance v2 DTOs/RPCs and sharing policies are unchanged. The independent optional app channel requires the additional SQL migration; missing support is isolated from existing project sharing and Git approval.
- Use the setup/privacy guide in `APP-OBSERVATION.md`. Native tests must use owned windows/controlled names and state exactly whether their evidence is a guarded native routine, packaged process-boundary substitution, or a live deployment.
