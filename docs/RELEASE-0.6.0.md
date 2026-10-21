# AI Project Hub v0.6.0

Release date: 2026-10-21. Windows x64.

## 繁體中文

- 新增「我的聚焦」，自行選入及排序本機專案，保留暫停／封存專案，不以推薦分數取代個人選擇。
- 新增「快速收工」，一次保存目前停點、阻礙、下一步與收工時間；草稿跨分頁及語言切換保留，版本衝突不會自動覆寫。
- 新增接續卡，集中顯示目的、停點、下一步、阻礙及 Git／任務事實，優先呈現人工記下的下一步。
- 共享工作區新增可複製的 AI 填寫 Prompt 與 Markdown 匯入。選檔或貼上後先預覽差異，再明確確認；只更新 UUID 對應本機專案的非空記憶欄位及下一步，空白／缺少欄位保留原值。
- 匯入會重新核對原文、本機修訂及共享政策；不呼叫 AI API、不自動傳送提示、不修改遠端摘要，也不擴充檔案系統權限。
- 保留英文與繁體中文介面，更新共享工作區及 Markdown 操作的打包桌面驗證。

下載 `AI-Project-Hub-0.6.0-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.6.0-portable-x64.exe` 免安裝版。發行版包含 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。

**升級前請完全退出 Hub，備份整個資料目錄。** 本版將本機 SQLite 升級至 **schema v5**，新增個人聚焦順序及收工時間，保留原有專案與裝置資料。舊版程式無法開啟升級後資料庫；回退須還原相容的升級前備份。本版沒有新增雲端 SQL migration。收工與匯入內容仍依既有分享政策同步；聚焦順序與收工時間不加入遠端摘要。Windows 建置尚未簽署。

## English

- Adds **My focus** for selecting and ordering local projects, including paused or archived projects, independently of automatic recommendations.
- Adds **Quick wrap-up** to save progress, blockers, next action, and a checkpoint time together. Drafts survive tab and language changes; conflicts never silently overwrite newer content.
- Adds resume cards showing purpose, checkpoint, next step, blockers, and Git/task facts, prioritizing the user's recorded next action.
- Adds a copy-only AI fill-in prompt and Markdown import to Shared Workspace. File selection or pasted text leads to a diff preview and explicit confirmation. Only nonblank memory fields and the next action of the matching local project UUID can change; missing or blank fields preserve local content.
- Rechecks the original text, local revision, and sharing policy before import. No model API, automatic sending, remote summary editing, or extra filesystem permission is introduced.
- Includes English and Traditional Chinese UI and expanded packaged-desktop coverage for shared-workspace and Markdown interactions.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included.

**Quit Hub completely and back up the full data directory before upgrading.** This release migrates local SQLite to **schema v5**, adding personal focus order and checkpoint timestamps while preserving existing project and device data. Older apps cannot open the upgraded database; downgrading requires a compatible pre-upgrade backup. No additional cloud SQL migration is required. Wrap-up and imported content follow existing sharing policies; focus order and checkpoint timestamps stay out of remote summaries. Windows binaries are unsigned.

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed.
- **609 tests across 36 files passed**, with no skipped tests, including schemas v1–v4 migrating to v5, rollback, focus storage, checkpoint invalidation, Markdown parsing/import, API guards, group isolation, and Git operations.
- **40 packaged desktop checks passed**, with no skips or renderer errors, including native clipboard prompt copying, Markdown file selection, blank-field preservation, explicit import, stale revision rejection, sharing controls, and native lifecycle behavior.
- **6 additional packaged resumption checks passed**: focus selection/reordering, draft retention and next-step validation, atomic wrap-up saving, resume-card content, 1440px/390px layout checks, restart persistence, focus removal, and native quit.
- **9 packaged Git checks passed**, using two isolated Electron instances and native Git helpers.
- **4 portable lifecycle groups passed**, covering real executable extraction/startup, tray restoration, language persistence, and native quit.
- Packaged version/source, application contents, native Git helpers, installer SHA-512/update metadata, and release-asset SHA-256 checksums were verified. All 121 build inputs remained unchanged through validation.

NSIS installation/uninstallation and an end-to-end installed-app update are outside this validation. Native file-dialog selections are simulated by the desktop test; subsequent IPC, file, and database operations are real. No live cloud service or two physical desktops are used. 本次未實際執行 NSIS 安裝／移除或完整線上更新安裝，也未部署或驗證實際雲端服務及兩台實體電腦。
