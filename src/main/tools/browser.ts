// ============================================================
// Playwright 浏览器工具集 — 基于 playwright 的 Chromium
// 工具: browser_navigate / browser_click / browser_type /
//       browser_screenshot / browser_get_text / browser_wait
// ============================================================
import { chromium, type BrowserContext, type Page } from 'playwright'
import { app } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { ToolHandler, ToolContext } from './registry'
import { log } from '../llm/logger'
import { getSettings } from '../store/db'
import { findBundledChromium } from './browserRuntime'

/** 浏览器模式（设置项 browserMode，默认 local） */
type BrowserMode = 'local' | 'headless'

// 全局浏览器实例（懒加载，首次调用时启动）。
// 统一用 launchPersistentContext（专用持久化 profile）：
// cookies / 登录态 / 本地存储跨会话保留——人工过一次验证码后长期有效，
// 同时避免"每次全新空白浏览器"这一最强的机器人特征。
let context: BrowserContext | null = null
let activePage: Page | null = null
/** 当前实例按哪种模式启动（null = 未启动）。设置变更后用于判断是否需要重启 */
let launchedMode: BrowserMode | null = null

function closeBrowserInternal(): Promise<void> {
  const c = context
  context = null
  activePage = null
  launchedMode = null
  return c ? c.close().catch(() => {}) : Promise.resolve()
}

/** 专用持久化 profile 目录（与用户日常 Chrome profile 隔离，避免锁冲突） */
function profileDir(): string {
  return path.join(app.getPath('userData'), 'browser-profile')
}

/**
 * 反检测注入（两种模式都生效）：
 * - navigator.webdriver → undefined（Playwright 默认注入 true，是 Cloudflare/DataDome 等的首要信号）
 * - languages/plugins 补齐（自动化浏览器常见异常值）
 * - window.chrome 兜底（真实 Chrome 必有该全局对象）
 * 配合 launch 参数 --disable-blink-features=AutomationControlled（禁用 blink 层的自动化标志）。
 */
