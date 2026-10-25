# Work-item verification / 小成果驗證

## Scope

Historical development verification of the manual work-item flow, now released in v0.9.0; SQLite schema v7. Fresh release-build results are recorded in [v0.9.0 release verification](RELEASE-0.9.0.md#verification--驗證). No OAuth, model requests, new dependencies, Codex execution/observation or desktop notifications. All runtime verification uses disposable data directories, not the user's normal workspace.

## Automated coverage

- `tests/work-items-storage.test.ts`: draft/confirmation, immutable handoff snapshots, both checks, manual results, failed-check correction, version invalidation, independent holds, idempotent receipts, stale edits, restart, local-only projections, source ideas and additive migration rollback.
- `tests/work-items-api.test.ts`: real local HTTP routes, CSRF/origin protection, strict schemas, no direct phase PATCH, safe localized errors and unchanged legacy workspace DTO.
- `tests/work-items-ui.test.ts`: rendered states and pure list/brief rules. Static rendering alone is not proof of interactive behavior.
- `tests/work-items-api-client.test.ts`: client request shapes, command-ID reuse for explicit retry, and no silent re-submission of conflicts.
- Existing database/device migration tests now expect schema v7; simulated legacy databases remove only new fixture tables before exercising the original upgrade paths.

## Results

- Targeted storage/API/database/device/resumption run: **66 tests passed**.
- Full `npm run verify`: **PASS — 47 files, 810 tests, typecheck and production build**. The first run found two legacy navigation/title assertions; the primary navigation landmark was preserved and the intentional new home title was updated in the regression test, then the full run passed.
- After the final clipboard-error feedback adjustment: **48 focused UI/client/i18n regression tests, typecheck, frontend build and Windows packaging passed**.
- Browser interaction: created a one-line draft, completed its brief, confirmed, previewed, explicitly handed off, recorded both checks and completed it. Completion stayed disabled with zero/one check, and remained a separate action after both passes. Dirty-close cancellation retained text; an injected concurrent update produced a real 409 while keeping the original revision and input, and compare/explicit reload recovered safely.
- Responsive checks: Traditional Chinese and English at 375px had no horizontal document overflow; the editor was 351px wide with no internal overflow. Desktop lists used two columns. The viewport emulation was restored after checking.
- Packaged work-item smoke, final run: **PASS — 6 checks, zero skips**. Actual Electron restart preserved pending work/history; desktop-secret enforcement, exact native clipboard readback, no auto-dispatch on copy, both-reviewer completion and version invalidation passed. The final run did not enable the clipboard-skip flag.
- **Clipboard investigation:** the Browser pane denied clipboard writes. The first native test read immediately after a direct bridge call and failed, then a diagnostic run explicitly skipped that check rather than claiming success. The final smoke instead drives the actual Copy task brief button, waits for UI feedback and bounded OS readback, and verified the exact full text without any skip. The browser-host permission remains a limitation; the UI offers selectable text and a manual-copy explanation, verified in the Browser pane.
- Browser screenshots timed out in this host. A real screenshot from the packaged Electron smoke was captured and supplied instead. Console inspection showed no uncaught errors; the deliberately induced 409 was handled by the UI.
- Full legacy `npm run test:desktop`: **PASS — 40 checks, zero skips** after updating home-title/project-navigation locators for the intentional new layout. This run also verified actual native clipboard readback, both languages, 390px layout, native save dialogs, memory/handoff round-trips, dirty close-to-tray behavior, full restart, read-only remote summaries, offline proposal handling and Markdown import. It did not connect a real relay or model.
- Build warnings remain: the existing large frontend chunk warning and `server/git-tools.ts` CJS `import.meta` warning. Both frontend and Windows packaging completed successfully; this change does not alter that Git helper.

## Reproducible isolated preview

The `Work items isolated preview` launch configuration runs `scripts/work-items-ui-preview.ts` on port 4324 with a new `.local/work-items-ui-*` directory. It seeds three fictional projects and pending, prepared, review and held work. Device synchronization and background Git observation are disabled. It never reads Codex credentials, calls a model or changes a real project.

## Packaged smoke

`scripts/work-items-desktop-smoke.mjs --executable <absolute packaged exe>` launches an actual Electron build with a new data directory. It checks desktop-secret enforcement, actual native clipboard copying without dispatch, pending work after a real application restart, both reviewers and explicit completion, and old-check invalidation on reopen. It restores the previous clipboard text if the user has not changed it meanwhile.

## Product acceptance is separate

Technical tests cannot prove the tool improves the user's actual work. The product trial remains three real small tasks: the brief can be handed to Codex without rewriting; returning after a context switch takes under one minute to identify the goal and first check; completed work has both verifications and unfinished work has a next action or waiting condition.
