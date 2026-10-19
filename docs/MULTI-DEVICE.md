# 桌面多設備與 Supabase relay

## 使用範圍與隱私

這是 **Windows 桌面 App 的可選功能，不是網站或手機版**。整合預設關閉；沒有雲端設定時，原有本機專案、SQLite、掃描及編輯功能仍可使用。交付程式與 SQL 不會替你建立 Supabase 帳號、購買方案、部署網站、建立雲端專案或上傳現有資料。

每台電腦保有自己的權威資料。其他設備只能查看你明確分享的白名單摘要、傳送文字訊息，或提出 `nextAction`／部分記憶欄位的變更請求。請求必須在資料所屬電腦預覽並確認；不會轉成 shell、檔案操作、遠端終端機或啟動程式指令，也不會同步 SQLite 或整份 workspace。

- 傳輸使用 HTTPS/TLS 與可撤銷設備憑證，**不是端對端加密**。Supabase、雲端管理方及具有資料庫管理權限的人可讀取已分享摘要、訊息及設備資訊。
- 預設不分享專案。啟用某專案後，所有有效配對設備都可讀取其選取欄位；記憶欄位必須另行勾選。請先檢查分享預覽。
- 自動摘要不包含專案路徑、原始碼、Git commit 文字或金鑰欄位。但若你自行把秘密、路徑或原始碼貼入文字訊息／選取的記憶欄位，這些文字仍會傳出。
- 撤回分享會發佈 tombstone；每次真正開始發送摘要前會重新核對目前的分享欄位及專案是否存在，避免把較早排隊的內容送出。已開始的網路請求可能已送達，不能追溯取消。撤銷設備會停止其後的授權，但不能保證從對方既有快取、匯出或備份中抹除已讀資料。
- 若之後的本機編輯讓選定摘要超過 256 KiB，該專案會排程撤下舊摘要，不再送出舊排隊內容；其他專案與訊息繼續同步。分享政策仍可讀取，可減少欄位或取消分享，修正內容後可恢復發佈。
- 每台有效配對設備同等受信任，均可發邀請或撤銷同一群組內的設備；這不是具有管理員／訪客分級的團隊權限系統。
- **App 關閉、電腦休眠／關機時不輪詢、不接收、不執行請求。** 本功能不保證關閉視窗後的背景代理或筆電闔蓋後執行。

## 手動設定自己的 Supabase 專案

以下都是由使用者自行在 Supabase 執行的管理操作；本機測試不會執行這些雲端步驟。建議使用專屬 HelpTool 的專案。

### 1. 確認資料庫管理權限

使用 Supabase Dashboard 的 SQL Editor，以管理角色 `postgres` 執行遷移。需要：

- 建立 `NOLOGIN` 角色、授予該角色給 `postgres`，以及 `SET ROLE` 的權限。
- 建立 schema，以及在 `public` schema 建立函式、授予／收回自建角色的 `CREATE` 權限。
- 專案具有 Supabase 標準 `anon` 與 `authenticated` 角色；Data API 已啟用並暴露 `public` schema。
- PostgreSQL 提供內建 `sha256(bytea)` 與 `gen_random_uuid()`；不需要 `pgcrypto` extension。

如果組織限制上述操作，請由資料庫管理員先核准或執行。**不要**改成對 `PUBLIC`／`anon` 開放私有表，不要把 `hub_private` 加入 exposed schemas，也不要把 service key 放進 App 來繞過限制。

### 2. 執行遷移一次

在 SQL Editor 貼入並執行完整檔案：

```text
supabase/migrations/202610190001_desktop_relay.sql
```

此遷移在單一 transaction 中建立：

- `hub_relay_owner`：專用 `NOLOGIN`、非 superuser、沒有 `BYPASSRLS` 的物件擁有者。
- `hub_private`：網路群組、設備憑證雜湊、邀請雜湊、不可變訊息及摘要表；全部開啟 RLS，沒有用戶端 policy、沒有 anon/authenticated 直接表權限。
- 14 個 `public.hub_*` RPC：`SECURITY DEFINER`、固定空 `search_path`、完整限定物件名稱，內部驗證設備授權。
- 私有驗證 helper 及管理用 bootstrap；沒有公開執行權限。

管理角色 `postgres` 保留新角色的 membership，方便後續管理。建立 RPC 後會收回新角色對 `public` 的 `CREATE` 權限。腳本不撤銷其他應用的函式權限、不修改其他 schema 的 default privileges，也不建立廣泛的 table grants。

**這是一次性遷移，不是可重複重建腳本。** 同名角色、schema 或函式已存在時會失敗並回滾。請先檢查是否曾成功安裝，不要為了重跑而直接 `DROP ... CASCADE`。

### 3. 管理員建立第一個短效配對碼

在同一 SQL Editor 執行 `supabase/bootstrap.sql`，或：

```sql
SELECT hub_private.bootstrap('My desktop devices');
```

回傳 `networkId`、`code`、`expiresAt`。每次呼叫建立一個**新群組**；配對碼為 64 位小寫十六進位，有效 15 分鐘，限新設備消耗一次。請私下複製，勿貼入 issue、log 或螢幕截圖。它不是 App 的長期設備憑證。

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

設備名稱可以相同，識別依 UUID。**本機 installation UUID 與雲端 membership UUID 分開**：一般使用、重試及重啟保留原身分；明確解除配對後重新配對會產生新的雲端設備 ID/token。舊設備 UUID 永不重新啟用；舊 token 也不復活。更換 endpoint／群組必須先明確解除配對，不會把舊 outbox 自動改送新後端。

