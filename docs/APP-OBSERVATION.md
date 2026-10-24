# 分享目前使用中的應用程式（Windows）

這是獨立、**預設關閉**的每群組分享選項。既有「HelpTool 自身運作狀態」同意不會自動開啟它；HelpTool 的前景／背景狀態也不是 Windows 正在使用哪個程式的判斷。預覽同意不應觸發採集，確認後才允許來源設備取得目前前景程式。

## 分享與隱私界線

- 來源是 Windows 當下前景視窗所屬的**單一程序 basename／對應友善名稱**與來源觀察時間，不是所有開啟或背景程序的清單。
- 不讀取或傳送視窗標題、文件名稱、網址、鍵盤輸入、螢幕內容、程序命令列或完整路徑。PID 僅在來源設備短暫用於定位該前景程序，不傳送或保留在觀察資料中。不新增應用程式使用歷史，也不把名稱加入作業事件、訊息、Git 審批或專案摘要。
- 使用 HTTPS/TLS、既有配對設備憑證及群組隔離，**不是端對端加密**。Supabase 服務商、雲端管理方及有資料庫管理權限的人可讀取最新名稱與時間。名稱本身也可能透露敏感工作內容。
- 雲端只保留每群組、每設備一筆最新發佈。更高序號會覆寫整份舊 payload；撤回也覆寫舊名字，而不是僅把舊名字藏起來。撤銷設備時會刪除該設備在本通道的完整資料列。
- 這是目前邏輯資料列的保留範圍，不保證擦除雲端備份、WAL、供應商記錄或對方已讀取／另存的資料。不要把本功能當作保密或強制刪除機制。
- 本機名稱與觀察 payload 只用於有限記憶體中的最新狀態，不寫入 SQLite/outbox/作業紀錄；本機持久化的是同意、版本／序號及必要的待撤回 metadata，而不是名稱歷史。

停用分享、暫停、解除配對、撤銷、鎖屏／睡眠或退出會停止相關採集與取消工作。已送出的請求可能已經抵達雲端，離線撤回也須等連線恢復才能送達；不能承諾立即收回對方已知的內容。HelpTool 隱藏至系統匣本身不代表停止已同意的前景程式分享。

## 如何解讀遠端資料

顯示的是「**最後回報使用中的應用程式**」，不是對方此刻仍在使用該程式的保證。來源觀察時間 `observedAt` 與雲端接收時間 `receivedAt` 是不同時鐘；舊觀察、過期接收、時鐘異常、離線及未分享不應顯示成即時使用。

- `observation: { name: "Visual Studio Code", observedAt: "…" }`：來源成功識別當次前景程式。
- `observation: { name: null, observedAt: "…" }`：當次無法取得名稱；舊名稱不應繼續顯示為目前使用。
- `observation: null`：已撤回。保留新序號與接收時間，防止較舊發佈把名稱恢復。
- 缺少新 RPC 或舊自訂 relay 沒有本通道：需要更新／不支援，只影響本功能；不可把 HelpTool 的「前景」冒充程式名稱。

顯示端把名稱當普通文字，不當作 HTML、連結或命令。程式不能保證名稱是可信的身分證明；配對設備是資料的來源。

## 手動 Supabase 遷移

**本次只交付 SQL；沒有執行雲端部署。** App、安裝程式及本機測試不會替你套用它。不需要新的 npm 套件、Supabase SDK、extension、管理金鑰或新的帳號。

### 依賴與順序

新的獨立通道依賴既有 v1 relay 與 v2 governance 的專用 `hub_relay_owner`、私有表及會鎖定群組後重新驗證有效設備的 `hub_private.auth` helper。使用 Supabase SQL Editor 的管理角色 `postgres`，按自己的實際安裝狀態處理：

| 後端目前狀態 | 需要執行的檔案，依序各一次 |
| --- | --- |
| 已安裝 v2（一般升級） | **只執行** `supabase/migrations/202610240001_foreground_app.sql` |
| 只有 v1 | 先 `202610200001_device_git_approval.sql`，再 `202610240001_foreground_app.sql` |
| 全新、尚未安裝 relay | `202610190001_desktop_relay.sql` → `202610200001_device_git_approval.sql` → `202610240001_foreground_app.sql` |

**已安裝的 baseline 不要重跑。** 這些是一次性、transaction 包覆的遷移，不是可重複重建腳本；不要用 `DROP … CASCADE` 清除現有資料來重跑。缺少 v2 時，新腳本會拒絕執行並回滾。若不確定是否已安裝，先由管理員檢查函式與遷移紀錄。

