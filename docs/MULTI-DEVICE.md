# 桌面多設備與 Supabase relay

## 使用範圍與隱私

這是 **Windows 桌面 App 的可選功能，不是網站或手機版**。整合預設關閉；沒有雲端設定時，原有本機專案、SQLite、掃描及編輯功能仍可使用。交付程式與 SQL 不會替你建立 Supabase 帳號、購買方案、部署網站、建立雲端專案或上傳現有資料。

每台電腦保有自己的權威資料。其他設備只能查看你明確分享的白名單摘要、傳送文字訊息、提出 `nextAction`／部分記憶欄位的變更請求，或審閱明確提交給指定管理員的單次 Git 操作摘要。記憶變更須由資料所屬電腦預覽並確認；Git 另走「管理員批准 → 原機再次確認 → 線上一次性授權」流程。任何訊息、批准或背景同步都不會自行啟動 Git，也沒有任意 shell／argv／cwd、遠端終端機或整份 workspace／SQLite 同步。

本文描述目前原始碼的 v2 升級，不表示既有 v0.3.0 發行資產已重新建置，也不代表 SQL 已部署到你的雲端。Git 操作界線與結果不明的處理另見 [GIT-SAFETY.md](GIT-SAFETY.md)。

- 傳輸使用 HTTPS/TLS 與可撤銷設備憑證，**不是端對端加密**。Supabase、雲端管理方及具有資料庫管理權限的人可讀取已分享摘要、審批摘要、訊息及設備資訊。
- 預設不分享專案。啟用某專案後，所有有效配對設備都可讀取其選取欄位；記憶欄位必須另行勾選。活動、Git 摘要及手動任務計數是**另外的 opt-in**，不因既有專案已分享就自動開啟。
- 一般自動摘要不包含專案絕對路徑、原始碼、patch、commit 訊息或憑證。但單次 Git 審批會明確預覽並傳出相對檔名、分支／ref、remote URL、commit 訊息與作者等必要中繼資料給指定審批者；diff／檔案內容與本機根路徑不屬於雲端 DTO。文字仍可能敏感；不要自行把秘密或原始碼貼入訊息、記憶欄位或審批文字。
- 撤回分享會發佈 tombstone；每次真正開始發送摘要前會重新核對目前的分享欄位及專案是否存在，避免把較早排隊的內容送出。已開始的網路請求可能已送達，不能追溯取消。撤銷設備會停止其後的授權，但不能保證從對方既有快取、匯出或備份中抹除已讀資料。
- 若之後的本機編輯讓選定摘要超過 256 KiB，該專案會排程撤下舊摘要，不再送出舊排隊內容；其他專案與訊息繼續同步。分享政策仍可讀取，可減少欄位或取消分享，修正內容後可恢復發佈。
- 角色為 **admin／member**，由伺服器按 token 決定，不信任客戶端宣稱。一般有效成員可發普通邀請，但新設備只成為 member。只有有效 admin 可授予／撤回管理員角色、撤銷設備或決定分派給自己的 Git 申請；禁止移除最後一位有效 admin。舊版 `hub_revoke` 也套用 admin-only 規則，不能用舊客戶端繞過。
- 系統匣可用時，**關閉視窗只會隱藏，runtime 仍可同步**；系統匣可恢復視窗或完全退出。沒有登入自啟或 Windows service。完全退出、休眠／關機後不輪詢或開始新工作，也不阻止睡眠；離線期間不能替另一台電腦回報即時狀態。

## 手動設定自己的 Supabase 專案

以下都是由使用者自行在 Supabase 執行的管理操作；本機測試不會執行這些雲端步驟。建議使用專屬 HelpTool 的專案。

### 1. 確認資料庫管理權限

使用 Supabase Dashboard 的 SQL Editor，以管理角色 `postgres` 執行遷移。需要：

- 建立 `NOLOGIN` 角色、授予該角色給 `postgres`，以及 `SET ROLE` 的權限。
- 建立 schema，以及在 `public` schema 建立函式、授予／收回自建角色的 `CREATE` 權限。
- 專案具有 Supabase 標準 `anon` 與 `authenticated` 角色；Data API 已啟用並暴露 `public` schema。
- PostgreSQL 提供內建 `sha256(bytea)` 與 `gen_random_uuid()`；不需要 `pgcrypto` extension。

