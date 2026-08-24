// ============================================================
// 统一 HTTP 出口 — 支持"使用系统证书库"开关
//
// 背景：Node 内置 fetch（undici）用的是打包在二进制里的 Mozilla CA 库，
// 不读操作系统证书库。当 LLM / MCP 端点使用自签名证书或内网 CA 时，
// 即使把证书导入 Windows 系统证书库，undici 仍然报
// "fetch failed"（cause: self signed certificate）。
//
// Electron 的 net.fetch 走 Chromium 网络栈，信任源与 Chrome 完全一致
// （Windows 系统证书库 / 受信任的根证书颁发机构）。开启开关后，
// 所有出网请求（LLM、MCP、上下文探测）切换到 net.fetch，
// 行为与浏览器一致。
// ============================================================
import { net, app } from 'electron'
import { getSettings } from '../store/db'
import { log } from '../llm/logger'

/** 当前是否使用系统证书库（net.fetch）。读取失败时保守回退内置 fetch */
export function useSystemCerts(): boolean {
  try {
    return getSettings().useSystemCerts === true
  } catch {
    return false
  }
}

/**
 * 项目统一的 fetch 入口：
 * - 开关开启（且 app 已 ready）→ Electron net.fetch（系统证书库）
 * - 否则 → Node 内置 fetch（Mozilla 内置 CA）
 * 所有 LLM / MCP / 网络探测请求都应走这里，不要直接调用全局 fetch。
 */
export function getFetch(): typeof fetch {
  if (useSystemCerts() && app.isReady()) {
    // net.fetch 签名兼容 FetchLike / 全局 fetch
    return net.fetch as unknown as typeof fetch
  }
  return fetch
}

/**
 * 供 MCP transport（SSE / StreamableHTTP）注入的 fetch 包装：
 * SDK 的 FetchLike 要求接受 (string | URL, RequestInit)；
 * 同时把 URL 对象规范成 string，避免个别版本对 URL 输入的兼容差异。
 */
export function getMcpFetch(): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const f = getFetch()
  return (url, init) => f(typeof url === 'string' ? url : url.toString(), init)
}

/**
 * 开关变更时调用：记录日志（net.fetch 无全局 agent 状态，切换即时生效，
 * 已建立的连接需重连 MCP 后使用新出口）。
 */
export function logCertModeChanged(enabled: boolean): void {
  log('info', enabled
    ? 'CA 模式已切换: 使用系统证书库（Electron net.fetch，与 Chrome 一致）'
    : 'CA 模式已切换: 使用 Node 内置 CA（Mozilla 证书库）')
}
