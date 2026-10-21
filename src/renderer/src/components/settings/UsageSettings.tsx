import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, Layers, TrendingUp } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { buildTrendChart, TREND_RANGES, type TokenUsageBucket, type TrendRange, type TrendSplit, type TrendMetric } from './usageTrend'

interface TokenUsageSummary {
  model: string
  totalInput: number
  totalOutput: number
  count: number
}

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

const METRICS: TrendMetric[] = ['total', 'input', 'output']

export function UsageSettings() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<TokenUsageSummary[]>([])
  const [buckets, setBuckets] = useState<TokenUsageBucket[]>([])
  const [range, setRange] = useState<TrendRange>('24h')
  const [split, setSplit] = useState<TrendSplit>('all')
  const [metric, setMetric] = useState<TrendMetric>('total')

  useEffect(() => {
    // 多取 1 天：日模式窗口起点是自然日 0 点，可能比 DB 的 30 分钟对齐 cutoff 早最多约 24h
    Promise.all([window.api.token.summary(), window.api.token.buckets(31)])
      .then(([s, b]) => {
        setSummary(s as TokenUsageSummary[])
        setBuckets(b as TokenUsageBucket[])
      })
  }, [])

  const totals = useMemo(() => {
    let input = 0, output = 0, requests = 0
    for (const row of summary) { input += row.totalInput; output += row.totalOutput; requests += row.count }
    return { input, output, requests, total: input + output }
  }, [summary])

  // 时间范围 × 拆分方式 × 指标 三个独立维度，聚合逻辑在 usageTrend.ts 纯函数中
  const chart = useMemo(() => buildTrendChart(buckets, range, split, metric), [buckets, range, split, metric])
  const metricLabel: Record<TrendMetric, string> = {
    total: t('settings.usage.metricTotal'),
    input: t('settings.usage.metricInput'),
    output: t('settings.usage.metricOutput')
  }

  if (summary.length === 0 && buckets.length === 0) {
    return (
      <div className="memory-empty">
        {t('settings.usage.noData')}
      </div>
    )
  }

  const seg = (active: boolean) => (active ? 'seg active' : 'seg')

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 12 }}>{t('settings.usage.hint')}</p>

      {/* 总览：全周期累计，不按任何维度拆分 */}
      <section className="settings-section">
        <div className="settings-section-title">
          <Gauge size={16} />
          <div><h3>{t('settings.usage.overview')}</h3></div>
        </div>
        <div className="usage-cards">
          <div className="usage-card">
            <span className="usage-card-label">{t('settings.usage.inputTokens')}</span>
            <span className="usage-card-value card-input">{formatNumber(totals.input)}</span>
          </div>
          <div className="usage-card">
            <span className="usage-card-label">{t('settings.usage.outputTokens')}</span>
            <span className="usage-card-value card-output">{formatNumber(totals.output)}</span>
          </div>
          <div className="usage-card">
            <span className="usage-card-label">{t('settings.usage.totalTokens')}</span>
            <span className="usage-card-value">{formatNumber(totals.total)}</span>
          </div>
          <div className="usage-card">
            <span className="usage-card-label">{t('settings.usage.requests')}</span>
            <span className="usage-card-value">{totals.requests}</span>
          </div>
        </div>
      </section>

      {/* 按模型：全周期分组明细 */}
      {summary.length > 0 && (
        <section className="settings-section">
          <div className="settings-section-title">
            <Layers size={16} />
            <div>
              <h3>{t('settings.usage.byModel')}</h3>
              <p>{t('settings.usage.byModelHint')}</p>
            </div>
          </div>
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
              <tfoot>
                <tr>
                  <td>{t('settings.usage.total')}</td>
                  <td className="num-input">{formatNumber(totals.input)}</td>
                  <td className="num-output">{formatNumber(totals.output)}</td>
                  <td className="num-total">{formatNumber(totals.total)}</td>
                  <td className="num-count">{totals.requests}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {/* 趋势：三个独立维度自由组合（时间范围 / 拆分方式 / 指标） */}
      {buckets.length > 0 && (
        <section className="settings-section">
          <div className="settings-section-title">
            <TrendingUp size={16} />
            <div>
              <h3>{t('settings.usage.trend')}</h3>
              <p>{t('settings.usage.trendHint')}</p>
            </div>
          </div>
          <div className="chart-toolbar">
            <div className="chart-group">
              <span className="chart-group-label">{t('settings.usage.range')}</span>
              <div className="chart-seg">
                {TREND_RANGES.map(r => (
                  <button key={r} className={seg(range === r)} onClick={() => setRange(r)}>{r}</button>
                ))}
              </div>
            </div>
            <div className="chart-group">
              <span className="chart-group-label">{t('settings.usage.split')}</span>
              <div className="chart-seg">
                <button className={seg(split === 'all')} onClick={() => setSplit('all')}>{t('settings.usage.splitAll')}</button>
                <button className={seg(split === 'model')} onClick={() => setSplit('model')}>{t('settings.usage.splitByModel')}</button>
              </div>
            </div>
            <div className="chart-group">
              <span className="chart-group-label">{t('settings.usage.metric')}</span>
              <div className="chart-seg">
                {METRICS.map(m => (
                  <button key={m} className={seg(metric === m)} onClick={() => setMetric(m)}>{metricLabel[m]}</button>
                ))}
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chart.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--app-color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--app-color-text-mute)' }} stroke="var(--app-color-border-strong)" minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--app-color-text-mute)' }} tickFormatter={v => formatCompact(Number(v))} stroke="var(--app-color-border-strong)" width={44} />
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
              {chart.series.map(s => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.key === 'value' ? metricLabel[metric] : s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}
    </div>
  )
}