如果組織限制上述操作，請由資料庫管理員先核准或執行。**不要**改成對 `PUBLIC`／`anon` 開放私有表，不要把 `hub_private` 加入 exposed schemas，也不要把 service key 放進 App 來繞過限制。

### 2. 依序執行兩份遷移，各執行一次

新專案在 SQL Editor 依序貼入並執行以下兩個完整檔案；已裝 v1 的專案只執行第二份。App 啟動、測試或安裝程式都**不會自動執行雲端遷移**。

```text
supabase/migrations/202610190001_desktop_relay.sql
supabase/migrations/202610200001_device_git_approval.sql
```

v1 遷移保留原樣，在單一 transaction 中建立：

- `hub_relay_owner`：專用 `NOLOGIN`、非 superuser、沒有 `BYPASSRLS` 的物件擁有者。
- `hub_private`：網路群組、設備憑證雜湊、邀請雜湊、不可變訊息及摘要表；全部開啟 RLS，沒有用戶端 policy、沒有 anon/authenticated 直接表權限。
- 14 個 `public.hub_*` RPC：`SECURITY DEFINER`、固定空 `search_path`、完整限定物件名稱，內部驗證設備授權。
- 私有驗證 helper 及管理用 bootstrap；沒有公開執行權限。

v2 是 additive 升級，新增角色／policy epoch、私有治理稽核、Git 審批與裝置狀態表，及 11 個獨立 `public.hub_v2_*` RPC。v1 payload／response 的 strict 形狀不變；但其驗證 helper、配對與撤銷實作會升級，所有驗證後操作先鎖定 network，再存取成員／資源，避免撤權與消耗授權使用不一致排序。新增表同樣開啟 RLS，helper／私有管理函式沒有公開權限。

管理角色 `postgres` 保留新角色的 membership，方便後續管理。建立 RPC 後會收回新角色對 `public` 的 `CREATE` 權限。腳本不撤銷其他應用的函式權限、不修改其他 schema 的 default privileges，也不建立廣泛的 table grants。

**這是一次性遷移，不是可重複重建腳本。** 同名角色、schema 或函式已存在時會失敗並回滾。請先檢查是否曾成功安裝，不要為了重跑而直接 `DROP ... CASCADE`。

### 3. 指定第一位管理員：新群組與既有群組不同

**新群組：** 先完成兩份遷移，再於同一 SQL Editor 執行 `supabase/bootstrap.sql`，或：

```sql
SELECT hub_private.bootstrap('My desktop devices');
```

回傳 `networkId`、`code`、`expiresAt`。每次呼叫建立一個**新群組**；配對碼為 64 位小寫十六進位，有效 15 分鐘，限新設備消耗一次。v2 私有 bootstrap 將該邀請標成 `initial_admin=true`，只有消耗這個邀請的設備成為第一位 admin。普通 `hub_invite` 永遠不設此旗標。請私下複製 code，勿貼入 issue、log 或螢幕截圖；它不是 App 的長期設備憑證。

**既有群組：** v2 不按設備名稱、配對先後或用戶端宣稱自動升權。既有設備與尚未消耗的舊邀請均保持 member；policy epoch 為 0，Git 授權停用，直到資料庫管理者明確選定第一位有效管理員。先私下核對正確的群組與有效設備 UUID，再執行（替換下列預留值）：

```sql
-- 僅限可信管理端／SQL Editor，不在桌面 App 執行。
SELECT id, name, role, revoked_at
FROM hub_private.devices
WHERE network_id = '<network-uuid>'::uuid;

SELECT hub_private.designate_initial_admin(
  '<network-uuid>'::uuid,
  '<active-device-uuid>'::uuid
);
```

`hub_private.designate_initial_admin(uuid, uuid)` 只接受尚未初始化（epoch 0、沒有有效 admin）的群組；成功後記錄稽核並設 epoch 1，不能作為之後任意升權的公開通道。之後由有效 admin 使用 App 的角色管理；勿授予 `anon`／`authenticated` 私有函式權限。重新配對的新 membership 不繼承舊設備的 admin 身分。

