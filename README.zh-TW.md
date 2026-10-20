# AI Project Hub

[English](README.md) · **繁體中文**

**下載 Windows x64 v0.3.0：** [安裝版](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-Setup-x64.exe) · [免安裝版](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-portable-x64.exe)

以本機資料為優先的 **Windows x64** 專案工作台。集中管理專案、任務、checkpoint、Git 觀測與逐次審批的 Git 操作，再由你決定何時把脈絡交給 Claude Desktop 或 ChatGPT Desktop。

**原始碼更新範圍：** 下述 Git 審批、管理員角色、可選裝置狀態與關閉縮至系統匣，是目前原始碼的變更。修改或建置原始碼不會更新既有 v0.3.0 下載資產、發布新版或部署雲端 SQL。請使用包含這些變更且重新建置、驗證的程式，並先明確升級自己的 relay。

**桌面版內含執行環境，一般使用者不需要另外安裝 Node.js、開啟瀏覽器或保留終端。** 本機功能不需要 Hub 帳號、API key 或雲端資料庫。Hub 不讀取私人聊天紀錄、不自動傳送提示詞，也不執行 AI 回覆。

## 可以做什麼

- **找到專案：** 預覽資料夾掃描結果，自行選擇加入哪些專案，不搬動檔案、不執行專案程式碼。
- **接續工作：** 集中保存下一步、優先級、任務、技術決策與專案記憶。
- **查看 Git 事實：** 檢視分支、commit、工作目錄快照與檔案差異；背景掃描不會修改儲存庫。
- **申請 Git 操作：** 預覽支援的操作，取得指定管理員批准，再由提出申請的原電腦另行確認執行；沒有遠端自動執行或永久通用批准。
- **交接給 AI App：** 審閱並複製脈絡，可選擇開啟桌面 App，再手動貼回 checkpoint 並確認匯入。
- **選擇介面語言：** 預設英文，可在頂端列切換為繁體中文。
- **選用多電腦連線：** 透過自己的 Supabase 後端分享選定摘要、交換訊息。預設停用，不是整份工作區同步。

## 取得 Windows 桌面版

透過下方連結直接下載 **v0.3.0**，或前往 [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest)。桌面版內含執行環境，不需要安裝 Node.js 或設定原始碼。

執行安裝版即可安裝到目前 Windows 使用者；選擇免安裝版則下載後雙擊執行。GitHub 的 **Source code (zip)** 和 **Source code (tar.gz)** 是提供給開發者的原始碼壓縮檔。

| 下載 | 用途 |
| --- | --- |
| [Windows x64 安裝版（.exe）](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-Setup-x64.exe) | 安裝到目前 Windows 使用者，可建立桌面與開始功能表捷徑。 |
| [Windows x64 免安裝版（.exe）](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/AI-Project-Hub-0.3.0-portable-x64.exe) | 不需安裝，下載後直接執行。 |

