import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

interface TokenUsageSummary {
  model: string
  totalInput: number
  totalOutput: number
  count: number
}

/** 30 分钟桶（DB 记录粒度：每半小时一个数据点，跨会话汇总） */
interface TokenUsageBucket {
  bucketStart: number   // 桶起点毫秒时间戳（对齐 30 分钟）
  model: string
  inputTokens: number
  outputTokens: number
  requestCount: number
}

const MODEL_COLORS = ['#1389c9', '#0e9aa7', '#c18a2e', '#d23b4c', '#13875d', '#7c5cd6', '#ec4899', '#14b8a6']
const BUCKET_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toString()
}
const pad2 = (n: number) => String(n).padStart(2, '0')
function fmt30m(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function fmtDay(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

type Granularity = '30m' | 'day'

export function UsageSettings() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<TokenUsageSummary[]>([])
  const [buckets, setBuckets] = useState<TokenUsageBucket[]>([])
  const [granularity, setGranularity] = useState<Granularity>('30m')
  const [range30m, setRange30m] = useState(24)   // 小时
  const [rangeDay, setRangeDay] = useState(7)    // 天

  const loadData = async () => {
    const [s, b] = await Promise.all([
      window.api.token.summary(),
      window.api.token.buckets(30)
    ])
    setSummary(s as TokenUsageSummary[])
    setBuckets(b as TokenUsageBucket[])
  }

  useEffect(() => {
    loadData()
  }, [])

  const models = useMemo(() => Array.from(new Set(buckets.map(b => b.model))), [buckets])
  const modelColor = (m: string) => MODEL_COLORS[models.indexOf(m) % MODEL_COLORS.length]

  // ---- 30 分钟粒度：每个半小时一个点（跨模型累计 input/output） ----
  const chartData30m = useMemo(() => {
    const now = Date.now()
    const start = Math.floor((now - range30m * 3600 * 1000) / BUCKET_MS) * BUCKET_MS
    // 索引：桶起点 → { input, output }
    const byBucket = new Map<number, { input: number; output: number }>()
    for (const b of buckets) {
      if (b.bucketStart < start) continue
      const e = byBucket.get(b.bucketStart) || { input: 0, output: 0 }
      e.input += b.inputTokens
      e.output += b.outputTokens
      byBucket.set(b.bucketStart, e)
    }
    const pts: { label: string; input: number; output: number }[] = []
    for (let ts = start; ts <= now; ts += BUCKET_MS) {
      const e = byBucket.get(ts)
      const d = new Date(ts)
      const label = (d.getHours() === 0 && d.getMinutes() === 0) ? fmtDay(ts) : fmt30m(ts)
      pts.push({ label, input: e?.input || 0, output: e?.output || 0 })
    }
    return pts
  }, [buckets, range30m])

  // ---- 按天粒度：按自然日聚合，每模型一条线（input+output 合计） ----
  const chartDataDay = useMemo(() => {
    const now = Date.now()
    const startDay = startOfDay(now - rangeDay * DAY_MS)
    const byDay = new Map<number, Map<string, number>>() // dayStart → model → total
    for (const b of buckets) {
      const day = startOfDay(b.bucketStart)
      if (day < startDay) continue
      let perModel = byDay.get(day)
      if (!perModel) { perModel = new Map(); byDay.set(day, perModel) }
      perModel.set(b.model, (perModel.get(b.model) || 0) + b.inputTokens + b.outputTokens)
    }
    const pts: Record<string, number | string>[] = []
    for (let day = startDay; day <= startOfDay(now); day += DAY_MS) {
      const row: Record<string, number | string> = { day: fmtDay(day) }
      const perModel = byDay.get(day)
      for (const m of models) row[m] = perModel?.get(m) || 0
      pts.push(row)
    }
    return pts
  }, [buckets, rangeDay, models])

  if (summary.length === 0 && buckets.length === 0) {
    return (
      <div className="memory-empty">
        {t('settings.usage.noData')}
      </div>
    )
  }

  const is30m = granularity === '30m'
  const data = is30m ? chartData30m : chartDataDay

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.usage.hint')}</p>

      {/* 汇总表格（按模型，全周期累计） */}
      {summary.length > 0 && (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t('settings.usage.model')}</th>
                <th>{t('settings.usage.inputTokens')}</th>
                <th>{t('settings.usage.outputTokens')}</th>
                <th>{t('settings.usage.totalTokens')}</th>
                <th>{t('settings.usage.requests')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.model}>
                  <td>{row.model}</td>
                  <td className="num-input">{formatNumber(row.totalInput)}</td>
                  <td className="num-output">{formatNumber(row.totalOutput)}</td>
                  <td className="num-total">{formatNumber(row.totalInput + row.totalOutput)}</td>
                  <td className="num-count">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 图表区：粒度切换（30 分钟 / 按天）+ 时间范围 */}
      {buckets.length > 0 && (
        <div className="chart-panel">
          <div className="chart-toolbar">
            <div className="chart-seg">
              <button className={is30m ? 'seg active' : 'seg'} onClick={() => setGranularity('30m')}>
                {t('settings.usage.chart30m')}
              </button>
              <button className={!is30m ? 'seg active' : 'seg'} onClick={() => setGranularity('day')}>
                {t('settings.usage.chartDay')}
              </button>
            </div>
            <div className="chart-seg">
              {is30m ? (
                <>
                  {[24, 72].map(h => (
                    <button key={h} className={range30m === h ? 'seg active' : 'seg'} onClick={() => setRange30m(h)}>
                      {h === 24 ? '24h' : '3d'}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {[7, 30].map(d => (
                    <button key={d} className={rangeDay === d ? 'seg active' : 'seg'} onClick={() => setRangeDay(d)}>
                      {d}d
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
          <p className="form-hint" style={{ marginBottom: 8 }}>
            {is30m ? t('settings.usage.chart30mHint') : t('settings.usage.chartDayHint')}
          </p>

          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--app-color-border)" />
              <XAxis dataKey={is30m ? 'label' : 'day'} tick={{ fontSize: 11, fill: 'var(--app-color-text-mute)' }} stroke="var(--app-color-border-strong)" minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--app-color-text-mute)' }} tickFormatter={v => formatCompact(Number(v))} stroke="var(--app-color-border-strong)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--app-color-surface-solid)',
                  border: '1px solid var(--app-color-border-strong)',
                  borderRadius: 6,
                  fontSize: 12
                }}
                labelStyle={{ color: 'var(--app-color-text)' }}
                formatter={(value, name) => [formatNumber(Number(value) || 0), String(name ?? '')]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {is30m ? (
                <>
                  <Line type="monotone" dataKey="input" name={t('settings.usage.inputTokens')} stroke="#1389c9" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="output" name={t('settings.usage.outputTokens')} stroke="#13875d" strokeWidth={2} dot={false} />
                </>
              ) : (
                models.map((m) => (
                  <Line
                    key={m}
                    type="monotone"
                    dataKey={m}
                    name={m}
                    stroke={modelColor(m)}
                    strokeWidth={2}
                    dot={false}
                  />
                ))
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/** 取某毫秒时间戳所在自然日的 0 点（本地时区） */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
