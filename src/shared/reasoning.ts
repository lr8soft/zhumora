// ============================================================
// 思考强度协议（跨进程契约 + 存储边界归一化）
//
// 绝大多数端点（llama.cpp / vLLM / SGLang / LiteLLM / OpenAI / Google 兼容层）
// 接受标准的 `reasoning_effort`，但两家官方 API 用的是自己的字段：
// - DeepSeek：仍叫 `reasoning_effort`，取值集合更窄（none/low/high/max）
// - 阿里云百炼（Qwen）：`enable_thinking`（非 OpenAI 标准参数）
//
// 方言只按端点主机名识别（见 `src/main/llm/reasoning.ts`），不按模型名——
// 本地 vLLM / SGLang 常托管同名 Qwen3 / DeepSeek 权重，按模型名识别会把
// 本地服务误判成官方 API 并发出它不接受的字段。
// ============================================================

/**
 * 思考强度的请求协议。
 * - `auto`：按端点主机名自动识别（默认）
 * - `openai`：标准 `reasoning_effort`（本地服务与多数网关）
 * - `deepseek`：DeepSeek 官方 API
 * - `qwen`：阿里云百炼 OpenAI 兼容模式
 */
export type ReasoningDialect = 'auto' | 'openai' | 'deepseek' | 'qwen'

const REASONING_DIALECTS: readonly ReasoningDialect[] = ['auto', 'openai', 'deepseek', 'qwen']

/**
 * 归一化存储边界读入的方言值：未知/缺失一律回落 `auto`。
 * 与其它设置一致，业务模块不自行用可选链实现迁移。
 */
export function normalizeReasoningDialect(value: unknown): ReasoningDialect {
  return REASONING_DIALECTS.includes(value as ReasoningDialect) ? (value as ReasoningDialect) : 'auto'
}
