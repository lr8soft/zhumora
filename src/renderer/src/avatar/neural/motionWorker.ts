import weights from './motion-model.json'
import { generateMotion, prepareMotionModel, type MotionModelData } from './inference'

const model = prepareMotionModel(weights as MotionModelData)

// Handshake first: the controller needs the trained vocabulary before it can
// decide which intents the model may drive.
self.postMessage({ classes: model.classes.map(entry => entry.name) })

self.addEventListener('message', (event: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = event.data
  try {
    const motion = generateMotion(model, text)
    self.postMessage({ id, motion }, { transfer: motion ? [motion.rotations.buffer as ArrayBuffer] : [] })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
