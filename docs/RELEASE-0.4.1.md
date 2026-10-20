# AI Project Hub v0.4.1

Release date: 2026-10-20. Windows x64.

## 繁體中文

- 分享設定新增「全選」核取方塊，可一次選取或取消所有記憶欄位。
- 部分選取時顯示中間狀態；個別欄位變更也會同步更新「全選」狀態。
- 選取變更會清除先前的分享預覽，仍需重新預覽並明確確認才會儲存。
- 停用專案分享或操作暫時不可用時，「全選」會一同停用。
- 提供英文與繁體中文標籤，並擴充實際打包桌面程式的回歸測試。

下載 `AI-Project-Hub-0.4.1-Setup-x64.exe` 安裝，或使用 `AI-Project-Hub-0.4.1-portable-x64.exe` 免安裝版。發行版包含 `SHA256SUMS.txt`、`latest.yml` 與安裝包 blockmap。

本版沿用 v0.4.0 的資料庫 schema v3，沒有新增資料庫或雲端 SQL 遷移。從 v0.3.0 升級仍需手動下載，並先完全退出 Hub、備份整個資料目錄。Windows 建置尚未簽署。

## English

- Adds a **Select all** checkbox for optional memory fields in project sharing settings.
- Shows an indeterminate state for partial selection and follows individual checkbox changes.
- Invalidates the previous preview when selections change. Saving still requires a fresh preview and explicit confirmation.
- Disables the control together with sharing fields when sharing or the current operation is unavailable.
- Includes English and Traditional Chinese labels and expanded packaged-desktop regression coverage.

Use the Setup executable to install, or the portable executable to run without installation. SHA-256 checksums and matching installer update metadata are included.

This patch retains v0.4.0's schema v3 and adds no local database or cloud SQL migrations. Upgrades from v0.3.0 require a manual download and a full data-directory backup after quitting Hub. Windows binaries are unsigned.

## Verification / 驗證

- TypeScript, production frontend, desktop bundle, Windows x64 portable and NSIS builds passed.
- **400 tests across 26 files passed**, with no skipped tests.
- **32 packaged desktop checks passed**, including the new select-all interaction, partial selection, preview invalidation, disabled state, and confirmation-before-save behavior; no skips.
- **4 portable lifecycle groups passed**, covering extraction/startup, tray restore, language persistence, and native quit; no skips.
- Packaged version/source, application contents, native Git helpers, installer SHA-512/update metadata, and all release-asset SHA-256 checksums were verified. All 106 tracked build inputs remained unchanged through validation.

NSIS installation/uninstallation and an end-to-end installed-app update were not executed. Native file-dialog selections are simulated by the desktop test; subsequent IPC, file, and database operations are real. 本次未實際執行 NSIS 安裝／移除或完整線上更新安裝，也未部署或驗證實際雲端服務。
