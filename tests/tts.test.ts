import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { equivalentTtsModels, normalizeTtsModels, prepareSpeechText, resolveDefaultTtsModelId, type TtsModelConfig } from '../src/shared/tts.ts'
import { inspectTtsModelDirectory, validateTtsModel } from '../src/main/tts/sherpaProvider.ts'
import { TtsManager, type TtsProvider } from '../src/main/tts/manager.ts'
import type { AppSettings, Session } from '../src/shared/types.ts'

const base: TtsModelConfig = {
  id: 'voice-1', name: 'Voice', type: 'vits', directory: 'D:/voice',
  modelPath: 'D:/voice/model.onnx', tokensPath: 'D:/voice/tokens.txt',
  lexiconPaths: [], ruleFsts: [], speakerId: 0, speed: 1
}
assert.deepEqual(normalizeTtsModels([{ ...base, speed: 9, speakerId: -2 }, base]), [{ ...base, speed: 2 }])
assert.equal(resolveDefaultTtsModelId([base], 'missing'), 'voice-1')
assert.equal(equivalentTtsModels([base, { ...base, id: 'voice-2' }], [{ ...base, id: 'voice-2' }, base]), true)
assert.equal(prepareSpeechText('## Hello [world](https://example.com)\n```ts\nsecret()\n```'), 'Hello world')
assert.equal(prepareSpeechText(null), '')

const directory = await mkdtemp(join(tmpdir(), 'zhumora-tts-'))
try {
  await Promise.all([
    writeFile(join(directory, 'en_US-voice.onnx'), ''), writeFile(join(directory, 'tokens.txt'), ''),
    writeFile(join(directory, 'lexicon-zh.txt'), ''), writeFile(join(directory, 'number.fst'), ''),
    mkdir(join(directory, 'espeak-ng-data'))
  ])
  const inspected = await inspectTtsModelDirectory(directory, 'imported')
  assert.equal(inspected.type, 'vits')
  assert.equal(inspected.modelPath, join(directory, 'en_US-voice.onnx'))
  assert.deepEqual(inspected.lexiconPaths, [join(directory, 'lexicon-zh.txt')])
  assert.deepEqual(inspected.ruleFsts, [join(directory, 'number.fst')])
} finally { await rm(directory, { recursive: true, force: true }) }

const kokoroDirectory = await mkdtemp(join(tmpdir(), 'zhumora-kokoro-'))
try {
  await Promise.all([
    writeFile(join(kokoroDirectory, 'model.int8.onnx'), ''),
    writeFile(join(kokoroDirectory, 'tokens.txt'), ''),
    writeFile(join(kokoroDirectory, 'voices.bin'), '')
  ])
  const inspected = await inspectTtsModelDirectory(kokoroDirectory, 'kokoro')
  assert.equal(inspected.type, 'kokoro')
  assert.equal(inspected.voicesPath, join(kokoroDirectory, 'voices.bin'))
} finally { await rm(kokoroDirectory, { recursive: true, force: true }) }

const ambiguousDirectory = await mkdtemp(join(tmpdir(), 'zhumora-tts-ambiguous-'))
try {
  await Promise.all([
    writeFile(join(ambiguousDirectory, 'acoustic.onnx'), ''),
    writeFile(join(ambiguousDirectory, 'vocoder.onnx'), ''),
    writeFile(join(ambiguousDirectory, 'tokens.txt'), '')
  ])
  await assert.rejects(inspectTtsModelDirectory(ambiguousDirectory, 'ambiguous'), /unambiguous ONNX model/)
} finally { await rm(ambiguousDirectory, { recursive: true, force: true }) }

const guardedDirectory = await mkdtemp(join(tmpdir(), 'zhumora-tts-guard-'))
const outsideModel = join(tmpdir(), `zhumora-outside-${Date.now()}.onnx`)
try {
  await Promise.all([
    writeFile(join(guardedDirectory, 'tokens.txt'), ''),
    writeFile(outsideModel, '')
  ])
  await assert.rejects(
    validateTtsModel({ ...base, directory: guardedDirectory, modelPath: outsideModel, tokensPath: join(guardedDirectory, 'tokens.txt') }),
    /invalid file path/
  )
} finally {
  await Promise.all([rm(guardedDirectory, { recursive: true, force: true }), rm(outsideModel, { force: true })])
}

const session: Session = {
  id: 's1', title: 'Session', createdAt: 1, updatedAt: 1, messageCount: 1,
  avatarEnabled: false, ttsEnabled: true
}
const settings = { ttsModels: [base], defaultTtsModelId: base.id } as AppSettings
const calls: string[] = []
let release: (() => void) | undefined
const provider: TtsProvider = {
  reset() { calls.push('reset') },
  async synthesize(text, _model, signal) {
    calls.push(text)
    await new Promise<void>(resolve => { release = resolve })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return { samples: new Float32Array([0, 0.1]), sampleRate: 24000 }
  }
}
const manager = new TtsManager({ getSession: () => session, getSettings: () => settings }, provider)
manager.complete('s1', 'm1', '**Hello**')
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(calls, ['Hello'])
manager.stop('s1')
release?.()
manager.dispose()

const disabledCalls: string[] = []
const disabledProvider: TtsProvider = {
  reset() {},
  async synthesize(text) { disabledCalls.push(text); return { samples: new Float32Array(), sampleRate: 24000 } }
}
const disabledManager = new TtsManager({
  getSession: () => ({ ...session, ttsEnabled: false }),
  getSettings: () => settings
}, disabledProvider)
disabledManager.complete('s1', 'm2', 'Must remain silent')
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(disabledCalls, [])
disabledManager.dispose()

console.log('TTS config, import and lifecycle tests passed')
