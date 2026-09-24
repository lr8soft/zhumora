/**
 * 思考强度参数策略测试（llama.cpp / vLLM / SGLang / LiteLLM + 官方 API 方言）
 *
 * 锁住四条不变量：
 * 1. 'off' 必须映射为线上 'none'（显式关闭），只有 undefined 才是不发送字段；
 * 2. 思考内容读取兼容 vLLM 的字段改名（reasoning_content → reasoning），
 *    空串不得遮蔽另一个键的真实内容；
 * 3. 端点能力声明只认显式布尔值；reasoning_effort 被拒的降级判定不得吞掉
 *    其它 400/422；
 * 4. 方言只按主机名识别（本地服务托管同名权重时不得被误判为官方 API）。
 */
import assert from 'node:assert/strict'
import {
  applyReasoningParams,
  decodeReasoningCapability,
  resolveReasoningDialect,
  toReasoningParam,
  UNKNOWN_REASONING_CAPABILITY
} from '../src/main/llm/reasoning.ts'
import { isReasoningParamRejected } from '../src/main/llm/errors.ts'
import { extractReasoningDelta } from '../src/main/llm/sseAccumulator.ts'
import { HttpError } from '../src/main/net/retryCore.ts'
import { normalizeReasoningDialect } from '../src/shared/reasoning.ts'

// --- 挡位 → 线上参数 ---------------------------------------------------------
// 不传 ≠ 关闭：vLLM / SGLang 不传时保留服务端默认，llama.cpp 交给模板默认，
// 因此"关闭思考"必须有显式取值。
assert.equal(toReasoningParam('off'), 'none', "'off' must be sent explicitly as 'none'")
assert.equal(toReasoningParam('low'), 'low')
assert.equal(toReasoningParam('medium'), 'medium')
assert.equal(toReasoningParam('high'), 'high')
assert.equal(
  toReasoningParam(undefined),
  undefined,
  'only the disabled feature toggle omits reasoning_effort entirely'
)

// --- 思考内容增量字段 --------------------------------------------------------
assert.equal(extractReasoningDelta({ reasoning_content: 'deepseek' }), 'deepseek', 'SGLang / llama.cpp shape')
assert.equal(extractReasoningDelta({ reasoning: 'vllm' }), 'vllm', 'vLLM renamed the field to reasoning')
assert.equal(
  extractReasoningDelta({ reasoning_content: '', reasoning: 'vllm' }),
  'vllm',
  'an empty legacy key must not shadow the renamed field'
)
assert.equal(
  extractReasoningDelta({ reasoning_content: null, reasoning: 'vllm' }),
  'vllm',
  'a null legacy key must not shadow the renamed field'
)
assert.equal(extractReasoningDelta({}), '', 'no reasoning keys yields empty')
assert.equal(extractReasoningDelta(null), '', 'null delta yields empty')
assert.equal(
  extractReasoningDelta({ reasoning: { type: 'summary', summary: 'x' } }),
  '',
  'object-shaped reasoning blocks (o-series) are ignored'
)

// --- 端点能力声明 -----------------------------------------------------------
assert.deepEqual(
  decodeReasoningCapability({ chat_template_caps: { supports_reasoning_effort: true } }),
  { declaresSupport: true, source: 'llama.cpp-caps' },
  'llama.cpp /props caps declare support'
)
assert.deepEqual(
  decodeReasoningCapability({ chat_template_caps: { supports_reasoning_effort: false } }),
  { declaresSupport: false, source: 'llama.cpp-caps' },
  'llama.cpp /props caps deny support'
)
// 旧版 llama.cpp 不上报 chat_template_caps：必须是"未声明"而不是"不支持"
assert.deepEqual(
  decodeReasoningCapability({ chat_template_caps: {} }),
  UNKNOWN_REASONING_CAPABILITY,
  'a caps object without the flag is undeclared, not unsupported'
)
assert.deepEqual(
  decodeReasoningCapability({ default_generation_settings: { n_ctx: 8192 } }),
  UNKNOWN_REASONING_CAPABILITY,
  '/props without chat_template_caps is undeclared'
)
assert.deepEqual(decodeReasoningCapability(null), UNKNOWN_REASONING_CAPABILITY, 'missing payload is undeclared')
assert.deepEqual(decodeReasoningCapability({ chat_template_caps: 'yes' }), UNKNOWN_REASONING_CAPABILITY, 'non-object caps ignored')

// --- reasoning_effort 被拒的降级判定 ----------------------------------------
assert.equal(
  isReasoningParamRejected(new HttpError(400, 'LLM API 400: {"error":{"message":"Unexpected field: reasoning_effort"}}')),
  true,
  'a 400 naming the field is eligible for one-shot degradation'
)
assert.equal(
  isReasoningParamRejected(new HttpError(422, 'unknown field reasoning.effort')),
  true,
  'dot-separated spelling is recognized too'
)
assert.equal(
  isReasoningParamRejected(new HttpError(500, 'reasoning_effort unsupported')),
  false,
  'only client-side 400/422 may degrade (5xx keeps the retry path)'
)
assert.equal(
  isReasoningParamRejected(new HttpError(400, 'context length exceeded')),
  false,
  'unrelated 400 must not be mistaken for a droppable parameter'
)
assert.equal(isReasoningParamRejected(new Error('network down')), false, 'plain errors never degrade')
assert.equal(isReasoningParamRejected(new HttpError(400, 'failed to parse tool call arguments as json')), false, 'tool-arg errors stay untouched')
assert.equal(
  isReasoningParamRejected(new HttpError(400, 'Unexpected field: enable_thinking')),
  true,
  'the Bailian toggle is degrading the same way as reasoning_effort'
)

