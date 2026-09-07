import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { TtsSessionUpdate } from '../../shared/tts'
import * as db from '../store/db'
import type { TtsManager } from '../tts/manager'

export function registerTtsIpc(win: BrowserWindow, tts: TtsManager): void {
  ipcMain.handle('tts:import-model', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a sherpa-onnx VITS or Kokoro model folder',
      properties: ['openDirectory']
    })
    return result.canceled ? null : tts.importModel(result.filePaths[0])
  })

  ipcMain.handle('tts:session-set', (_event, sessionId: unknown, requested: TtsSessionUpdate) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id.')
    if (!db.getSession(sessionId)) throw new Error('Session not found.')
    const enabled = requested?.enabled === true
    const settings = db.getSettings()
    if (enabled && !settings.ttsModels.some(model => model.id === settings.defaultTtsModelId)) {
      throw new Error('Import and select a default TTS model first.')
    }
    db.updateSessionTts(sessionId, enabled)
    if (!enabled) tts.stop(sessionId)
    return db.getSession(sessionId)
  })
}
