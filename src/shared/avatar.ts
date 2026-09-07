export type AvatarAnimationSource = 'embedded' | 'vrma'

export interface AvatarAnimationConfig {
  id: string
  /** Name exposed to the user and the LLM. */
  name: string
  source: AvatarAnimationSource
  /** Embedded glTF clip name. Defaults to `name`. */
  clipName?: string
  /** Managed .vrma file path when source=vrma. */
  filePath?: string
}

export interface AvatarModelConfig {
  id: string
  name: string
  /** Managed .vrm file path. Renderer never receives this path directly. */
  filePath: string
  animations: AvatarAnimationConfig[]
}

export interface AvatarSessionUpdate {
  enabled: boolean
  modelId: string | null
}

export interface AvatarCapabilities {
  animations: string[]
  expressions: string[]
}

export type AvatarCommand =
  | { type: 'play_animation'; animation: string; loop: boolean }
  | { type: 'set_expression'; expression: string; value: number }
  | { type: 'reset_pose' }
  | { type: 'show_message'; message: string }

export interface AvatarCommandEnvelope {
  id: string
  command: AvatarCommand
}

export interface AvatarBootstrap {
  sessionId: string
  model: {
    id: string
    name: string
    animations: Array<Omit<AvatarAnimationConfig, 'filePath'>>
  }
  latestMessage: string
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

export function normalizeAvatarModels(value: unknown): AvatarModelConfig[] {
  if (!Array.isArray(value)) return []
  const seenModels = new Set<string>()
  const models: AvatarModelConfig[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<AvatarModelConfig>
    const id = cleanText(raw.id, 128)
    const name = cleanText(raw.name, 120)
    const filePath = cleanText(raw.filePath, 4096)
    if (!id || !name || !filePath || seenModels.has(id)) continue
    seenModels.add(id)

    const seenAnimations = new Set<string>()
    const animations: AvatarAnimationConfig[] = []
    for (const animation of Array.isArray(raw.animations) ? raw.animations : []) {
      if (!animation || typeof animation !== 'object') continue
      const candidate = animation as Partial<AvatarAnimationConfig>
      const animationId = cleanText(candidate.id, 128)
      const animationName = cleanText(candidate.name, 120)
      const source: AvatarAnimationSource = candidate.source === 'vrma' ? 'vrma' : 'embedded'
      const animationPath = cleanText(candidate.filePath, 4096)
      if (!animationId || !animationName || seenAnimations.has(animationId)) continue
      if (source === 'vrma' && !animationPath) continue
      seenAnimations.add(animationId)
      animations.push({
        id: animationId,
        name: animationName,
        source,
        clipName: source === 'embedded' ? cleanText(candidate.clipName, 240) || animationName : undefined,
        filePath: source === 'vrma' ? animationPath : undefined
      })
    }
    models.push({ id, name, filePath, animations })
  }
  return models
}

export function resolveDefaultAvatarModelId(models: AvatarModelConfig[], requested: unknown): string | null {
  if (typeof requested === 'string' && models.some(model => model.id === requested)) return requested
  return models[0]?.id ?? null
}

/** Presentation order is not part of the runtime identity of a model or its animations. */
export function equivalentAvatarModel(left: AvatarModelConfig, right: AvatarModelConfig): boolean {
  if (left.id !== right.id || left.name !== right.name || left.filePath !== right.filePath) return false
  const canonicalize = (animations: AvatarAnimationConfig[]) => animations
    .map(animation => ({
      id: animation.id,
      name: animation.name,
      source: animation.source,
      clipName: animation.clipName || '',
      filePath: animation.filePath || ''
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(canonicalize(left.animations)) === JSON.stringify(canonicalize(right.animations))
}

export function normalizeAvatarLine(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}