// --- 方言识别：只按主机名 ----------------------------------------------------
// 本地服务常托管 Qwen3 / DeepSeek 权重，按模型名识别会把它们误判成官方 API，
// 因此识别只依赖 baseUrl 主机名（模型名参数刻意不存在）。
assert.equal(resolveReasoningDialect({ baseUrl: 'https://api.deepseek.com/v1' }), 'deepseek')
assert.equal(resolveReasoningDialect({ baseUrl: 'http://localhost:8000/v1' }), 'openai', 'a local vLLM stays on the standard protocol')
assert.equal(
  resolveReasoningDialect({ baseUrl: 'http://localhost:30000/v1' }),
  'openai',
  'a local SGLang serving Qwen3 weights must not be treated as the Bailian API'
)
assert.equal(resolveReasoningDialect({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), 'qwen')
assert.equal(resolveReasoningDialect({ baseUrl: 'https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }), 'qwen')
assert.equal(resolveReasoningDialect({ baseUrl: 'https://api.openai.com/v1' }), 'openai')
assert.equal(resolveReasoningDialect({ baseUrl: 'not a url' }), 'openai', 'an unparseable base URL falls back to the standard protocol')
assert.equal(
  resolveReasoningDialect({ baseUrl: 'https://api.deepseek.com/v1', reasoningDialect: 'auto' }),
  'deepseek',
  "'auto' still runs detection"
)
assert.equal(
  resolveReasoningDialect({ baseUrl: 'https://api.deepseek.com/v1', reasoningDialect: 'openai' }),
  'openai',
  'an explicit choice overrides detection'
)

// --- 方言编码 ---------------------------------------------------------------
const body = () => ({ model: 'm', messages: [] }) as Record<string, unknown>

const openaiBody = body()
assert.deepEqual(applyReasoningParams(openaiBody, { baseUrl: 'http://localhost:8080/v1' }, 'high'), ['reasoning_effort'])
assert.equal(openaiBody.reasoning_effort, 'high')
assert.equal('enable_thinking' in openaiBody, false)

const deepseekBody = body()
assert.deepEqual(applyReasoningParams(deepseekBody, { baseUrl: 'https://api.deepseek.com/v1' }, 'medium'), ['reasoning_effort'])
assert.equal(deepseekBody.reasoning_effort, 'high', "DeepSeek has no 'medium': it is sent as the mapped 'high'")
assert.equal(applyReasoningParams(body(), { baseUrl: 'https://api.deepseek.com/v1' }, 'low')[0], 'reasoning_effort')
const deepseekOff = body()
applyReasoningParams(deepseekOff, { baseUrl: 'https://api.deepseek.com/v1' }, 'none')
assert.equal(deepseekOff.reasoning_effort, 'none', "'off' disables thinking on DeepSeek too")

const qwenBody = body()
assert.deepEqual(applyReasoningParams(qwenBody, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, 'medium'), ['enable_thinking'])
assert.equal(qwenBody.enable_thinking, true)
assert.equal('reasoning_effort' in qwenBody, false, 'Bailian does not accept reasoning_effort')
const qwenOff = body()
applyReasoningParams(qwenOff, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, 'none')
assert.equal(qwenOff.enable_thinking, false, "'off' turns the Bailian toggle off")

// 功能开关关闭（undefined）＝不发送任何字段：保留端点默认行为，任何方言都一样
for (const baseUrl of ['http://localhost:8080/v1', 'https://api.deepseek.com/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1']) {
  const empty = body()
  assert.deepEqual(applyReasoningParams(empty, { baseUrl }, undefined), [], `${baseUrl}: no field when the feature toggle is off`)
  assert.deepEqual(empty, { model: 'm', messages: [] })
}

// 显式选择协议时按显式协议编码，不受主机名影响
const explicitQwen = body()
applyReasoningParams(explicitQwen, { baseUrl: 'http://localhost:9000/v1', reasoningDialect: 'qwen' }, 'low')
assert.equal(explicitQwen.enable_thinking, true)

// --- 存储边界归一化 ---------------------------------------------------------
assert.equal(normalizeReasoningDialect(undefined), 'auto', 'a missing value means auto')
assert.equal(normalizeReasoningDialect('deepseek'), 'deepseek')
assert.equal(normalizeReasoningDialect('anthropic'), 'auto', 'an unknown dialect falls back to auto instead of leaking into the request')
assert.equal(normalizeReasoningDialect(42), 'auto')

console.log('reasoning effort policy tests passed')
