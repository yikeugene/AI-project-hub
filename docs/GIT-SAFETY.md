# Git 安全、審批與恢復

本文件說明目前原始碼的受控 Git 功能與限制。它不是既有 v0.3.0 下載資產已包含功能的宣告，也不代表已替使用者部署 Supabase、發布新版或驗證真實跨電腦環境。一般專案規劃、任務、記憶與唯讀 Git 不需要雲端；**Git 變更必須經升級後的 v2 relay 與原機確認**。

## 先建立正確的信任關係

- 使用 Windows 桌面版、已配對且仍有效的設備憑證，以及 v2 `GovernanceRelay`。Web 開發模式、離線快取、舊 relay 或缺少 capability 都不是免審批的後門。
- 由資料庫管理者依序手動套用 `supabase/migrations/202610190001_desktop_relay.sql` 與 `supabase/migrations/202610200001_device_git_approval.sql`。已有 v1 時只套用第二份，不重跑或修改第一份。App 不會自動部署 SQL。
- 新群組由私有 `hub_private.bootstrap('My devices')` 建立第一個帶 `initial_admin` 旗標的邀請。既有群組的第一位管理員必須由可信 SQL Editor 執行 `hub_private.designate_initial_admin('<network-uuid>'::uuid, '<active-device-uuid>'::uuid)`；不按名稱或配對先後自動升權。
- 一般邀請與重新配對都只產生 member。有效 admin 才能管理角色／撤銷設備或決定分派給自己的 Git 申請；不能移除最後一位有效 admin。舊版 `hub_revoke` 也受相同授權限制。
- 只在 App 填入公開 publishable／anon key。不要輸入 service-role／secret key，不要把 `hub_private` 暴露給 Data API 或授予用戶端私有 helper/table 權限。

完整 SQL 操作、RPC mapping 與雲端限制見 [MULTI-DEVICE.md](MULTI-DEVICE.md)。

## 每一次操作都要走完三個明確動作

### 1. 原機預覽與送出

在本機查看 diff，選擇一個支援的動作並建立預覽。預覽固定操作參數、儲存庫相關狀態與 digest；它不是可以後續修改內容的任意指令工作單。

送出前確認會分享的摘要，再選擇指定管理員。申請綁定 network、原設備、reviewer、digest、摘要及期限，最長 24 小時。更換路徑、訊息、目標或 reviewer 需建立新申請，不能覆寫已送出或已批准的內容。

### 2. 指定管理員審批

只有**被指定且目前仍有效的 admin** 可批准或拒絕。其他 admin 不能代替指定 reviewer；member 不能審批或自行升權。

管理員可以審批自己電腦提出的申請，但仍須完成正式、留下紀錄的批准動作。沒有「管理員直接執行」、永久批准全部、從普通訊息的已讀／接受推導批准等捷徑。

**批准不等於執行。** 背景同步只傳遞申請、決定及結果；收到批准、重新連線、恢復視窗或從睡眠恢復都不會自動啟動 Git。

### 3. 原電腦另行確認執行

回到提出申請的電腦，明確確認執行。Hub 取得儲存庫執行協調、重新核對新鮮狀態，並在寫入前線上呼叫一次性 `consumeGit`。不能把本機 SQLite 的 approved 欄位或快取的 admin 角色當作授權。

伺服器在 network policy lock 與 request row lock 內確認：

- 呼叫者仍是有效的原設備，network 與 request 相符。
- 決定仍為 approved，digest 相符，未取消、未過期、未被其他 execution attempt 消耗。
- 指定批准者仍是有效 admin，批准時的 epoch 與目前伺服器權限 epoch 相符。

這是授權排序點。之後發生的撤權不能追溯取消已准入的操作；安全邊界不是「按下撤銷立刻殺死別台電腦的一切工作」。如果核對失敗，停止並重新檢視，不離線猜測授權、不改用未審批路徑。

## 可用動作與禁止事項

下表是操作白名單，不保證每個 Git 版本、儲存庫設定或遠端都符合執行條件。不支援時顯示原因並維持唯讀，不為了讓按鈕成功而放寬安全限制。

| 操作 | 邊界 |
| --- | --- |
| 選定路徑暫存 | 只處理本次預覽的 literal paths；不隱式 add-all，不因檔名含空白／特殊符號而變成命令。 |
| 選定路徑取消暫存 | 只變更選定 index entries；不是丟棄或覆寫工作檔案。 |
| Commit | 固定本次審閱的 index、訊息、作者與 parent；不自動暫存、不 amend、不改寫既有歷史。 |
| 新建分支 | 固定起點，要求新 ref 不存在；不覆蓋同名分支。 |
| 切換分支 | 需符合乾淨工作目錄／index 與其他安全條件；不以 force checkout 覆蓋未提交內容。 |
| Fetch | 單一明確 HTTPS endpoint／branch 的受控擷取；不是自動背景 fetch，不 force／prune 或覆寫 tags。 |
| Pull | 僅接受已檢視並固定的目標，做 fast-forward-only；不 merge commit、rebase、autostash 或自動解衝突。 |
| Push | 只推本次批准的確切 commit 到單一分支 ref，做一般非強制 push；遠端狀態不符則拒絕，不自動改用 force-with-lease。 |

