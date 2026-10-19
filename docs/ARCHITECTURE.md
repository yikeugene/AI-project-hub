# Architecture

## Desktop-first host, shared local backend

```text
Electron BrowserWindow (sandboxed React UI; no Node)
  ├── narrow preload → validated folder / save / clipboard operations
  └── dedicated session → exact-origin per-run desktop key
         ▼
    Express on 127.0.0.1:<ephemeral port> (inside the main process)
      ├── SQLite Store: preserved local records, additive schema v2
      ├── bounded discovery / read-only Git observations
      ├── desktop Context + reviewed pasted JSON checkpoints
      ├── registered Windows Claude / ChatGPT activation
      └── advanced CLI and repository-file handoff
```

The desktop runtime, main/server bundle and built frontend ship together. There is no system Node/npm/tsx dependency for end users. A hidden loopback listener is an internal transport—not a browser shortcut or a separately managed server. Every native asset/API request requires a random per-run key injected only for the owning webContents and exact origin; the key is not returned to renderer JavaScript or placed in a URL/cookie.

Web mode remains optional through `server/index.ts`; Vite is development-only. Both hosts reuse `createApp()` and the SQLite store. Only built frontend assets are served, not repositories or the database directory. React renders repository strings and Markdown as text, not executable HTML.

## Why this stack

Electron reuses the existing tested React/Express implementation with less risk than a rewrite. Electron 44.9.0 embeds Node 24.22.0 and provides `node:sqlite`; the packaged-runtime smoke test queries its actual SQLite rather than relying on development Node. No external SQLite addon/compiler, ORM, Python service, agent SDK, hosted database or account is required.

The main/preload code is bundled with esbuild. A minimal staging app and explicit file allowlist keep source/tests/user data/development dependencies out of the artifact. The builder's documented `beforeBuild: async () => false` hook marks dependencies handled externally, so it performs neither package lifecycle installation/rebuild nor parent node_modules collection. Dependency notices and Electron/Chromium licenses are included. Versions are pinned; the `global-agent` override removes the old build-time vulnerable logging chain.

## Native lifecycle and trust

`server/runtime.ts` owns the store, refresh timer, optional device worker, listener and graceful stop. Electron acquires a single-instance lock before opening SQLite and retains `%LOCALAPPDATA%/AIProjectHub/hub.sqlite`. Version 0.3 performs an additive, transactional schema-v2 migration; existing project/task/settings records are neither reseeded nor rewritten. A canceled renderer beforeunload leaves both the window and backend alive. After an approved close, new requests stop, device requests are aborted/drained, active HTTP work and Git observations drain, and SQLite closes.

The window explicitly enables sandbox/context isolation/web security, disables Node integration/webviews, and denies permissions, popups and unexpected navigation. Preload exposes only three validated methods. Main-process handlers check the owning webContents and exact main frame/document URL. Session traffic is restricted to the own origin, with no automatic remote fonts, scripts or model calls. These measures do not provide isolation from malware already running as the same Windows user.

## Module boundaries

| Module | Responsibility |
|---|---|
| `shared/types.ts` | DTOs, enum values, memory shape, labels |
| `shared/insights.ts` | Pure focus ranking and honest resume summary |
| `shared/devices.ts` | Separate safe device DTOs, strict relay schemas and opt-in projections |
| `server/device-store.ts` | Namespaced caches, encrypted credentials, durable outbox/inbox and sharing versions |
| `server/devices.ts` | Local device routes, pairing and reviewed owner-side proposal decisions |
| `server/sync.ts` | Bounded polling, retry/receipt delivery, cancellation and snapshot reconciliation |
| `server/supabase-relay.ts` | Narrow native-fetch RPC transport; no renderer or administrative key access |
| `desktop/credentials.ts` | Injected OS-backed encryption codec, without plaintext fallback |
| `supabase/` | User-applied protected SQL schema/RPCs and admin-only bootstrap |
| `server/validation.ts` | Bounded, strict Zod schemas and HTTP errors |
| `server/db.ts` | Prepared statements, schema migration, optimistic revisions |
| `server/app.ts` | HTTP endpoints, local request guard, bounded refresh coordination |
| `server/runtime.ts` | Shared storage selection, listener, session-key guard, static serving, polling and draining |
| `server/index.ts` | Optional web/dev entry, Vite and signal handling |
| `desktop/main.ts` | Native window, single instance, session security, validated IPC and quit behavior |
| `desktop/preload.ts` | Three-method isolated native bridge |
| `server/desktop-apps.ts` | Bounded registered-app discovery and allowlisted desktop launch |
| `server/discovery.ts` | Canonical local directory validation, bounded project discovery |
| `server/git.ts` | Git facts, no project progress inference |
| `server/launcher.ts` | Capability detection and platform launch adapters |
| `server/handoff.ts` | Copy/export context, exclusive snapshot writes, reviewed state imports |
| `src/` | Application shell, forms, detail views and API state |

## Data model and concurrency

`PRAGMA user_version` controls schema migrations. Future database versions are rejected rather than overwritten. Foreign keys, WAL and a busy timeout are enabled. Projects have unique canonical paths; tasks reference project IDs with cascade deletion inside Hub only.

Project memory is a small JSON object stored in SQLite. No parser attempts to turn commit messages into task completions. Task rows remain independently editable; memory can describe broader plans without silently duplicating task state.