[版本說明](https://github.com/yikeugene/AI-project-hub/releases/tag/v0.3.0) · [SHA-256 校驗檔](https://github.com/yikeugene/AI-project-hub/releases/download/v0.3.0/SHA256SUMS.txt)

v0.3.0 需手動下載更新，這一版尚未設定程式內更新來源。免安裝**不代表**資料存放在執行檔內或執行檔旁邊。

**目前建置尚未做程式碼簽署。** Windows SmartScreen、Smart App Control 或組織政策可能提醒或阻擋。請確認發布者的發行位置及可用的驗證資訊，不要為了執行程式停用 Windows 安全防護；若遭政策阻擋，請洽管理員或等待經核准的發行方式。

Git 檢視與經批准的 Git 操作需要 Git；沒有 Git 仍可使用專案、記憶、任務與文字交接。VS Code、Claude Desktop、ChatGPT Desktop 與進階 CLI 工具都是可選的外部 App，Hub 不會代為安裝。

## 第一次使用

1. **選擇語言。** 在頂端列使用 **English / 繁體中文** 切換。偏好儲存在本機 SQLite 資料庫，重新啟動後仍會保留。切換只影響介面文字，不會翻譯專案名稱、筆記、任務或其他使用者內容。
2. **加入專案。** 選擇本機開發資料夾，預覽掃描結果，再勾選要加入的專案。
3. **設定下一步。** 記錄狀態與優先級，或新增任務。
4. **儲存 checkpoint。** 在專案記憶記錄目前進度、決策與已知問題。
5. **繼續工作。** 工作台結合已記錄脈絡、Git 事實與可解釋的建議；commit 數量不是完成百分比。

正式工作區不會預填示範專案。**目前原始碼會將本機 SQLite schema 升級至第 3 版。** 升級前請備份；已安裝的舊版程式無法開啟升級後資料庫，也沒有自動降版。若須退回舊版，請在另一資料目錄還原相容的升級前備份。

## AI 交接：複製、貼上、審閱

### 交出脈絡

1. 開啟專案的 AI 交接畫面，選擇 Claude Desktop 或 ChatGPT Desktop。
2. 預覽由 Hub 已儲存資料整理出的脈絡。
3. 複製內容，或複製並請 Windows 開啟所選 App。
4. **自行貼上並傳送。** 需要檔案時，透過聊天 App 本身的功能附加。

開啟 App **不代表**選好了對話、傳送了脈絡、讀取了專案資料夾或取得檔案權限。Hub 使用 Windows 已登記的 App 身分，不依賴桌面 App 的 CLI 或未公開的對話網址。無法啟動 App 時，仍可複製內容。

### 帶回 checkpoint

1. 交接脈絡包含完整的 JSON checkpoint 範本，請 AI 在完成工作後更新。
2. 將**純 JSON 或單一完整 JSON code block** 貼入 Hub 的 checkpoint 輸入欄位。
3. 預覽匯入差異，逐欄比較，再明確確認。
4. 只會更新**九個專案記憶欄位與 `nextAction`**。匯入不會修改原始碼、路徑、生命週期狀態或任務，也不執行其中的指令文字。

貼上本身不會儲存 checkpoint。修改貼上文字會讓預覽失效；確認時會重新檢查專案 ID、schema、文字指紋與本機修訂版本。請去除 AI 的前後說明，不要只匯入片段 JSON。符合 schema 不代表 AI 的敘述正確，仍須審閱內容。

### 進階 CLI 與檔案交換

Claude Code／Codex CLI 與儲存庫檔案交接保留在進階選項。首次檔案匯出會建立 `.ai-project-hub/state.json`；之後的匯出只新增時間戳 Markdown 快照，**不覆寫既有 `state.json`**。此檔案不會自動跟隨後續 Hub 編輯變動，匯入前請再次預覽。

Hub 不建立或修改 `AGENTS.md`／`CLAUDE.md`。匯出的檔案可能被 Git 追蹤；不想提交時，請自行加入該專案的忽略規則。詳見[桌面整合說明](docs/INTEGRATIONS.md)。

## Git：預覽、審批，再由原機確認

唯讀觀測不需要雲端連線。**Git 變更需要已配對的桌面版、v2 relay、有效管理員與即時線上授權。** 舊 relay、缺少協議能力或審批服務無法使用時，寫入會停用，不會降級成免審批；web 開發模式也不能繞過。

1. 檢視本機 diff，預覽一項支援的操作；確認會送給指定審批者的相對檔名與操作中繼資料。
2. 送出不可變且有期限的申請。只有指定的有效管理員可批准或拒絕。管理員可以審批自己的申請，但仍須完成獨立、留有紀錄的批准動作。
3. 在**提出申請的原電腦**明確確認執行。Hub 重新檢查儲存庫狀態，再線上消耗一次性授權；收到批准或背景輪詢不會啟動 Git。
4. 檢視結果。儲存庫已變動時須重新預覽／申請；中斷或結果不明的操作不會自動重跑。`unknown`／`partial` 會封鎖後續寫入，直到使用者在本機檢查並明確確認。

白名單包含選定路徑的暫存／取消暫存、提交、新建／切換分支、fetch、僅快轉 pull 與一般 push，且各自必須符合安全前提。需要 fetch 時先另行審批，再對已固定的目標申請 pull。不提供強推、hard reset、clean／丟棄變更、改寫歷史、自動 stash 或自動解衝突。遠端操作只接受支援的 **HTTPS 與可信 Git Credential Manager**；SSH／自訂 helper，以及需要未支援 hooks、filters／LFS、sparse checkout 或 submodule 的儲存庫會被拒絕，不會放寬保護。

審批者收到明確預覽的摘要，不是原始碼、diff／patch 或本機絕對根路徑。相對檔名、分支／ref、remote URL、commit 訊息與作者資料仍可能敏感。詳見 [Git 安全與恢復](docs/GIT-SAFETY.md)及[管理員／relay 設定](docs/MULTI-DEVICE.md)。

## 更新

更新由**使用者主動操作**，不是無人值守升級。**v0.3.0** 請從 [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest) 手動下載新版，完全退出 App 後再安裝或替換（支援縮至系統匣的建置請選擇系統匣的**退出**）。程式內更新控制項需要使用已設定 GitHub 更新來源的建置。

| 執行方式 | 更新方式 |
| --- | --- |
| NSIS 安裝版，使用預設資料目錄 | v0.3.0 需手動下載並執行新版安裝程式。已設定 GitHub 更新來源的建置才可提供手動檢查、下載及明確確認後重新啟動安裝。請先儲存工作並備份。 |
| 免安裝執行檔 | 開啟 [GitHub Releases](https://github.com/yikeugene/AI-project-hub/releases/latest)，下載較新的 portable `.exe`，完全退出 Hub 後更換舊執行檔。 |
| 自訂資料目錄（`HUB_DATA_DIR` 或 `--data-dir`） | 手動下載／安裝發行檔，之後用相同的資料目錄設定啟動。此模式不提供程式內重新啟動安裝。 |
| 尚未設定發行來源的原始碼建置 | 不猜測 GitHub 發行位置。維護者設定完成後，更新檢查或發行連結才可使用。 |

安裝版更新需要已發布發行版本中的對應安裝包與更新中繼資料。只有原始碼壓縮檔或免安裝執行檔，不能作為安裝版更新。請保留備份，避免不同版本的 Hub 同時操作同一份資料庫。

## 本機資料與備份

Windows 預設資料庫位置為：

```text
%LOCALAPPDATA%\AIProjectHub\hub.sqlite
```

- SQLite 保存專案、任務、記憶、設定（含語言）、Git 快照、審批／執行紀錄與可選裝置狀態快取。桌面視窗設定與 Chromium profile 位於同一資料目錄內的 `desktop-profile`。
- 設定 `HUB_DATA_DIR` 或傳入 `--data-dir` 可使用獨立資料目錄。手動更新後請沿用該設定，不要讓不同版本指向同一份正在使用的資料庫。
- **備份前請從系統匣選擇完全退出，並停止 web 模式程序。** 只關閉視窗並不足夠；待受控工作與關閉流程結束後，再複製整個資料目錄。SQLite 仍可能使用 WAL 檔案時，不要只複製正在使用的 `hub.sqlite`。
- 系統匣圖示可用時，**X 會隱藏視窗，保留 runtime 與裝置輪詢**；可從系統匣恢復或完全退出。系統匣建立失敗時不會留下無法找回的隱藏程式。明確退出／更新仍經草稿確認並等待受控工作結束；Git 草稿也納入未儲存保護。
- Git 預設每 60 秒刷新，可在設定改成 `0` 停用。不設定登入自啟或 Windows service；完全退出、休眠或關機時不輪詢、不開始新工作，也不阻止休眠。離線裝置無法回報即時狀態。
- 移除專案只刪除 Hub 紀錄與相關任務，不刪除原始資料夾、Git 儲存庫或已匯出檔案。
- 一般資料列（包括訊息與遠端快取）**未加密**，保護程度取決於 Windows 權限與磁碟加密。裝置長期憑證另以 Windows 使用者範圍的安全儲存機制保護。

將脈絡貼入雲端聊天 App，或啟用選定欄位分享，都是主動傳出資料的動作；請先檢查是否含有秘密。資料目錄備份可能含私人資訊，不要上傳到問題回報中。

## 可選：連接自己的電腦

Supabase 整合**預設停用**。它讓已配對的桌面 App 交換選定專案摘要、訊息、需審閱的記憶變更請求、管理員治理的 Git 審批，以及另行同意的裝置狀態；不是檔案同步、共用 SQLite 資料庫、手機 App 或遠端 shell。每台電腦仍各自負責本機專案。

1. 在自己的 Supabase 專案依序手動套用 `supabase/migrations/202610190001_desktop_relay.sql` 與 `supabase/migrations/202610200001_device_git_approval.sql`，不會自動部署。新的私有 `hub_private.bootstrap(...)` 邀請會指定第一位管理員；既有群組須由資料庫管理者明確執行 `hub_private.designate_initial_admin(network_uuid, device_uuid)`，升級本身不會提升任何既有成員權限。
2. 在桌面設定輸入 Project URL、**公開 publishable／anon key**、裝置名稱與配對碼。不要輸入 `service_role` 或 secret 管理金鑰。
3. 使用一次性配對碼邀請另一台桌面。
4. 選擇要分享的專案與記憶欄位，預覽後確認。預設沒有任何分享；選定摘要會提供給所有目前及之後加入的已配對裝置。
5. 在本機審閱收到的請求，再接受或拒絕。只有資料所屬電腦的確認能修改允許的記憶欄位或下一步。

一般邀請只建立 **member**，重新配對也不繼承原角色。成員不能自行升權或撤銷設備；只有有效 **admin** 可管理角色／撤銷設備，或決定分派給自己的 Git 申請，且禁止移除最後一位有效管理員。

可選的活動、Git 摘要與手動任務計數**預設全部關閉**，已分享的專案也不例外。請分別預覽並啟用各類資料。取消基本專案分享，也會清除該專案的附加狀態分享選項；重新分享不會偷偷重新勾選。接收端觀察到撤回後也會失效化舊附加快取。任務 `doing` 是人工記錄，不代表程式真的正在執行；不收集 CPU、記憶體或其他 App 活動。

訊息會先持久化，runtime 運作且可連線時再重試，包括縮至系統匣時。**已送達不等於已套用。** 套用記憶變更請求需要即時來源授權與相符的本機修訂版本，不能沿用舊的離線授權。完全退出後停止收發，後端可保留待接收訊息。「最後看到」／「最後成功同步」時間不證明過期或離線電腦目前正在運作。

**傳輸使用 HTTPS／TLS，但不是端對端加密。** Supabase 管理方可以讀取已分享內容、審批摘要與訊息。暫停同步不會撤銷裝置或刪除雲端資料，撤銷也無法取回已被保存的副本。Supabase 免費方案有配額及閒置限制。

啟用前請閱讀[多設備設定與限制](docs/MULTI-DEVICE.md)。本機 SQL／HTTP 測試不代表你的真實 Supabase 部署或兩台實體 Windows 電腦已完成驗證。未設定雲端時，本機專案規劃、任務、交接與唯讀 Git 仍可使用；經審批的 Git 變更則需要升級後的 relay。

## 工作台知道什麼

| 來源 | 顯示內容 | 界線 |
| --- | --- | --- |
| 觀測事實 | 分支、commit、工作目錄、觀測時間 | 最近 commit 不一定是最後工作時間。 |
| 已記錄狀態 | 手動輸入或審閱後匯入的記憶、任務與狀態 | Git 活動不會自動把專案判為完成。 |
| 規則建議 | 明確的優先級與任務排序理由 | 不是 AI 推斷或完成百分比。 |

刷新失敗時，Hub 會保留舊快照並顯示錯誤。Git 查詢停用 clean/process filters，以免啟動自訂程式；Git LFS 等經轉換的檔案可能保守地顯示為已修改。背景觀測不深入子模組，也不執行 fetch、checkout、stage 或 commit。明確批准的操作走獨立受限執行路徑；不支援的儲存庫設定仍維持唯讀。

## 從原始碼建置

需要 **Windows x64、Node.js 24 LTS 與 npm**。涉及 Git 的測試與 fixtures 也需要 Git。這些是開發環境要求，不是使用發行版 `.exe` 的要求。

在儲存庫根目錄（包含 `package.json` 的資料夾）執行：

```sh
npm install --ignore-scripts
npm run pack:desktop
npm start
```

打包工具會下載官方 Electron／NSIS 工具；下載與執行必須符合本機政策。`pack:desktop` 會建置 `release/win-unpacked/`。**`npm start` 只啟動先前打包好的程式，** 不會建置，也不會啟動開發伺服器。`Start-Hub.cmd` 同樣是啟動已打包程式。請保留整個 `win-unpacked` 資料夾，不要只移走 `AI Project Hub.exe`。

### 檢查

```sh
npm run verify
npm run test:desktop
```

`verify` 執行型別檢查、單元測試及前端建置。`test:desktop` 必須先執行最新的 `pack:desktop`，再以隔離資料測試打包版。原生檔案對話框的選取結果會被模擬，後續 IPC、資料庫與檔案儲存流程則實際執行。這些測試不會傳訊給 Claude／ChatGPT，也不使用你的真實專案。

`npm run test:ui` **只建立 UI fixtures**，包括範例儲存庫及 `.local/verification/hub.sqlite`。它不是 UI 測試執行器，也不會啟動或驗證 App。

此次原始碼更新已通過針對性的 governance adapter／PGlite SQL 與本機審批／狀態整合測試；這**不代表**完整更新後測試套件、Windows 打包版系統匣／更新流程或瀏覽器互動已對你的建置驗證。發行前仍須以同一候選建置重跑完整檢查與 native／UI 測試。Live Supabase、真正 PostgreSQL 多連線競爭及兩台實體電腦仍未驗證，詳見[驗證界線](docs/GIT-SAFETY.md#verification-scope)。

### 可選的 web 開發模式

```sh
npm run dev
```

也可先建置，再啟動前端服務：

```sh
npm run build
npm run start:web
```

Web 模式預設為 `http://127.0.0.1:4317`，需要保留終端。這是開發／備用選項，不是桌面使用的必要條件。桌面版採用隨機內部 port 與由主程序持有的每次啟動密鑰，不需要手動以瀏覽器開啟該服務。

## 維護者發行設定

原始碼位於**儲存庫根目錄**，與本 README 及 `package.json` 放在一起。發布前請檢查內容：`.local/`、私人資料庫、`.env` 檔案、憑證、私人截圖與產生的執行檔都不應納入版本控制。執行檔應放在 Release assets。

1. 在 `release.config.cjs` 設定真實的**公開 GitHub 儲存庫**。原始碼中的 owner/repo 刻意留空；請填入自己的值，不要直接使用下列預留文字：

   ```js
   module.exports = {
     github: {
       owner: '<GITHUB_OWNER>',
       repo: '<GITHUB_REPOSITORY>',
     },
   };
   ```

2. 設定要發布的 package 版本並完成上述檢查，再建置發行檔：

   ```sh
   npm run dist:desktop
   ```

   發行建置必須提供有效的 owner/repo。建置使用 **`--publish never`**，只產生本機檔案，不會建立 GitHub 儲存庫、上傳檔案或發布版本。

3. 建立對應的公開 GitHub Release。上傳 `release/` 中**同一次建置產生的 NSIS Setup `.exe`、`latest.yml` 與安裝包的 `.exe.blockmap`**；可另附 portable `.exe` 與發行說明。不要用 GitHub 原始碼壓縮檔取代應用程式資產。
4. 公告可用前，請在 Windows 驗證已發布下載與安裝版更新流程。本機測試不能單獨證明線上發行可用。本專案不提供簽署憑證、雲端帳號或發布憑證。

## 貢獻與問題回報

歡迎範圍明確的修正與文件改善。回報問題時，請提供 App 版本、Windows 版本、重現步驟及移除敏感資訊後的診斷資料。優先使用隔離範例資料；不要附上私人資料庫、配對碼、憑證或未遮蔽的截圖。

安全問題請使用儲存庫已啟用的私人回報管道；若尚未提供，先向維護者詢問私人聯絡方式，不要直接公開敏感細節。

## 授權與延伸閱讀

AI Project Hub 採用 [MIT 授權](LICENSE) 開放原始碼，著作權為 2026 AI Project Hub。第三方依賴仍適用各自授權，發行檔包含第三方聲明。

以下技術文件目前使用繁體中文。驗證紀錄描述特定時間已執行的檢查，不代表每次建置或部署都已驗證。

[架構](docs/ARCHITECTURE.md) · [桌面整合](docs/INTEGRATIONS.md) · [Git 安全](docs/GIT-SAFETY.md) · [多設備設定](docs/MULTI-DEVICE.md) · [多設備驗證紀錄](docs/MULTI-DEVICE-VERIFICATION.md) · [Roadmap](docs/ROADMAP.md) · [桌面版驗證紀錄](docs/DESKTOP-VERIFICATION.md)