本機資料庫是另一路升級：v0.9.0 的 SQLite schema 為 **v7**，新增只在本機使用的小成果與事件歷史，不新增雲端遷移。v0.8.0 的 v6 新增前景 App 分享的同意／修訂／序號／待撤回 metadata，不保存程式名稱（v0.6／v0.7 使用 v5；v0.5 使用 v4；v0.4 使用 v3）。既有聚焦、收工、群組身分、共享政策、待送工作與 Git journals 保留；歷史群組不會重新啟用。升級前請完全退出並備份整個資料目錄，v0.8.0 及更舊 App 無法開啟 v7，回退須還原相容備份。本機升級不會自動部署雲端；多群組原功能沿用既有 relay，既有前景 App 通道仍須另行套用下方所述遷移。

### 4. 取得公開連線設定

從 Supabase 專案設定複製：

- **Project URL**：例如 `https://your-project-ref.supabase.co`。
- **Publishable key**：以 `sb_publishable_` 開頭；或舊版 JWT 格式、角色為 `anon` 的 anon key。

App 不接受 `sb_secret_...`、`service_role` JWT 或其他管理金鑰；它們不應離開管理環境。公開 key 不是設備身分，只用來通過 Supabase gateway；真正的設備授權使用獨立隨機憑證。

只接受官方 HTTPS `*.supabase.co` 的單一專案 host 與根 origin。自訂域名、本機 HTTP、額外 port、URL 帳密、路徑、query、fragment 都不接受；不跟隨重新導向。根目錄尾端 `/` 可省略。

### 5. 配對與分享

1. 在第一台桌面的設備／雲端設定輸入 URL、公開 key、設備名稱及 bootstrap code，閱讀隱私說明並確認。
2. App 先以 Electron `safeStorage` 加密持久化 pending attempt、設備 ID 及設備 token，才呼叫配對 RPC。加密不可用時拒絕保存，不退回明文。
3. 配對完成後，由任一有效配對設備產生下一個邀請，將公開設定與短效 code 私下交給另一台桌面。
4. 第二台配對後，逐項選擇要分享的專案及記憶欄位；遠端摘要獨立於本機專案並保持唯讀。
5. 訊息先存本機 outbox，App 開啟且連線可用時重試。接收端先存本機 inbox，再回覆 ACK；變更請求不會因收到訊息就改動本機資料。

設備名稱可以相同，識別依 UUID。**本機 installation UUID 與各群組的雲端 membership UUID 分開**：同一台裝置可同時加入多個群組（也可使用不同 relay endpoint），每組有獨立的設備 ID/token、配對重試、快取與 outbox。一般使用、重試及重啟保留原身分；明確解除該群組配對後重新加入會產生新的 membership，不恢復舊 token、分享政策或 outbox，也不會把舊訊息改送另一群組。

暫停同步會保留設備憑證供之後恢復。**解除本機配對會在 SQLite transaction 中清空該連線的加密憑證及待配對秘密，保留非秘密的歷史紀錄。** 這不等於撤銷雲端 membership，也不承諾抹除既有備份或 WAL 的歷史資料；要使舊憑證在雲端失效，請由另一台有效 admin 撤銷舊設備（不可撤銷最後一位有效 admin）。

## 共享工作區與多群組

以下功能自 v0.5.0 起提供。

