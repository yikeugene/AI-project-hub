import type { MessageCatalog } from '../../shared/i18n';
const en = {
  title: 'Joined groups', subtitle: 'Each group has separate membership, sharing choices, and background sync. Switching the management group does not stop other groups.',
  management: 'Current management group', manage: 'Manage this group', managed: 'Managing this group', none: 'No groups joined yet.',
  label: 'Local group label', labelHint: 'Only changes this computer’s label; it does not rename the cloud group.', saveLabel: 'Save label', labelSaved: 'Group label saved.',
  join: 'Join another group', joinFirst: 'Join a group', joinHint: 'New groups start with no shared projects or extra device status. Adding a group does not rename this computer.',
  joinLabel: 'Group label (optional)', joinLabelHint: 'Use a local label to distinguish groups. You can edit it later.',
  identity: 'Group ID: {id}', membership: 'Membership device ID: {id}', lastSync: 'Last group sync: {date}', pending: 'Pairing pending',
  switchTitle: 'Discard unsaved group settings?', switchConfirm: 'Discard and switch group', switchDescription: 'Unsaved fields and previews on this settings page will be discarded. Saved policies and other groups’ background work are unaffected.',
  leaveTitle: 'Leave this group locally?', leaveConfirm: 'Remove local pairing',
  leaveDescription: 'Only this group’s saved credentials are removed and its summaries are hidden. Other groups stay connected. This does not revoke the cloud membership or delete cloud data. Previously downloaded Markdown and other devices’ copies remain.',
  groupContext: 'Group: {label} ({id})', joinBlocked: 'Save or discard sharing and status drafts before joining another group.',
} as const;
export const groupMessages: MessageCatalog<keyof typeof en> = { en, 'zh-TW': {
  title: '已加入群組', subtitle: '每個群組各自保有會員身分、共享選擇與背景同步；切換管理群組不會停止其他群組。',
  management: '目前管理群組', manage: '管理此群組', managed: '目前管理中', none: '尚未加入群組。',
  label: '本機群組標籤', labelHint: '只修改這台電腦的標籤，不會重新命名雲端群組。', saveLabel: '儲存標籤', labelSaved: '群組標籤已儲存。',
  join: '加入另一個群組', joinFirst: '加入群組', joinHint: '新群組預設不共享任何專案或額外設備狀態；加入群組不會重新命名這台電腦。',
  joinLabel: '群組標籤（選填）', joinLabelHint: '使用本機標籤區分群組，之後仍可修改。',
  identity: '群組 ID：{id}', membership: '會員設備 ID：{id}', lastSync: '最近群組同步：{date}', pending: '配對待完成',
  switchTitle: '捨棄尚未儲存的群組設定？', switchConfirm: '捨棄並切換群組', switchDescription: '會捨棄此設定頁尚未儲存的欄位與預覽；已儲存的政策及其他群組的背景工作不受影響。',
  leaveTitle: '在本機離開此群組？', leaveConfirm: '移除本機配對',
  leaveDescription: '只移除此群組已保存的憑證並隱藏其摘要，其他群組保持連線。這不會撤銷雲端會員或刪除雲端資料；已下載的 Markdown 及其他設備副本仍然保留。',
  groupContext: '群組：{label}（{id}）', joinBlocked: '加入另一個群組前，請先儲存或捨棄共享與狀態草稿。',
} };
