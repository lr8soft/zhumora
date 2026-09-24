// ============================================================
// 思考强度请求编码 — 纯模块（零依赖，可直接用 node 运行单元测试）
//
// 输入侧策略集中在这里，只有两件事：
//
// 1) 档位 → 线上取值。关闭必须显式表达，不能退化成"不发送参数"：
//    不传 ≠ 关闭 —— vLLM / SGLang 不传时保留服务端默认（reasoning_effort
//    仅用于注入 enable_thinking），llama.cpp 交给 Jinja 模板默认；对默认
//    思考的模型（Qwen3 系列等）用户选了"关闭"仍会思考。
//    llama.cpp / vLLM / SGLang / DeepSeek 都把 `none` 解释为关闭思考。
// 2) 方言 → 写哪些字段。目标端点族（llama.cpp server / vLLM / SGLang /
//    LiteLLM 网关 / OpenAI / Google 兼容层）共用标准 `reasoning_effort`，
//    只有 DeepSeek 官方 API（取值集合更窄）与阿里云百炼（`enable_thinking`）
//    需要另行编码。
//
// 能力探测的 IO 边界在 reasoningCapability.ts；方言类型与存储边界归一化在
// `shared/reasoning.ts`。
// ============================================================
import type { ReasoningDialect } from '../../shared/reasoning'
import type { ProviderConfig, ReasoningCapability, ReasoningEffort } from '../../shared/types'

/**
 * 线上 `reasoning_effort` 取值。
 * 与对话级档位（ReasoningEffort）的区别只有一项：'off' 在线上是 'none'
 * （显式关闭思考），而不是"省略字段，保留端点默认"。
 */
export type ReasoningEffortParam = 'none' | 'low' | 'medium' | 'high'

const EFFORT_TO_PARAM: Record<ReasoningEffort, ReasoningEffortParam> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high'
}

/**
 * DeepSeek 官方 API 的取值集合是 none/low/high/max：
 * `medium` 被官方映射为 high，这里直接按映射后的值发送，行为不依赖端点的别名策略。
 */
const DEEPSEEK_EFFORT: Record<ReasoningEffortParam, string> = {
  none: 'none',
  low: 'low',
  medium: 'high',
  high: 'high'
}

/**
 * 对话级档位 → 线上参数。
 * undefined = 该 provider 未开启"思考强度"功能开关 → 不发送任何字段，
 * 由端点/模板决定默认行为（这是唯一合法的"不发送"来源）。
 */
export function toReasoningParam(effort: ReasoningEffort | undefined): ReasoningEffortParam | undefined {
  return effort ? EFFORT_TO_PARAM[effort] : undefined
}

/**
 * 解析端点使用的思考强度协议：显式配置优先，否则按主机名识别，再回落标准协议。
 *
 * 只按主机名（不用模型名）：本地 vLLM / SGLang / llama.cpp 常托管 Qwen3 与
 * DeepSeek 权重，按模型名识别会把它们误判成官方 API。官方 API 与本地服务正是
 * 需要区分的两种情形，主机名恰好是这条分界线。网关/私有部署可显式选协议。
 */
export function resolveReasoningDialect(
  provider: Pick<ProviderConfig, 'baseUrl'> & { reasoningDialect?: ReasoningDialect }
): Exclude<ReasoningDialect, 'auto'> {
  const configured = provider.reasoningDialect
  if (configured && configured !== 'auto') return configured
  const host = hostnameOf(provider.baseUrl)
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek'
  if (host.endsWith('dashscope.aliyuncs.com') || host.endsWith('.maas.aliyuncs.com')) return 'qwen'
  return 'openai'
}

function hostnameOf(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl || '').hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 把思考强度写入请求体，返回实际写入的字段名。
 *
 * 返回字段名而不是 void：端点拒绝这些参数时（严格校验请求体的网关），
 * provider 层需要精确地只删掉自己写入的字段后重发一次，而不是猜名字。
 * 档位为 undefined（功能开关关闭）时不写入任何字段，返回空数组。
 */
export function applyReasoningParams(
  body: Record<string, unknown>,
  provider: Pick<ProviderConfig, 'baseUrl'> & { reasoningDialect?: ReasoningDialect },
  effort: ReasoningEffortParam | undefined
): string[] {
  if (!effort) return []
  const dialect = resolveReasoningDialect(provider)
  if (dialect === 'qwen') {
    // 百炼的开关是二元的：低/中/高三档都只是"开启思考"。档位差异需要
    // thinking_budget（未在本项目提供 UI），因此这里不发送该参数。
    body.enable_thinking = effort !== 'none'
    return ['enable_thinking']
  }
  body.reasoning_effort = dialect === 'deepseek' ? DEEPSEEK_EFFORT[effort] : effort
  return ['reasoning_effort']
}

/**
 * 未声明能力的默认值：按标准参数发送（端点自行忽略不认识的字段）。
 *
 * 能力类型目前只建模"是否声明接受该参数"这一位——llama.cpp 是唯一在
 * /props 上暴露该能力的本地服务。OpenRouter 形状的档位集合 / mandatory /
 * token 预算等官方 API 能力（`supported_efforts` 等）接入时再按需扩展：
 * 在那之前不预留没有数据来源的字段。
 */
export const UNKNOWN_REASONING_CAPABILITY: ReasoningCapability = Object.freeze({
  declaresSupport: null,
  source: 'unknown'
})

/**
 * 从 llama.cpp `GET /props` 载荷解出能力声明。
 * 只有显式布尔值才算声明：旧版本 llama.cpp 不上报 chat_template_caps，
 * 此时必须是"未声明"而不是"不支持"（后者会造成误报）。
 */
export function decodeReasoningCapability(props: unknown): ReasoningCapability {
  const caps = (props as { chat_template_caps?: unknown } | null | undefined)?.chat_template_caps
  if (!caps || typeof caps !== 'object') return UNKNOWN_REASONING_CAPABILITY
  const declared = (caps as { supports_reasoning_effort?: unknown }).supports_reasoning_effort
  if (typeof declared !== 'boolean') return UNKNOWN_REASONING_CAPABILITY
  return { declaresSupport: declared, source: 'llama.cpp-caps' }
}
