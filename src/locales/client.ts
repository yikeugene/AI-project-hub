import type { MessageCatalog } from '../../shared/i18n';

const en = {
  connection: 'Cannot connect to the local service. Check that AI Project Hub is still running and try again.',
  response: 'The local service returned an unreadable response. Reload or check the service.',
  request: 'Request failed ({status}). Please try again.',
  incomplete: 'The operation did not finish. Please try again.',
  conflict: 'There are newer changes. Your edits have not been overwritten. Keep your input, reload the latest version, and merge your changes.',
  deviceBusy: 'A device operation is still running. Please wait.',
  languageBusy: 'A language change is still being saved. Please wait.',
  unavailableWorkspace: 'Wait for the workspace to connect before changing the language.',
  clipboard: 'This browser cannot access the clipboard. Download the content or select the preview text and copy it manually.',
  noRecord: 'No record yet', unknownDate: 'Unknown date', noActivity: 'No activity yet',
  paused: 'Connection paused', unconfigured: 'Not paired', idle: 'Waiting to sync', syncing: 'Syncing', online: 'Connected to cloud',
  connectionError: 'Connection failed', revokedDevice: 'This device has been revoked', locked: 'Cannot unlock device credentials',
  queued: 'Queued', submitted: 'Submitted to cloud', received: 'Delivered', failed: 'Delivery failed; retry pending',
  read: 'Read', applied: 'Accepted and applied', rejected: 'Rejected', conflictDecision: 'Version conflict; not applied', expired: 'Expired; not applied',
  revoked: 'Revoked', recent: 'Recently online', offline: 'Offline / status not updated', withdrawn: 'This summary has been withdrawn. Changes cannot be proposed.',
};
const zh: Record<keyof typeof en, string> = {
  connection: '無法連線到本機服務。請確認 AI Project Hub 仍在執行，再重試。',
  response: '服務回傳了無法讀取的內容。請重新整理，或檢查本機服務。',
  request: '請求失敗（{status}）。請重試。', incomplete: '操作未完成，請重試。',
  conflict: '內容已有其他更新，尚未覆寫您的變更。請保留目前輸入，重新載入最新版本後再合併。',
  deviceBusy: '設備操作仍在進行，請稍候。', languageBusy: '正在儲存語言選擇，請稍候。', unavailableWorkspace: '請等候工作台連線後再切換語言。',
  clipboard: '此瀏覽器無法存取剪貼簿。請下載內容，或選取預覽文字後手動複製。',
  noRecord: '尚無紀錄', unknownDate: '日期未知', noActivity: '尚無活動',
  paused: '連線已暫停', unconfigured: '尚未配對', idle: '等待同步', syncing: '正在同步', online: '雲端已連線',
  connectionError: '連線失敗', revokedDevice: '這台設備已被撤銷', locked: '無法解鎖設備憑證',
  queued: '待送出', submitted: '已提交雲端', received: '已送達', failed: '傳送失敗，等待重試',
  read: '已讀', applied: '已接受並套用', rejected: '已拒絕', conflictDecision: '版本衝突，未套用', expired: '已過期，未套用',
  revoked: '已撤銷', recent: '最近上線', offline: '離線／狀態未更新', withdrawn: '這個摘要已撤回，不能提出變更。',
};
export const clientMessages: MessageCatalog<keyof typeof en> = { en, 'zh-TW': zh };
