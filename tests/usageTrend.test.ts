// usageTrend.buildTrendChart 纯函数单测：无测试框架，顶层直接执行（node --no-warnings tests/usageTrend.test.ts）。
// 时区无关：时间全部用本地 Date 构造；NOW = 本地 2026-10-21 12:00（同时 30 分钟对齐与整点对齐）。
import assert from 'node:assert/strict'
import { buildTrendChart, TREND_RANGES, type TokenUsageBucket, type TrendRange, type TrendSplit, type TrendMetric } from '../src/renderer/src/components/settings/usageTrend.ts'

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime()

// 本地 Date → 30 分钟对齐桶；requestCount 默认 1
const bucket = (month: number, day: number, hour: number, minute: number, model: string, input: number, output: number, requestCount = 1): TokenUsageBucket =>
  ({ bucketStart: new Date(2026, month, day, hour, minute, 0).getTime(), model, inputTokens: input, outputTokens: output, requestCount })

// 按 label 找唯一行并断言存在（24h 窗口从 10-20 12:00 起，HH:MM label 在窗口内唯一）
const row = (rows: Record<string, number | string>[], label: string): Record<string, number | string> => {
  const found = rows.find(r => r.label === label)
  assert.ok(found, `存在 label 为 ${label} 的行`)
  return found
}

// A 窗口与补零：24h/30 分钟模式 start = 本地 10-20 12:00，含两端共 49 行；窗外桶不计入
{
  const buckets: TokenUsageBucket[] = [
    bucket(9, 21, 10, 0, 'm1', 100, 50),
    bucket(9, 19, 12, 0, 'm1', 999, 999)
  ]
  const chart = buildTrendChart(buckets, '24h', 'all', 'total', NOW)
  assert.equal(chart.rows.length, 49, 'A: 24h 窗口 30 分钟步长含两端共 49 行')
  assert.deepEqual(chart.series, [{ key: 'value', color: '#1389c9' }], 'A: all 模式恰 1 条 series value/#1389c9')
  assert.equal(row(chart.rows, '10:00').value, 150, 'A: 窗内 10:00 行 total = 100+50')
  assert.equal(row(chart.rows, '10:30').value, 0, 'A: 空桶 10:30 补 0')
  assert.equal(row(chart.rows, '11:30').value, 0, 'A: 空桶 11:30 补 0')
  assert.equal(chart.rows.reduce((sum, r) => sum + Number(r.value), 0), 150, 'A: 窗外 999 完全不计入')
  assert.equal(chart.rows[24].label, '10-21', 'A: 窗口内唯一 00:00 点为 10-21 00:00，label 取该点自身日期 MM-DD')
  assert.equal(chart.rows[0].label, '12:00', 'A: 首行 label 为窗口起点 10-20 12:00')
  assert.equal(chart.rows[chart.rows.length - 1].label, '12:00', 'A: 末行 label 为 now 10-21 12:00')
}

// B metric 选择：同 A 桶，'10:00' 行 input=100 / output=50 / total=150
{
  const buckets: TokenUsageBucket[] = [
    bucket(9, 21, 10, 0, 'm1', 100, 50),
    bucket(9, 19, 12, 0, 'm1', 999, 999)
  ]
  const byMetric = (metric: TrendMetric) => buildTrendChart(buckets, '24h', 'all', metric, NOW)
  assert.equal(row(byMetric('input').rows, '10:00').value, 100, 'B: input 取 inputTokens')
  assert.equal(row(byMetric('output').rows, '10:00').value, 50, 'B: output 取 outputTokens')
  assert.equal(row(byMetric('total').rows, '10:00').value, 150, 'B: total = input+output')
}

// C 模型拆分：总量 ma=300/mb=150/mc=50 降序；颜色取调色板前 3；行含三个模型键，空桶补 0
{
  const buckets: TokenUsageBucket[] = [
    bucket(9, 21, 10, 0, 'ma', 200, 100),
    bucket(9, 21, 10, 30, 'mb', 100, 50),
    bucket(9, 21, 11, 0, 'mc', 50, 0)
  ]
  const chart = buildTrendChart(buckets, '24h', 'model', 'total', NOW)
  assert.deepEqual(chart.series, [
    { key: 'ma', color: '#1389c9' },
    { key: 'mb', color: '#0e9aa7' },
    { key: 'mc', color: '#c18a2e' }
  ], 'C: series 按窗口内 total 降序，颜色按索引取调色板前 3')
  const at10 = row(chart.rows, '10:00')
  assert.equal(at10.ma, 300, 'C: ma 行 10:00 = 200+100')
  assert.equal(at10.mb, 0, 'C: 10:00 mb 补 0')
  assert.equal(at10.mc, 0, 'C: 10:00 mc 补 0')
  assert.equal(row(chart.rows, '10:30').mb, 150, 'C: mb 行 10:30 = 100+50')
  assert.equal(row(chart.rows, '11:00').mc, 50, 'C: mc 行 11:00 = 50')
  const empty = chart.rows[0]
  assert.deepEqual(empty, { label: empty.label, ma: 0, mb: 0, mc: 0 }, 'C: 无数据步长行三键全 0')
  assert.deepEqual(Object.keys(empty).sort(), ['label', 'ma', 'mb', 'mc'], 'C: 行只有 label + 每个 series 模型键')
}