**需要先 fetch 才能 pull 時，是兩次可見的審批。** 先預覽／批准／確認 fetch，再檢視取得的固定目標，重新申請 fast-forward pull；不能把尚未抓到、尚未審閱的新內容藏在同一次 pull 批准裡。

不提供強推、`--force-with-lease`、hard reset、clean、restore/discard 工作檔案、刪除分支、amend、歷史重寫、自動 stash 或自動解衝突，也不接受任意 command／shell／argv／cwd。審批文字與 commit 訊息不是可執行腳本。

## Repository 與網路執行界線

- 讀取與寫入是分開的受限路徑；不因新增寫入功能而放寬全部 Git 觀測。背景觀測不執行 fetch、stage、commit 或 checkout。
- 使用受信任的 Git executable、固定參數、非 shell 執行、受控環境及時間／輸出限制。Repository 提供的 hooks、fsmonitor、external diff／textconv、任意 credential／SSH／remote helper 不能藉此啟動程式。受控 push 可使用隨 App 提供的可信檢查器，不接受 repository 指定的替代品。
- 首版遠端操作只支援標準 **HTTPS**，驗證憑證、拒絕 redirect，透過可信安裝位置的 **Git Credential Manager／作業系統安全儲存** 使用非互動認證。需要互動登入時，先在可信工具完成設定後重新預覽；不在 Hub 保存／上傳認證，也不將 raw stderr 當作遠端結果分享。
- SSH、自訂 helper、含帳密 URL、任意 URL rewrite／proxy command 等不支援；不能靜默回退到較不安全的 helper。
- 需要自訂 hooks、簽章、clean／smudge／process filters、Git LFS、submodule、sparse checkout／split index、shallow／partial clone 等尚未支援條件的寫入會拒絕。這不是要求使用者刪除這些保護或偷偷略過它們；可保留唯讀檢視，改用符合該專案規範的外部工具。
- 依 canonical Git common directory 協調同一 repository（包含 linked worktrees）並尊重 Git 原生鎖。已有 lock 視為忙碌，不刪除他人的鎖。檔案、index、HEAD／refs、設定或 remote 狀態改變時，舊預覽可能失效。
- Hub 的協調不能鎖住所有編輯器、終端機或其他 Git 程式，也不宣稱能阻止同一 OS 使用者直接執行外部 Git。確認到實際操作之間仍須依 Git 原生非覆寫／expected-old 檢查；有競爭就如實停止或報告結果不明，而不是強制修復。

## 會傳出什麼？

一般成員只看到自己明確分享的白名單專案／狀態資料；審批 request 僅供 origin 與指定 reviewer 取得，不因某設備是 admin 就能瀏覽所有人的單次申請。具有資料庫管理權限的人仍可讀取雲端私有紀錄。

Git 審批會明確預覽必要中繼資料，包括：

- 專案名稱、動作種類、相對檔名、分支、HEAD／目標 OID、remote URL／target ref。
- 變更／暫存計數；該操作相關的 commit 訊息與作者名稱／email。
- Request ID、origin／reviewer 設備身分、digest、期限，以及後續決定／安全結果狀態。

**不會自動上傳原始碼、檔案內容、diff／patch、本機絕對根路徑、任意指令或憑證。** 本機 diff 留在本機。Digest 是操作綁定，不是對摘要的加密；相對檔名、訊息、作者與遠端名稱也可能透露機密，送出前仍須審閱。不要在可編輯文字欄位自行貼入不想分享的秘密。

傳輸使用 HTTPS／TLS，**不是端對端加密**。Supabase 管理方可以讀取已提交資料；撤回／撤銷不是遠端抹除，也無法收回已被閱讀、截圖、匯出或備份的副本。本機 SQLite 的一般資料列與 journal 也未加密；保護依賴作業系統權限與磁碟加密，設備憑證才另由安全儲存保護。

## 重試、未知結果與 repository 封鎖

目標是**每份批准至多啟動一次受控執行**，不是跨 SQLite、Git 與 relay 的 exactly-once transaction 承諾。

- 確認執行前先持久化 execution attempt；實際開始前留下執行紀錄。
- 第一次消耗綁定不可變 nonce。相同 nonce 的 retry 只回傳 `replayed: true` 歷史收據，不能再次啟動 child process；另一個 nonce 不得覆用同一批准。
- 允許重送不可變的結果回報，不允許自動重跑 Git 副作用。回報可以晚於批准 expiry，但呼叫者必須仍是有效 origin；不能改寫已記錄的結果。
- Timeout、程式中斷、consume 回應遺失，或遠端 push 回覆遺失，都可能無法證明副作用是否已發生。不能僅因 HTTP 失敗就宣稱「完全沒有改動」。

