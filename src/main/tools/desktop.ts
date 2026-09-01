// ============================================================
// 桌面观察工具集 — 单一原子工具 `desktop`（仅截图）
//
// 设计要点（参考 Anthropic computer-use）：
// 1. 截图走 Electron desktopCapturer：robotjs screen.capture() 的 C++
//    绑定返回"外部内存 buffer"，而 Electron 43 内置 Node 22 禁用外部 buffer，
//    一调用就抛 "External buffers are not allowed"。desktopCapturer 返回
//    NativeImage（Electron 内部管理），toPNG() 正常。
// 2. 截图固定缩放到 ≤1280px 宽（对齐 vision 模型舒适区，省 token），
//    并在文本中同时报告图像尺寸与物理屏幕尺寸。
//
// 说明：本工具集只负责"观察"桌面（截图喂给视觉模型）。鼠标/键盘等输入
// 能力已移除（原先由 robotjs 提供，体验不佳且跨平台成本高），如需交互
// 请走浏览器自动化（browser_*）或 bash。
// ============================================================
import { desktopCapturer, screen as electronScreen } from 'electron'
import type { ToolHandler } from './registry'

export const DESKTOP_TOOL_NAME = 'desktop'

/** 截图缩放后的最大宽度（像素）。超过则等比缩小。 */
const MAX_IMAGE_WIDTH = 1280

/** 主屏物理像素尺寸（用于向模型报告屏幕空间） */
function getScreenPhysicalSize(): { width: number; height: number } {
  const display = electronScreen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale)
  }
}

// ============================================================
// 截图（desktopCapturer → NativeImage.toPNG）
// ============================================================

/**
 * 截取主屏，等比缩放到 ≤MAX_IMAGE_WIDTH 宽，返回 PNG base64 + 实际图像尺寸。
 */
export async function captureScreen(): Promise<{ base64: string; width: number; height: number }> {
  const display = electronScreen.getPrimaryDisplay()
  const logicalW = display.size.width
  const logicalH = display.size.height
  // 以逻辑尺寸捕获（desktopCapturer 屏幕源为逻辑空间），再限宽
  const targetW = Math.min(MAX_IMAGE_WIDTH, logicalW)
  const targetH = Math.max(1, Math.round((logicalH * targetW) / logicalW))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH },
    fetchWindowIcons: false
  })
  if (sources.length === 0) throw new Error('desktopCapturer 未返回任何屏幕源')

  // 多屏时取第一个屏幕源（主屏）；NativeImage 尺寸已实测与请求一致
  const img = sources[0].thumbnail
  const actual = img.getSize()
  const png = img.toPNG() // Buffer，PNG 数据（89 50 4E 47 开头，已实测）

  return { base64: png.toString('base64'), width: actual.width, height: actual.height }
}

/** 截图元信息文本（与图像一起返回，告知 LLM 图像与物理屏幕尺寸） */
function screenshotMeta(width: number, height: number): string {
  const screen = getScreenPhysicalSize()
  return `Screenshot (primary screen): image ${width}x${height}px, physical screen ${screen.width}x${screen.height}px.`
}

// ============================================================
// 工具定义
// ============================================================

export const desktopTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: DESKTOP_TOOL_NAME,
      description:
        'Capture a screenshot of the primary screen for visual analysis (observation only — it does NOT control the mouse or keyboard). ' +
        'Use this to see what is currently on the user\'s screen. To interact with web content, prefer the browser_* tools.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['screenshot'],
            description: 'screenshot: capture the primary screen and return it as an image for visual analysis.'
          }
        },
        required: ['action']
      }
    }
  },
  permission: 'normal',
  async execute(args) {
    const action = args.action as string
    if (action === 'screenshot') {
      const { base64, width, height } = await captureScreen()
      return `__IMAGE_BASE64__:${base64}\n${screenshotMeta(width, height)}`
    }
    return `Unknown action "${action}". This tool only supports "screenshot" (the desktop is observation-only — mouse/keyboard control has been removed). Use the browser_* tools or bash to interact with the system.`
  }
}

// ============================================================
// 导出（ipc/index.ts 按 { name, handler } 数组注册）
// ============================================================
export const desktopTools: { name: string; handler: ToolHandler }[] = [
  { name: DESKTOP_TOOL_NAME, handler: desktopTool }
]
