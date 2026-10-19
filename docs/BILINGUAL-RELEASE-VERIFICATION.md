# Bilingual interface and release preparation verification

Date: 2026-10-19. Application version: 0.3.0. Host: Windows 11 x64.

## Completed

- `npm run verify`: TypeScript checks, **280 tests across 18 files**, and the production Vite build passed.
- `npm run pack:desktop`: the bundled Electron desktop application was produced successfully.
- `npm run test:desktop`: **28 end-to-end checks passed with no skipped checks**, using disposable local data. The app was launched and driven through actual UI interactions, not merely imported. This was repeated successfully against the final local build.
- `node scripts/portable-smoke.mjs`: **9 portable checks passed**, including extraction/startup, English defaults, language switching without draft loss, saved Traditional Chinese after a complete restart, protected local access and clean shutdown.
- Final unsigned local preview executables were produced in `release/` for both portable and NSIS targets, with a separate `AI-Project-Hub-0.3.0-local-preview-SHA256SUMS.txt`. They intentionally contain no configured GitHub source. The release preflight correctly refuses missing repository coordinates, and both standard packaging scripts explicitly disable publication.
- English defaults were verified independently of the host language. English and Traditional Chinese switching was verified for the interface, document metadata, native menus and app-owned dialogs.
- Saved Traditional Chinese survives a complete app restart. Unsaved settings/device drafts survive switching. Canceling native close preserves an unsaved memory draft and keeps the local service running.
- Desktop and 390px test viewports keep the language controls available. Narrow navigation intentionally scrolls; the last navigation item remains reachable.
- Native clipboard copying, native file saving (dialog selection stubbed), checkpoint preview/import, local preferences and device data round trips passed. No messages were sent to a real chat app or Supabase service.
- Sandbox, context isolation, the desktop session-key boundary, the exact native bridge allowlist and OS-backed credential storage were retained and tested.
- Unconfigured updater actions remain inert, including when callers supply extra URL arguments. No arbitrary URL was opened and no installer was executed.
- A separate, local-only build fixture generated an NSIS installer, its blockmap, `latest.yml`, embedded GitHub update configuration and the elevation helper. The installer's SHA-512 and size matched the metadata. Application MIT and third-party notices were included without replacing Electron's license.

## Limits — not a production upgrade certification

- The real GitHub owner/repository is still blank in `release.config.cjs`. No repository, release or binary was published.
- Metadata compilation used placeholder coordinates in an ignored local fixture only. Those outputs are **not release artifacts** and must not be uploaded. The normal source and local preview builds remain unconfigured.
- No real GitHub download or installed old-version-to-new-version upgrade was performed. This still needs a configured public repository, releases and an isolated Windows installation test.
- Portable/unpacked/browser modes do not perform in-place installation. Automatic installation is also disabled for custom data directories because restart-argument propagation has not been certified.
- Builds are unsigned. Checksums validate integrity; they are not a publisher signature. Windows security policy may block unsigned software.
- Vite reported a non-fatal bundle-size warning for the main JavaScript chunk (approximately 552 kB before gzip). This did not prevent the build.
- Historical stored diagnostics and unknown system/tool errors retain their original text. User-authored content and machine-readable schemas are not translated.

Earlier smoke attempts exposed assertions still tied to the old mixed-language handoff headings and a test that incorrectly rejected intentionally scrollable navigation. These assertions were updated to check the intended localized output and reachable navigation; the final complete desktop run passed.

Screenshots, fixture databases, logs, temporary build configurations and pre-change source backups remain in ignored local working directories. They are not part of the public documentation or source release.
