interface PackedArray { scale: number; data: string }

export interface DenseLayer {
  input: number
  output: number
  weights: PackedArray
  bias: PackedArray
}

export interface MotionModelData {
  version: number
  bones: string[]
  classes: Array<{ name: string; duration: number; aliases: string[] }>
  text: DenseLayer
  pose: DenseLayer[]
  prototypes: number[][]
}

interface PreparedLayer {
  input: number
  output: number
  weights: Float32Array
  bias: Float32Array
}

export interface PreparedMotionModel extends Omit<MotionModelData, 'text' | 'pose'> {
  text: PreparedLayer
  pose: PreparedLayer[]
}

export interface GeneratedMotion {
  name: string
  duration: number
  bones: string[]
  frames: number
  rotations: Float32Array
}

/** Same NFKC/FNV-1a character n-grams as the offline PyTorch trainer. */
export function hashMotionText(text: string, size = 512): Float32Array {
  const characters = [...normalizeMotionText(text)]
  const features = new Float32Array(size)
  const encoder = new TextEncoder()
  for (const width of [1, 2, 3]) {
    for (let start = 0; start + width <= characters.length; start++) {
      let hash = 2166136261
      for (const byte of encoder.encode(characters.slice(start, start + width).join(''))) {
        hash = Math.imul(hash ^ byte, 16777619) >>> 0
      }
      features[hash % size]++
    }
  }
  let squared = 0
  for (const value of features) squared += value * value
  const norm = Math.sqrt(squared)
  if (norm > 0) for (let i = 0; i < features.length; i++) features[i] /= norm
  return features
}

function normalizeMotionText(text: string): string {
  return [...text.normalize('NFKC').toLowerCase()].filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('')
}

function unpack(source: PackedArray, expected: number): Float32Array {
  if (!Number.isFinite(source.scale) || source.scale <= 0) throw new Error('Avatar motion model has invalid quantization.')
  const bytes = atob(source.data)
  if (bytes.length !== expected * 2) throw new Error('Avatar motion model has invalid weight size.')
  const values = new Float32Array(expected)
  for (let index = 0; index < expected; index++) {
    const raw = bytes.charCodeAt(index * 2) | (bytes.charCodeAt(index * 2 + 1) << 8)
    values[index] = (raw << 16 >> 16) * source.scale
  }
  return values
}

/** Decode quantized weights once at worker startup. */
export function prepareMotionModel(model: MotionModelData): PreparedMotionModel {
  if (model.version !== 1 || !Array.isArray(model.bones) || !Array.isArray(model.classes) || model.pose.length !== 3) {
    throw new Error('Avatar motion model has an unsupported format.')
  }
  const prepare = (layer: DenseLayer): PreparedLayer => ({
    input: layer.input,
    output: layer.output,
    weights: unpack(layer.weights, layer.input * layer.output),
    bias: unpack(layer.bias, layer.output)
  })
  return { ...model, text: prepare(model.text), pose: model.pose.map(prepare) }
}

function linear(layer: PreparedLayer, input: Float32Array): Float32Array {
  if (input.length !== layer.input || layer.weights.length !== layer.input * layer.output || layer.bias.length !== layer.output) {
    throw new Error('Avatar motion model has invalid layer dimensions.')
  }
  const result = new Float32Array(layer.output)
  for (let row = 0; row < layer.output; row++) {
    let value = layer.bias[row]
    const offset = row * layer.input
    for (let column = 0; column < layer.input; column++) value += layer.weights[offset + column] * input[column]
    result[row] = value
  }
  return result
}

function noveltyOverlap(features: Float32Array, prototypes: number[][]): number {
  const present = new Set<number>()
  for (let i = 0; i < features.length; i++) if (features[i] > 0) present.add(i)
  let best = 0
  for (const prototype of prototypes) {
    let shared = 0
    for (const index of prototype) if (present.has(index)) shared++
    best = Math.max(best, shared / Math.max(present.size, prototype.length, 1))
  }
  return best
}

/** Return null for descriptions outside the small model's trained vocabulary. */
export function routeMotion(model: PreparedMotionModel, text: string): number | null {
  if (model.version !== 1 || !text.trim() || text.length > 160) return null
  const cleaned = normalizeMotionText(text)
  let matched: number | null = null
  let matchLength = 0
  for (let index = 0; index < model.classes.length; index++) {
    for (const alias of [model.classes[index].name, ...model.classes[index].aliases]) {
      const normalized = normalizeMotionText(alias)
      if (normalized.length < 2 || normalized.length / cleaned.length < 0.18
        || !cleaned.includes(normalized) || normalized.length <= matchLength) continue
      matched = index
      matchLength = normalized.length
    }
  }
  if (matched !== null) return matched
  const features = hashMotionText(text, model.text.input)
  if (noveltyOverlap(features, model.prototypes) < 0.18) return null
  const logits = linear(model.text, features)
  if (logits.length !== model.classes.length) throw new Error('Avatar motion model has invalid class count.')
  let best = -1
  let second = -1
  for (let i = 0; i < logits.length; i++) {
    if (best < 0 || logits[i] > logits[best]) { second = best; best = i }
    else if (second < 0 || logits[i] > logits[second]) second = i
  }
  if (best < 0 || (second >= 0 && logits[best] - logits[second] < 0.25)) return null
  return best
}

function phaseInput(classes: number, selected: number, phase: number): Float32Array {
  const input = new Float32Array(classes + 25)
  input[selected] = 1
  input[classes] = phase
  for (let harmonic = 1; harmonic <= 12; harmonic++) {
    const angle = phase * harmonic * 2 * Math.PI
    input[classes + harmonic] = Math.sin(angle)
    input[classes + 12 + harmonic] = Math.cos(angle)
  }
  return input
}

function poseAt(model: PreparedMotionModel, selected: number, phase: number): Float32Array {
  let vector = phaseInput(model.classes.length, selected, phase)
  for (let index = 0; index < model.pose.length; index++) {
    vector = linear(model.pose[index], vector)
    if (index < model.pose.length - 1) {
      for (let i = 0; i < vector.length; i++) vector[i] /= 1 + Math.exp(-vector[i])
    }
  }
  if (vector.length !== model.bones.length * 4) throw new Error('Avatar motion model has invalid pose dimensions.')
  for (let i = 0; i < vector.length; i += 4) {
    const norm = Math.hypot(vector[i], vector[i + 1], vector[i + 2], vector[i + 3])
    if (!Number.isFinite(norm) || norm < 1e-6) throw new Error('Avatar motion model produced an invalid rotation.')
    for (let j = 0; j < 4; j++) vector[i + j] /= norm
  }
  return vector
}

/** Runs wholly on the CPU. Call from the Avatar worker, never the render loop. */
export function generateMotion(model: PreparedMotionModel, text: string, fps = 24): GeneratedMotion | null {
  const selected = routeMotion(model, text)
  if (selected === null) return null
  const choice = model.classes[selected]
  const frames = Math.max(2, Math.ceil(choice.duration * fps) + 1)
  const rotations = new Float32Array(frames * model.bones.length * 4)
  for (let frame = 0; frame < frames; frame++) {
    rotations.set(poseAt(model, selected, frame / (frames - 1)), frame * model.bones.length * 4)
  }
  return { name: choice.name, duration: choice.duration, bones: model.bones, frames, rotations }
}
