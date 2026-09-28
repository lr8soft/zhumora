// ============================================================
// 后台运行（Path A）：关窗收进系统托盘，main 进程继续运行。
//
// 本模块是 Electron 适配层：托盘菜单 + 系统通知。策略判断
// （什么时候提醒）全部在 backgroundPolicy.ts 纯函数里，本文件
// 只负责创建/销毁 Tray/Notification 与把事件接到策略上。
//
// 它订阅 SessionEventHub（完成/出错）和 PermissionBroker（挂起审批），
// 不修改任何会话、权限或 Agent 协议。Agent 本体仍在 main 进程内
// 由 SessionService 驱动，窗口隐藏只是让其"继续实时运行"。
// ============================================================
import { Notification, Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { AgentEventSink } from './agent/persistedCallbacks'
import type { PermissionBroker } from './agent/permissionBroker'
import {
  backgroundStringsFor,
  permissionBody,
  runEndBody,
  shouldNotifyPermission,
  shouldNotifyRunEnd,
  type RunEndKind
} from './backgroundPolicy'
import { log } from './llm/logger'

export interface BackgroundMainWindow {
  isVisible(): boolean
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface BackgroundManagerOptions {
  /** 订阅全局会话事件（返回取消订阅函数） */
  subscribeEvents: (sink: AgentEventSink) => () => void
  /** 挂起权限状态观察器（返回取消函数） */
  permissions: Pick<PermissionBroker, 'addObserver'>
  getSessionTitle: (sessionId: string) => string | null
  /** 当前生效 UI 语言码（en/zh/ja/es/fr/de；'auto' 回落 en，托盘不接 renderer 检测器） */
  getLanguage: () => string
  getMainWindow: () => BackgroundMainWindow | null
  trayIconPath: string
  quitApp: () => void
}

export class BackgroundManager {
  private readonly opts: BackgroundManagerOptions
  private readonly tray: Tray
  private readonly unsubscribeEvents: () => void
  private readonly unsubscribeObserver: () => void
  private readonly permNotifications = new Map<string, Notification>()

  constructor(opts: BackgroundManagerOptions) {
    this.opts = opts
    const icon = nativeImage.createFromPath(opts.trayIconPath)
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    this.tray.setToolTip('Zhumora')
    // 左键点击 = 打开窗口（与 dock/任务栏行为一致）
    this.tray.on('click', () => this.showWindow())
    this.tray.on('right-click', () => this.tray.setContextMenu(this.buildMenu()))
    this.tray.setContextMenu(this.buildMenu())

    this.unsubscribeEvents = opts.subscribeEvents(this.createSink())
    this.unsubscribeObserver = opts.permissions.addObserver((sessionId, pending) => this.onPermissionState(sessionId, pending))
  }

  showWindow(): void {
    const win = this.opts.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  dispose(): void {
    this.unsubscribeEvents()
    this.unsubscribeObserver()
    for (const n of this.permNotifications.values()) n.close()
    this.permNotifications.clear()
    this.tray.destroy()
  }

  private isVisible(): boolean {
    const win = this.opts.getMainWindow()
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  private buildMenu(): Menu {
    const s = backgroundStringsFor(this.opts.getLanguage())
    const items: MenuItemConstructorOptions[] = [
      { label: s.show, click: () => this.showWindow() },
      { type: 'separator' },
      { label: s.quit, click: () => this.opts.quitApp() }
    ]
    return Menu.buildFromTemplate(items)
  }

  private createSink(): AgentEventSink {
    const self = this
    return {
      // aborted 不通知（用户/外部主动中止，见 shouldNotifyRunEnd）
      complete: sessionId => self.notifyRunEnd(sessionId, 'complete'),
      error: sessionId => self.notifyRunEnd(sessionId, 'error')
    }
  }

  private notifyRunEnd(sessionId: string, kind: RunEndKind): void {
    const outcome = shouldNotifyRunEnd({ windowVisible: this.isVisible(), kind })
    if (!outcome) return
    const strings = backgroundStringsFor(this.opts.getLanguage())
    const body = runEndBody(outcome, this.opts.getSessionTitle(sessionId), strings)
    this.buildNotification(body)?.show()
  }

  private onPermissionState(sessionId: string, pending: boolean): void {
    const existing = this.permNotifications.get(sessionId)
    if (pending) {
      if (!shouldNotifyPermission({ windowVisible: this.isVisible(), pending: true })) return
      if (existing) return
      const strings = backgroundStringsFor(this.opts.getLanguage())
      const n = this.buildNotification(permissionBody(this.opts.getSessionTitle(sessionId), strings))
      if (n) {
        this.permNotifications.set(sessionId, n)
        n.show()
      }
    } else if (existing) {
      existing.close()
      this.permNotifications.delete(sessionId)
    }
  }

  private buildNotification(body: string): Notification | null {
    if (!Notification.isSupported()) return null
    const n = new Notification({ title: 'Zhumora', body })
    try { n.icon = this.opts.trayIconPath } catch { /* 图标失败不影响通知 */ }
    n.on('click', () => this.showWindow())
    n.on('error', err => log('warn', `Background notification failed: ${String(err)}`))
    return n
  }
}
