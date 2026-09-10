// IPC is a transport adapter. Session policy and Agent orchestration live in SessionService.
import { BrowserWindow, ipcMain } from 'electron'
import type { AutoApproveMode, ReasoningEffort, UserMessageInput } from '../../shared/types'
import { AgentAbortedError } from '../../shared/types'
import type { ApplicationServices } from '../composition'
import { createAvatarAgentEventSink } from '../avatar/agentEvents'
import { createTtsAgentEventSink } from '../tts/agentEvents'
import { log } from '../llm/logger'
import { combineAgentEventSinks } from '../agent/persistedCallbacks'
import { createIpcAgentEventSink, createIpcPermissionPresenter } from './agentCallbacks'
import { registerAvatarIpc } from './registerAvatarIpc'
import { registerGeneralIpc } from './registerGeneralIpc'
import { registerTtsIpc } from './registerTtsIpc'

export function setupIpc(win: BrowserWindow, services: ApplicationServices): void {
  services.tts.attachRenderer(win.webContents)
  services.permissions.addPresenter(createIpcPermissionPresenter(win.webContents))
  services.sessions.events.subscribe(combineAgentEventSinks(
    createIpcAgentEventSink(win.webContents),
    createAvatarAgentEventSink(services.avatar),
    createTtsAgentEventSink(services.tts),
    {
      running: (sessionId, running) => {
        if (!running) services.desktopControl.release(sessionId)
      }
    }
  ))

  registerGeneralIpc(win, services)
  registerAvatarIpc(win, services.avatar)
  registerTtsIpc(win, services.tts)

  ipcMain.handle('agent:run', async (
    _event,
    sessionId: string,
    userMessage: UserMessageInput,
    options?: {
      providerId?: string
      modelOverride?: string
      approveMode?: AutoApproveMode
      reasoningEffort?: ReasoningEffort
    }
  ) => {
    try {
      log('info', `agent:run — sessionId=${sessionId}, providerId=${options?.providerId || '(active)'}, modelOverride=${options?.modelOverride || '(default)'}`)
      const run = await services.sessions.sendMessage({
        sessionId,
        message: userMessage,
        providerId: options?.providerId,
        modelOverride: options?.modelOverride,
        approveMode: options?.approveMode,
        reasoningEffort: options?.reasoningEffort
      })
      void run.completion.catch(error => {
        if (!(error instanceof AgentAbortedError)) {
          log('error', `agent:run failed (sessionId=${sessionId}): ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      return { ok: true, userMessage: run.userMessage }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:running', () => services.sessions.runningSessionIds())

  ipcMain.handle('agent:abort', (_event, sessionId: string) => {
    services.tts.stop(sessionId)
    services.sessions.abort(sessionId)
    return true
  })

  ipcMain.handle('agent:set-approve-mode', (_event, sessionId: string, mode: AutoApproveMode) => {
    services.sessions.setApproveMode(sessionId, mode)
    log('info', `approveMode changed: sessionId=${sessionId}, mode=${mode}`)
    return true
  })

  ipcMain.handle('agent:compact-now', async (_event, sessionId: string) => {
    try {
      return { ok: true, info: await services.sessions.compact(sessionId) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Manual compact failed: ${message}`)
      return { error: message }
    }
  })

  ipcMain.handle('agent:permission_response', (_event, permissionId: string, allowed: boolean) =>
    services.permissions.respond(permissionId, allowed))
}
