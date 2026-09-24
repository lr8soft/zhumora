import type { VRM } from '@pixiv/three-vrm'
import { trainedAvatarIntents, type AvatarIntent } from '@shared/avatar'
import type { NeuralMotionSource } from '../AvatarMotionController'
import { NeuralMotionClient } from './NeuralMotionClient'
import { createNeuralClip } from './createNeuralClip'

/** A stalled worker must never block the Avatar ready signal. */
const STARTUP_TIMEOUT_MS = 5000

export interface NeuralMotionBinding {
  client: NeuralMotionClient
  /** Trained action names, reported as capabilities and written into the prompt. */
  actions: string[]
  source: NeuralMotionSource
}

/**
 * Starts the CPU motion worker and binds it to a loaded VRM. `perform` may only
 * use intents the model was actually trained on; the returned binding exposes
 * that subset so every other intent keeps its built-in procedural motion.
 */
export async function bindNeuralMotion(vrm: VRM): Promise<NeuralMotionBinding> {
  const client = new NeuralMotionClient()
  let actions: string[]
  try {
    actions = await withTimeout(client.classes(), STARTUP_TIMEOUT_MS)
  } catch (error) {
    client.dispose()
    throw error
  }
  const intents: ReadonlySet<AvatarIntent> = new Set(trainedAvatarIntents(actions))
  return {
    client,
    actions,
    source: {
      intents,
      generate: async (text, intensity) => {
        const generated = await client.generate(text)
        return generated ? createNeuralClip(vrm, generated, intensity) : null
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Avatar motion worker did not start in time.')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}
