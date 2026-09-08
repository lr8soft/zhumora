import { access, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import * as path from 'node:path'
import type { TtsModelConfig } from '../../shared/tts.ts'

export interface SynthesizedAudio { samples: Float32Array; sampleRate: number }

interface SherpaTts {
  generateAsync(request: object): Promise<SynthesizedAudio>
}

interface SherpaModule {
  OfflineTts: { createAsync(config: object): Promise<SherpaTts> }
  GenerationConfig: new (config: object) => object
}

const nodeRequire = createRequire(import.meta.url)

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function existingFile(root: string, file: string, extension?: string): Promise<string> {
  if (!contained(root, file) || (extension && path.extname(file).toLowerCase() !== extension)) {
    throw new Error('TTS model contains an invalid file path.')
  }
  await access(file)
  if (!(await stat(file)).isFile()) throw new Error(`TTS model file is missing: ${path.basename(file)}`)
  return file
}

async function existingDirectory(root: string, directory?: string): Promise<string | undefined> {
  if (!directory) return undefined
  if (!contained(root, directory) || !(await stat(directory)).isDirectory()) {
    throw new Error('TTS model contains an invalid data directory.')
  }
  return directory
}

export async function validateTtsModel(model: TtsModelConfig): Promise<void> {
  const root = path.resolve(model.directory)
  if (!(await stat(root)).isDirectory()) throw new Error('TTS model directory no longer exists.')
  await existingFile(root, model.modelPath, '.onnx')
  await existingFile(root, model.tokensPath, '.txt')
  if (model.type === 'kokoro') await existingFile(root, model.voicesPath || '', '.bin')
  await Promise.all(model.lexiconPaths.map(file => existingFile(root, file, '.txt')))
  await Promise.all(model.ruleFsts.map(file => existingFile(root, file, '.fst')))
  await existingDirectory(root, model.dataDir)
}

export async function inspectTtsModelDirectory(directory: string, id: string): Promise<TtsModelConfig> {
  const root = path.resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  const onnxFiles = files.filter(name => name.toLowerCase().endsWith('.onnx'))
  const modelName = files.find(name => name.toLowerCase() === 'model.onnx')
    || files.find(name => name.toLowerCase() === 'model.int8.onnx')
    || (onnxFiles.length === 1 ? onnxFiles[0] : undefined)
  const tokensName = files.find(name => name.toLowerCase() === 'tokens.txt')
  const voicesName = files.find(name => /^voices?\.bin$/i.test(name))
  if (!modelName || !tokensName) {
    throw new Error('Select a sherpa-onnx model folder containing tokens.txt and one unambiguous ONNX model file.')
  }
  const type = voicesName ? 'kokoro' : 'vits'
  const dataDirName = entries.find(entry => entry.isDirectory() && /^(?:espeak-ng-data|data)$/i.test(entry.name))?.name
  const result: TtsModelConfig = {
    id,
    name: path.basename(root),
    type,
    directory: root,
    modelPath: path.join(root, modelName),
    tokensPath: path.join(root, tokensName),
    lexiconPaths: files.filter(name => /^lexicon.*\.txt$/i.test(name)).sort().map(name => path.join(root, name)),
    ruleFsts: files.filter(name => name.toLowerCase().endsWith('.fst')).sort().map(name => path.join(root, name)),
    ...(dataDirName ? { dataDir: path.join(root, dataDirName) } : {}),
    ...(voicesName ? { voicesPath: path.join(root, voicesName) } : {}),
    speakerId: 0,
    speed: 1
  }
  await validateTtsModel(result)
  return result
}

export class SherpaOnnxTtsProvider {
  private loaded: { key: string; instance: SherpaTts; module: SherpaModule } | undefined

  async synthesize(text: string, model: TtsModelConfig, signal: AbortSignal): Promise<SynthesizedAudio> {
    await validateTtsModel(model)
    if (signal.aborted) throw new DOMException('TTS synthesis aborted.', 'AbortError')
    const sherpa = nodeRequire('sherpa-onnx-node') as SherpaModule
    const key = JSON.stringify({
      type: model.type, modelPath: model.modelPath, tokensPath: model.tokensPath,
      voicesPath: model.voicesPath, lexiconPaths: model.lexiconPaths,
      dataDir: model.dataDir, ruleFsts: model.ruleFsts
    })
    if (this.loaded?.key !== key) {
      const common = {
        model: model.modelPath,
        tokens: model.tokensPath,
        lexicon: model.lexiconPaths.join(','),
        ...(model.dataDir ? { dataDir: model.dataDir } : {})
      }
      const config = {
        model: {
          [model.type]: model.type === 'kokoro' ? { ...common, voices: model.voicesPath } : common,
          debug: false,
          numThreads: Math.max(1, Math.min(4, availableParallelism())),
          provider: 'cpu'
        },
        maxNumSentences: 1,
        ...(model.ruleFsts.length ? { ruleFsts: model.ruleFsts.join(',') } : {})
      }
      this.loaded = { key, instance: await sherpa.OfflineTts.createAsync(config), module: sherpa }
    }
    const generationConfig = new this.loaded.module.GenerationConfig({
      sid: model.speakerId, speed: model.speed, silenceScale: 0.2
    })
    const audio = await this.loaded.instance.generateAsync({
      text,
      enableExternalBuffer: true,
      generationConfig,
      onProgress: () => signal.aborted ? 0 : 1
    })
    if (signal.aborted) throw new DOMException('TTS synthesis aborted.', 'AbortError')
    return audio
  }

  reset(): void { this.loaded = undefined }
}
