import type { MessageCatalog } from '../i18n.js';
const en = {
  shutdownFailed: 'AI Project Hub could not close', startupFailed: 'AI Project Hub could not start', trusted: 'Only the AI Project Hub main window may perform this operation.',
  directory: 'Choose a local project folder', save: 'Save handoff document', text: 'Text document', invalidSave: 'Choose a Markdown, JSON or text filename and content of at most 1 MB.', invalidClipboard: 'Clipboard content must be text of at most 1 MB.', credentials: 'Secure credential storage is unavailable.',
  unsaved: 'Unsaved content', closeQuestion: 'Discard unsaved changes and close the window?', closeDetail: 'Continue editing to save your changes or export a draft first.', continueEditing: 'Continue editing', discardClose: 'Discard and close',
  file: 'File', open: 'Open AI Project Hub', quit: 'Quit AI Project Hub', edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', view: 'View', actualSize: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Full screen', help: 'Help', about: 'About AI Project Hub',
  aboutDetail: 'A local-first project workbench.\nClaude / ChatGPT Desktop handoffs use explicit copying and pasted checkpoints.\nHub does not read chats or send messages to chat apps automatically.',
  updateTitle: 'Software updates', updateIntro: 'Updates are checked and downloaded only when you choose. Ordinary app exit never installs an update.',
  currentVersion: 'Current version', check: 'Check for updates', download: 'Download update', install: 'Restart and update', releases: 'Open GitHub Releases',
  idle: 'Ready to check for updates.', checking: 'Checking GitHub Releases…', current: 'You are using the latest eligible stable version.', available: 'Version {version} is available.', downloading: 'Downloading update… {progress}%', downloaded: 'Version {version} is ready to install.', installing: 'Closing safely and starting the installer…', error: 'The update could not be completed. Check the details and try again.',
  unconfigured: 'The maintainer has not configured a GitHub update source yet.', development: 'In-app installation is unavailable in development mode.', portable: 'Portable editions must be updated manually. Download the new executable from the official release page, close this app, then replace it.', unpacked: 'This is an unpacked build, not an installed NSIS edition. Install an official Setup release to enable in-app updates.', customData: 'Automatic installation is disabled for a custom data directory. Download and install manually, then reopen with the same --data-dir or HUB_DATA_DIR.', unsupportedPlatform: 'In-app installation is supported only by the Windows NSIS edition.', web: 'Browser mode cannot install desktop updates.',
  installTitle: 'Restart and install update?', installWarning: 'The app will close to install the downloaded update. Save your work first. Unsaved edits will still require confirmation.', cancel: 'Cancel', updateFailed: 'AI Project Hub update failed',
};
const zh: Record<keyof typeof en, string> = {
  shutdownFailed: 'AI Project Hub 關閉失敗', startupFailed: 'AI Project Hub 無法啟動', trusted: '只接受 AI Project Hub 主視窗的操作。',
  directory: '選擇本機專案資料夾', save: '儲存交接文件', text: '文字文件', invalidSave: '請使用 Markdown、JSON 或文字檔名，內容不得超過 1 MB。', invalidClipboard: '剪貼簿內容必須為文字，且不得超過 1 MB。', credentials: '安全憑證儲存不可用。',
  unsaved: '還有尚未儲存的內容', closeQuestion: '要捨棄尚未儲存的變更並關閉視窗嗎？', closeDetail: '選擇繼續編輯，可先儲存變更或匯出草稿。', continueEditing: '繼續編輯', discardClose: '捨棄變更並關閉',
  file: '檔案', open: '開啟 AI Project Hub', quit: '完全退出 AI Project Hub', edit: '編輯', undo: '復原', redo: '重做', cut: '剪下', copy: '複製', paste: '貼上', selectAll: '全選', view: '檢視', actualSize: '實際大小', zoomIn: '放大', zoomOut: '縮小', fullscreen: '全螢幕', help: '說明', about: '關於 AI Project Hub',
  aboutDetail: '本機優先的個人開發控制中心。\nClaude／ChatGPT Desktop 使用明確複製及貼回 checkpoint 的交接流程。\n不自動讀取對話或向聊天 App 傳送訊息。',
  updateTitle: '軟件更新', updateIntro: '只在您選擇時檢查與下載。一般關閉軟件不會安裝更新。',
  currentVersion: '目前版本', check: '檢查更新', download: '下載更新', install: '重啟並更新', releases: '開啟 GitHub Releases',
  idle: '可以檢查新版。', checking: '正在檢查 GitHub Releases…', current: '目前已是適用的最新穩定版本。', available: '已有新版本 {version}。', downloading: '正在下載更新… {progress}%', downloaded: '版本 {version} 已準備好安裝。', installing: '正在安全關閉並啟動安裝程式…', error: '更新未能完成。請檢查詳細訊息後重試。',
  unconfigured: '維護者尚未設定 GitHub 更新來源。', development: '開發模式無法在軟件內安裝更新。', portable: '免安裝版須手動更新。請從官方發佈頁下載新執行檔，關閉本程式後再替換。', unpacked: '這是展開的測試版本，不是已安裝的 NSIS 版本。請安裝官方 Setup 發行檔以啟用軟件內更新。', customData: '使用自訂資料目錄時停用自動安裝。請手動下載及安裝，並使用原有 --data-dir 或 HUB_DATA_DIR 重新開啟。', unsupportedPlatform: '軟件內安裝僅支援 Windows NSIS 安裝版。', web: '瀏覽器模式無法安裝桌面更新。',
  installTitle: '重新啟動並安裝更新？', installWarning: '程式將關閉以安裝已下載的更新，請先儲存工作。尚未儲存的編輯仍會另外要求確認。', cancel: '取消', updateFailed: 'AI Project Hub 更新失敗',
};
export const desktopMessages: MessageCatalog<keyof typeof en> = { en, 'zh-TW': zh };
