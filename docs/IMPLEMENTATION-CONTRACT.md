# Internal implementation contract

Shared DTOs live in `shared/types.ts`. All API requests use same-origin `/api`, all successful JSON; errors `{error: string}` with HTTP code. GET `/api/workspace` returns Workspace including csrfToken; all other methods use `Content-Type: application/json` and `X-Hub-Token: <csrfToken>`. Mutation responses can be ignored then reload workspace except specified below. Never use `dangerouslySetInnerHTML` for repository content.

## API (server owner will implement)
- GET `/api/workspace`
- POST `/api/projects`: `{path, name?, description?, category?, status?, priority?, stage?, nextAction?}` -> Project
- PATCH `/api/projects/:id`: `{revision, name?, description?, category?, status?, priority?, stage?, nextAction?}` -> Project. Path immutable; remove/re-add to change.
- DELETE `/api/projects/:id`: `{revision, confirm: true}` -> `{ok:true}`. Removes only Hub record/tasks.
- POST `/api/scan`: `{path, depth?:number}` -> ScanResult. Saves scan root in settings. Preview only.
- POST `/api/scan/import`: `{paths:string[]}` -> `{added:number, skipped:number, errors:string[]}`. At most 100 selected paths.
- POST `/api/refresh`: `{}` -> `{refreshed:number}`. All tracked nonarchived projects.
- POST `/api/projects/:id/refresh`: `{}` -> Project.
- PUT `/api/projects/:id/memory`: `{revision, memory:ProjectMemory}` -> Project. Memory all fields, revision detects conflict.
- POST `/api/projects/:id/tasks`: `{title, detail?, status?, priority?}` -> Task
- PATCH `/api/tasks/:id`: `{revision, title?, detail?, status?, priority?}` -> Task
- DELETE `/api/tasks/:id`: `{revision}` -> `{ok:true}` (UI confirm).
- GET `/api/projects/:id/handoff?agent=claude|codex|generic` -> HandoffPreview.
- POST `/api/projects/:id/handoff/export`: `{confirm:true, agent:'claude'|'codex'|'generic'}` -> `{directory:string, files:string[], stateCreated:boolean}`. Writes unique Markdown snapshot inside project `.ai-project-hub`; creates `state.json` ONLY if absent. Existing `state.json` NEVER overwritten. UI warns about possible Git tracking and asks confirmation. Exported state editable by either agent then reviewed import.
- GET `/api/projects/:id/shared-state`: -> SharedStatePreview (reads ONLY `.ai-project-hub/state.json`, no arbitrary file access). Errors for missing/invalid/symlink. UI preview before apply.
- POST `/api/projects/:id/shared-state/import`: `{revision, hash, confirm:true}` -> Project. Rechecks exact bytes, schema, projectId. Imports memory+nextAction ONLY, cannot import paths, commands, lifecycle or tasks.
- POST `/api/projects/:id/open`: `{action:'folder'|'vscode'|'claude'|'codex'}` -> `{ok:true}`. Requires explicit click; UI confirmation for agent launch; disabled if capability unavailable.
- PATCH `/api/settings`: `{staleDays?:number, refreshSeconds?:number, scanRoots?:string[]}` -> Settings. Refresh defaults60, zero to disable, otherwise30..3600. staleDays1..365.

## Server IO modules (IO agent owns)
- `server/discovery.ts`: `canonicalDirectory(input:string):Promise<string>` (absolute existing real dir, reject UNC/device paths); `scanProjects(root:string, options?:{depth?:number;maxDirectories?:number;timeoutMs?:number}):Promise<ScanResult>`.
- `server/git.ts`: `readGitSnapshot(path:string):Promise<GitSnapshot>`; plain dirs -> `isRepo:false`, descendants not repo roots; throw meaningful errors on real failures. exported parsing helpers welcome.
- `server/launcher.ts`: `getCapabilities():Promise<Capabilities>`; `openProject(path:string,action:LaunchAction):Promise<void>`; no input shell interpolation, no shell:true; mock injectable execution helpers for tests welcome. Command discovery from trusted PATH only, not project cwd.
- IO agent adds own tests `tests/discovery.test.ts`, `tests/git.test.ts`, `tests/launcher.test.ts`. No edits to shared DTOs without notifying main.

## Frontend
Traditional Chinese UX, product English name. All actual project/task/memory data from API, empty onboarding (no fake data). Main can implement shared `shared/insights.ts` with `getFocusItems(projects,tasks,staleDays?,now?): FocusItem[]`, `activityAt(project):string|null`, `isStale(project,days,now?):boolean`, `getResumeSummary(project,tasks):{checkpoint:string;facts:string[];nextAction:string}`. Prefer importing these to duplicate calculations.
Views dashboard, all projects, cross-project tasks, handoff center, settings; full project detail or drawer with memory/tasks/Git/handoff. Scan modal selectable previews. Forms clear errors, loading, revisions. Empty production workspace primary experience.

## Desktop device contract (v0.3)

Device DTOs and strict wire schemas live separately in `shared/devices.ts`; the original local Project/Workspace contracts remain local-only. All routes below retain the existing same-origin desktop/token guards. There is no peer-to-local API forwarding.

- `GET /api/devices` → sanitized `DeviceState` (never device credentials).
- `PATCH /api/devices/local` `{name}` → own device name only.
- `POST /api/devices/pair` `{url,publishableKey,name,code,confirm:true}`; `POST /api/devices/pair/retry` `{}` → pairing/recovery. Cryptographic credentials are generated and encrypted by the backend, not supplied by the renderer.
- `POST /api/devices/connection` `{enabled}`; `/devices/disconnect` `{confirm:true}`; `/devices/invitation` `{}`; `/devices/:id/revoke` `{confirm:true}`; `/devices/sync` `{}`.
- `GET /api/devices/sharing/:projectId` → current `SharedPreview` including policy even if a later local edit is too large (`project:null`, safe `error`); withdrawal controls remain available. `POST .../preview` `{enabled,memoryFields}` is pure and does not save/upload. `PUT /api/devices/sharing/:projectId` saves that explicitly reviewed policy.
- `GET /api/devices/:deviceId/projects` → independent `CachedSnapshot[]`; no editable local Project objects, paths or launch actions.
- `GET /api/messages?box=inbox|sent` → latest 200 local records for the current connection namespace. `POST /api/messages` `{toDeviceId,payload}` → durable outbox entry; payload is a text message or a nextAction/selected-memory proposal with baseRevision.
- `POST /api/messages/:id/preview` `{}` → captured hash/current revision/before-after. `POST .../accept` `{hash,revision,confirm:true}` freshly checks relay source authorization, then applies allowed fields and records the decision/outbox atomically. Stale revisions never auto-merge.
- `POST /api/messages/:id/reject` `{confirm:true}` and `POST .../read` `{}` only record local decisions, which can queue while offline.

`deviceApi` remains a same-origin frontend adapter. Local Git refresh, local service reachability, relay connection, peer heartbeat and snapshot age are separate states. Remote pages must never render through actionable ProjectDetail. Device navigation/composer/settings must preserve existing unsaved/busy guards. Paused sync and local detach do not imply remote deletion or revocation.

The relay protocol, grants, bootstrap and verified-versus-live limitations are documented in `MULTI-DEVICE.md`. Test fixtures must be explicit isolated `.local`/temporary databases, never the default user data directory.
