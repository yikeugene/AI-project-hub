# AI Project Hub v0.8.0

Release date: 2026-10-24. Windows x64.

## 繁體中文

- 新增獨立、預設關閉的每群組「目前使用中的應用程式」分享。先預覽再確認同意；既有 HelpTool 活動分享或未確認預覽都不會啟動採集。
- 只分享 Windows 當下前景程式的名稱與觀察時間，不讀取視窗標題、文件、網址、輸入或程序清單，不傳送 PID 或完整路徑。
- 接收端顯示「最後回報使用中的應用程式」，區分過期、未知、撤回與不支援；它不保證對方此刻仍在使用該程式。
- 名稱只留在本機有限記憶體，雲端每群組／設備只保留一筆最新狀態，不建立使用歷史。停止分享、暫停、憑證失效、鎖屏／睡眠或退出會取消採集；離線撤回須待連線恢復。
- Windows 發行檔包含獨立原生 helper，無須為此功能另外安裝 Node.js 或 Git；保留雙語介面與既有專案、記憶及 Git 功能。

下載 `AI-Project-Hub-0.8.0-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.8.0-portable-x64.exe` 免安裝版。另附 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。

**升級前請完全退出 Hub 並備份整個資料目錄。** 本版將本機 SQLite 升級至 **schema v6**，新增同意／修訂／序號／待撤回 metadata，不保存觀察到的程式名稱。舊版無法開啟 v6 資料庫；回退需還原相容備份。

啟用新分享功能前，已有 v2 後端的管理員須另行套用 `supabase/migrations/202610240001_foreground_app.sql`。不要重跑既有 baseline；App 與安裝程式不會部署雲端。未套用時只停用新通道，既有 v2 功能不受影響。分享使用 HTTPS/TLS，並非端對端加密，雲端管理方可讀取名稱。詳見 [設定、遷移與隱私界線](https://github.com/yikeugene/AI-project-hub/blob/v0.8.0/docs/APP-OBSERVATION.md)。Windows 建置尚未簽署。

## English

- Adds a separate, default-off current-app sharing option for each group. Preview and explicit consent are required; existing HelpTool activity consent and unconfirmed previews never start collection.
- Shares only the Windows foreground application's name and observation time. It does not read window titles, documents, URLs, input or process lists, or transmit PIDs or full paths.
- Shows the last reported app with explicit stale, unknown, withdrawn and unsupported states, without claiming the remote device is still using it now.
- Keeps names only in bounded local memory and one latest cloud value per group/device, without a usage history. Disabling sharing, pausing, credential loss, lock/suspend and quit cancel capture; offline withdrawals wait for connectivity.
- Bundles an independent native Windows helper, requiring no separate Node.js or Git installation for this feature, with English/Traditional Chinese UI and existing project, memory and Git functionality preserved.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included.

**Quit Hub completely and back up the full data directory before upgrading.** Local SQLite migrates to **schema v6**, storing consent, revision, sequence and pending-withdrawal metadata rather than observed app names. Older apps cannot open v6 databases; downgrading requires a compatible backup.

To enable this optional feature on an existing v2 backend, its administrator must apply only `supabase/migrations/202610240001_foreground_app.sql`. Do not rerun installed baseline migrations. Neither the app nor installer deploys cloud SQL; a missing migration disables only the new channel. Sharing uses HTTPS/TLS, not end-to-end encryption, and cloud administrators can read app names. See the [setup and privacy guide](https://github.com/yikeugene/AI-project-hub/blob/v0.8.0/docs/APP-OBSERVATION.md). Windows binaries are unsigned.

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed.
- **770 tests across 43 files passed in 363.05 seconds**, with no skipped tests, including SQLite v1-v5 migration to v6, consent/cancellation, strict API and SQL validation, group isolation, withdrawal, old-backend compatibility and existing feature regressions.
- **40 packaged desktop checks passed**, with no skips or renderer errors, covering native security boundaries, bilingual layouts, draft protection, Markdown import, sharing and lifecycle.
- **9 packaged Git checks passed** with two isolated Electron instances and actual bundled native Git helpers.
- **7 packaged app-sharing checks passed**: defaults/previews launch no collector, explicit consent, profile-scoped SQL delivery, receiver UI, higher-sequence withdrawal and genuine native quit. This layer substitutes only the exact helper's output with a controlled test name; all other processes and SQL operations remain real.
- The separate **owned-window native test passed**, including **2,194 shared/native Unicode-name cases**, the real foreground fixture name and UTC timestamp, unavailable-state clearing, and absence of title/PID/path output. This proves the guarded collector code on an owned window, not every Windows application or a locked workstation.
- **5 portable lifecycle groups passed**, including actual extraction, version/isolated data, the bundled foreground helper with sharing off, language persistence, tray restoration, restart and native quit.
- Packaged version/source, native helper placement and build equality, installer SHA-512/update metadata and release-asset SHA-256 checksums were verified. All **140 release inputs** remained unchanged through validation.

完整測試 **43 個檔案／770 個案例全數通過**，無跳過項目。打包桌面／Git／新分享流程分別通過 40／9／7 項檢查，免安裝通過 5 組；原生受控視窗及 2,194 個名稱案例另行通過。新分享的打包測試使用受控子程序輸出；原生採集測試才使用真實自有視窗，兩者證據範圍不同。

No live Supabase deployment, two physical desktops, real multi-connection PostgreSQL race, physical lock/suspend/wake sequence, NSIS installation/uninstallation or end-to-end installed-app update is claimed. Native file-dialog selections are simulated; subsequent IPC/file/database operations are real. 本次未部署真實雲端，亦未驗證兩台實體電腦、實體鎖屏／睡眠／喚醒或安裝／更新全流程。
