# 本機記憶與 Git 診斷驗證

日期：2026-10-23。以下記錄功能開發與獨立測試包的驗證；正式 v0.7.0 的重新打包及發布驗證另見 [版本說明](RELEASE-0.7.0.md)。驗證不代表真實 Supabase 已配置。

## 自動檢查

- `npm run verify`：初次完整驗證 37 個測試檔、635 項通過，包含型別檢查及正式建置。
- 檢查後補強草稿保留、過期 Prompt、尾端 CR 與 Unicode 邊界，再執行 `npm run build`（包含 TypeScript）成功。
- 記憶功能階段 `npm test`：37 個測試檔、637 項全部通過。
- 使用者明確授權 Git 本機恢復修正後，`npm run build`（包含 TypeScript）成功；最終 `npm test`：**37 個測試檔、650 項全部通過**。
- 新增 13 項恢復／授權邊界案例，涵蓋 `unknown`／`partial`、離線、停用、無群組／null profile、已確認狀態及一般 execute／cancel 不放寬授權。
- Vite 提示主 bundle 超過 500 kB；屬體積警告，建置成功。

## 實際瀏覽器驗證

使用 `scripts/memory-ui-preview.ts`、`.claude/launch.json` 的 **Local memory isolated preview**，在新建 `.local/memory-ui-*` 目錄內建立獨立資料庫及兩個測試專案。沒有使用正式資料庫、憑證、外部 Relay 或真實 Git 儲存庫。

| 案例 | 結果 |
| --- | --- |
| 未共享／未配對專案的記憶入口 | 可開啟 Prompt 與 Markdown 匯入；英文／繁中均有正確標籤。 |
| Prompt 使用未儲存草稿 | 包含畫面最新的九欄資料、目前 UUID 與基準修訂，不含專案路徑或獨立 nextAction。 |
| 預覽與確認前 | 對照未儲存草稿顯示差異；API 讀回的資料庫內容與 revision 不變。 |
| 套用至草稿 | 畫面更新並標示尚未儲存；API 仍回傳原記憶與原 revision。 |
| 明確儲存 | 記憶更新且 revision 增加一次；空白 notes 保留原筆記，獨立 nextAction 不變。 |
| 選檔與錯誤專案 UUID | 透過 File input 的 File/Change 事件讀取測試 Markdown；不同 UUID 顯示錯誤、不能確認，原草稿不變。 |
| 背景更新與匯回舊基準值 | 草稿 B 留在畫面，同時以獨立 API 寫入 C 並觸發工作台重讀。匯入舊基準 A 後，A 仍保留、儲存按鈕可用、基準 revision 不變，未被 C 覆蓋。 |
| revision 衝突 | 對上述舊 revision 按儲存得到預期 409；畫面保留 A，資料庫保留 C，不強制覆寫。 |
| 過期 Prompt | 開啟乾淨草稿的 Prompt，模擬另一來源更新與工作台重讀後，舊範本隱藏、複製停用並顯示重新產生提示。 |
| Git 停用提示 | web 模式明確說明桌面安全儲存／唯讀限制，並列出 stage、commit、分支操作也需配對及在線審批；沒有放寬原授權條件。 |
| 窄螢幕 | 375px 下工具列換行，對話框無水平溢出；完成後恢復 desktop viewport。 |

## Git 本機恢復互動驗證

使用 `scripts/git-recovery-preview.ts` 與 **Git recovery isolated preview**：新建隔離資料庫、真實本機 API／journal、測試用安全儲存與本機 SQL Relay；Git 引擎為可計數的模擬實作，不執行真正 Git 命令。真實 Git 引擎的既有測試仍納入上方全套回歸。

| 案例 | 結果 |
| --- | --- |
| 已配對但同步停用 | `unknown`／`partial` 恢復按鈕均可用；一般 prepared 請求的取消仍停用。 |
| 重新讀取後確認 | 先取得新鮮狀態；未勾選時確認按鈕停用，勾選後才可確認。 |
| 取消恢復視窗 | 不呼叫恢復、不執行 Git；重新開啟時重新讀取，勾選狀態重設。 |
| `unknown` 恢復 | 記錄 `fenceAcknowledged=true`，原狀態維持 `unknown`，不再顯示同筆恢復按鈕。 |
| 模擬儲存庫讀取失敗 | 顯示具體錯誤，不開啟確認視窗，也不增加恢復或執行次數。 |
| 已解除配對／null profile | `partial` 仍可讀取、勾選與確認；原狀態維持 `partial`，普通請求不因恢復而獲得權限。 |
| 最終計數 | **恢復 2 次、Git 執行 0 次**。兩筆紀錄原狀態不變，恢復按鈕均移除；沒有未知錯誤或伺服器錯誤。 |

此輪故意注入一次讀取失敗，Network／Console 的對應 HTTP 400 是預期測試結果。驗證後已恢復 desktop viewport 並停止隔離預覽。

## Windows 桌面打包（2026-10-23）

- 產物位於 `release/local-fixes-20261023-0218/`，含 portable 與 NSIS Setup x64；保留 0.6.0 來源版本，檔名附 `local-fixes-20261023`，沒有覆寫舊發行目錄。
- `npm run build:desktop` 與 electron-builder 成功，明確使用 `--publish never`。
- 已核對包內記憶格式、恢復入口、前端 JS、main bundle 與原生 Git helper；封裝內容與建置 staging 相符。
- 新 portable wrapper 冒煙測試 **4 項檢查通過**，驗證解壓／啟動、隔離資料、雙語持續性、系統匣／第二實例恢復與真正退出。報告：`.local/portable-smoke-mTohgk/report.json`。
- 新 win-unpacked 桌面程式的 Git 冒煙測試 **9 項檢查通過**：沙盒／安全儲存、群組授權、無批准不執行、原機單次暫存、重播／過期狀態拒絕、包內 native helper／pre-push guard、真實 staged diff、正常退出。報告：`.local/git-desktop-smoke-dfDITv/report.json`。
- 測試使用新建的 `.local` 資料庫／Git 儲存庫及本機 PGlite SQL Relay；沒有使用正式 App 資料庫、安裝／更新現有 App，亦未執行 Setup。
- 發行檔旁附 `SHA256SUMS.txt`、`BUILD-INFO.json` 與 `README-LOCAL-BUILD.txt`。SHA-256 在冒煙測試後再次核對通過。

## 驗證範圍與限制

- 預覽環境的 Clipboard API 拒絕寫入。UI 顯示寫入權限錯誤，完整 Prompt 可檢視；**未據此宣稱原生 Electron 剪貼簿成功**。
- 版本衝突測試刻意產生一筆 409，不是無預期的應用錯誤。
- 已產生上述獨立桌面打包檔，但沒有執行 Setup 或更新現有安裝；原有 App 與正式資料庫保持原狀。
- 沒有部署 Supabase、驗證真實帳號的 HTTPS/GCM、對外 push 或進行跨實體設備測試。
- Git 本機恢復入口已完成授權範圍內的修正與測試；**一般 Git 執行、取消及審批規則不變**。本機恢復只確認封鎖，不授權其他操作，也不宣告原操作成功。