Every user change increments a revision. Project/task writes check the expected revision in the SQL `WHERE` clause and reject conflicts; memory and metadata share a project revision. Git refresh writes only observation columns and does not increment that revision, overwrite notes, change lifecycle, or fabricate a new work timestamp.

The frontend keeps unsaved edits separate from periodically refreshed workspace snapshots. An explicit conflict requires reviewing the latest version rather than a last-write-wins overwrite.

## Discovery and observation

Only a user-selected root is scanned. Defaults: depth 4, up to 10,000 directories, 15-second traversal budget. Known project roots stop descent to avoid treating all internal source directories as projects. Nested applications can be added individually or scanned from a more specific root. Results include warnings/truncation; discovery is not a claim that every project on disk was found.

Git uses repository-root verification, bounded subprocess output and timeouts. An unborn repository, detached HEAD, worktree and ordinary non-Git folder are separate valid cases. Failures do not become a false clean working tree. The last successful snapshot remains with a current error indicator.

Git polling runs while the Hub service is open. There is no OS background service, filesystem watcher, global disk scan, commit history crawl, network fetch or chat-log ingestion. By default archived projects are excluded from bulk refresh; explicit per-project refresh remains available.

## Explainable recommendations

Only Active and Planning projects participate. A candidate is a todo/doing task that is not backlog, or an explicitly recorded next action. Blocked/done tasks are excluded. With no recorded action, the system asks for one rather than inventing work.

Score components:

- Project priority: high 40, normal 20, low 5, backlog 0.
- Active project: +10; Planning: +0.
- Actionable task priority: same weight as above.
- Doing task: +5.
- Stable tie break by project name, then ID.

Staleness and other blockers are displayed as warnings, **not** scores that reward abandoned work. Staleness is based on last commit age and explicitly does not prove inactivity. The UI exposes the components. No percentage claims to measure project completion.

## Shared-state protocol v1

Hub is the canonical store of reviewed state. An exported `.ai-project-hub/state.json` is a collaboration boundary, not a file the server blindly trusts. Its only writable content fields are the nine memory strings and nextAction. The schema also binds it to a project UUID and export timestamp.

Exports create unique Markdown filenames with exclusive creation (`wx`). The first export creates state JSON; later exports preserve it unchanged. Existing instructions are never modified. Imports check regular-file status, link boundaries, byte size (1 MB), strict schema, project identity and the exact SHA-256 from the preview. Database revision checks catch edits made during the preview window.

Desktop chat apps use the same schema through pasted raw JSON or a single fenced JSON block, without local file access. Preview binds the exact original text hash and project revision; confirmation reparses and checks both before writing. Editing the paste invalidates its preview. Desktop prompts embed a complete return template and explicitly do not assume filesystem or prior-conversation access.

Shared state does not import project paths, executable commands, lifecycle, Git facts or tasks. Filesystem checks mitigate accidental links and path mistakes, but cannot defeat a malicious process racing filesystem changes under the same user account.

## Optional desktop device relay

Schema v2 adds isolated relay profiles, encrypted credential blobs, per-project sharing policies, versioned publications/tombstones, remote snapshots, inbox/sent messages and a durable outbox. The local installation identity is distinct from a cloud membership identity; explicit re-pairing creates a fresh membership and namespace with sharing off. Remote snapshots never enter `Project[]`, local discovery, Git refresh, local task joins or `ProjectDetail`.

The main process alone calls Supabase using bounded native `fetch`; the renderer still calls only the guarded same-origin API. Disabled or unconfigured integration makes no cloud calls. Device tokens are encrypted by injected Electron safeStorage and are excluded from ordinary Settings and Workspace. No administrative Supabase key is accepted. The private SQL schema denies direct client access; narrowly scoped RPCs verify revocable device tokens and derive sender/network identity server-side.

Sharing is explicit and network-wide. The projection excludes local paths, source files, task contents, Git details, environment and credentials. Optional memory fields require selection. This is TLS plus authorization, not end-to-end encryption; the provider can read intentionally shared text. Publication versions are independent from project revisions; withdrawal and deletion retain higher-version tombstones so stale retries cannot resurrect data. Each publication is re-read immediately before starting its request, including after an earlier request awaited. Oversized projections become per-project tombstones/warnings without blocking inbox/outbox or policy controls; a permanent publication rejection does not block unrelated messages.

Receivers persist inbox data before ACK. Delivery uses stable IDs and idempotent retry, not a high-water sequence cursor. A proposal is inert until a local preview and explicit confirmation. Acceptance freshly verifies the source online, then atomically commits the allowed local revision update, decision and result outbox on the same SQLite connection. Offline rejection/read receipts may queue, but offline acceptance is denied. Supabase expiry timestamps may be normalized from `Z` to `+00:00`; immutable expiry comparisons use time instants, not spelling.

See [multi-device setup](MULTI-DEVICE.md) for manual SQL/bootstrap, privileges, boundaries and the distinction between embedded SQL testing and unverified live Supabase deployment.

## HTTP security

- Exact allowed local Host includes the actual listening port.
- If supplied, Origin must exactly match that local origin; cross-site fetch metadata is rejected.
- No CORS headers are granted.
- Mutations require JSON and a per-process random token loaded through same-origin workspace API.
- Production CSP, `nosniff`, frame denial, same-origin resource policy, no-referrer and API no-store headers.
- All SQL values parameterized; strict schema rejects unknown fields.
- Local path validation and allowlisted launch actions; no generic filesystem or shell endpoint.

This is a single-user local tool, not a multi-user authentication system. Do not run it under a public bind address or expose it through a proxy.
