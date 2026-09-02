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

export let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: 'Zhumora',
    backgroundColor: '#f5f6f8',
    icon: is.dev
      ? path.join(__dirname, '../../src/renderer/public/icon.ico')
      : path.join(__dirname, '../renderer/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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

  // 创建窗口
  const win = createWindow()

  // 设置 IPC
  setupIpc(win)

  // 注册日志转发：主进程 → 渲染进程
  onLog(({ level, msg, ts }) => {
    mainWindow?.webContents.send('agent:log', { level, msg, ts })
  })

  // 启动时自动连接已配置的 MCP 服务器
  const settings = getSettings()
  if (settings.mcpServers?.length > 0) {
    log('info', `Auto-connecting ${settings.mcpServers.length} MCP server(s) on startup`)
    reconnectAllMcpServers(settings.mcpServers).catch((err) => {
      log('error', `Failed to connect MCP servers on startup: ${err}`)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeDesktopAdapter().catch(error => {
    log('warn', `Failed to stop desktop automation process: ${String(error)}`)
  })
})