// C2 同分稳定排序：x1(10+0)/x2(5+5) 总量各 10，buckets 数组中 x2 先贡献 → series [x2, x1]
{
  const buckets: TokenUsageBucket[] = [
    bucket(9, 21, 10, 0, 'x2', 5, 5),
    bucket(9, 21, 10, 30, 'x1', 10, 0)
  ]
  const chart = buildTrendChart(buckets, '24h', 'model', 'total', NOW)
  assert.deepEqual(chart.series, [
    { key: 'x2', color: '#1389c9' },
    { key: 'x1', color: '#0e9aa7' }
  ], 'C2: 同分保持 buckets 数组中首次非零贡献先后')
  assert.equal(row(chart.rows, '10:00').x2, 10, 'C2: x2 10:00 = 5+5')
  assert.equal(row(chart.rows, '10:30').x1, 10, 'C2: x1 10:30 = 10+0')
  assert.equal(row(chart.rows, '10:30').x2, 0, 'C2: x2 10:30 补 0')
}

// D 日模式：7d start = startOfDay(now - 7d) = 本地 10-14 00:00，labels 恰为 '10-14'…'10-21' 共 8 行
{
  const buckets: TokenUsageBucket[] = [
    bucket(9, 20, 23, 0, 'm1', 10, 10),
    bucket(9, 20, 1, 0, 'm1', 5, 5),
    bucket(9, 14, 12, 0, 'm2', 500, 500)
  ]
  const chart = buildTrendChart(buckets, '7d', 'all', 'total', NOW)
  assert.equal(chart.rows.length, 8, 'D: 7d 日模式 start 10-14 00:00，含两端共 8 行')
  assert.deepEqual(chart.rows.map(r => r.label), ['10-14', '10-15', '10-16', '10-17', '10-18', '10-19', '10-20', '10-21'], 'D: labels 顺序 10-14…10-21')
  assert.equal(row(chart.rows, '10-20').value, 30, 'D: 10-20 日 = (10+10)+(5+5)')
  assert.equal(row(chart.rows, '10-14').value, 1000, 'D: 10-14 12:00 桶在窗口内，500+500=1000')
  assert.equal(row(chart.rows, '10-15').value, 0, 'D: 10-15 无数据补 0')
}

// E 3d 标签格式：'MM-DD HH:MM'，145 行，首行 '10-18 12:00'，空桶全 0
{
  const chart = buildTrendChart([], '3d', 'all', 'input', NOW)
  assert.equal(chart.rows.length, 145, 'E: 3d 窗口 30 分钟步长含两端共 145 行')
  assert.equal(chart.rows[0].label, '10-18 12:00', 'E: 首行为窗口起点 10-18 12:00')
  assert.ok(chart.rows.some(r => r.label === '10-21 11:30'), 'E: 存在 10-21 11:30 行')
  assert.ok(chart.rows.every(r => r.value === 0), 'E: 空 buckets 全行补 0')
}

// F 空 buckets：all → 单条 series 全行 0；model → series 空数组，行仍覆盖完整窗口且只有 label 键
{
  const all = buildTrendChart([], '24h', 'all', 'total', NOW)
  assert.deepEqual(all.series, [{ key: 'value', color: '#1389c9' }], 'F: 空 all 保留单条 series')
  assert.equal(all.rows.length, 49, 'F: all 行仍覆盖完整窗口')
  assert.ok(all.rows.every(r => r.value === 0), 'F: all 全行补 0')
  const model = buildTrendChart([], '24h', 'model', 'total', NOW)
  assert.deepEqual(model.series, [], 'F: 空 model 无 series')
  assert.equal(model.rows.length, 49, 'F: model 行仍覆盖完整窗口')
  assert.ok(model.rows.every(r => Object.keys(r).length === 1 && 'label' in r), 'F: 空 model 行只有 label 键')
}

// G 零值桶：input/output 全 0 且 requestCount=3 的桶不计入任何 series
{
  const buckets: TokenUsageBucket[] = [bucket(9, 21, 10, 0, 'zero', 0, 0, 3)]
  const chart = buildTrendChart(buckets, '24h', 'model', 'total', NOW)
  assert.deepEqual(chart.series, [], 'G: 零值桶不产生 series')
  assert.ok(chart.rows.every(r => Object.keys(r).length === 1 && 'label' in r), 'G: 行只有 label 键')
}

// H TREND_RANGES 常量
assert.deepEqual(TREND_RANGES, ['24h', '3d', '7d', '30d'], 'H: TREND_RANGES 内容与顺序')

console.log('usageTrend buildTrendChart（窗口/metric/模型拆分/标签/补零）测试通过')