| 狀態 | 下一步 |
| --- | --- |
| `rejected`／`cancelled`／`expired` | 不執行；需要時重新預覽並建立新申請。 |
| `stale` | 儲存庫與計劃不符；重新讀取 diff／refs 後重新申請，不原地更新已批准計劃。 |
| `succeeded` | 檢視新的 Git 觀測；結果上傳如需重試，不代表再執行 Git。 |
| `failed` | 看安全錯誤與最新觀測；不要把所有失敗都當作無副作用，結果不確定應使用下兩種狀態。 |
| `partial`／`unknown` | 同一 repository 的後續 Hub 寫入被封鎖，直到明確的本機核對／恢復確認。 |

恢復時先看 journal 與新鮮的唯讀觀測，核對 HEAD、index、工作檔案，以及遠端操作相關的遠端 ref。需要時使用你信任的外部唯讀工具協助確認。只有了解目前狀態後才明確確認解除封鎖，之後仍須重新預覽／申請新的操作。確認解除封鎖**不會重跑舊操作、不會回滾，也不是證明遠端一定成功**。

不要刪除 SQLite journal、換 nonce、反覆按執行或重新配對來繞過不確定結果。部分／未知結果的保護不能因移除本機專案或變更連線就自動消失。若介面無法完成恢復，保留資料並回報已遮蔽的重現步驟，不直接編輯資料庫來解除安全限制。

## 背景與其他電腦狀態不是自動執行

有可用系統匣時，X 隱藏視窗、保留草稿與 backend 同步；系統匣可恢復或完全退出。只有在建立系統匣成功時才採此隱藏方式。明確退出／更新仍需處理未儲存工作並等待受控執行結束；沒有登入自啟或 Windows service。

休眠、關機、完全退出或網路中斷都限制可用性，Hub 不阻止睡眠。恢復後可重新同步，但不會因此自動執行已批准申請。過期狀態與「最後成功同步」不能當作另一台電腦目前在線的證明。

App 活動、Git 摘要與手動任務計數全部另行 opt-in、預設關閉；不監控 CPU／記憶體或其他 App。手動 `doing` 任務不代表真的有程式在執行。取消基本專案分享會清除其可選狀態政策及已觀察的附加快取，重新分享不自動復活舊內容，詳見 [多設備隱私與撤回](MULTI-DEVICE.md#可選裝置狀態背景與撤回)。

## 資料庫升級與備份

目前本機 SQLite schema 為 **v5**，保存 approval／execution journal 與 governance 狀態。舊版 App 不能開啟升級後的資料庫，沒有自動降版；這與雲端 v1／v2 RPC 的相容安排不同。

備份前從系統匣完全退出 Hub，停止 web-mode 程序，等待受控工作及關閉流程完成，再複製整個資料目錄（包含必要 WAL／其他相關檔案），不要只複製使用中的 `hub.sqlite`。不要讓不同版本操作同一份資料庫。若要回退，只能以相容舊版的升級前備份使用另一資料目錄，不能把新版 journal 留在原檔再強行降低 schema version。

<a id="verification-scope"></a>

## 驗證範圍

本次文件更新時，針對性的 adapter／真 SQL 與本機整合測試已通過；完整新測試套件、原生打包／系統匣與瀏覽器檢查仍須以最終候選建置的實際結果為準。本文件不以 UI 有按鈕或舊版 smoke 成功代替安全機制驗證。

已執行的 relay 指令：

```sh
npm exec -- vitest run tests/supabase-relay.test.ts tests/relay-sql.test.ts tests/governance-relay.test.ts tests/governance-sql.test.ts
npm run typecheck
```

四份 relay／SQL 測試共 **58 tests 通過**。使用實際遷移與 PostgreSQL ACL／RLS／SECURITY DEFINER 的 PGlite fixture，不接觸 live Supabase。v1 封存相容測試與 v2 角色／舊 RPC 加固測試分開；涵蓋跨群組、member／reviewer、epoch／expiry、replay、immutable 結果、bootstrap／last-admin、legacy revoke、狀態分享 ownership／撤回／不復活與 byte limits。另有以隔離資料／可控引擎驗證的本機審批、durable journal 與狀態整合測試；這些不等於真 Git 子程序或 Windows 系統匣驗證。

發行前至少另外執行並記錄：

```sh
npm run verify
npm run pack:desktop
npm run test:desktop
```

另外使用隔離儲存庫與 UI fixtures，實際核對雙裝置申請／審批／原機確認、Git 原生競爭與中斷、背景收發、草稿、系統匣恢復、明確退出／更新與睡眠恢復。Fixtures 建立成功不是 UI 測試通過；瀏覽器預覽也不能驗證 Electron 原生行為。

**尚未驗證：** live Supabase SQL Editor／PostgREST／gateway／真實 TLS 與配額、真正多連線 PostgreSQL approve／revoke／consume 競爭、兩台實體 Windows 電腦及其 safeStorage／網路恢復。PGlite 的單一連線不能代替這些驗證；沒有可用 disposable PostgreSQL 工具時不得宣稱已跑競爭測試。這次變更沒有自動部署 SQL 或發布 release。