- **加入及管理：** 在設定中保留既有群組，選擇加入另一群組；每組可設定只存在本機的名稱。群組可獨立同步、暫停及解除本機配對。群組 A 暫停、斷線或被撤銷，不會停止群組 B 的同步。
- **共享對象：** 選擇專案後，勾選要共享的一個或多個群組，各組保留自己的記憶欄位選擇。「全選」只選取該組的記憶欄位，不代表未來自動共享給所有群組。預覽列出每組的實際投影；確認前若專案版本、群組集合或政策改變，需要重新預覽。本機政策一起儲存，但各組的雲端傳送獨立重試，不宣稱雲端跨組原子提交。
- **集中查看：** 左側「共享工作區」預設顯示所有已加入群組，包含自己的共享與其他成員的摘要，支援群組篩選及搜尋。同一專案在不同群組分列，識別依本機 profile、擁有會員及專案 UUID，不把不同組的可見欄位合併。
- **唯讀與下載：** 只有共享的名稱、狀態、優先級、階段、下一步及選定記憶欄位。可下載附有來源與版本的 Markdown；不傳送專案實際檔案，不使用包含路徑／任務／Git 的本機 handoff，也不提供直接修改遠端摘要的編輯或提案入口。另存取消不視為下載成功。
- **本機 Markdown 匯入（v0.6.0 起提供）：** 可複製 AI 填寫指示與目前摘要模板，並選檔／貼上填好的 Markdown，預覽後匯入 UUID 對應的既有本機專案。只更新非空記憶與下一步，不建立專案、不清空空白欄位、不修改共享政策。現有共享欄位仍可能依既定政策同步；來源群組 ID 不是目標或授權證明。此流程沒有 AI API 或自動傳送，詳見 [Markdown 匯入與 Prompt](MARKDOWN-IMPORT.md)。
- **新舊資料：** 自己的尚未送出版本標為待同步；他人的內容標示發布及接收時間。離線／暫停時可以查看及下載最後有效快取，但無法知道尚未收到的遠端撤回。已知撤回、來源撤銷或本機解除配對後，不再顯示／匯出該資料。已經另存的 Markdown 無法收回。
- **操作範圍：** 目前管理群組決定裝置、訊息、治理及 Git 審批操作範圍；共享工作區篩選不會切換它。背景同步不改寫這個選取狀態。API 的群組操作要求 `X-Hub-Profile-Id`，舊畫面不能默默改用新群組的身分；A 的管理員不會替 B 授權。實體 repository 的未知執行結果保護仍在整台裝置生效，不能換群組繞過。

## 可選裝置狀態、背景與撤回

新狀態欄位全部預設關閉，須在 App 中預覽並選擇：

- **HelpTool 自身活動：** HelpTool 視窗的前景／背景、同步狀態、最後成功同步，以及 Hub 自己受控的 scan／sync／git 作業摘要。這個既有選項不會採集其他軟體名稱，沒有 CPU／記憶體或外部終端機工作監控。
- **目前使用中的應用程式（Windows，v0.8 新增）：** 另一個獨立、預設關閉的每群組同意。只讀取當下前景程序的名稱與觀察時間，不讀取視窗標題、文件、網址、輸入、完整路徑或程序清單。名稱不寫入本機資料庫／outbox／事件紀錄；本機只留有限記憶體快取，雲端只保留每設備一筆最新狀態。不是持續追蹤或使用歷史，受保護／無法識別的軟體會顯示不可取得，不會猜測名稱。需要另外套用 [前景應用程式分享遷移](APP-OBSERVATION.md)，原有 v2 功能不受缺少這個遷移影響。
- **已分享專案的 Git 摘要：** 分支、變更／暫存／衝突計數、觀察時間與是否無法觀測；不包含 diff、原始碼或本機根路徑。
- **手動任務計數：** `todo / doing / blocked / done`。它們來自使用者記錄的任務，不代表某個程序真的正在執行。

活動與每個專案的 Git／任務欄位分別 opt-in。專案必須已透過 v1 分享且屬於發佈設備，否則伺服器拒絕附加欄位；不可以用別人的 project ID 分享自己的未分享專案。基本專案取消分享時，來源端也清除該專案的可選狀態政策；重新分享須再次明確選擇，不會自動恢復舊 opt-in。接收端觀察到 v1 tombstone 時會持久地清除附加快取，避免稍後重新分享又顯示舊資料。

每台設備的狀態版本單調增加；同版本只接受**完全相同 UTF-8 JSON bytes** 的重試，重試不更新 `receivedAt`。`activity: null, projects: []` 是保留的撤回 tombstone，不會因內容為空而省略。發送前會重新建立當下投影，不盲目重播磁碟中的舊排隊欄位；若投影超過 8192 bytes，會排程撤下舊狀態而不是繼續分享過期內容。SQL 同時在 v1 取消分享時清除可見附加欄位；重試舊版本或只重新分享基本專案，都不會讓舊附加資料復活。