完整的初次設定、既有群組初始 admin 指派與公開 key 規則，見 [MULTI-DEVICE.md](MULTI-DEVICE.md)。升級本通道不需要重新 bootstrap 群組、重新配對、變更角色或把管理金鑰放進桌面 App。公開 Data API 仍只暴露 `public`，**不要暴露 `hub_private`** 或給 anon/authenticated 私有表權限。

### 新腳本的變更範圍

- 新增私有 `hub_private.app_observations`：`network_id`、`device_id`、`sequence`、原始 `payload` 文字、`received_at`。複合主鍵只允許一筆最新值，啟用 RLS，沒有用戶端 policy，也沒有直接表權限。
- 正好新增三個公開 RPC，都是專用 owner 的 `SECURITY DEFINER`、空 `search_path`，只授權 `anon`／`authenticated` 執行。所有呼叫仍使用既有有效設備 token 驗證，不信任 payload 中的自稱身分。
- 新增私有格式驗證 helper 及僅針對 `devices.revoked_at` 更新的清除 trigger。**不替換**既有 `hub_revoke`、`hub_private.auth`、任何 v2 函式或 policy/status DTO。
- 不新增 app 歷史、訊息或事件表，不向現有 history/message/audit 路徑插入觀察內容。

## 獨立通道契約

| RPC | POST body | 結果 |
| --- | --- | --- |
| `hub_app_v1_capability` | `{ p_token }` | 嚴格 `{ protocol: 1, networkId, deviceId }` |
| `hub_app_v1_publish` | `{ p_token, p_payload }`，payload 是 **TEXT JSON 字串** | JSON `null` 表示成功 |
| `hub_app_v1_statuses` | `{ p_token }` | 同群組有效設備的最新狀態，最多 100 筆 |

發佈格式固定為：

```json
{"protocol":1,"sequence":1,"observation":{"name":"Visual Studio Code","observedAt":"2026-10-24T12:00:00.000Z"}}
```

- 整份原始 UTF-8 payload 最多 **1024 bytes**。名稱最多 **96 個 Unicode code points／384 UTF-8 bytes**；不裁切或清洗，直接拒絕超界、空白首尾、`.`／`..`、Windows 檔名禁止符號及共享契約列出的控制／方向／零寬字元。
- 所有層級使用欄位白名單；不接受額外 title、path、PID、network/device 身分等欄位。原始 JSON 重複 key 也拒絕，避免在保留原始文字時夾帶被覆蓋的舊名稱。
- 時間必須是有效 Gregorian 日期、四位年份 0001–9999、包含秒的 ISO 字串；秒的小數可為 1–9 位，時區為 `Z` 或不超過 `±14:00` 的 `±HH:MM`。不修改來源時間或替舊樣本更新觀察時間。
- 序號是 1 到 JavaScript 最大安全整數的整數。相同序號僅允許**完全相同 UTF-8 bytes**的重試，不更新 `receivedAt`；較低序號或相同序號但不同 bytes 均衝突。更高序號覆寫最新值，撤回也遵守同一規則。
- 狀態列為同一發佈 DTO 加上 token 所屬的 `deviceId` 與伺服器 `receivedAt`。最多 100 筆，HTTP 回應另外限制為 150 KiB；不回傳已撤銷設備的觀察。

原生 fetch adapter 沿用嚴格官方 HTTPS Supabase origin、公開 key、禁止 redirect、POST body 中的 token、串流大小上限、timeout、AbortSignal 及不回顯供應商詳細資訊的錯誤。只有 capability RPC 的 `PGRST202`／`42883` 缺少函式代碼代表不支援；無效／撤銷憑證、權限拒絕、網路錯誤及 malformed 回應仍是錯誤，不能假裝只是舊後端。既有 governance 遺失 RPC 仍維持 fail-closed。

## 驗證與尚未驗證的範圍

本機測試以 PGlite 執行實際交付的三份遷移與真正的 `SET LOCAL ROLE anon/authenticated`；覆蓋 ACL、群組隔離、撤銷、嚴格格式、Unicode／UTF-8 上限、完全相同重試、撤回及舊函式不變。HTTP 測試使用注入的本機 transport，**沒有對實際 Supabase 發送測試請求**。

這不是「已驗證 live Supabase／兩台實體設備互通」的宣稱。真實雲端的遷移、PostgREST schema cache、公開 key／權限設定及兩台設備端到端互通，需要使用者手動套用新 SQL 後另行驗證。未安裝新遷移時，原有設備連線、HelpTool 狀態、專案與 Git 審批應照舊運作。
