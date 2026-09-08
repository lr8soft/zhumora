import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { equivalentTtsModels, normalizeTtsModels, prepareSpeechText, resolveDefaultTtsModelId, splitSpeechText, type TtsModelConfig } from '../src/shared/tts.ts'
import { inspectTtsModelDirectory, validateTtsModel } from '../src/main/tts/sherpaProvider.ts'
import { TtsManager, type TtsProvider } from '../src/main/tts/manager.ts'
import { createTtsAgentEventSink } from '../src/main/tts/agentEvents.ts'
import { TtsPlaybackQueue, type QueuedAudio } from '../src/renderer/src/tts/playbackQueue.ts'
import { TtsPlaybackController } from '../src/renderer/src/tts/playback.ts'
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
const speechParts = splitSpeechText(`${'甲'.repeat(60)}。${'乙'.repeat(60)}`, 70)
assert.equal(speechParts.length, 2)
assert.ok(speechParts.every(part => part.length <= 70))

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
const releases: Array<() => void> = []
const provider: TtsProvider = {
  reset() { calls.push('reset') },
  async synthesize(text, _model, signal) {
    calls.push(text)
    await new Promise<void>(resolve => { releases.push(resolve) })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return { samples: new Float32Array([0, 0.1]), sampleRate: 24000 }
  }
}
const manager = new TtsManager({ getSession: () => session, getSettings: () => settings }, provider)
const sent: Array<{ channel: string; payload: unknown }> = []
manager.attachRenderer({
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) }
} as never)
manager.enqueue('s1', 'm1', '**Hello**')
manager.enqueue('s1', 'm2', 'World')
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(calls, ['Hello'])
releases.shift()?.()
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(calls, ['Hello', 'World'])
assert.equal(sent.filter(event => event.channel === 'tts:audio').length, 1)
manager.stop('s1')
releases.shift()?.()
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(sent.some(event => event.channel === 'tts:stop'), true)
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
disabledManager.enqueue('s1', 'm2', 'Must remain silent')
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(disabledCalls, [])
disabledManager.dispose()

const eventCalls: string[] = []
const sink = createTtsAgentEventSink({
  enqueue: (_sessionId, _messageId, content) => eventCalls.push(`speak:${content}`),
  stop: sessionId => eventCalls.push(`stop:${sessionId}`)
})
sink.reasoning?.('s1', 'm1', 'private thought')
sink.toolCall?.('s1', 'm1', { id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } })
sink.assistantEnd?.('s1', 'm1', 'Before tool', [])
sink.complete?.('s1', 'm1', 'Before tool')
assert.deepEqual(eventCalls, ['speak:Before tool'])
sink.error?.('s1', new Error('failed'))
assert.deepEqual(eventCalls, ['speak:Before tool', 'stop:s1'])

const playback = new TtsPlaybackQueue()
const playbackEvents: string[] = []
const endings = new Map<string, () => void>()
const audio = (id: string, sessionId: string): QueuedAudio => ({
  sessionId,
  start: ended => { playbackEvents.push(`start:${id}`); endings.set(id, ended) },
  stop: () => playbackEvents.push(`stop:${id}`)
})
playback.enqueue(audio('a', 's1'))
playback.enqueue(audio('b', 's2'))
playback.enqueue(audio('c', 's1'))
assert.deepEqual(playbackEvents, ['start:a'])
playback.stop('s1')
assert.deepEqual(playbackEvents, ['start:a', 'stop:a', 'stop:c', 'start:b'])
endings.get('b')?.()
assert.deepEqual(playbackEvents, ['start:a', 'stop:a', 'stop:c', 'start:b'])

let createdContexts = 0
let startedSources = 0
const playbackController = new TtsPlaybackController(() => {
  createdContexts++
  return {
    state: 'running',
    resume: async () => {},
    close: async () => {},
    destination: {},
    createBuffer: () => ({ copyToChannel: () => {} }),
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => {},
      disconnect: () => {},
      start: () => { startedSources++ },
      stop: () => {}
    })
  } as unknown as AudioContext
})
playbackController.dispose()
await playbackController.play({ sessionId: 's1', messageId: 'm1', samples: new Float32Array([0.1]), sampleRate: 24000 })
assert.equal(createdContexts, 1, 'StrictMode remount must create a fresh audio context')
assert.equal(startedSources, 1, 'StrictMode cleanup must not permanently disable playback')
playbackController.dispose()

console.log('TTS config, import and lifecycle tests passed')