`receivedAt` 由 relay 收到資料時產生；快取載入時間不是「在線」證據。「最後看到裝置」與「最後成功同步」須分開理解。保留的舊狀態會過期，不宣稱能即時判斷另一台電腦是斷線、睡眠還是關機；撤銷後則不再向有效成員提供該設備的狀態。

有可用系統匣時，X 僅隱藏視窗並保留 renderer 草稿與 backend 輪詢；系統匣／再次啟動可恢復原視窗。明確退出或更新仍須處理未儲存草稿，並等待受控工作結束。系統匣建立失敗不允許留下無法恢復的隱藏視窗。備份、替換 executable 或停止所有同步時，請選擇**完全退出**，不要只按 X。

## 配對重試、撤銷及變更確認

- 雲端只存 32-byte 隨機 token 的 SHA-256，不存 token 明文；邀請 code 也只存 SHA-256。
- 配對以 row lock 原子消耗 code。回應遺失後，只允許完全相同 `attemptId + deviceId + token hash` 重試；已成功消耗的 code 即使之後過期也可恢復原回應，但設備已撤銷時永遠拒絕。
- 除配對外，每個 RPC 都重新驗證 token 與有效 membership；sender／network 從 token 推導，拒絕客戶端冒充 sender 或跨群組存取。
- 文字 proposal 的變更只允許 `nextAction` 與白名單 partial memory，接受前還要檢查本機 revision、分享政策與最新線上來源授權。離線或授權查詢失敗時不套用；它不是 Git 審批或 Git 執行入口。
- `checkProposal` 的有效來源檢查是授權排序點。之後才發生的並發撤銷不能追溯取消已授權的本機 transaction。
- 本機已完成的 `applied`／`rejected`／`read` 結果可能延後送達；`resolve` 只驗證有效接收端及結果不可變性，不因來源之後被撤銷或訊息過期而丟棄已完成結果。
- 雲端不自動將過期訊息寫成 terminal decision；過期會阻止新的套用／新訊息提交，但不能先覆蓋尚在重試的有效處理結果。

## Git 審批與授權順序

Git 每次操作都是獨立、不可變的 request，綁定 network、原設備、指定審批者、操作 digest／摘要與 expiry。新 request 期限最長 24 小時，建立／決定／消耗時間由伺服器產生。只有指定且仍有效的 admin 可以批准／拒絕；admin 自審可以，但仍須正式記錄批准，再在原機另行確認。沒有背景自動 execute 或永久「批准全部」。

執行前，原設備在線呼叫 `consumeGit`；伺服器在 network policy lock 與 request row lock 內，重新檢查 origin、批准者目前角色／有效 membership、epoch、decision、digest、expiry。授權消耗是排序點，之後才發生的撤銷不能追溯取消已准入的操作。角色／撤銷變動增加 epoch，舊批准不能直接繼續使用；需要重新預覽／申請。

第一次成功消耗綁定不可變 execution nonce。相同 attempt 的重試只回傳 `replayed: true` 的歷史收據，**不代表可再次啟動 Git**；不同 nonce 衝突。結果回報只允許仍有效的 origin，安全欄位只有固定 status、code、head；同一結果可以重送，但不能改寫，也不因批准已過期而丟棄。未知／部分結果不得自動重跑，詳見 [Git 安全與恢復](GIT-SAFETY.md)。

若 relay 沒有 v2 capability、仍未指定第一位 admin，或線上驗證失敗，Git 寫入停用。本機規劃、記憶、任務與唯讀 Git 不依賴此權限；不能把無法取得政策解讀成「不必審批」。

## RPC 對應

所有呼叫都是 `POST /rest/v1/rpc/<name>`，`apikey` 放公開 key，`Content-Type: application/json`。設備 token 放 **JSON POST body 的 `p_token`**，不放 URL，也不當成 JWT Bearer token。回傳欄位採 shared schemas 的 camelCase。

