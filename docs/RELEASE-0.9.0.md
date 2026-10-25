# AI Project Hub v0.9.0

Release date: 2026-10-25. Windows x64.

## 繁體中文

- 新增人工「小成果 → 待接回 → 雙方驗證」流程。新版首頁集中顯示可推進、待接回、檢查中、暫停與已完成工作，方便跨專案接續。
- 可先保存一句目標，再補齊範圍、驗收條件與返回後第一個檢查動作。確認後預覽、複製任務說明，自行貼到 Codex；複製不會標記交出，需另按「我已交給 Codex」。
- 本人與搭檔對目前同一版本／提交的檢查都通過，且沒有暫停限制，才可明確完成。搭檔回報由本人記錄來源，是工作紀錄，不是經驗證的搭檔身分簽核。
- 返工、重開或新一輪會使舊檢查失效，保留版本、交接快照與事件歷史。可暫停、等待或延後；到期不會自動執行或通知。
- 保存的工作可在重啟後接回；未儲存提示與衝突比較保護編輯內容。小成果保留在本機，不加入雲端共享，也不覆寫既有任務、專案記憶或下一步。

下載 `AI-Project-Hub-0.9.0-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.9.0-portable-x64.exe` 免安裝版。另附 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。Windows 建置尚未簽署。

**升級前請完全退出 Hub 並備份整個資料目錄。** 本版將本機 SQLite 升級至 **schema v7**，新增 `work_items` 與 `work_item_events`。v0.8.0 及更舊版無法開啟 v7 資料庫；回退需還原相容備份，沒有自動降版。本版沒有新增雲端 SQL 遷移，既有可選分享功能的設定要求不變。

此流程不連接 AI、不包含 OAuth 或模型請求，不自動派工、執行 Codex、監測其進度或判定完成。外部程式碼改動後須自行開始新一輪檢查。詳見[小成果使用說明](https://github.com/yikeugene/AI-project-hub/blob/v0.9.0/docs/WORK-ITEMS.md)。

## English

- Adds a manual work-item flow from a small outcome through handoff, return and verification. The new home screen brings actionable, returning, review, held and completed work together across projects.
- Save a one-line draft, then define scope, acceptance criteria and the first check on return. Preview and copy the brief, paste it into Codex yourself, then separately record that you handed it off. Copying never marks it handed off.
- Completion requires both reviewers' passing checks for the current version and submission, no active hold, and an explicit completion action. Partner reports are recorded locally with their source; they are not independently authenticated signatures.
- Rework, reopening or a new round invalidates previous checks while preserving versions, handoff snapshots and event history. Pause, wait or defer work without automatic execution or notifications when a date expires.
- Saved work survives restarts; dirty-draft guards and conflict comparison protect input. Work items stay local and do not join cloud projections or overwrite existing tasks, project memory or next actions.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included. Windows binaries are unsigned.

**Quit Hub completely and back up the full data directory before upgrading.** Local SQLite migrates to **schema v7**, adding `work_items` and `work_item_events`. v0.8.0 and earlier cannot open v7 databases; downgrading requires a compatible backup. This release adds no cloud SQL migration; existing optional sharing setup requirements remain unchanged.

This workflow makes no AI connection, OAuth or model requests, and does not dispatch, execute or monitor Codex, or detect completion. After external code changes, start a new verification round yourself. See the [work-item guide](https://github.com/yikeugene/AI-project-hub/blob/v0.9.0/docs/WORK-ITEMS.md).

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed. Existing Vite chunk-size and development-only CJS `import.meta` fallback warnings remain; packaged Git-helper resolution passed.
- **810 tests across 47 files passed in 360.62 seconds**, with no skipped tests. Coverage includes additive schema-v7 migration, state transitions, both-reviewer completion gates, version invalidation, idempotent commands, conflicts, local-only projections and existing regressions.
- **40 packaged desktop checks passed**, with no skips or renderer errors, covering native security boundaries, bilingual layouts, draft protection, Markdown import, sharing and lifecycle.
- **9 packaged Git checks passed**, using isolated Electron peers, real Git operations and the bundled native Git helpers.
- **7 packaged app-sharing checks passed**, covering default-off consent, scoped SQL delivery, receiver UI, withdrawal and native quit. This layer substitutes only the exact helper's output with a controlled name; it does not collect other applications on the user's desktop.
- **6 packaged work-item checks passed**, with no skips: session protection, exact native clipboard contents, copying without dispatch, real quit/restart persistence without replay, both-check completion gates, and reopening with old checks invalidated while history remains. The pending-work screenshot was also inspected.
- **5 portable lifecycle groups passed**, including extraction, version/isolated data, bundled foreground helper with sharing off, language persistence, tray restoration, restart and native quit.
- A separate **owned-window native test passed**, including **2,194 shared/native Unicode-name cases**, a real fixture foreground name and UTC timestamp, unavailable-state clearing, and absence of title/PID/path output. This is guarded collector-code evidence on a test-owned window.
- Packaged version/source, native helpers matching the current staged build, installer SHA-512/update metadata and release-asset SHA-256 checksums were verified. All **148 release inputs** and their path set remained unchanged through validation.

完整測試 **47 個檔案／810 個案例全數通過**，無跳過項目。打包桌面／Git／分享／小成果分別通過 40／9／7／6 項檢查，免安裝通過 5 組；另通過原生受控視窗及 2,194 個名稱案例。小成果檢查實際使用原生剪貼簿與重啟；雙方驗收狀態轉移透過打包 runtime 的 API 驗證。

No live Supabase deployment, two physical desktops, real multi-connection PostgreSQL race, physical lock/suspend/wake sequence, NSIS installation/uninstallation or end-to-end installed-app update is claimed. Native file-dialog selections are simulated; subsequent IPC/file/database operations are real. A real-user trial across three actual work items has not been performed. Earlier feature-development browser interaction and exploratory results are documented separately in [work-item verification](https://github.com/yikeugene/AI-project-hub/blob/v0.9.0/docs/WORK-ITEMS-VERIFICATION.md).

本次未部署真實雲端，亦未驗證兩台實體電腦、實體鎖屏／睡眠／喚醒、安裝／更新全流程或三項真實工作的使用者試用。上述結果來自獨立測試資料，不使用正式工作區。
