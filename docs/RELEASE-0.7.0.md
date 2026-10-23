# AI Project Hub v0.7.0

Release date: 2026-10-24. Windows x64.

## 繁體中文

- 本機「專案記憶」新增記憶填寫 Prompt 與 Markdown 匯入，未共享、未配對的專案也能使用。Prompt 與下載草稿包含目前九欄內容，包括未儲存的編輯。
- 匯入前先比較目前草稿，確認後只套用至草稿，再另按「儲存記憶」寫入資料庫。UUID 必須符合目前專案，空白／缺少欄位保留原值，獨立的專案下一步不變。
- 草稿或專案變更會讓舊預覽／Prompt 失效；版本衝突保留草稿，不強制覆寫。Hub 不會呼叫 AI API 或自動傳送內容。
- Git 頁顯示更具體的桌面、配對、同步、治理及管理員限制，並保留儲存庫錯誤的詳細原因。
- 修正 Git 本機恢復入口：`unknown`／`partial` 紀錄在離線、同步停用或解除配對後，仍可重新讀取儲存庫、勾選核對並確認解除本機封鎖。原操作狀態維持不變；此流程不執行 Git 變更，也不放寬一般執行、取消或審批規則。
- 更新英文／繁體中文介面、Markdown 格式說明及隔離驗證工具。

下載 `AI-Project-Hub-0.7.0-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.7.0-portable-x64.exe` 免安裝版。另附 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。

本版沿用 **schema v5**，從 v0.6.0 升級沒有新增資料庫遷移；更早版本仍會升級至 v5。升級前請完全退出 Hub 並備份整個資料目錄。匯入後儲存的記憶仍遵循既有共享設定；本版沒有新增雲端 SQL migration。Windows 建置尚未簽署。

## English

- Adds a memory fill-in prompt and Markdown import directly to local Project memory, including unshared and unpaired projects. Prompts and downloaded drafts contain the current nine-field draft, including unsaved edits.
- Import compares against the current draft, then explicitly applies to the draft. A separate Save memory action writes to the database. Project UUIDs must match; blank or missing fields preserve existing content, and the separate project next action stays unchanged.
- Project or draft changes invalidate old previews and prompts. Revision conflicts preserve the draft without forced overwrites. Hub does not call an AI API or send the content automatically.
- Improves Git diagnostics for desktop capability, pairing, sync, governance and administrator requirements, preserving detailed repository error parameters.
- Fixes local recovery for unknown/partial Git records while offline, sync is paused, or pairing has been removed. Recovery rereads the repository and requires explicit acknowledgement. It retains the original operation state, runs no Git mutation, and does not relax execution, cancellation or approval rules.
- Updates English/Traditional Chinese UI, Markdown format documentation and isolated verification tools.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included.

This release retains **schema v5**, with no new database migration from v0.6.0; earlier versions still migrate to v5. Quit Hub completely and back up the full data directory before upgrading. Saved memory follows existing sharing settings. No additional cloud SQL migration is required. Windows binaries are unsigned.

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed.
- The full run covered **650 tests across 37 files**: 647 passed; three Git-operation cases failed after multi-hour execution pauses (two test deadlines and one process-tree deadline). The entire affected file was rerun: **29/29 passed in 356.55 seconds**, so every one of the 650 cases has a passing result across the completed runs. No tests were skipped.
- **40 packaged desktop checks passed**, without skips or renderer errors, covering native clipboard/file operations, sharing, Markdown import, conflict rejection and application lifecycle.
- **6 additional packaged local-memory checks passed**: native prompt copying with unsaved content, draft download and BOM/CRLF import, apply-without-saving, explicit save, blank-field preservation, wrong-project rejection, bilingual/390px layouts and native quit.
- **9 packaged Git checks passed**, using two isolated Electron instances, actual safeStorage and the bundled native Git helpers.
- **4 portable lifecycle groups passed** on rerun: extraction/startup, isolated data, tray/second-instance restoration, language persistence and genuine native quit. The first attempt exceeded its deadline during the long execution pause.
- Packaged version/source, application contents, native helpers, installer SHA-512/update metadata and release-asset SHA-256 checksums were verified. All **125 production build inputs** remained unchanged through validation.

完整測試首輪有三項 Git 案例在跨數小時停頓後逾時失敗，整份受影響測試檔重跑 **29／29 項通過**（356.55 秒），650 項案例均取得通過結果；免安裝首輪也逾時，重跑四組檢查已全數通過。桌面／本機記憶／Git 檢查分別為 40／6／9 項通過，沒有跳過項目。

NSIS installation/uninstallation and an end-to-end installed-app update are outside this validation. Native file-dialog selections are simulated; subsequent IPC, file and database operations are real. No live cloud service or two physical desktops are used. 本次未實際執行 NSIS 安裝／移除或完整線上更新安裝，也未部署或驗證實際雲端服務及兩台實體電腦。