| RelayClient 方法 | SQL RPC | 除 `p_token` 外的參數 | 回傳 |
| --- | --- | --- | --- |
| `pair` | `hub_pair` | `p_attempt_id`, `p_device_id`, `p_code`, `p_name` | `{ networkId, device }` |
| `listDevices` | `hub_devices` | 無 | `DeviceRecord[]`，包含撤銷紀錄 |
| `renameDevice` | `hub_rename` | `p_name` | JSON `null` → `void` |
| `createInvite` | `hub_invite` | `p_code` | `{ expiresAt }` |
| `revokeDevice` | `hub_revoke` | `p_device_id` | `null` → `void` |
| `publish` | `hub_publish` | `p_snapshot` | `null` → `void` |
| `manifest` | `hub_manifest` | `p_after`，第一頁為 `null` | `{ entries, next }` |
| `snapshots` | `hub_snapshots` | `p_refs: [{ ownerDeviceId, projectId }]` | `RemoteSnapshot[]` |
| `send` | `hub_send` | `p_message` | `RelayMessage` |
| `pull` | `hub_pull` | 無 | 未 ACK 的 `RelayMessage[]` |
| `acknowledge` | `hub_ack` | `p_ids` | `null` → `void` |
| `statuses` | `hub_statuses` | `p_ids` | 自己發出的 `MessageReceipt[]` |
| `checkProposal` | `hub_check_proposal` | `p_id`, `p_hash` | 尚有效且待處理的 `RelayMessage` |
| `resolve` | `hub_resolve` | `p_id`, `p_decision` | `null` → `void` |

v2 adapter 放在 `RelayClient.governance`，與 v1 訊息收據的 `statuses(token, ids)` 不同；不把新欄位塞進舊 DTO：

| GovernanceRelay 方法 | SQL RPC | 除 `p_token` 外的參數 | 回傳 |
| --- | --- | --- | --- |
| `policy` | `hub_v2_policy` | 無 | `GovernancePolicy`：protocol 2、network/device、角色、epoch、有效成員角色 |
| `setRole` | `hub_v2_set_role` | `p_device_id`, `p_role` | `null` → `void` |
| `submitGit` | `hub_v2_submit_git` | `p_request`（JSONB） | `GitApproval` |
| `listGit` | `hub_v2_list_git` | 無 | 自己提出／分派給自己的 `GitApproval[]` |
| `getGit` | `hub_v2_get_git` | `p_id` | `GitApproval` |
| `decideGit` | `hub_v2_decide_git` | `p_id`, `p_digest`, `p_decision`, `p_reason` | `GitApproval` |
| `cancelGit` | `hub_v2_cancel_git` | `p_id`, `p_digest` | `GitApproval`，僅 origin 可取消 |
| `consumeGit` | `hub_v2_consume_git` | `p_id`, `p_digest`, `p_execution_id` | `{ id, executionId, consumedAt, replayed }` |
| `reportGit` | `hub_v2_report_git` | `p_id`, `p_execution_id`, `p_result`（JSONB） | `null` → `void` |
| `publishStatus` | `hub_v2_publish_status` | `p_status`（**TEXT JSON 字串**，不是 JSONB） | `null` → `void` |
| `statuses` | `hub_v2_statuses` | 無 | 同群組有效成員的 `RemoteDeviceStatus[]` |

完整 signature 同時列於 `tests/helpers/sql-relay.ts`。角色變更與撤銷寫入私有稽核；此介面沒有開放讀寫私有表或呼叫 bootstrap／初始管理員 helper 的方法。

`send` 的 payload 是**不可變 JSON 字串**，雜湊以該字串的原始 UTF-8 bytes 計算，不重新排序／序列化再算。同群組同 event ID 只有同 sender、destination、payload 與 expiry 才可重送；變更內容會衝突。已提交重送會先查重，再判斷新訊息期限，避免「提交成功但回應遺失」造成假失敗。

收件採未 ACK 清單，沒有可能漏掉併發提交的 max-sequence cursor。只有接收端可 ACK／寫入單調、不可覆寫的 decision；完全相同 decision 重送成功。發件端只查自己發出 ID 的收據。

摘要只能由 owner 發佈，依 `(ownerDeviceId, projectId)` 隔離。版本單調遞增；同版本不同內容拒絕，同版本相同內容可重試；`project: null` 為永久保留的撤回標記。Manifest 用 `ownerUUID/projectUUID` keyset cursor，每輪從頭對照版本；它不是以資料列插入順序當同步游標。

## 實際上限與運作限制