暫停同步會保留設備憑證供之後恢復。**解除本機配對會在 SQLite transaction 中清空該連線的加密憑證及待配對秘密，保留非秘密的歷史紀錄。** 這不等於撤銷雲端 membership，也不承諾抹除既有備份或 WAL 的歷史資料；要使舊憑證在雲端失效，請由另一台有效設備撤銷舊設備。

## 配對重試、撤銷及變更確認

- 雲端只存 32-byte 隨機 token 的 SHA-256，不存 token 明文；邀請 code 也只存 SHA-256。
- 配對以 row lock 原子消耗 code。回應遺失後，只允許完全相同 `attemptId + deviceId + token hash` 重試；已成功消耗的 code 即使之後過期也可恢復原回應，但設備已撤銷時永遠拒絕。
- 除配對外，每個 RPC 都重新驗證 token 與有效 membership；sender／network 從 token 推導，拒絕客戶端冒充 sender 或跨群組存取。
- 變更只允許 `nextAction` 與白名單 partial memory，接受前還要檢查本機 revision、分享政策與最新線上來源授權。離線或授權查詢失敗時不套用。
- `checkProposal` 的有效來源檢查是授權排序點。之後才發生的並發撤銷不能追溯取消已授權的本機 transaction。
- 本機已完成的 `applied`／`rejected`／`read` 結果可能延後送達；`resolve` 只驗證有效接收端及結果不可變性，不因來源之後被撤銷或訊息過期而丟棄已完成結果。
- 雲端不自動將過期訊息寫成 terminal decision；過期會阻止新的套用／新訊息提交，但不能先覆蓋尚在重試的有效處理結果。

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
| HTTP adapter 回應 | 串流讀取最多 2 MiB；provider error body 最多 8 KiB |
| HTTP adapter timeout | 預設 15 秒，涵蓋 headers 與 body；停用／停止時可由 caller abort |

SQL 接受實際有效的 ISO 時間；PostgreSQL 不支援 JSON 字串中的 NUL 字元。payload／snapshot 不是任意 binary blob。供應商錯誤、SQL details、憑證不會直接回傳給 UI 或寫入 adapter log，只映射安全的 `invalid / unauthorized / denied / conflict / expired / unavailable / aborted`。

錯誤機器碼明確區分：`HU401 → unauthorized` 僅表示呼叫者自己的設備 token 無效／已撤銷；`HU403 → denied` 表示來源、目標、邀請或資料 ownership 權限不足（包含對方已撤銷或跨群組），不得因此停用仍有效的本機設備。沒有 relay 機器碼的 gateway HTTP 401／403 可能是公開 key／API 設定問題，映射為可重試的 `unavailable`，不冒充設備撤銷。

Supabase 免費方案可能有資料量、流量、API、運算配額，以及閒置專案暫停限制；條款可能變動，請以目前 Dashboard／官方方案資訊為準。本版本不替你付費或自動升級。未 ACK 訊息、已消耗邀請、撤銷紀錄及 tombstone 不會因短期過期而自動刪除；請監看容量。任意清除這些紀錄會破壞去重、配對重試或撤回語意，不提供未經確認的自動 purge。

## 故障處理

- **配對碼過期**：尚未消耗的 code 請重新邀請；第一台尚未配對時可手動重新 bootstrap（會建立新群組）。已成功提交但回應遺失時保留 pending attempt 並重試，勿直接手動清除加密資料。
- **憑證無效／已撤銷**：停止重試舊身分。由仍有效設備確認是否誤撤銷；明確解除配對後，使用新邀請建立新 membership。
- **safeStorage 無法解密**：不會退回明文；不要複製加密 credential blob 到另一個 Windows 帳號期待可用。檢查目前 OS 帳號與桌面安全儲存後，再決定是否明確解除配對。
- **API 暫時無法使用**：檢查連線、Supabase 暫停／配額、Project URL、公開 key 與遷移是否成功；不要貼出完整憑證或 provider error body。網路失敗不影響原有本機編輯。
- **出現資料衝突**：重新預覽本機 revision；不要手動改 message ID 後自動套用同一要求。
- **只看到快取摘要**：確認來源 App 已開啟、連線已啟用，且仍選取分享；快取不是遠端電腦正在運作的證明。

## 已測與尚待實機驗證

本機驗證指令：

```bash
npm exec -- vitest run tests/supabase-relay.test.ts tests/relay-sql.test.ts
```

```bash
npm run typecheck
```

`@electric-sql/pglite` 僅是 dev dependency，不是 App 的雲端 SDK。SQL 測試執行交付的 migration 與 RPC，使用真的 PostgreSQL `SET LOCAL ROLE anon/authenticated`、grants、RLS 與 `SECURITY DEFINER`，不是用 SQL 字串比對假裝授權測試。涵蓋錯誤／撤銷憑證、helper/table ACL、跨群組、sender 冒充、配對重試／重用／過期、訊息不可變／收據 ownership、延後結果、tombstone／keyset、UTF-8 bytes 與批次上限。HTTP 測試覆蓋設定、公開 key、轉址拒絕、嚴格回傳 schemas、錯誤遮蔽、串流上限與 timeout/abort。

測試用 `tests/helpers/sql-relay.ts` 的 `createSqlRelayFixture()` 可讓多個隔離本機 store 共用真 SQL relay，不會送出網路請求；使用完必須 `close()`。PGlite 採單一實例／連線，**不能代替真正多連線競爭或 Supabase gateway 驗證**。

**尚未執行**：使用者真實 Supabase 的 SQL Editor 角色權限、PostgREST schema cache／回應、publishable/legacy key gateway、雲端多連線競爭、實際配額／暫停／TLS／跨電腦網路，以及兩台真 Windows 桌面 safeStorage 與重啟流程。沒有使用者提供專案並明確進行 live 驗證前，不宣稱完成真實跨電腦雲端連線。
