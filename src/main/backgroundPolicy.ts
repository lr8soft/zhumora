// ============================================================
// 后台运行（Path A）的纯策略层：无 Electron / DB 依赖，可直接单测。
//
// 背景：关窗收进系统托盘后，main 进程继续运行会话。窗口"不可见"期间
// 需要两件事（对齐 Codex app-server 的 waiting-on-approval 语义）：
//   1. 运行完成 / 出错 → 系统通知提醒用户回窗口；
//   2. 挂起权限请求 → 通知 + 保持挂起（不自动批准、不加超时）。
// 本模块只决定"要不要提醒"，不拥有任何会话或权限状态。
// ============================================================

/** 运行结束类别。aborted 是用户/外部主动中止，不弹"完成"通知。 */
export type RunEndKind = 'complete' | 'error' | 'aborted'

export type RunEndOutcome = 'finished' | 'failed'

/** 窗口可见时不打扰；不可见时仅对完成/出错提醒（中止静默）。 */
export function shouldNotifyRunEnd(args: { windowVisible: boolean; kind: RunEndKind }): RunEndOutcome | null {
  if (args.windowVisible) return null
  if (args.kind === 'aborted') return null
  return args.kind === 'error' ? 'failed' : 'finished'
}

/** 仅当窗口不可见且该会话进入挂起集合（pending=true）时提醒。 */
export function shouldNotifyPermission(args: { windowVisible: boolean; pending: boolean }): boolean {
  return !args.windowVisible && args.pending
}

/**
 * 关窗是否应真销毁（而非 hide 进后台）。
 * 唯一判定点：退出中 / macOS（红点关闭走既有 destroy+activate 重建路径）/
 * dev（避免调试残留后台进程）/ 用户显式关闭了后台模式。
 */
export function shouldCloseInsteadOfHide(args: {
  quitting: boolean
  platform: NodeJS.Platform
  dev: boolean
  backgroundClose: boolean | undefined
}): boolean {
  if (args.quitting || args.platform === 'darwin' || args.dev) return true
  // 默认后台运行（normalizeSettings 保证为 true）；仅用户显式关闭（false）才关窗即退出
  return args.backgroundClose === false
}

/** 托盘/通知文案（与 renderer i18n 的 6 语言保持一致；未知语言回落 en）。 */
const STRINGS: Record<string, { show: string; quit: string; needsApproval: string; finished: string; failed: string }> = {
  en: { show: 'Show Zhumora', quit: 'Quit', needsApproval: 'Needs your approval', finished: 'Run finished', failed: 'Run failed' },
  zh: { show: '显示 Zhumora', quit: '退出', needsApproval: '需要你批准', finished: '运行已完成', failed: '运行出错' },
  ja: { show: 'Zhumora を表示', quit: '終了', needsApproval: '承認が必要です', finished: '実行が完了しました', failed: '実行エラー' },
  es: { show: 'Mostrar Zhumora', quit: 'Salir', needsApproval: 'Requiere tu aprobación', finished: 'Ejecución finalizada', failed: 'Ejecución fallida' },
  fr: { show: 'Afficher Zhumora', quit: 'Quitter', needsApproval: 'Nécessite votre approbation', finished: 'Exécution terminée', failed: "Échec de l'exécution" },
  de: { show: 'Zhumora anzeigen', quit: 'Beenden', needsApproval: 'Benötigt deine Genehmigung', finished: 'Lauf abgeschlossen', failed: 'Lauf fehlgeschlagen' }
}

export function backgroundStringsFor(lang: string) {
  return STRINGS[lang] ?? STRINGS.en
}

/** 通知正文：会话标题（截断到 40 字符）+ 结果前缀；无标题时仅结果。 */
export function runEndBody(outcome: RunEndOutcome, title: string | null, strings: { finished: string; failed: string }): string {
  const prefix = outcome === 'failed' ? strings.failed : strings.finished
  const clean = (title || '').trim()
  if (!clean) return prefix
  const short = clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
  return `${prefix}：${short}`
}

export function permissionBody(title: string | null, strings: { needsApproval: string }): string {
  const clean = (title || '').trim()
  if (!clean) return strings.needsApproval
  const short = clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
  return `${strings.needsApproval}：${short}`
}