const ANTI_DETECTION_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
`

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check'
]

/**
 * 解析 Chromium 可执行文件路径
 * - dev 模式：由 Playwright 自动从系统缓存目录查找
 * - 打包模式：从 extraResources/browsers/ 下查找
 */
function resolveChromiumPath(): string | undefined {
  if (!app.isPackaged) {
    // dev 模式：让 Playwright 自己找
    return undefined
  }

  // 打包模式：在 extraResources/browsers/ 下递归识别当前平台的 Chromium 布局。
  // Playwright 在 Windows/macOS/Linux 以及不同 CPU 架构下使用不同的中间目录名。
  const browsersDir = path.join(process.resourcesPath, 'browsers')
  if (!fs.existsSync(browsersDir)) {
    log('warn', `[Playwright] Browsers directory not found: ${browsersDir}`)
    return undefined
  }

  const exePath = findBundledChromium(browsersDir)
  if (exePath) {
    log('info', `[Playwright] Using bundled chromium: ${exePath}`)
    return exePath
  }

  log('warn', `[Playwright] Chromium executable not found in: ${browsersDir}`)
  return undefined
}

async function ensureBrowser(): Promise<Page> {
  const mode: BrowserMode = getSettings().browserMode === 'headless' ? 'headless' : 'local'
  // 已运行的浏览器模式与当前设置不一致（用户中途切换了设置）→ 重启使其生效
  if (context && launchedMode !== null && launchedMode !== mode) {
    log('info', `[Playwright] Browser mode changed to ${mode}, restarting browser...`)
    await closeBrowserInternal()
  }
  if (!context) {
    const opts = {
      headless: mode === 'headless',
      args: LAUNCH_ARGS,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      userAgentLocale: 'en-US,en;q=0.9',
      // 每个新文档加载前注入反检测脚本（先于页面 JS 执行）
      addInitScript: { content: ANTI_DETECTION_SCRIPT }
    }
    if (mode === 'local') {
      // 调用本机 Google Chrome（channel 由 Playwright 自动定位安装路径，
      // 未安装会抛错 → 回退内置 Chromium 可视模式，行为不变）
      try {
        log('info', '[Playwright] Launching local Chrome (visible window)...')
        context = await chromium.launchPersistentContext(profileDir(), { ...opts, channel: 'chrome' })
      } catch (err) {
        log('warn', `[Playwright] Local Chrome unavailable (${(err as Error).message}); falling back to bundled Chromium`)
        context = await chromium.launchPersistentContext(profileDir(), opts)
      }
    } else {
      log('info', '[Playwright] Launching bundled chromium (headless)...')
      const executablePath = resolveChromiumPath()
      context = await chromium.launchPersistentContext(
        profileDir(),
        executablePath ? { ...opts, executablePath } : opts
      )
    }
    launchedMode = mode
    activePage = context.pages()[0] ?? (await context.newPage())
    log('info', '[Playwright] Browser ready')
  }
  if (!activePage || activePage.isClosed()) {
    activePage = await context.newPage()
  }
  return activePage
}

// ---- 导航 ----
export const browserNavigateTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: [
        'Navigate the browser to a URL. Returns the final URL and page title.',
        'Usage:',
        '- Call this first to start browser automation; subsequent actions operate on the loaded page.',
        '- For single-page apps or slow pages, use wait_until="networkidle" to wait until network activity settles before inspecting content.',
        '- After navigating, inspect the page with browser_screenshot or browser_get_text before interacting with it.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to (include http:// or https://)' },
          wait_until: { type: 'string', description: 'Wait strategy: load (default) | domcontentloaded | networkidle' }
        },
        required: ['url']
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const url = args.url as string
    const waitUntil = (args.wait_until as 'load' | 'domcontentloaded' | 'networkidle') || 'load'
    try {
      const page = await ensureBrowser()
      await page.goto(url, { waitUntil, timeout: 30000 })
      const title = await page.title()
      return `Navigated to: ${page.url()}\nTitle: ${title}`
    } catch (err) {
      return `Error navigating: ${(err as Error).message}`
    }
  }
}

// ---- 点击 ----
export const browserClickTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_click',
      description: [
        'Click an element on the page.',
        'Usage:',
        '- Use a CSS selector (#id, .class, tag, or compound selectors) to target the element precisely.',
        '- Use text=Visible Text to click by visible text when a CSS selector is awkward (e.g. text=Submit, text=Next Page).',
        '- If the click fails or the element is not found, take a browser_screenshot or browser_get_text first to see the current page state and find the correct selector.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (e.g. "#submit-btn", ".nav a") or text=Visible Text to match by visible text' },
          timeout: { type: 'number', description: 'Wait timeout in milliseconds, default 10000' }
        },
        required: ['selector']
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const selector = args.selector as string
    const timeout = (args.timeout as number) || 10000
    try {
      const page = await ensureBrowser()
      // text= 前缀转为 Playwright 的文本选择器
      const loc = selector.startsWith('text=')
        ? page.getByText(selector.slice(5), { exact: false }).first()
        : page.locator(selector).first()
      await loc.click({ timeout })
      return `Clicked: ${selector}`
    } catch (err) {
      return `Error clicking "${selector}": ${(err as Error).message}`
    }
  }
}

// ---- 输入文本 ----
export const browserTypeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element. Clears the existing content first (fill, not append). Use press_enter=true to submit forms.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器定位输入框' },
          text: { type: 'string', description: '要输入的文本' },
          press_enter: { type: 'boolean', description: '输入完成后是否按回车键，默认 false' }
        },
        required: ['selector', 'text']
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const selector = args.selector as string
    const text = args.text as string
    const pressEnter = args.press_enter as boolean
    try {
      const page = await ensureBrowser()
      await page.locator(selector).first().fill(text, { timeout: 10000 })
      if (pressEnter) await page.keyboard.press('Enter')
      return `Typed "${text}" into ${selector}${pressEnter ? ' + Enter' : ''}`
    } catch (err) {
      return `Error typing into "${selector}": ${(err as Error).message}`
    }
  }
}

// ---- 截图 ----
export const browserScreenshotTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: [
        'Capture a screenshot of the current page. The image is returned to you for visual analysis — you can see the rendered layout, find buttons/inputs, and verify the result of an action.',
        'Usage:',
        '- Use this to inspect the page state when you are unsure which selectors exist, or to verify that a click/typing/navigation produced the expected result.',
        '- Use full_page=true to capture the entire scrollable page, not just the viewport.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to save the screenshot (.png). Defaults to a timestamped file in the workspace' },
          full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of just the viewport, default false' }
        }
      }
    }
  },
  permission: 'safe' as const,
  async execute(args, ctx) {
    const fullPage = args.full_page as boolean
    const path = require('node:path') as typeof import('node:path')
    const fs = require('node:fs') as typeof import('node:fs')
    const filePath = (args.file_path as string) || path.join(ctx.workspacePath, `screenshot-${Date.now()}.png`)
    try {
      const page = await ensureBrowser()
      // 同时保存到文件和获取 base64
      const screenshotBuffer = await page.screenshot({ path: filePath, fullPage, type: 'png' })
      const size = fs.statSync(filePath).size
      // screenshotBuffer 是 Buffer，转为 base64
      const base64 = Buffer.isBuffer(screenshotBuffer)
        ? screenshotBuffer.toString('base64')
        : Buffer.from(screenshotBuffer).toString('base64')
      return {
        content: `Screenshot saved to ${filePath} (${size} bytes)`,
        attachments: [{ type: 'image', mediaType: 'image/png', base64, detail: 'auto' }]
      }
    } catch (err) {
      return `Error taking screenshot: ${(err as Error).message}`
    }
  }
}

// ---- 获取页面文本 ----
export const browserGetTextTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Extract visible text content from the page. Lighter than a screenshot — prefer it when you only need text (forms, lists, labels). Use a CSS selector to target a region; omit it for the whole page body.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，不填则获取整个页面 body 文本' },
          max_length: { type: 'number', description: '返回文本的最大字符数，默认 5000' }
        }
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const selector = args.selector as string
    const maxLength = (args.max_length as number) || 5000
    try {
      const page = await ensureBrowser()
      let text: string
      if (selector) {
        text = await page.locator(selector).first().innerText({ timeout: 10000 })
      } else {
        text = await page.locator('body').innerText()
      }
      if (text.length > maxLength) text = text.slice(0, maxLength) + '\n... (truncated)'
      return text || '(no text found)'
    } catch (err) {
      return `Error getting text: ${(err as Error).message}`
    }
  }
}

// ---- 等待 ----
export const browserWaitTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待页面上的元素出现、消失，或等待固定时间。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '等待类型: selector (等元素出现) | selector_gone (等元素消失) | timeout (固定等待)', enum: ['selector', 'selector_gone', 'timeout'] },
          selector: { type: 'string', description: 'CSS 选择器 (type=selector/selector_gone 时必填)' },
          timeout: { type: 'number', description: '超时毫秒数 (type=timeout 时为等待毫秒数，默认 3000)' }
        },
        required: ['type']
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const type = args.type as string
    const selector = args.selector as string
    const timeout = (args.timeout as number) || 3000
    try {
      const page = await ensureBrowser()
      if (type === 'timeout') {
        await page.waitForTimeout(timeout)
        return `Waited ${timeout}ms`
      } else if (type === 'selector') {
        await page.locator(selector).first().waitFor({ state: 'visible', timeout })
        return `Element "${selector}" appeared`
      } else if (type === 'selector_gone') {
        await page.locator(selector).first().waitFor({ state: 'hidden', timeout })
        return `Element "${selector}" disappeared`
      }
      return 'Error: invalid wait type'
    } catch (err) {
      return `Error waiting: ${(err as Error).message}`
    }
  }
}

// ---- 获取页面 HTML ----
export const browserGetHtmlTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_get_html',
      description: 'Get the HTML of a page element. Use this when you need to discover the exact CSS selectors/structure of a section (e.g. to build a selector for click/type). Omit the selector for the whole body.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，不填则获取 body HTML' },
          max_length: { type: 'number', description: '返回 HTML 的最大字符数，默认 5000' }
        }
      }
    }
  },
  permission: 'safe' as const,
  async execute(args) {
    const selector = args.selector as string
    const maxLength = (args.max_length as number) || 5000
    try {
      const page = await ensureBrowser()
      const html = await page.locator(selector || 'body').first().innerHTML()
      let result = html || '(no html)'
      if (result.length > maxLength) result = result.slice(0, maxLength) + '\n... (truncated)'
      return result
    } catch (err) {
      return `Error getting HTML: ${(err as Error).message}`
    }
  }
}

// ---- 关闭浏览器 ----
export const browserCloseTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭浏览器实例，释放资源。在完成所有浏览器操作后应该调用。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  permission: 'safe' as const,
  async execute() {
    try {
      if (context) {
        await closeBrowserInternal()
        log('info', '[Playwright] Browser closed')
        return 'Browser closed'
      }
      return 'Browser was not open'
    } catch (err) {
      return `Error closing browser: ${(err as Error).message}`
    }
  }
}

// 导出所有浏览器工具
export const browserTools: { name: string; handler: ToolHandler }[] = [
  { name: 'browser_navigate', handler: browserNavigateTool },
  { name: 'browser_click', handler: browserClickTool },
  { name: 'browser_type', handler: browserTypeTool },
  { name: 'browser_screenshot', handler: browserScreenshotTool },
  { name: 'browser_get_text', handler: browserGetTextTool },
  { name: 'browser_get_html', handler: browserGetHtmlTool },
  { name: 'browser_wait', handler: browserWaitTool },
  { name: 'browser_close', handler: browserCloseTool }
]
