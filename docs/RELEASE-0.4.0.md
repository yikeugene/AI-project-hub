# AI Project Hub v0.4.0

Release date: 2026-10-20. Windows x64.

## 繁體中文

### 本版更新

- Git 操作採用「預覽 → 指定管理員審批 → 原電腦確認執行」流程，並提供狀態變動檢查、一次性授權及執行紀錄。
- 新增管理員角色、權限交接與選用的跨裝置背景狀態分享。
- 關閉視窗可縮至系統匣；再次開啟會恢復原視窗。完全退出仍會確認未儲存草稿並等待受控工作結束。
- 安裝版與免安裝版包含 Windows 原生 Git supervisor 及 pre-push guard。
- 設定正式 GitHub 更新來源；安裝版使用預設資料目錄時，可手動檢查、下載，並明確確認重新啟動安裝。

### 下載與升級

- `AI-Project-Hub-0.4.0-Setup-x64.exe`：Windows x64 安裝版。
- `AI-Project-Hub-0.4.0-portable-x64.exe`：Windows x64 免安裝版。
- `SHA256SUMS.txt`：發行檔 SHA-256 校驗碼。
- `latest.yml` 與安裝包 `.exe.blockmap`：同一次建置產生的安裝版更新資料。

**從 v0.3.0 升級需手動下載。請先完全退出 Hub 並備份整個資料目錄。** 本版將本機 SQLite schema 升級至 v3，舊版無法開啟升級後的資料庫；退回舊版需要相容的升級前備份。

Git 審批需自行套用 `202610200001_device_git_approval.sql`（先有 `202610190001_desktop_relay.sql`）並指定初始管理員。發行程式不會自動部署或修改你的雲端資料庫。設定方式見 [多設備說明](https://github.com/yikeugene/AI-project-hub/blob/v0.4.0/docs/MULTI-DEVICE.md)。

免安裝版與自訂資料目錄仍採手動下載更新。Windows 建置尚未簽署。

## English

### Changes

- Adds reviewed Git operations with designated administrator approval, separate confirmation on the originating desktop, repository-state checks, one-use authorization, and execution records.
- Adds administrator roles and transfer, plus optional device activity/status sharing.
- Closing the window hides it in the system tray. Reopening restores the existing window; explicit quit preserves draft confirmation and drains controlled work.
- Ships the native Windows Git supervisor and pre-push guard in both distributions.
- Configures the official GitHub update source. Installed builds using the default data directory support user-initiated checks, downloads, and explicit restart-to-install.

### Upgrade notes

Download the Setup executable to install, or the portable executable to run without installation. Both include the desktop runtime. SHA-256 checksums and matching installer update metadata accompany the release.

**Upgrade from v0.3.0 manually. Fully quit Hub and back up the entire data directory first.** The local SQLite database upgrades to schema v3. Older applications cannot open it; downgrade requires a compatible pre-upgrade backup.

Git approvals require the v2 relay migration and an explicitly designated initial administrator. This release does not deploy cloud SQL. Portable builds and custom data directories continue to use manual downloads. Windows binaries are unsigned.

## Verification / 驗證

- `npm run verify`: TypeScript checks, **26 test files / 400 passing tests**, and production frontend build; no skips.
- Fresh packaged Electron: **31 checks passed**, including actual native clipboard, safeStorage, bilingual UI, draft preservation, tray behavior, SQLite persistence, and release-source navigation; no skips.
- Fresh packaged Git integration: **9 checks passed**, using two isolated Electron instances, actual PGlite relay SQL/anon roles, a disposable Git repository, and the shipped native supervisor/guard; no skips.
- Distributed portable executable: **4 lifecycle groups passed**, including real extraction/startup, hide/restore, restart persistence, and native quit; no skips.
- Packaged application version and release source match v0.4.0 and `yikeugene/AI-project-hub`. The ASAR contains only bundled application files, assets, metadata, and license notices; native Git tools are present in resources.
- `latest.yml` version, installer filename, byte size, and SHA-512 match the Setup executable. SHA-256 checksums cover both executables, the blockmap, and update metadata.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `AI-Project-Hub-0.4.0-Setup-x64.exe` | 100938675 | `ddddf15a0c8385a177265e8062e397b58d0f76b9dbcfd48e015a851c295e3d33` |
| `AI-Project-Hub-0.4.0-portable-x64.exe` | 100793833 | `3865fac8ce47124536f21dca809bcd76213ac5a4992204f644e72e90088fdaa2` |

**Limits / 限制：** NSIS installation/uninstallation and end-to-end installed-app update installation were not executed. Live Supabase, true multi-connection PostgreSQL races, and networking between two physical desktops were not tested. Native file-dialog selections are simulated in automation; subsequent IPC, file, and database operations are real. 沒有執行 NSIS 安裝／移除或完整線上更新安裝，也沒有部署雲端 SQL。
