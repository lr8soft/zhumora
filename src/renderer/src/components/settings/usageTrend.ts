// 用量统计趋势图的纯函数构造：把 30 分钟桶聚合为 时间范围 × 拆分方式 × 指标 三个正交维度的图表数据。
// 不依赖 React / Electron / i18n，node 可直接单测（tests/usageTrend.test.ts）。

export interface TokenUsageBucket {
  /** 桶起点（毫秒时间戳，对齐 30 分钟） */
  bucketStart: number
  model: string
  inputTokens: number
  outputTokens: number
  requestCount: number
}

export type TrendRange = '24h' | '3d' | '7d' | '30d'
export type TrendSplit = 'all' | 'model'
export type TrendMetric = 'total' | 'input' | 'output'

export const TREND_RANGES: TrendRange[] = ['24h', '3d', '7d', '30d']

const BUCKET_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const RANGE_MS: Record<TrendRange, number> = {
  '24h': DAY_MS,
  '3d': 3 * DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS
}

const MODEL_COLORS = ['#1389c9', '#0e9aa7', '#c18a2e', '#d23b4c', '#13875d', '#7c5cd6', '#ec4899', '#14b8a6']
const ALL_SERIES_COLOR = '#1389c9'

export interface TrendSeries { key: string; color: string }
export type TrendRow = Record<string, number | string>

export interface TrendChart {
  series: TrendSeries[]
  rows: TrendRow[]
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtTime = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
const fmtDate = (ms: number) => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function alignTo(ms: number, stepMs: number): number {
  return Math.floor(ms / stepMs) * stepMs
}

function metricValue(b: TokenUsageBucket, metric: TrendMetric): number {
  if (metric === 'input') return b.inputTokens
  if (metric === 'output') return b.outputTokens
  return b.inputTokens + b.outputTokens
}

/** 某 30 分钟桶起点在给定步长下所属的统计步起点（日模式落到自然日 0 点） */
function stepOf(ts: number, stepMs: number): number {
  return stepMs === DAY_MS ? startOfDay(ts) : alignTo(ts, BUCKET_MS)
}

/**
 * 构造趋势图数据。粒度由 range 决定（24h/3d 用 30 分钟桶，7d/30d 按自然日聚合，本地时区）。
 * split='all' → 单序列（key='value'）；split='model' → 窗口内有非零用量的每个模型一条序列，
 * 按窗口内总量降序（同分保持 buckets 数组中首次非零贡献的先后），空步长补 0。
 * now 可显式传入用于确定性测试。
 */
export function buildTrendChart(
  buckets: TokenUsageBucket[],
  range: TrendRange,
  split: TrendSplit,
  metric: TrendMetric,
  now: number = Date.now()
): TrendChart {
  const stepMs = range === '7d' || range === '30d' ? DAY_MS : BUCKET_MS
  const start = stepMs === DAY_MS ? startOfDay(now - RANGE_MS[range]) : alignTo(now - RANGE_MS[range], BUCKET_MS)

  type Accum = number | Map<string, number>
  const byStep = new Map<number, Accum>()
  const modelTotals = new Map<string, number>()

  for (const b of buckets) {
    const v = metricValue(b, metric)
    if (v === 0) continue
    const step = stepOf(b.bucketStart, stepMs)
    if (step < start) continue
    if (split === 'all') {
      byStep.set(step, ((byStep.get(step) as number | undefined) ?? 0) + v)
    } else {
      let per = byStep.get(step) as Map<string, number> | undefined
      if (!per) { per = new Map(); byStep.set(step, per) }
      per.set(b.model, (per.get(b.model) ?? 0) + v)
      modelTotals.set(b.model, (modelTotals.get(b.model) ?? 0) + v)
    }
  }

  const models = split === 'model'
    ? Array.from(modelTotals.entries()).sort((a, z) => z[1] - a[1]).map(e => e[0])
    : []

  const rows: TrendRow[] = []
  let ts = start
  while (ts <= now) {
    const d = new Date(ts)
    const isMidnight = d.getHours() === 0 && d.getMinutes() === 0
    const label = stepMs === DAY_MS
      ? fmtDate(ts)
      : range === '24h'
        ? (isMidnight ? fmtDate(ts) : fmtTime(ts))
        : `${fmtDate(ts)} ${fmtTime(ts)}`
    const row: TrendRow = { label }
    if (split === 'all') {
      row.value = (byStep.get(ts) as number | undefined) ?? 0
    } else {
      const per = byStep.get(ts) as Map<string, number> | undefined
      for (const m of models) row[m] = per?.get(m) ?? 0
    }
    rows.push(row)
    if (stepMs === DAY_MS) {
      // 按"自然日"推进：setDate 自动处理夏令时切换；固定 +86400000 在 DST 时区会永久偏离本地 0 点
      const next = new Date(ts)
      next.setDate(next.getDate() + 1)
      ts = next.getTime()
    } else {
      ts += BUCKET_MS
    }
  }

  const series: TrendSeries[] = split === 'all'
    ? [{ key: 'value', color: ALL_SERIES_COLOR }]
    : models.map((m, i) => ({ key: m, color: MODEL_COLORS[i % MODEL_COLORS.length] }))

  return { series, rows }
}
