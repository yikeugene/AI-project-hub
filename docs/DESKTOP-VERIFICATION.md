# v0.2 Windows desktop verification

Date: 2026-10-19. This supersedes the original web-only delivery recommendation. No application was installed into Windows during verification; no Claude/ChatGPT messages were sent.

## Delivered artifacts

Both Windows x64 artifacts were built successfully with Electron 44.9.0 / electron-builder 26.15.3:

| Artifact | Approximate size | SHA-256 |
|---|---:|---|
| `release/AI-Project-Hub-0.2.0-portable-x64.exe` | 96 MiB | `065b4b5393c7ce079e512800cf3bf4c4418ddefe4f09126f46669e3f51b79408` |
| `release/AI-Project-Hub-0.2.0-Setup-x64.exe` | 96 MiB | `6bdbceb7d9e2de4af43f7378715b3750bbad9573403e41bbf08d275dd2b66cdc` |

The unpacked executable also exists at `release/win-unpacked/AI Project Hub.exe`; its whole directory is required. `release/SHA256SUMS.txt` is supplied. PE headers were checked. Authenticode status is **NotSigned** for both distributed executables. SmartScreen/Smart App Control/organization policies may warn or block; no security settings were changed.

## Automated checks — all passed

- Strict TypeScript across frontend, backend, shared types, Electron main/preload and tests.
- **170 tests across 10 files**, including the previous web/core baseline and desktop additions.
- Production Vite frontend build plus esbuild bundled main/preload build.
- Windows unpacked, portable and NSIS packaging.
- `npm audit`: **0 reported vulnerabilities** in the final locked dependency tree.

New test coverage includes registered-app discovery/allowlists/ambiguity, raw/fenced JSON parsing, exact-byte hashes, input limits, stale revisions, native origin and payload policies, per-run desktop key for HTML/assets/API, preserved web CSRF checks, restart persistence, listener shutdown and draining an active API write before SQLite closes.

Dependencies were installed with `--ignore-scripts`. After explicit user authorization, the new build tools downloaded the official runtime/toolchain and generated the executables. The build-only `global-agent` override removes an older vulnerable logging dependency. No package lifecycle install/rebuild is needed in the final packaging configuration.

## Actual packaged Electron test — passed

Executed `npm run test:desktop` against **the packaged executable**, not a development Electron window or browser substitute. Final full run used an isolated directory at `.local/desktop-smoke-CaFpdy`.

The application was launched with a PATH limited to Windows/System32, excluding system Node/npm/Git. The automation itself uses host Node, but the app does not use it. Verified inside the running packaged main process:

| Runtime | Actual version |
|---|---|
| Electron | 44.9.0 |
| Embedded Node | 24.22.0 |
| Embedded SQLite | 3.53.4 |
| `app.isPackaged` | true |
| Renderer sandbox / context isolation | enabled |
| Renderer Node integration | disabled |

Executed flows:

1. Imported `node:sqlite`, created an in-memory database and queried its actual version inside packaged Electron.
2. Verified renderer has no `window.process` or `require`, and only three explicit native bridge methods.
3. Ordinary external HTTP clients received 401 for both native HTML and workspace API without the private session key.
4. Loaded an empty isolated desktop workspace, preserving the existing production database location by default.
5. Invoked the native folder-picker IPC, selected a path with Unicode and spaces, and created a project through the real UI.
6. Selected ChatGPT Desktop, generated the tailored prompt and copied it through the native clipboard; did not click the launch/send action.
7. Pasted a complete fenced JSON checkpoint, viewed the diff, verified editing invalidated the preview, re-previewed and explicitly imported.
8. Saved Markdown through native save IPC to an isolated path and verified the real written contents.
9. Edited memory, attempted to close the native window, canceled the close, and verified both draft and backend remained alive.
10. Closed the app, verified its listener was released, reopened the same test database and verified saved memory survived.
11. No renderer page errors occurred during the successful run.

**Native dialog selection was stubbed** to make the run unattended; main-process IPC checks and the downstream file/database operations were real. This is not a claim that a human manually completed every OS dialog.

Earlier development runs exposed automation-context/selector/timing problems and one unstable textarea accessible label; these were corrected. The final run passed all checks. The source includes the repeatable smoke script.

## Actual portable executable test — passed

Executed `node scripts/portable-smoke.mjs` against the **distributed single-file portable exe**, not just `win-unpacked`.

- The portable wrapper extracted its runtime and opened the desktop window.
- The process had no system Node/npm on PATH.
- Test data stayed in `.local/portable-smoke-aIay5Q/data`.
- UI reported desktop mode and version 0.2.0 with an empty test workspace.
- A normal HTTP client could not access its internal origin (401).
- Closing the window terminated the portable process and released the listener.

The test enabled a temporary loopback debugging port only for automation; normal desktop startup does not enable this port. Report and screenshot are in the isolated test directory.

## Packaging/privacy checks

The staged app initially caused builder to collect parent development/runtime node_modules. The final configuration uses the supported external-dependency hook plus explicit exclusions. Final ASAR listing contains only:

- main.cjs and preload.cjs
- package metadata and icon
- compiled HTML/CSS/JS assets
- bundled dependency license notices

No node_modules, project source, tests, `.local` fixtures, private conversation files, or user database are included. Application code/assets are around 2 MB; most of the 96 MiB distributable is the bundled Electron runtime. Electron/Chromium and bundled dependency notices are preserved.

## Desktop app discovery and optional web regression

The actual Windows registration query found both Claude and ChatGPT desktop applications. No hardcoded package IDs are used. Activation subprocesses are tested with mocks; **the real chat apps were not launched by the test, and no text was automatically pasted or sent**.

The optional web host was also started with isolated existing fixtures. Browser inspection confirmed the AI handoff view defaults to Claude Desktop, includes the paste-return UI, hides the unavailable native bridge, and showed no console errors. The verification web host was stopped after checking.

## Deliberate remaining limits

- NSIS Setup was built and its PE/signature status checked, but installation/uninstallation was **not executed** because that would change Windows registrations/shortcuts.
- No code-signing certificate, SmartScreen reputation, updater, or clean-machine/enterprise-policy compatibility certification is claimed.
- macOS/Linux packaging and native integration were not tested; this delivery is Windows x64.
- No live model call or automatic access to desktop chat history exists. Users still paste/send Context and review returned JSON.
- No real user project was modified, scanned or removed during the new desktop tests.

See `README.md` for end-user startup and `INTEGRATIONS.md` for the exact privacy and handoff boundaries.
