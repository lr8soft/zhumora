// ============================================================
// 主窗口导航策略（纯函数，无 Electron 依赖，可直接单测）。
//
// 背景：主窗口里渲染的是助手消息（含 markdown 超链接）。Chromium 对
// <a href> 的默认行为是同一 tab 导航——点一下链接整个应用窗口就跳走，
// 主进程没有 will-navigate 拦截时这个行为无人阻挡。本模块是
// will-navigate / setWindowOpenHandler 的唯一判定点：
//   - 同源导航（页面内导航、刷新、hash 锚点）放行；
//   - http/https 目标 → 交给系统默认浏览器（main 里 shell.openExternal）；
//   - 其余一切（file:、javascript:、自定义协议、未知 origin）一律拒绝。
// ============================================================

export type NavigationDecision = 'allow' | 'external' | 'deny'

/**
 * @param url 目标 URL
 * @param appOrigin 当前文档 origin（dev server 的 http origin；生产 file:// 文档 origin 为 "null"，
 *        与目标 file: URL 的 origin 相等即同源；未知 origin 传空串）
 */
export function decideNavigation(url: string, appOrigin: string): NavigationDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'deny'
  }
  if (appOrigin && parsed.origin === appOrigin) return 'allow'
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'external' : 'deny'
}