| 項目 | 上限／行為 |
| --- | --- |
| 配對／邀請 code | 64 位 hex、15 分鐘、原子單次消耗 |
| 設備 token | 32-byte 隨機值、64 位 hex；伺服器只存 SHA-256 |
| 群組設備紀錄 | 100 筆，包含撤銷歷史；避免無界設備清單 |
| 每個 message payload／snapshot | 256 KiB UTF-8；SQL 對 snapshot 的 JSONB 序列化 bytes 再檢查，可能比無空白 JSON 略保守 |
| 訊息文字／proposal 說明 | 10,000 個 UTF-16 code units |
| `nextAction` | 2,000 個 UTF-16 code units |
| 每個記憶欄位 | 20,000 個 UTF-16 code units，僅 shared/types 白名單 9 欄 |
| 名稱／stage | 設備 80、專案 120、stage 160 個 UTF-16 code units |
| revision／snapshot version | 1 至 JavaScript safe integer 上限 9,007,199,254,740,991 |
| ACK、status、snapshot refs | 每次最多 50 項 |
| pull／manifest | 每頁最多 50 項 |
| pull／snapshot 回應 | 另有 1 MiB serialized JSON 上限；回傳可容納的 prefix，剩餘未 ACK 訊息／未更新 refs 下輪重取 |
| Git 新申請期限／內容 | 最長 24 小時；compact JSON UTF-8 最多 256 KiB，與 adapter 的 JSON.stringify byte 計算一致 |
| Git 清單 | 最多 100 筆、1 MiB；有效 pending／approved 優先於 terminal 歷史；單筆可用 `getGit` 取得 |
| Git 摘要 | 最多 200 個相對路徑、每個 4096 UTF-16 units；commit 訊息 10,000、拒絕／批准理由 1,000 |
| 裝置狀態 | 每次 8192 UTF-8 bytes；最多 20 個不重複專案、10 個受控作業摘要；版本為正 safe integer |
| 狀態回傳 | 最多群組中的 100 個有效設備；保留過期觀測與空 tombstone，不回傳撤銷設備資料 |
| HTTP adapter 回應 | 串流讀取最多 2 MiB；provider error body 最多 8 KiB |
| HTTP adapter timeout | 預設 15 秒，涵蓋 headers 與 body；停用／停止時可由 caller abort |

SQL 接受實際有效的 ISO 時間；PostgreSQL 不支援 JSON 字串中的 NUL 字元。payload／snapshot 不是任意 binary blob。供應商錯誤、SQL details、憑證不會直接回傳給 UI 或寫入 adapter log，只映射安全的 `invalid / unauthorized / denied / conflict / expired / unavailable / aborted`。

錯誤機器碼明確區分：`HU401 → unauthorized` 僅表示呼叫者自己的設備 token 無效／已撤銷；`HU403 → denied` 表示來源、目標、邀請或資料 ownership 權限不足（包含對方已撤銷或跨群組），不得因此停用仍有效的本機設備。沒有 relay 機器碼的 gateway HTTP 401／403 可能是公開 key／API 設定問題，映射為可重試的 `unavailable`，不冒充設備撤銷。缺少 v2 RPC 的 `PGRST202`／`42883` 也映射為安全的 `unavailable`，而非允許免審批；若自訂 relay 根本沒有 governance adapter，客戶端要求升級。

Supabase 免費方案可能有資料量、流量、API、運算配額，以及閒置專案暫停限制；條款可能變動，請以目前 Dashboard／官方方案資訊為準。本版本不替你付費或自動升級。未 ACK 訊息、已消耗邀請、撤銷／治理稽核、Git 審批／執行紀錄及 tombstone 不會因短期過期而自動刪除；請監看容量。任意清除這些紀錄會破壞去重、配對重試或撤回語意，不提供未經確認的自動 purge。

## 故障處理

