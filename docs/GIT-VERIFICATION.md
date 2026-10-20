# Git 審批與背景執行驗證

日期：2026-10-20。這份記錄針對本次原始碼與本機預覽建置，不代表 GitHub 既有 v0.3.0 下載已更新。

## 已完成的驗證

- 最終 `npm run verify` 全部通過：TypeScript 檢查、26 個測試檔／400 個案例，以及 production 前端 build。背景輪詢的精簡欄位查詢與相關回歸已包含在這輪檢查。
- Build 有非阻斷的 Vite bundle 大小提示（主要 JS 約 630 kB、gzip 約 193 kB）；不是建置失敗。
- 真實暫存 Git 儲存庫：選擇暫存／取消暫存、rename、unborn、detached、SHA-256、固定 tree/parent 的提交、分支操作、狀態變動、鎖競爭、不覆寫 checkout、設定／filter 防護及差異大小限制。
- 真 SQL relay fixture：實際執行兩份遷移、RLS／ACL、裝置角色、管理員自審、跨群組隔離、角色變更後的失效、一次性 consume、不可變結果及分享撤回。不是以假 SQL 字串取代授權測試。
- 網路 Git 的本機整合：使用測試模組提供的隔離本地傳輸，驗證固定 OID fetch、分開審批的 fast-forward pull、真正的打包 pre-push guard、協商時／接收時競爭與未知結果。正式程式沒有放寬傳輸的開關。
- Windows 原生 supervisor：二進位 stdin、輸出上限、父程序先退出的 detached 子程序、整個 job 的 timeout／退出確認、缺少完成證據時停止，以及 owned fence 的保守復原。

## 瀏覽器中的實際流程

使用 `scripts/git-ui-preview.ts` 建立兩個隔離 runtime、一個本機 PGlite relay 與新建的測試 Git 儲存庫；未連接真正 Supabase。

1. 原電腦選擇 `README.md`，檢查本機 diff、審批摘要並送交管理員。
2. 管理員另外批准；原儲存庫仍是 **0 個已暫存檔案**。
3. 原電腦再次確認後，只有 `README.md` 被暫存；結果為成功，已暫存數變為 **1**，不再提供重複執行按鈕。
4. 另一份 `notes.txt` 申請批准後，由外部編輯器改動該檔案；原電腦執行被判為 **stale**，仍只有原來的 1 個已暫存檔案，須重新申請。
5. 遠端只看到選擇分享的背景／同步狀態、Git 計數和手動任務計數；來源 Git 觀察過舊時有獨立提示，不把最近收到的 relay 快照稱為即時 Git 狀態。
6. 375px 寬度下，Git dialog 及遠端狀態沒有頁面橫向溢出；繁體中文及英文內容均可使用。沒有非預期瀏覽器 console 錯誤。
7. 暫停連線後，仍能取消勾選並確認保存本機的 App／Git／任務分享。實際 API 顯示 `enabled: false`、分享政策已清空；恢復連線後，relay 收到較新版本的 `activity: null, projects: []`。這不放寬 Git 執行或管理員權限。另有 oversized publication／跨網路狀態的 UI 回歸。

早期測試服務曾載入尚未修正的 native lock 版本，操作被保守標為未知而沒有暫存。修正、序列化計劃回歸與重啟後，以上成功／stale 流程均以真正儲存庫重新驗證；沒有把早期失敗當作成功。

## Windows 建置與原生整合

最終交付檔的三組 smoke 已完成，均使用明確的新建置路徑與隔離 `--data-dir`，不是舊發行檔。所有測試程式最後均透過真正的 File／Quit 結束並釋放 listener，沒有遺留已啟動的測試 App。

| 測試 | 最終結果 | 本機證據 |
|---|---|---|
| 打包 Git／雙實例 | 9 項通過，無跳過 | `.local/git-desktop-smoke-5YmC1r/report.json` |
| 一般桌面 | 31 項通過；1 項明確環境限制 | `.local/desktop-smoke-rMa19p/report.json` |
| Portable | 4 組生命週期檢查通過，無跳過 | `.local/portable-smoke-7pdAKT/report.json` |

剪貼簿讀回在本環境失敗，獨立的 OS 寫入／讀取探測也失敗；桌面 smoke 使用既有的 `--allow-unavailable-clipboard` 明確記錄跳過，**不宣稱剪貼簿驗證成功**。

打包 Git 測試使用真正的 Electron safeStorage、renderer sandbox、實際 SQL／anon 權限及原生 Git。隱藏原視窗後，後端自動同步送回批准並上報背景狀態，但沒有執行 Git；原機確認才暫存一次。也驗證 shipped `resources/git-tools` supervisor／pre-push guard 在沒有系統 Node PATH 時運作、重播拒絕及檔案變動攔截。Portable 已驗證關窗保留草稿、第二個 wrapper 喚回同一視窗／renderer、語言持久化及正常退出。

早期 portable 測試曾因驅動使用 renderer `window.close()` 觸發 Chromium 未儲存對話框而卡住；已改用 native BrowserWindow.close，並以真正的 native visibility 判斷隱藏狀態，所有等待與清理均有上限。這不是修改程式來繞過草稿保護。

- 本機產物：`.local/approved-git-final/AI-Project-Hub-0.3.0-approved-git-preview-x64.exe`（Windows x64 可攜預覽版，未發布）。原有 `release/` 發行檔未覆寫。
- SHA-256：`d44d529d317f1976e3a37cb8312cf1cedb99c3428cfc05719f684324e431049e`，測試後已再核對。
- 原生 Git smoke：`npm run test:git-desktop -- --executable <新建置的絕對路徑>`；一般桌面與 portable smoke 同樣支援 `--executable`。
- 桌面 CJS bundle 對僅供 ESM 開發環境的 `import.meta` fallback 有非阻斷警告；實際打包後的 `resources/git-tools` 路徑已在原生測試中確認。

## 尚未驗證／明確限制

- 未部署到使用者的 Supabase；未驗證真實 gateway、TLS、雲端配額與兩台實體 Windows 電腦之間的網路。
- PGlite 是單一連線，不能證明真正 PostgreSQL 多連線競爭；此環境未提供 PostgreSQL／Docker 供該項測試。
- 未使用真實遠端帳號做 authenticated HTTPS/GCM fetch／push；沒有推送本專案或任何使用者儲存庫。
- 未實際安裝 NSIS 或執行線上更新安裝。更新／退出／取消退出的生命週期由測試驗證，不等同完整安裝器驗證。
- SSH、自訂 hooks／filters／LFS、需要簽章或特殊索引／物件配置等不支援的寫入會停下；既有安全的唯讀檢視保留。
- 不保證睡眠、關機、登出後繼續工作。已失聯的裝置只顯示最後回報與資料時效。
- 這是本軟件內的審批邊界，不會阻止同一 OS 使用者直接執行外部 Git。

## 使用前

先備份現有 Hub 資料，再使用新程式；SQLite 升級至 v3 後，舊版程式不能直接開啟。啟用管理員審批需依 [多設備說明](MULTI-DEVICE.md) 套用 additive v2 relay 遷移並指定初始管理員。唯一管理員解除配對前應先交接權限，新配對不會自動繼承舊角色。完整限制與復原規則見 [Git 安全說明](GIT-SAFETY.md)。
