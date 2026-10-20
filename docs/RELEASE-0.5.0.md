# AI Project Hub v0.5.0

Release date: 2026-10-20. Windows x64.

## 繁體中文

- 新增「共享工作區」，集中查看所有已加入群組的唯讀專案摘要，支援群組篩選、搜尋及 Markdown 下載。
- 同一台裝置可加入多個群組，各組獨立同步、暫停、解除配對及保留離線快取；群組名稱可在本機修改。
- 專案分享可逐群組選擇收件對象與記憶欄位，保留「全選／取消全選」。加入新群組不會自動分享既有專案，儲存仍需完整預覽與明確確認。
- 同一專案在不同群組分開顯示，不合併可見欄位。下載只包含已允許的摘要與來源／版本資訊，不包含專案檔案；已知撤回、撤銷或離開群組後的內容不再顯示或匯出。
- 「目前管理群組」控制裝置、訊息、治理與 Git 審批的操作範圍，與共享工作區篩選獨立。舊請求不能改用另一群組身分，跨群組仍保留 Git 未知執行結果的本機復原保護。
- 擴充英文、繁體中文及實際打包程式的多群組操作測試。

下載 `AI-Project-Hub-0.5.0-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.5.0-portable-x64.exe` 免安裝版。發行版包含 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。

**升級前請完全退出 Hub，備份整個資料目錄。** 本版將本機 SQLite 升級至 **schema v4**，保留既有群組、共享政策、待送工作與 Git journals，不重新啟用已解除配對的歷史群組。舊版程式無法開啟升級後資料庫；回退須還原相容的升級前備份。多群組功能沿用現有 relay 協定，沒有新增雲端 SQL migration；Git 審批仍需既有 v2 relay 遷移與管理員設定。Windows 建置尚未簽署。

## English

- Adds **Shared Workspace** for read-only summaries across joined groups, with group filtering, search, and Markdown downloads.
- Supports multiple groups on one installation, with independent synchronization, pause, disconnect, offline caches, and local group labels.
- Lets each project explicitly select recipient groups and memory fields, including Select all. Joining a new group never automatically shares existing projects; saving requires a complete preview and confirmation.
- Keeps each group's projection separate. Downloads contain only approved summary fields and provenance, not project files. Known withdrawals, revocations, and departed memberships are excluded from browsing and export.
- Scopes devices, messages, governance, and Git approvals to the selected management group independently of the workspace filter. Stale requests cannot silently switch identity, and uncertain Git journals retain installation-wide recovery protection.
- Expands English, Traditional Chinese, and packaged-desktop coverage for multi-group interactions.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included.

**Quit Hub completely and back up the full data directory before upgrading.** This release migrates local SQLite to **schema v4**, retaining the existing membership, sharing policies, queued work, and Git journals without reviving detached historical groups. Older apps cannot open the upgraded database; downgrading requires a compatible pre-upgrade backup. Multi-group sharing uses the existing relay protocol with no additional cloud SQL migration. Git approvals still require the existing v2 relay migration and administrator setup. Windows binaries are unsigned.

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed.
- **449 tests across 29 files passed**, with no skipped tests, covering migration from schemas v1/v2/v3, migration rollback, multi-group identity and synchronization, sharing confirmation, summary export, API scope guards, and Git operations.
- **35 packaged desktop checks passed**, with no skips or renderer errors, including shared-workspace browsing, localized filters, exact-source Markdown export, canceled saves, per-group select-all, preview invalidation, and explicit sharing withdrawal.
- **9 packaged Git checks passed**, including two isolated Electron instances, group-scoped pairing and authorization, background synchronization, approved local staging, stale-preview rejection, native Git helpers, and genuine quit.
- **4 portable lifecycle groups passed**, covering real executable extraction/startup, tray restoration, language persistence, and native quit.
- Packaged version/source, application contents, native Git helpers, installer SHA-512/update metadata, and release-asset SHA-256 checksums were verified. All 111 build inputs remained unchanged through validation.

NSIS installation/uninstallation and an end-to-end installed-app update are outside this validation. Native file-dialog selections are simulated by the desktop test; subsequent IPC, file, and database operations are real. No live cloud service or two physical desktops are used. 本次未實際執行 NSIS 安裝／移除或完整線上更新安裝，也未部署或驗證實際雲端服務及兩台實體電腦。
