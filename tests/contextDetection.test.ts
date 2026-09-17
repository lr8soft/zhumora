import assert from 'node:assert/strict'
import { configuredContextWindow, contextDetectionCacheKey, pickContextLength } from '../src/main/agent/contextDetectionPolicy.ts'

const provider = {
  baseUrl: 'http://localhost:11434/v1/context-detection-test',
  apiKey: 'secret',
  contextWindow: 32_000
}

assert.equal(configuredContextWindow(provider, true), 32_000, 'Agent runtime honors an explicit override')
assert.equal(configuredContextWindow(provider, false), null, 'fresh settings detection ignores an old manual value')
assert.notEqual(
  contextDetectionCacheKey({ ...provider, apiKey: '' }, 'large-context-model'),
  contextDetectionCacheKey(provider, 'large-context-model'),
  'anonymous fallback must not poison authenticated context detection'
)

// pickContextLength：各后端 /v1/models 条目的上下文长度字段
// 字段来源（对照各家服务实现）：
// - llama.cpp: meta.n_ctx
// - vLLM: max_model_len（model_config.max_model_len）
// - SGLang: max_model_len（model_config.context_len）
// - OpenRouter: context_length
// - Mistral 系: max_context_length
// - DeepSeek/GLM/OpenAI 官方: 无上下文字段 → 交给启发式表兜底
assert.equal(pickContextLength({ id: 'model-a', meta: { n_ctx: 8192 } }), 8192, 'llama.cpp meta.n_ctx')
assert.equal(pickContextLength({ id: 'model-a', max_model_len: 131072 }), 131072, 'vLLM / SGLang max_model_len')
assert.equal(pickContextLength({ id: 'model-a', context_length: 1048576 }), 1048576, 'OpenRouter context_length')
assert.equal(pickContextLength({ id: 'model-a', max_context_length: 32768 }), 32768, 'Mistral-style max_context_length')
assert.equal(pickContextLength({ id: 'model-a', limit_context: 16384 }), 16384, 'gateway limit_context')
assert.equal(pickContextLength({ id: 'deepseek-chat' }), null, 'plain OpenAI-shaped card yields null')
assert.equal(pickContextLength({ id: 'lora-a', parent: 'base', max_model_len: null }), null, 'vLLM LoRA card has null max_model_len')
assert.equal(pickContextLength({ id: 'm', max_model_len: 0 }), null, 'non-positive values are ignored')
assert.equal(pickContextLength({ id: 'm', meta: { n_ctx: 4096 }, max_model_len: 131072 }), 4096, 'first positive candidate wins (llama.cpp nesting is more specific)')
assert.equal(pickContextLength(null), null, 'null entry yields null')
assert.equal(pickContextLength('not-an-object'), null, 'string entry yields null')

console.log('provider context detection tests passed')
