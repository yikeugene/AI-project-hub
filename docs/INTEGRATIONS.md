# Claude Desktop / ChatGPT Desktop 整合

v0.2 的主要目標是 **桌面聊天 App**，不是 Claude Code／Codex CLI。Windows 桌面 app 啟動、Context 分享和 checkpoint 匯入是三個分開的動作。

## 支援的流程

```text
Hub 已儲存記憶／任務／Git 快照
  → 預覽 Context
  → 複製（可同時請 Windows 開啟 Claude／ChatGPT）
  → 使用者貼上／附檔／傳送
  → AI 回覆 checkpoint JSON
  → 使用者貼回 Hub
  → 預覽逐欄差異
  → 明確確認匯入 Memory + nextAction
```

這個協定不依賴付費 API、不讀私人聊天資料、不要求兩個 Agent 的對話格式相容。Hub 也不會假裝桌面聊天 App 自動取得了本機資料夾權限。

## Windows App 啟動

`server/desktop-apps.ts` 透過受限的固定 PowerShell 指令呼叫 Windows `Get-StartApps`，只尋找顯示名稱恰好為 **Claude** 或 **ChatGPT** 的登記項目。

- 使用實際登記的 AppID，不硬編碼猜測的 package ID 或自訂 protocol。
- AppID 經格式驗證；重複／模糊的登記不會任選一個。
- 只透過可信任的系統 Explorer，傳入單一 `shell:AppsFolder\<AppID>` 參數；不用 `shell:true`、不拼接專案文字到命令。
- 查詢有限制時間／輸出大小並短暫快取；不掃描 conversation、credential 或 app 內部資料。
- 若找不到，仍可複製 Context 並自行開啟 App，不自動下載、不回退到未經確認的雲端網站。
- 目前 registered-app adapter 支援 Windows；其他平台會回報不可用，不猜平台命令。

啟動成功只表示 Windows 接受開啟請求，不保證新視窗已顯示，也不會選擇特定對話、專案或自動貼上訊息。

## 文字交接協定

`shared/types.ts` 統一五種目標：`claude-desktop`、`chatgpt-desktop`、`generic`、`claude`、`codex`。最後兩者僅用於進階 CLI，不與桌面 App 混用。

Desktop Context 明確要求：

1. 本機路徑只是識別資訊，不能因此宣稱已讀取檔案或取得過往對話。
2. 只根據已提供內容工作，缺少資料請使用者附檔。
3. 沒有檔案或執行工具時，註記尚未驗證，不宣稱測試通過。
4. 工作完成後回傳完整 JSON checkpoint，保留 schemaVersion、projectId、projectName、exportedAt，只更新 memory 與 nextAction。
5. 不嘗試自行修改 state.json、AGENTS.md、CLAUDE.md。

## 貼回安全檢查

接受完整的純 JSON，或只包含一個完整外層 JSON code block；不接受前後解說、多個區塊、半段 JSON 或 JavaScript。

- 原始文字上限 1 MiB，以 UTF-8 bytes 計算。
- 既有嚴格 schema 與欄位長度限制，未知欄位會被拒絕。
- projectId 必須屬於目前項目。
- hash 綁定預覽時的**原始文字**，包括 code fences 與空白。
- revision 綁定開始預覽時的 Hub 版本。
- 編輯貼上文字會立即使預覽失效；另一個視窗改過記憶也需重新預覽。
- 確認匯入後只儲存九個 memory 字串與 nextAction，不匯入任務、路徑、Git facts、生命週期或命令。

AI 回覆仍可能有事實錯誤。Schema 安全不等於內容正確，逐欄審閱是刻意保留的界線。

## 原生功能

Electron preload 只公開明確列出的桌面功能，例如選資料夾、寫入文字剪貼簿與儲存文字檔。所有操作都由主程序核對目前主視窗／主 frame 的 origin 與輸入，沒有任意 filesystem、shell 或原始 IPC 介面。

程式不讀取剪貼簿背景內容；貼回 JSON 由使用者手動執行。檔案儲存經原生 save dialog 決定位置，取消不寫入。

## 進階：CLI 與檔案交換

原有 Claude Code／Codex CLI 仍可從項目 cwd 啟動，但要先在 PATH 安裝。此功能與 registered desktop App 狀態分開顯示。

`.ai-project-hub/state.json` 檔案交接仍可用：初次建立，重複匯出不覆寫；Agent 或協作者更新後，使用者先預覽再匯入。Markdown 快照使用唯一檔名。既有 AGENTS.md／CLAUDE.md 永不被修改。

Claude Code 官方文件中的指示載入、AGENTS.md 支援與 import 行為會受版本／設定影響；普通 Markdown link 不等於 `@path` import。不能假設 Codex 讀 CLAUDE.md，也不能將私人 JSONL 視為穩定的跨廠商 session API。

## 未使用或未假設的能力

- 沒有自動讀取 Claude／ChatGPT Desktop 的私人對話。
- 沒有未公開的 conversation injection、UI auto-typing、登入 token 或模型 API。
- 沒有自動恢復同一個聊天 thread。
- 沒有保證桌面 App 能直接開啟本機專案；使用者可依該 App 的正常功能附檔或授權連接器。
- OpenAI 文件在本次環境未取得，因此不以未核實的 ChatGPT／Codex 自動載入規則作設計前提。

## 官方參考

- [Microsoft：取得 AppUserModelID / Get-StartApps](https://learn.microsoft.com/en-us/windows/configuration/store/find-aumid)
- [Electron 安全建議](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron preload / context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Claude Code memory / instructions](https://code.claude.com/docs/en/memory.md)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions.md)

這些來源支持 OS／Electron／進階 CLI 的實作界線，不代表已取得任何桌面聊天 App 的私人整合 API。
