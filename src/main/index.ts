// ============================================================
// 主进程入口
// ============================================================
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as path from 'node:path'
import { initDatabase, getSettings } from './store/db'
import { setupIpc } from './ipc'
import { reconnectAllMcpServers } from './mcp/client'
import { log, onLog } from './llm/logger'
import { disposeDesktopAdapter } from './desktop/adapter'
import { createApplicationServices } from './composition'
import type { ApplicationServices } from './composition'
import { reloadSkills } from './skill/manager'
import { refreshSkillTool } from './skill/skillTool'
import { AvatarAssetStore } from './avatar/assetStore'
import { AvatarWindowManager } from './avatar/windowManager'
import { reconcileAvatarSessions } from './ipc/registerAvatarIpc'
import { BackgroundManager } from './background'
import { shouldCloseInsteadOfHide } from './backgroundPolicy'

export let mainWindow: BrowserWindow | null = null
let applicationServices: ApplicationServices | null = null
let background: BackgroundManager | null = null
// 区分"关窗收进后台"与"真退出"的唯一标志：只有 app.quit()（托盘退出/系统关机）
// 才会触发 before-quit 置位。窗口自身永远不知道进程要去哪。
let quitting = false

// 后台化后必须保证单实例：用户在窗口隐藏期间再次启动应用时，
// 不能让第二个 main 进程去抢同一份 SQLite / MCP 端口 / Bot 连接。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 840,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: 'Zhumora',
    backgroundColor: '#f5f6f8',
    icon: is.dev
      ? path.join(__dirname, '../../src/renderer/public/icon.ico')
      : path.join(__dirname, '../renderer/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
    // dev 模式自动打开 DevTools
    if (is.dev) {
      mainWindow!.webContents.openDevTools({ mode: 'right' })
    }
  })

  // 关窗 → 收进后台（默认）：拦截 close 事件，仅隐藏不销毁。
  // 窗口销毁（真退出）只发生在 before-quit 置位 quitting 之后，或后台模式被显式关闭时。
  mainWindow.on('close', (event) => {
    const close = shouldCloseInsteadOfHide({
      quitting,
      platform: process.platform,
      dev: is.dev,
      backgroundClose: getSettings().backgroundClose
    })
    if (!close) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // 仅真销毁时触发（退出中 / dev / 用户关闭后台模式 / darwin 红点）。后台 hide 不会走到这里。
  mainWindow.on('closed', () => {
    mainWindow = null
    if (quitting || process.platform === 'darwin') return
    // 真销毁（dev 或显式关闭后台模式）保留原"关主窗即退出"语义：
    // 即使 Avatar 辅助窗口还开着也不能让进程残留。
    if (is.dev || getSettings().backgroundClose === false) app.quit()
  })

  // 导航守卫（唯一判定点见 navigationPolicy）：同源放行，http(s) 转系统浏览器，其余拒绝。
  // will-navigate 拦截消息里 <a href> 的默认同窗口导航；setWindowOpenHandler 拦截 window.open/新窗口。
  // 没有这两道守卫，点一条助手消息里的链接整个主窗口就会跳走。
  // 当前文档 origin 在事件时刻解析（创建窗口时 loadURL/loadFile 尚未执行，getURL 还是 about:blank）。
  const currentAppOrigin = (): string => {
    try {
      return new URL(mainWindow!.webContents.getURL()).origin
    } catch {
      return ''
    }
  }
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, currentAppOrigin())
    if (decision !== 'allow') {
      // 非同源一律拦下，主窗口绝不被导航走；http(s) 额外交给系统浏览器打开
      event.preventDefault()
      if (decision === 'external') void shell.openExternal(url)
    }
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (decideNavigation(details.url, currentAppOrigin()) === 'external') void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发环境加载 dev server，生产环境加载打包文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  // 设置应用信息
  electronApp.setAppUserModelId('com.zhumora.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 初始化数据库
  initDatabase()

  // 组合根：集中构造并注册进程级服务，避免 IPC 层承担初始化副作用。
  const avatar = new AvatarWindowManager({
    preloadPath: path.join(__dirname, '../preload/avatar.cjs'),
    productionHtmlPath: path.join(__dirname, '../renderer/avatar.html'),
    developmentUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    assets: new AvatarAssetStore(path.join(app.getPath('userData'), 'avatars'))
  })
  const services = createApplicationServices(avatar)
  applicationServices = services

  // 创建窗口
  const win = createWindow()

  // 设置 IPC
  setupIpc(win, services)

  // 注册日志转发：主进程 → 渲染进程
  onLog(({ level, msg, ts }) => {
    mainWindow?.webContents.send('agent:log', { level, msg, ts })
  })

  // 启动时自动连接已配置的 MCP 服务器
  const settings = getSettings()
  reconcileAvatarSessions(avatar, settings)
  await reloadSkills(settings.skills)
  refreshSkillTool()
  if (settings.mcpServers?.length > 0) {
    log('info', `Auto-connecting ${settings.mcpServers.length} MCP server(s) on startup`)
    reconnectAllMcpServers(settings.mcpServers).catch((err) => {
      log('error', `Failed to connect MCP servers on startup: ${err}`)
    })
  }
  void services.bots.configureAll(settings).catch(err => {
    log('error', `Failed to start Bot platform(s): ${err instanceof Error ? err.message : String(err)}`)
  })
  void services.mcpServer.configure(settings.mcpServer).catch(err => {
    log('error', `Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`)
  })

  // 后台可见性：托盘 + 系统通知。只读订阅 SessionEventHub 与 PermissionBroker，
  // 不参与会话/权限/Agent 决策（见 background.ts 头注）。
  background = new BackgroundManager({
    subscribeEvents: sink => services.sessions.events.subscribe(sink),
    permissions: services.permissions,
    getSessionTitle: id => services.sessions.getSession(id)?.title ?? null,
    getLanguage: () => getSettings().language ?? 'auto',
    getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    // 托盘/通知用 32px PNG（.ico 多尺寸在 Tray 上取用不一致）
    trayIconPath: is.dev
      ? path.join(__dirname, '../../src/renderer/public/icon-32.png')
      : path.join(__dirname, '../renderer/icon-32.png'),
    quitApp: () => app.quit()
  })

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else if (!mainWindow.isVisible()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
    }
    mainWindow.focus()
  })
})

// 窗口全部销毁不再自动退出：后台模式下主窗口只是隐藏，进程必须存活。
// 真退出唯一入口 = 托盘"退出" / 系统关机 → app.quit() → before-quit 清理链。
// （darwin 上原本就随窗关闭不退出，此处理论上不会走到 quit。）
app.on('window-all-closed', () => {
  if (quitting) return
  // 兜底：非后台模式（dev / 用户关闭后台）下 window-all-closed 仍是合理退出点，
  // 与 macOS 行为对齐（darwin 不退出）。
  if (process.platform !== 'darwin' && (is.dev || getSettings().backgroundClose === false)) {
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
  background?.dispose()
  void applicationServices?.bots.stopAll()
  void applicationServices?.mcpServer.stop()
  void applicationServices?.sessions.stopAll()
  applicationServices?.permissions.dispose()
  applicationServices?.avatar.dispose()
  applicationServices?.tts.dispose()
  applicationServices?.desktopControl.dispose()
  void disposeDesktopAdapter().catch(error => {
    log('warn', `Failed to stop desktop automation process: ${String(error)}`)
  })
})
