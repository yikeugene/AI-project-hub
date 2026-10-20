# AI Project Hub

**English** · [繁體中文](README.zh-TW.md)

**Download v0.3.0 for Windows x64:** [Installer](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-Setup-x64.exe) · [Portable — no installation](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-portable-x64.exe)

A local-first project workbench for **Windows x64**. Keep projects, tasks, checkpoints, Git observations, and individually approved Git actions in one place, then carry the context into Claude Desktop or ChatGPT Desktop—on your terms.

**Source-update scope:** the approved Git workflow, administrator roles, optional device status, and close-to-tray behavior described below are current source changes. Editing or building this source does not update the existing v0.3.0 download assets, publish a release, or deploy cloud SQL. Use a freshly built and verified app containing these changes, and explicitly upgrade your own relay before enabling them.

**The desktop app includes its runtime. End users do not need Node.js, a browser, or an open terminal.** Local features need no Hub account, API key, or cloud database. Hub does not read private chat histories, automatically send prompts, or execute AI replies.

## What you can do

- **Find your projects:** preview a folder scan and choose which projects to add, without moving files or running project code.
- **Pick up where you left off:** keep a next action, priorities, tasks, technical decisions, and project memory together.
- **See Git facts:** inspect branches, commits, working-tree snapshots, and file diffs without a background scan modifying your repository.
- **Request a Git action:** preview a supported operation, obtain a designated administrator's approval, then separately confirm execution on the originating computer. No remote auto-execution or blanket approval.
- **Hand off to an AI app:** review and copy context, optionally open the desktop app, and manually paste back a checkpoint for approval.
- **Choose your interface language:** English by default, with a top-bar switch to 繁體中文.
- **Optionally connect your own desktops:** share selected summaries and exchange messages through your own Supabase backend. This is off by default, not full-workspace sync.

## Get the Windows app

Download **v0.3.0** from the links below or visit [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest). The app includes its runtime; no Node.js installation or source-code setup is needed.

Run the installer to install for your Windows user, or download and double-click the portable executable. GitHub's **Source code (zip)** and **Source code (tar.gz)** archives are for developers.

| Download | Use |
| --- | --- |
| [Windows x64 installer (.exe)](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-Setup-x64.exe) | Install for your Windows user, with desktop and Start menu shortcuts. |
| [Windows x64 portable (.exe)](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-portable-x64.exe) | Run directly without an installer. |

