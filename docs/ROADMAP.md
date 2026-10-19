# Roadmap

原則：先降低每天恢復工作的成本，再增加自動化；不把管理工作轉嫁給使用者。

## v0.1 — 基礎 MVP（已完成）

- [x] 集中工作台、項目狀態／優先級／分類／搜尋／篩選。
- [x] 指定目錄的 bounded scan、預覽匯入與手動新增。
- [x] 唯讀 Git 快照、分支／commit／working tree、定時及手動刷新。
- [x] 結構化 Project Memory、工作筆記、衝突防護。
- [x] Where I left off：記錄、事實與規則建議分開。
- [x] 基本跨項目 Task 管理與可解釋的 Next focus。
- [x] Markdown Context、獨立共享 JSON、預覽確認匯回。
- [x] 可用性檢測、開啟資料夾／VS Code／Agent CLI。
- [x] Local SQLite，無登入、模型 API 或 telemetry。

## v0.2 — Windows 桌面版與聊天 App 交接

- [x] Electron 獨立視窗及隨附執行環境，不需要外部 Node／瀏覽器／終端。
- [x] 原生資料夾選擇與儲存、原生剪貼簿、單一實例、未儲存關閉確認。
- [x] Claude Desktop／ChatGPT Desktop 登記偵測及明確 copy/open 操作。
- [x] 貼回 JSON、差異預覽、確認匯入；不假設聊天 App 能存取本機檔案。
- [x] 保留既有 SQLite 位置；原有 CLI／repository 交接改為進階選項。
- [x] Windows x64 portable／NSIS 建置流程；產物及驗證狀態以桌面驗證紀錄為準。

## 下一階段 — 更順手、更可靠

1. SQLite 線上備份／還原預覽及 schema migration 回歸測試。
2. 多 IDE 偵測及 WSL 專用路徑／終端 adapter。
3. 在現有匯入逐欄 diff 之上加入記憶變更歷史與三方合併，解決 Hub 與 AI 同時改 checkpoint。
4. 使用者選擇的「開始／結束工作」checkpoint，補足 Git commit 並不等於最近工作的不足。
5. 正式程式碼簽署、安全更新及 macOS／Linux 原生實機驗證；不保證未簽署軟件可通過所有組織政策。
6. Background polling 加入 idle backoff、取消掃描、可自訂排除規則；不預設掃描整顆磁碟。

驗收：新使用者數分鐘內可加入真實項目；資料可還原；數百項目下介面仍流暢；所有自動化能追溯原因。

## v0.3 — Opt-in Agent adapters

1. 逐一核實 Claude／Codex 官方支援介面及版本。
2. 可選 hooks 只寫出 checkpoint 草稿；使用者審閱後才合併。
3. 可選的 session metadata 摘要，以最小保留期限保存；不任意讀整段對話。
4. 穩定 shared-state schema 的升級工具與公開契約測試。

驗收：停用 adapter 不影響基本工作流程；權限、來源與更新時間可見；既有 Agent 指示檔永不被靜默覆寫。

## v0.4 — 有邊界的 AI 輔助

1. 可選本機模型或使用者指定 provider 的摘要草稿。
2. 發送前顯示資料清單、隱私／成本及來源；預設不外傳。
3. 摘要有來源引用，明確區分「觀測」「使用者確認」「AI 建議」。
4. 下一步建議結合顯式目標／blockers，提供理由和否決／修正方式。

驗收：不用 AI API 仍能完整使用 v0.1；沒有任何推測直接改變完成狀態；不為了看 dashboard 強制登入。

## 不做（除非真有需要）

企業組織／權限模型、Sprint 儀式、工時監控、雲端帳號中心、自動執行 repo 程式碼、任意 shell agent、無限保存私人對話、把 Git commit 數量轉換成虛假完成率。
