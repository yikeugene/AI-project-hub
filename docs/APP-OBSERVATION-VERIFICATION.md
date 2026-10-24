# v0.8 前景應用程式分享驗證

日期：2026-10-24。功能分支：`feat/current-app-sharing`。以下記錄功能開發階段，當時沒有部署 Supabase、讀取正式工作區或提交／發布；正式 v0.8.0 的重新打包與發布驗證另見 [版本說明](RELEASE-0.8.0.md)。

## 已完成的驗證

### 程式、儲存與傳輸

`npm run verify` 通過 **43 個測試檔、770 個測試**，包括型別檢查及前端 production build。原本的 Git 審批、裝置分享、工作區、記憶匯入、語言及桌面生命週期測試保留。

新功能驗證包含：
- 舊 HelpTool 活動同意及未確認預覽都不會啟動採集；新同意獨立、預設關閉。
- SQLite v1–v5 升級至 v6，不改寫既有資料；新表只保存同意／修訂版／序號／待撤回 metadata。
- 兩個真實本機 HTTP runtime、嚴格 profile header、桌面 key／Origin／mutation token、同意 digest 與修訂版檢查。
- 實際 PGlite 執行新增 SQL；同群組授權、撤銷清除、禁止欄位、Unicode／日期／byte 限制、單調序號、精確重試及撤回。
- 既有 SQL 函式定義／owner／ACL 完全不變；舊後端缺少新 RPC 只影響新通道。
- 跨群組採集合併、管理選擇不改同意、新同意不使用舊樣本、未知值清除名稱、重新啟動不重播正向資料。
- 暫停、撤回、鎖屏／睡眠、憑證失效及退出的取消／晚回應防護。
- 本機資料庫／outbox／事件紀錄沒有觀察到的應用名稱；測試使用獨有的假名稱檢查所有本機資料表。

邊界檢查另重現並修正：憑證可用性在採集中途消失時，不能把晚回應留在共用快取，再於恢復後重送；明確重新整理也不能只等待一個已失效的舊請求而漏掉新同意的採集。兩個 regression tests 先失敗，再經修正後通過。

### Windows 原生採集

`node --import tsx scripts/foreground-app-smoke.mjs --interactive` 已通過：
- 以實際 .NET 編譯器建立獨立 production helper。
- 2,194 個 shared／native Unicode 名稱驗證案例。
- 使用與 production 相同的原生觀察程式碼，在我們建立的受控 WinForms 視窗上讀到 `HubForegroundFixture` 與 UTC 時間。
- 確認輸出僅有 name／observedAt，沒有測試視窗標題、PID 或完整路徑；無效的受限 HWND 會清除名稱。

自動背景執行最初未獲 Windows 前景焦點，明確回報 `UNPROVEN`，沒有當成成功。經使用者同意並點擊測試視窗後，互動原生檢查成功。測試先核對 HWND 屬於測試視窗，再查詢該程序；即使焦點切換，也不讀取開發者的其他應用名稱。

此項是 **受控原生程式碼／視窗證據**，不是所有 Windows 軟體、實體鎖屏／睡眠或兩台實體電腦的完整證明。

### 介面

使用 `Current app isolated preview`（僅本機 4323、獨立 `.local` 資料、固定測試名稱、實際本機 API／SQL）：
- 「最後回報使用中的應用程式」可顯示 Visual Studio Code，與「HelpTool 自身背景／系統匣」分開。
- 無法取得時清除舊名稱；來源時間過期，即使 relay 接收時間很新也顯示目前未知。
- 預覽及未確認草稿不增加採集次數；確認關閉後，手動同步仍不採集，接收端顯示撤回。
- 英文／繁體中文 catalog 與元件測試通過；原有分享 policy／wire 未改動。

預覽中的程式名稱是受控測試資料，不是開發者的實際程式。跨 localhost／127.0.0.1 的測試導航曾被同來源防護拒絕；改為同來源導航後繼續，沒有放寬該防護。

## 打包驗證的證據邊界

Windows 0.8.0 免安裝版及 NSIS 安裝包在 `release/current-app-verification/` 產生，使用 `--publish never`。獨立 helper 放於 `resources/app-observation/foreground-app.exe`，不在 ASAR 內，也不依賴系統 Node 或 Git 安裝。

已通過：
- 新增 app-observation 打包流程 **7 個檢查點**：真實兩個 sandboxed Electron、真實 DPAPI、預設／預覽零啟動、儲存同意與受控解鎖、實際 SQL 與接收端 UI、較高序號撤回、正常退出。原生 helper 的程序輸出在這一層被明確替代為測試名稱，真實 OS 讀取由上面的獨立原生檢查證明。
- 既有桌面回歸 **40 個檢查點**，沒有跳過，包括語言、原生 bridge、視窗／系統匣生命週期、草稿保護、Markdown 匯入、共享工作區及設定。
- 既有打包 Git 回歸 **9 個檢查點**，使用真正 Git supervisor／pre-push guard 與隔離儲存庫；沒有 remote push。
- 免安裝版 **5 個檢查組**：解壓、版本／隔離資料、語言／系統匣／重啟／退出，以及實際解壓後 helper 可用且應用分享仍預設關閉。

新 smoke 的靜態安全檢查一開始因 esbuild 將參數 `options` 改名為 `options2` 而拒絕執行，尚未進入配對或同意；檢查已改為驗證同一個實際參數與動態 spawn 呼叫的綁定，沒有移除安全門檻，重跑通過。

`scripts/app-observation-desktop-smoke.mjs` 的目的，是以受控的子程序輸出驗證 **真正打包程式的同意 → 採集 adapter → SQL → 接收端／UI**。它不宣稱重新執行真實 OS 採集：
- 先驗證指定的新 package 與 helper 存在／時間戳，以及 main.cjs 的動態 spawn 邊界。
- 只替代該 package 精確 helper 路徑的輸出，固定回傳測試名稱；其他程序保持真實。
- 若看到舊的 captured-spawn package，會在配對／同意前拒絕，不冒險採集任意前景程式。
- 此受控輸出測試與上面的真實原生視窗測試是互補證據，不能混稱。

## 尚未執行

- 使用者真實 Supabase 的遷移、HTTP gateway／schema cache 與兩台實體電腦互通。
- 真實多連線 PostgreSQL 的競爭條件；PGlite 是單一連線的本機 SQL 驗證。
- 所有受保護／UWP／特殊桌面軟體名稱；部分情況應顯示不可取得，而非猜測。
- 實體鎖定／睡眠／喚醒全流程；目前以真實 desktop main 的受控事件測試取消與恢復。
- NSIS 安裝／解除安裝及完整更新安裝流程。

建置仍有既有大 chunk 與 Git 開發路徑的 CJS `import.meta` 警告；本次不以修改警告門檻掩蓋它們。正式啟用需先閱讀 [設定與隱私限制](APP-OBSERVATION.md)，由後端管理者套用新增 SQL，再由來源設備明確勾選及確認。
