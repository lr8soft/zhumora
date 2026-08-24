// ============================================================
// Settings 变更广播 — 主进程内非 IPC 路径（如 agent 工具）修改 settings 后，
// 通知所有渲染窗口重新拉取设置（前端设置页保持与 DB 同步）
// ============================================================
import { BrowserWindow } from 'electron'

/** 广播 settings 已变更（调用方需已持久化到 DB） */
export function broadcastSettingsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('settings:changed')
    }
  }
}
