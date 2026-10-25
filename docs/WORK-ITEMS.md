# 小成果與跨專案接續 / Work items

本功能自 **v0.9.0** 起提供，使用本機 SQLite **schema v7**。升級前請完全退出 Hub，備份整個資料目錄。v0.8.0 及更舊版不能開啟 v7 資料庫，回退需還原升級前備份，沒有自動降版。

Available since **v0.9.0**, using local SQLite **schema v7**. Quit Hub and back up the entire data directory before upgrading. v0.8.0 and earlier cannot open v7 databases; reverting requires a compatible pre-upgrade backup.

## 用途

**派工前說清楚，切換後接得回，驗證後才完成。** 一個小成果是一個可以驗收的工作範圍，不是整個專案，也不是 AI 對話紀錄。可以同時有多個專案與成果，不要求搭檔登入。

## 人工工作流程

- 從首頁或專案詳情新增小成果。先填一句目標也能保存草稿；準備好時填寫標題、目標、非目標、驗收條件、返回後第一個檢查動作。
- 確認本輪範圍。預覽並複製任務說明，再到 Codex 自行貼上、送出。**複製不會標記交出**；確實送出後另按「我已交給 Codex」。
- 去處理另一個專案。原工作持續留在待接回；Hub 不偵測 Codex 是否仍在執行，不發桌面通知。
- 回來先看原目標、驗收條件與第一檢查動作，再明確開始檢查。自己直接完成的工作也可以進入檢查，不需要假裝派給 AI。
- 分別記錄本人與搭檔的通過/失敗、簡短結果。搭檔可透過訊息、電話、當面或其他方式回報，由本人代記來源；這是工作紀錄，不是對搭檔身分的系統簽核。
- 兩方對目前同一成果版本通過後，另按完成。任何一方尚未驗證或失敗，都不能完成。

**Manual flow:** draft → confirm scope → preview/copy → explicitly mark handed off → return and review → record both checks → explicitly complete. No account, API key, model connection or network is required. Copying, opening a card, an AI response and Git activity never mean completion.

## 修正、等待與新想法

- 失敗後開始新一輪修正；本輪的舊驗證留存，但不再視為新版本有效。修改已確認範圍、重交或重開完成工作也會開新版本。新版後續派工不再次增加版本。
- 工具不監控外部程式變更。檢查後又改碼時，必須明確開始修正/宣告新一輪，不可沿用舊驗證。
- 新需求另存為新草稿，不默默加入本輪目標。
- 延後、等待審批、暫停不會覆寫原階段。留下原因和恢復動作；有時間的延後到期只會讓工作重新可處理，不自動執行或通知。
- 暫停/封存的專案仍可能有未完成成果。這些項目不會只因專案狀態而從工作清單消失。

## 保存與資料界線

- 草稿與操作都在本機保存。已保存的待接回項目在重新啟動後保留；未保存輸入依離開確認保護，不保證應用崩潰後復原。
- 修訂衝突保留你的輸入，不自動用新修訂覆蓋；確認最新資料後再處理。保存成功但清單刷新失敗，不等於原操作未保存。
- 重試相同操作不重複建立成果、派工或增加版本。操作歷史保存當時的說明快照與驗證。
- 小成果不自動更新舊待辦、專案記憶、專案下一步或 checkpoint；不加入既有裝置共享、訊息、雲端投影或舊 handoff。
- 舊功能保留在次要入口。明確刪除專案會同時刪除該專案的小成果、草稿、快照及驗證紀錄，但不刪除專案資料夾或程式碼。

## 本次沒有的功能

依使用者決定，本次是人工版：**沒有 ChatGPT OAuth、AI 拆解連線、新依賴、Codex 執行整合、完成偵測或桌面提醒。** 不讀取 Codex 登入憑證，不傳送任何工作內容給模型服務。

This implementation deliberately contains no OAuth or model connection. Existing optional device-sharing behavior remains separate and unchanged.

## 驗證

技術驗證與限制見 [WORK-ITEMS-VERIFICATION.md](WORK-ITEMS-VERIFICATION.md)。實用性仍需用三個真實任務試用：說明能直接交給 Codex；切換/隔天回來一分鐘內知道原目標與先檢查什麼；完成者有雙方驗證，未完成者有下一步或等待條件。
