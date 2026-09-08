export const TTS_MODEL_TYPES = ['vits', 'kokoro'] as const
export type TtsModelType = typeof TTS_MODEL_TYPES[number]

export interface TtsModelConfig {
  id: string
  name: string
  type: TtsModelType
  directory: string
  modelPath: string
  tokensPath: string
  lexiconPaths: string[]
  dataDir?: string
  voicesPath?: string
  ruleFsts: string[]
  speakerId: number
  speed: number
}

export interface TtsSessionUpdate { enabled: boolean }

export interface TtsAudioPayload {
  sessionId: string
  messageId: string
  samples: Float32Array
  sampleRate: number
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => text(item, 4096)).filter(Boolean))]
}

export function normalizeTtsModels(value: unknown): TtsModelConfig[] {
  if (!Array.isArray(value)) return []
  const result: TtsModelConfig[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<TtsModelConfig>
    const id = text(raw.id, 128)
    const name = text(raw.name, 120)
    const directory = text(raw.directory, 4096)
    const modelPath = text(raw.modelPath, 4096)
    const tokensPath = text(raw.tokensPath, 4096)
    const type = TTS_MODEL_TYPES.includes(raw.type as TtsModelType) ? raw.type as TtsModelType : undefined
    if (!id || ids.has(id) || !name || !type || !directory || !modelPath || !tokensPath) continue
    const voicesPath = text(raw.voicesPath, 4096)
    if (type === 'kokoro' && !voicesPath) continue
    ids.add(id)
    result.push({
      id, name, type, directory, modelPath, tokensPath,
      lexiconPaths: paths(raw.lexiconPaths),
      ruleFsts: paths(raw.ruleFsts),
      ...(text(raw.dataDir, 4096) ? { dataDir: text(raw.dataDir, 4096) } : {}),
      ...(voicesPath ? { voicesPath } : {}),
      speakerId: Number.isInteger(raw.speakerId) && Number(raw.speakerId) >= 0 ? Number(raw.speakerId) : 0,
      speed: Number.isFinite(raw.speed) ? Math.min(2, Math.max(0.5, Number(raw.speed))) : 1
    })
  }
  return result
}

export function resolveDefaultTtsModelId(models: TtsModelConfig[], requested: unknown): string | null {
  return typeof requested === 'string' && models.some(model => model.id === requested)
    ? requested : models[0]?.id ?? null
}

export function equivalentTtsModels(left: TtsModelConfig[], right: TtsModelConfig[]): boolean {
  const canonical = (models: TtsModelConfig[]) => models.map(model => ({
    ...model,
    lexiconPaths: [...model.lexiconPaths].sort()
  })).sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** Convert assistant Markdown into prose suitable for speech. */
export function prepareSpeechText(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function splitSpeechText(input: unknown, maxLength = 500): string[] {
  const text = prepareSpeechText(input)
  if (!text) return []
  const limit = Math.max(50, Math.floor(maxLength))
  const result: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    const punctuation = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('；'),
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('; ')
    )
    const whitespace = window.lastIndexOf(' ')
    const splitAt = punctuation >= Math.floor(limit * 0.4)
      ? punctuation + 1
      : whitespace >= Math.floor(limit * 0.6) ? whitespace : limit
    result.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) result.push(remaining)
  return result.filter(Boolean)
}
