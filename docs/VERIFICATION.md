# v0.1 historical MVP verification report

> This is the original web-MVP report. Its web server is no longer left running. For the current Windows desktop version and artifacts, see [Desktop verification](DESKTOP-VERIFICATION.md). The 78-test count below is historical, not the current test total.

Date: 2026-10-19

Environment: Windows 11, Node.js 24.19.0, npm 11.17.0, Git for Windows 2.55.0; native `node:sqlite` available. This report distinguishes executed checks from capabilities that remain untested on other machines.

## Automated checks — passed

`npm run verify` completed successfully:

- Strict TypeScript check.
- **78 tests across 7 files**, all passed, no skipped tests in the final run.
- Production build: Vite 6.4.4, 319.43 kB JavaScript / 97.36 kB gzip; 49.25 kB CSS / 10.86 kB gzip.
- Separate `npm audit`: **0 vulnerabilities** reported by the configured registry at verification time.

The installation used `npm install --ignore-scripts`; package lifecycle scripts were not executed. The initial Vitest selection had advisories and was upgraded to 5.0.5 before final verification.

| Suite | Verified scope |
|---|---|
| `tests/db.test.ts` | Restart persistence, duplicate paths, revisions, Hub-only cascade, preservation of last successful Git facts |
| `tests/insights.test.ts` | Transparent score ordering, exclusion of inactive/blocked/backlog-only work, no invented activity |
| `tests/handoff.test.ts` | Snapshot contents, preserving instructions/state, schema/project/size checks, link boundary, missing-file behavior |
| `tests/api.test.ts` | Host/Origin/token/JSON enforcement, case-variant mutation routes, CRUD/revision conflicts, scan preview/import, safe shared-state application, launch whitelist |
| `tests/discovery.test.ts` | Local paths, project markers, skipped directories and links, traversal limits, worktree markers, stop-at-project behavior |
| `tests/git.test.ts` | Read-only facts, Unicode/NUL/rename/conflict parsing, branches/unborn/detached/worktree cases, helper/filter suppression |
| `tests/launcher.test.ts` | Capability lookup, allowlist, path/argument handling and mocked native launch plans |

A review found mixed-case `/API/...` routes bypassing a case-sensitive mutation guard. The regression was first reproduced as HTTP 200 instead of expected 403, then fixed by applying the token check to every mutation regardless of route case. The final test and a live production-server request both returned 403.

## Browser end-to-end — passed

Executed against **separate `.local/verification/hub.sqlite` and disposable fixture directories**. No real user repository was scanned, imported, edited or removed during verification.

- Loaded the production dashboard with five isolated projects and real fixture Git histories.
- Inspected Git facts: branch `main`, recent fixture commit, untracked working-tree file, counts and observation time.
- Edited Traditional Chinese memory through the UI, switched tabs without losing the draft, tested the unsaved-close confirmation and canceled it, then saved.
- Created and completed a task through the UI.
- Generated a handoff containing the saved checkpoint and tasks; Copy action reported success.
- Confirmed repository export and verified unique Markdown plus initial `state.json` creation.
- Changed only the isolated fixture's shared-state checkpoint, viewed the current/proposed field diff, and explicitly confirmed import.
- Restarted the verification server and confirmed the imported memory and completed task persisted.
- Scanned a new isolated root, previewed one manifest-based project, selected/imported it, and saw the saved result.
- Manually added a non-Git folder with an empty name field (folder-name fallback); searched for it; removed only its Hub record through confirmation. The original directory still existed afterward.
- Final browser console: no warnings/errors. Browser request log for normal tested flows: no failed requests.

## Layout checks — passed

- Desktop capture at **1440 × 1050** in an isolated headless Edge profile, visually inspected. Screenshot: `../.local/verification-dashboard.png` (contains verification examples, not user projects).
- Mobile emulation at **375 × 812** with six rows: root scroll width and client width both 375 px; project table keeps its own horizontal scrolling.
- A narrow-layout defect was fixed: the offscreen accessible table-header label now has a containing block inside the scroll container rather than extending root overflow.
- Emulation was reset after testing.

## Clean production workspace — running

The normal profile was started at **http://127.0.0.1:4317**, with zero projects and zero tasks. Dashboard, projects, tasks, handoff and settings empty states were opened without visible errors. The verification server on 4318 was stopped; its database remains isolated for reproducibility.

## Explicitly not verified / not implemented

- Claude Code and Codex were **not found on this Windows PATH**. Their actual interactive launch/login was not exercised; launcher plans are covered by tests and unavailable buttons are disabled.
- Explorer and VS Code executables were detected, but the verification deliberately did not launch external apps. Their process planning was tested with mocks.
- No real model/API call, cloud upload, automatic AI summary or private session ingestion was performed or implemented.
- OpenAI documentation access was denied in this environment. The conservative explicit-text handoff does not depend on unverified Codex auto-loading semantics.
- macOS/Linux native launch actions, WSL translation, installer packaging, prolonged hundreds-of-project load tests, and OS-level background service behavior were not validated. There is no OS background service in this version.
- Download controls are implemented, but the browser's file-save location/permissions were not part of the manual run; copy and repository export were exercised.

See `README.md` for the daily workflow, backup procedure and limitations; `ROADMAP.md` for follow-up work.