- **配對碼過期**：尚未消耗的 code 請重新邀請；第一台尚未配對時可手動重新 bootstrap（會建立新群組）。已成功提交但回應遺失時保留 pending attempt 並重試，勿直接手動清除加密資料。
- **憑證無效／已撤銷**：停止重試舊身分。由仍有效 admin 確認是否誤撤銷；明確解除配對後，使用新邀請建立 member 身分的新 membership，舊 admin 角色不會恢復。
- **safeStorage 無法解密**：不會退回明文；不要複製加密 credential blob 到另一個 Windows 帳號期待可用。檢查目前 OS 帳號與桌面安全儲存後，再決定是否明確解除配對。
- **API 暫時無法使用**：檢查連線、Supabase 暫停／配額、Project URL、公開 key 與遷移是否成功；不要貼出完整憑證或 provider error body。網路失敗不影響原有本機編輯。
- **出現資料衝突**：重新預覽本機 revision；不要手動改 message ID 後自動套用同一要求。
- **只看到快取摘要**：確認來源 runtime 仍運作（可以縮至系統匣）、連線已啟用，且仍選取分享；快取不是遠端電腦正在運作的證明。
- **Git 要求升級／沒有管理員**：確認兩份遷移均成功；既有群組需由私有管理端執行 `designate_initial_admin`。不要改本機快取角色、使用 service key 或放寬 SQL grants。
- **批准後仍不能執行**：可能已過期、被取消、角色 epoch 已變，或儲存庫與預覽不符；重新檢查並建立新申請，不重寫已批准內容。
- **unknown／partial**：先檢查本機 journal、HEAD、index、工作檔案與必要的遠端狀態，再依 Git 畫面提供的恢復流程明確確認。不要刪除 journal、重送 nonce 或重跑 Git 來猜測結果。

## 已測與尚待實機驗證

本機驗證指令：

```bash
npm exec -- vitest run tests/supabase-relay.test.ts tests/relay-sql.test.ts tests/governance-relay.test.ts tests/governance-sql.test.ts
```

```bash
npm run typecheck
```

`@electric-sql/pglite` 僅是 dev dependency，不是 App 的雲端 SDK。SQL 測試執行交付的 migration 與 RPC，使用真的 PostgreSQL `SET LOCAL ROLE anon/authenticated`、grants、RLS 與 `SECURITY DEFINER`，不是用 SQL 字串比對假裝授權測試。涵蓋錯誤／撤銷憑證、helper/table ACL、跨群組、sender 冒充、配對重試／重用／過期、訊息不可變／收據 ownership、延後結果、tombstone／keyset、UTF-8 bytes 與批次上限。HTTP 測試覆蓋設定、公開 key、轉址拒絕、嚴格回傳 schemas、錯誤遮蔽、串流上限與 timeout/abort。

本次針對上述四份測試的執行共 **58 tests 通過**；另有針對性的本機審批／狀態整合測試通過。新 SQL 測試包含既有群組不自動升權、私有初始化、member 不能撤銷／升權／審批、last-admin 保護、指定 reviewer／自審、epoch／expiry、一次性消耗與重播、immutable 結果、狀態 bytes／版本／ownership、v1 取消分享及重新分享不復活附加資料。

測試用 `tests/helpers/sql-relay.ts` 的 `createSqlRelayFixture()` **預設執行兩份實際 migration**，可讓多個隔離本機 store 共用真 SQL relay，不會送出網路請求；使用完必須 `close()`。`{ governance: false }` 僅供封存 v1 相容測試；`tests/relay-sql.test.ts` 記錄 v1 的舊行為，不能拿它的「同等設備權限」斷言描述升級後政策。`tests/governance-sql.test.ts` 另證明 v2 下舊 RPC 的撤銷權限已加固。PGlite 採單一實例／連線，**不能代替真正多連線競爭或 Supabase gateway 驗證**。

以上通過紀錄不是整個功能已完成發行驗證的宣告。完整新套件、瀏覽器互動、重新打包後的 Windows 系統匣／退出／更新及 Git 原生執行路徑，仍須在同一候選建置逐項執行並記錄；既有驗證文件只能證明其當時所測版本。

**尚未執行**：使用者真實 Supabase 的 SQL Editor 角色權限、PostgREST schema cache／回應、publishable/legacy key gateway、雲端多連線競爭、實際配額／暫停／TLS／跨電腦網路，以及兩台真 Windows 桌面 safeStorage 與重啟流程。沒有使用者提供專案並明確進行 live 驗證前，不宣稱完成真實跨電腦雲端連線。
