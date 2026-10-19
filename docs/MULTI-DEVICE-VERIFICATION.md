# v0.3.0 桌面多設備驗證

日期：2026-10-19。所有驗證使用隔離測試資料；沒有連線到使用者的真實 Supabase、沒有部署 SQL、沒有上傳正式專案資料。

## 環境

- Windows 11 x64；開發 Node 24.19.0。
- 實際打包程式：Electron 44.9.0、內嵌 Node 24.22.0、SQLite 3.53.4。
- 本機資料庫版本：schema v2；v1 升級不重寫原有專案／任務／設定。
- `@electric-sql/pglite` 0.5.10 僅作開發測試依賴，不包含在正式 App。

## 已通過

### 自動測試及建置

`npm run verify`：16 個測試檔、236 個測試通過，TypeScript 型別檢查及 Vite production build 通過。

測試包含：
- 既有專案、Git、安全邊界、AI 交接與 revision 回歸。
- v0/v1 → v2、重開、失敗回滾及較新資料庫版本拒絕。
- 實際交付 SQL 的角色／表權限、SECURITY DEFINER、配對碼原子消耗、撤銷、跨群組拒絕、訊息 hash／去重、收據歸屬及摘要 tombstone。
- 兩份隔離 SQLite store 經實際 SQL relay 的配對、opt-in 摘要、離線 outbox／重啟、回應遺失重送、本機接受／拒絕及結果回覆。
- 兩個真實 loopback HTTP runtime 的 desktop key、Origin、mutation token、遠端唯讀 API、本機確認及關閉時 abort／drain。
- 套用後的專案修改、訊息決定及結果 outbox 原子提交；故障注入確認失敗全部回滾。
- 憑證解密失敗仍可使用本機功能；停用時零雲端連線。

SQL 的時間可能從 `Z` 正規化為 `+00:00`；測試曾抓到收據被誤判的問題，已改為比較時間點而非字串拼法。

額外邊界檢查找出的問題已修正並加入回歸測試：
- 先前一次 publish 等待期間，另一個專案被取消分享、取消記憶欄位或刪除：發送前重新讀取最新政策／版本，不發送已捕獲的舊內容。
- 對方被撤銷不代表本機憑證失效：`HU401` 只表示呼叫者失效；`HU403` 表示資料／其他設備不可存取，不會誤撤銷接收端。
- 後續編輯造成過大摘要時，保留可修改的政策與錯誤提示、撤下該專案的舊待送內容，其他專案、訊息與收據繼續同步；單一永久發佈錯誤也不阻塞其他工作。
- 解除配對以 transaction 清空加密憑證及 pending pairing 秘密，但保留非秘密歷史；沒有宣稱撤銷雲端或抹除備份。

Windows 暫存 Git 測試目錄曾出現 `EBUSY` 清理錯誤；已為測試清理加入最多 5 次、50ms 遞增等待的重試，讓剛結束的子程序釋放目錄 handle。沒有停用測試、放寬執行時間／輸出限制斷言或跳過 Git 測試。

### 真正 Windows 打包版

`npm run pack:desktop` 與 `npm run dist:desktop` 建置成功。最終實際執行 `node scripts/desktop-smoke.mjs --allow-unavailable-clipboard`，報告為 **`result: passed`、21 個檢查點、`skippedChecks: []`**，包括精確比對當次專案的剪貼簿內容；備用略過分支沒有啟用。隨後 `node scripts/portable-smoke.mjs` 也通過，確認實際 v0.3.0 免安裝 exe 的解壓／啟動、版本、隔離資料、session key 及正常關閉。桌面驗證涵蓋：
- 實際內嵌 SQLite 可用、renderer sandbox／context isolation 保持啟用。
- 沒有 desktop key 的一般本機客戶端無法讀取 API 或資源。
- 多設備預設停用；本機命名可持久化；新舊設定表單不巢狀且保護草稿。
- 原生選資料夾、另存、handoff 預覽失效／確認及取消關閉保護仍可用。
- 真實 OS safeStorage 的測試憑證加解密，以及打包程式重啟後的解密通過；不是僅使用單元測試假 codec。
- 同名設備、同一 project UUID 的遠端資料不會變成本機專案或取得編輯／啟動工具按鈕。
- 提案作成只送出選定欄位與固定 baseRevision，不當成直接執行。
- 離線可預覽、拒絕及標記已讀；不能離線接受；本機專案沒有被這些操作改動。
- 分享預覽來自真實本機 API，不包含路徑、Git 或未選記憶。
- 真正桌面介面中，後續編輯產生過大摘要仍可讀取政策、取消勾選、預覽並確認停止分享。
- 沒有 renderer page errors。

**剪貼簿測試歷程：** 嚴格 `npm run test:desktop` 中途數次讀回空字串或上一輪內容。已確認目前 Electron 的 `clipboard.writeText()` 是非同步 API，正式 IPC 現在會等待它完成，測試也等待 UI 成功狀態並精確比對當次完整內容，不再只比對共通標題。中途獨立直接 OS write/read 探測也曾失敗，因此不把原因完全歸咎於 UI；此環境出現過波動。最終完整 smoke 的剪貼簿精確比對已成功，沒有使用略過或替代內容。

補充模式 `node scripts/desktop-smoke.mjs --allow-unavailable-clipboard` 只有在直接 OS 探測同樣失敗時，才把這一項寫入 `skippedChecks`，改用真實畫面中的 handoff 預覽繼續測試其他功能，不 mock 剪貼簿、不把它列為成功。預設嚴格模式仍會失敗，不會偷偷跳過。報告使用 `passed-with-environment-limitations` 明確區分。

### 本機預覽

使用既有隔離 verification profile，不是產品網站：
- 檢查設備導覽、唯讀摘要、收件匣、前後差異與離線接受禁用。
- 1280×900 與 760×900 桌面尺寸；760px 無頁面水平溢出。
- Browser console、server errors 與 failed network requests 均無異常。
- 驗證後恢復預設 viewport 並停止預覽服務。

## 不代表已完成的項目

以上 PGlite 及注入 HTTP adapter 是真 SQL／實際本機程式測試，**不是 Supabase 雲端部署驗證**。尚未測試：
- 使用者 Supabase 專案中的角色建立權限、gateway／publishable key、PostgREST schema cache／實際網路及供應商配額。
- 多個獨立 PostgreSQL 連線的真實競爭條件。
- 兩台實體 Windows 電腦透過網際網路配對／斷線恢復；跨 Windows 帳戶的 DPAPI 憑證搬遷不受支援。

正式使用前按 [多設備設定](MULTI-DEVICE.md) 建立自己的後端並進行兩台電腦的 live 驗證。未設定時仍然是本機工具；首版不宣稱端對端加密，也沒有手機、網站前台或關閉視窗後的常駐接收服務。