[Release notes](https://github.com/yikeugene/AI-project-hub/releases/tag/v0.3.0) · [SHA-256 checksums](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/SHA256SUMS.txt)

Version 0.3.0 uses manual downloads for updates; its in-app updater is not configured. Portable means no installation; it does **not** mean your data is stored inside or beside the executable.

**Builds are currently unsigned.** Windows SmartScreen, Smart App Control, or organizational policy may warn or block them. Verify the publisher's release location and any available verification information. Do not disable Windows security protections to run the app; if policy blocks it, consult your administrator or wait for an approved distribution.

Git is needed for Git views and approved Git operations; projects, memory, tasks, and text handoffs still work without it. VS Code, Claude Desktop, ChatGPT Desktop, and advanced CLI tools are optional external apps. Hub does not install them for you.

## First run

1. **Choose a language.** Use **English / 繁體中文** in the top bar. The preference is saved in the local SQLite database and survives restarts. It changes interface text, not your project names, notes, tasks, or other user content.
2. **Add projects.** Select a local development folder, preview the scan results, and choose what to add.
3. **Set a next action.** Record a status and priority, or add a task.
4. **Save a checkpoint.** Use project memory for the current state, decisions, and known issues.
5. **Continue work.** The workbench combines recorded context with Git facts and explainable suggestions. Commit counts are not completion percentages.

Your normal workspace is not seeded with demo projects. **This source upgrades the local SQLite schema to version 3.** Back up before upgrading: older installed apps cannot open the upgraded database, and there is no automatic downgrade. To return to an older app, restore a compatible pre-upgrade backup into a separate data directory.

## AI handoffs: copy, paste, review

### Send context

1. Open a project's AI handoff view and choose Claude Desktop or ChatGPT Desktop.
2. Preview the context assembled from saved Hub data.
3. Copy it, or copy it and ask Windows to open the selected app.
4. **Paste and send it yourself.** Attach any needed files using the chat app's own features.

Opening an app does **not** select a conversation, transmit context, read your project folder, or grant file access. Hub uses registered Windows app identities; it does not depend on a desktop app's CLI or an undocumented conversation URL. If launching is unavailable, copying still works.

### Bring back a checkpoint

1. The context includes a complete JSON checkpoint template. Ask the AI to update it after the work.
2. Paste **plain JSON or one complete JSON code block** into Hub's checkpoint input.
3. Preview the import differences, compare each field, and explicitly confirm.
4. Only the **nine project-memory fields and `nextAction`** are updated. Import does not change source code, paths, lifecycle status, or tasks, and does not execute command text.

Pasting alone never saves the checkpoint. Editing the pasted text invalidates its preview; confirmation rechecks the project ID, schema, text fingerprint, and local revision. Remove surrounding AI commentary rather than importing a partial JSON fragment. A valid schema is not proof that an AI's claims are correct—review the content.

### Advanced CLI and file exchange

Claude Code / Codex CLI and repository-file handoffs remain under the advanced options. The first file export creates `.ai-project-hub/state.json`; later exports add timestamped Markdown snapshots and **do not overwrite an existing `state.json`**. That file does not automatically track later Hub edits. Preview it again before importing.

Hub does not create or modify `AGENTS.md` or `CLAUDE.md`. Exported files may be tracked by Git; add them to your project's ignore rules if you do not want to commit them. See [desktop integration details](docs/INTEGRATIONS.md).

## Git: review, approve, confirm locally

Read-only observations remain available without a cloud connection. **Git changes require a paired desktop, the v2 relay, an active administrator, and fresh online authorization.** A missing/older relay or unavailable approval service disables writes; it never falls back to unapproved execution. Web development mode is not a bypass.

1. Inspect the local diff and preview one supported operation. Review the exact relative filenames and operation metadata that will be sent to the designated reviewer.
2. Submit an immutable, expiring request. Only its designated active administrator can approve or reject it. Administrators may approve their own requests, but approval is still a separate recorded action.
3. On the **originating computer**, explicitly confirm execution. Hub rechecks repository state and consumes a one-use authorization online; receiving approval or background polling never launches Git.
4. Review the result. A changed repository requires a new preview/request. An interrupted or uncertain operation is not automatically retried; `unknown`/`partial` results fence further writes until explicit local inspection and acknowledgement.

The whitelist is selected-path stage/unstage, commit, create/switch branch, fetch, fast-forward-only pull, and normal push when the safety prerequisites are met. Fetch is separately reviewed before a pull of its pinned target. No force push, hard reset, clean/discard, history rewriting, automatic stash, or automatic conflict resolution is offered. Remote operations require supported **HTTPS and trusted Git Credential Manager**; SSH/custom helpers and repositories requiring unsupported hooks, filters/LFS, sparse checkout, or submodules are refused rather than weakened.

The reviewer receives an explicitly previewed summary—not source contents, a diff/patch, or your absolute local root. Filenames, branch/ref names, remote URL, commit message and author metadata can still be sensitive. See [Git safety and recovery](docs/GIT-SAFETY.md) and [administrator/relay setup](docs/MULTI-DEVICE.md).

## Updates

Updates are **user initiated**, not unattended upgrades. For **v0.3.0**, download updates from [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest) and fully quit the app before installing or replacing it (use tray **Quit** on close-to-tray builds). In-app update controls require a build with a configured GitHub update source.

| How you run Hub | Update path |
| --- | --- |
| Installed NSIS version, default data directory | In v0.3.0, download and run the newer installer manually. A build configured for GitHub updates can offer a manual check, download, and explicit restart-to-install. Save your work and back up first. |
| Portable executable | Open [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest), download the newer portable `.exe`, fully quit Hub, and replace the old executable. |
| Custom data directory (`HUB_DATA_DIR` or `--data-dir`) | Use the manual release-download/install path, then launch with the same data-directory setting. In-app restart-to-install is not offered for this mode. |
| Unconfigured source build | No GitHub release location is guessed. A maintainer must configure it before update checks or release links can work. |

An installed-app update needs the matching installer and update metadata in the published release. A source archive or portable executable alone is not an installed-app update. Keep a backup and avoid running different Hub versions against the same database.

## Local data and backups

The default Windows database is:

```text
%LOCALAPPDATA%\AIProjectHub\hub.sqlite
```

- SQLite stores projects, tasks, memory, settings (including language), Git snapshots, approval/execution journals, and optional device-status caches. Desktop window settings and the Chromium profile live in `desktop-profile` under the same data directory.
- Set `HUB_DATA_DIR` or pass `--data-dir` to use a separate data directory. Keep using that setting after a manual update; do not point different versions at the same live database.
- **Use the system-tray Quit action and stop any web-mode processes before backing up.** Merely closing a desktop window is not enough. Wait for controlled work and shutdown to finish, then copy the whole data directory; do not copy only a live `hub.sqlite` while SQLite may still use WAL files.
- With a working tray icon, **X hides the window and keeps the runtime/device polling alive**; use the tray to restore it or quit completely. Tray creation failure does not leave an inaccessible hidden app. Explicit quit/update flows preserve draft confirmation and drain controlled work. Git drafts join the existing unsaved-work protection.
- Git refresh defaults to 60 seconds and can be set to `0` in Settings to disable it. There is no login auto-start or Windows service. After explicit quit, sleep, or shutdown, Hub does not poll or perform new work; it does not prevent sleep. Offline devices cannot report live state.
- Removing a project deletes Hub records and related tasks, not the original folder, Git repository, or exported files.
- Ordinary database rows—including messages and remote caches—are **not encrypted**. Their protection depends on Windows permissions and disk encryption. Long-lived device credentials are separately protected with Windows user-scoped secure storage.

Copying context into a cloud chat app or enabling selected-field sharing is an intentional transfer of data. Review it for secrets first. A data-directory backup can contain private information; do not upload it in an issue report.

## Optional: connect your own desktops

The Supabase integration is **disabled by default**. It provides selected project summaries, messages, reviewable memory-change requests, administrator-governed Git approvals, and separately opted-in device status—not file sync, a shared SQLite database, a mobile app, or a remote shell. Every computer remains responsible for its own local projects.

1. Manually apply `supabase/migrations/202610190001_desktop_relay.sql`, then `supabase/migrations/202610200001_device_git_approval.sql`, to your own Supabase project. Nothing deploys automatically. A new private `hub_private.bootstrap(...)` invitation designates the first administrator. For an existing group, the database operator must explicitly call `hub_private.designate_initial_admin(network_uuid, device_uuid)`; upgrading alone never promotes an existing member.
2. In desktop settings, enter the Project URL, a **public publishable/anon key**, a device name, and the pairing code. Never enter a `service_role` or secret administrative key.
3. Invite another desktop using a one-time pairing code.
4. Select which projects and memory fields to share, preview them, and confirm. Nothing is shared by default. Selected summaries are visible to all currently paired devices and devices paired later.
5. Review incoming requests locally before accepting or rejecting them. Only confirmation on the owning computer can change the allowed memory fields or next action.

Normal invitations create **members**, including after re-pairing; members cannot promote themselves or revoke devices. Only active administrators manage roles/revocations or decide assigned Git requests, and the last active administrator is protected.

Optional activity, Git-summary, and manual-task-count sharing is **off by default**, even for already-shared projects. Preview and enable each category separately. Removing the base project share also clears its optional status-sharing choices; re-sharing does not silently opt them back in. Cached extensions are invalidated when an unshare is observed. Task `doing` counts are manually recorded work, not proof of a running process; no CPU, memory, or unrelated application activity is collected.

Messages are persisted and retried while the runtime is running and connected, including when hidden in the tray. **Delivered does not mean applied.** Applying a memory-change request requires fresh source authorization and a matching local revision; an old offline authorization is not sufficient. Explicit Quit stops sending and receiving; the backend can retain pending messages. Last-seen/last-successful-sync timestamps are not proof that a stale or offline computer is currently running.

**HTTPS/TLS is used, but this is not end-to-end encrypted.** The Supabase administrator can read shared content, approval summaries, and messages. Pausing sync does not revoke devices or erase cloud data, and revocation cannot retrieve copies already saved elsewhere. Supabase's free tier has quotas and inactivity limits.

See [multi-device setup and limitations](docs/MULTI-DEVICE.md) before enabling it. Local SQL/HTTP tests are not proof that your live Supabase deployment or two physical Windows computers have been verified. Local project planning, tasks, handoffs, and read-only Git remain available without cloud setup; approved Git changes require the upgraded relay.

## What the workbench knows

| Source | What it shows | Boundary |
| --- | --- | --- |
| Observed facts | Branch, commits, working tree, observation time | A recent commit is not necessarily the last time you worked. |
| Recorded state | Manually entered or reviewed/imported memory, tasks, and status | Git activity never automatically marks a project complete. |
| Rule-based suggestions | Explicit priorities and reasons for task ordering | These are not AI inferences or completion percentages. |

If a refresh fails, Hub retains the previous snapshot and shows an error. Git queries disable clean/process filters to avoid starting custom programs; transformed files such as Git LFS files may conservatively appear modified. Background observations do not recurse into submodules or fetch, checkout, stage, or commit. Explicit approved operations use a separate restricted execution path; unsupported repository configurations remain read-only.

## Build from source

Use **Windows x64, Node.js 24 LTS, and npm**. Git is also needed for Git-dependent tests and fixtures. These are development requirements, not requirements for people using a released `.exe`.

Run the following from the repository root (the folder containing `package.json`):

```sh
npm install --ignore-scripts
npm run pack:desktop
npm start
```

The packaging tools download the official Electron/NSIS tooling; allow only downloads and execution permitted by your local policy. `pack:desktop` builds `release/win-unpacked/`. **`npm start` only launches that previously packed app**; it does not build or run a development server. `Start-Hub.cmd` has the same packaged-app purpose. Keep the entire `win-unpacked` folder together, not just `AI Project Hub.exe`.

### Checks

```sh
npm run verify
npm run test:desktop
```

`verify` runs type checking, unit tests, and the frontend build. `test:desktop` requires a fresh `pack:desktop` first and exercises the packaged app using isolated data. Native file-dialog selections are simulated; subsequent IPC, database, and file-save flows are real. These tests do not send messages to Claude/ChatGPT or use your real projects.

`npm run test:ui` **only creates UI fixtures**, including sample repositories and `.local/verification/hub.sqlite`. It is not a UI test runner and does not launch or verify the app.

Targeted governance adapter/PGlite SQL and local approval/status integration tests have passed during this source update. Those checks do **not** establish that the entire updated suite, packaged Windows tray/update flows, or browser interactions are verified for your build. Rerun the full checks and native/UI tests on the exact release candidate. Live Supabase, true multi-connection PostgreSQL races, and two physical desktops remain unverified; see [verification boundaries](docs/GIT-SAFETY.md#verification-scope).

### Optional web development mode

```sh
npm run dev
```

Or build and serve the frontend:

```sh
npm run build
npm run start:web
```

Web mode defaults to `http://127.0.0.1:4317` and requires its terminal to stay open. It is a development/fallback option, not required for desktop use. The desktop app uses a random internal port and a per-launch secret held by its main process; you do not manually open that service in a browser.

## Maintainer release setup

The source files are at the **repository root**, alongside this README and `package.json`. Review what you publish: keep `.local/`, private databases, `.env` files, credentials, personal screenshots, and generated executables out of version control. Executables belong in Release assets.

1. Configure the real **public GitHub repository** in `release.config.cjs`. The checked-in owner/repo values are intentionally empty; replace them with your own values, not these placeholders:

   ```js
   module.exports = {
     github: {
       owner: '<GITHUB_OWNER>',
       repo: '<GITHUB_REPOSITORY>',
     },
   };
   ```

2. Set the intended package version and complete the checks above. Then build the release artifacts:

   ```sh
   npm run dist:desktop
   ```

   Distribution builds require valid owner/repo values. The release build uses **`--publish never`**: it creates local artifacts and does not create a GitHub repository, upload files, or publish a release.

3. Create the corresponding public GitHub Release. Upload the **NSIS Setup `.exe`, `latest.yml`, and the installer's `.exe.blockmap` from the same build** in `release/`. Optionally add the portable `.exe` and release notes. Do not substitute GitHub's source archives for application assets.
4. Verify the published download and installed-app update flow on Windows before announcing availability. Local tests alone do not validate a live release. No signing certificate, cloud account, or publishing credential is supplied by this project.

## Contributing and reporting problems

Focused fixes and documentation improvements are welcome. Include the app version, Windows version, reproduction steps, and redacted diagnostics in bug reports. Prefer isolated sample data; never attach your private database, pairing codes, credentials, or unredacted screenshots.

For a security issue, use a private reporting channel if the repository has one enabled. Otherwise ask the maintainer for a private contact before sharing sensitive details publicly.

## License and further reading

AI Project Hub is open source under the [MIT License](LICENSE), copyright 2026 AI Project Hub. Third-party dependencies retain their own licenses; distributions include third-party notices.

The detailed technical documents below are currently in Traditional Chinese. Verification records describe specific past checks, not a guarantee for every build or deployment.

[Architecture](docs/ARCHITECTURE.md) · [Desktop integrations](docs/INTEGRATIONS.md) · [Git safety](docs/GIT-SAFETY.md) · [Multi-device setup](docs/MULTI-DEVICE.md) · [Multi-device verification record](docs/MULTI-DEVICE-VERIFICATION.md) · [Roadmap](docs/ROADMAP.md) · [Desktop verification record](docs/DESKTOP-VERIFICATION.md)
