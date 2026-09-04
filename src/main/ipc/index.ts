// ============================================================
// IPC 处理层 — 主进程侧
// 所有来自渲染进程的请求在这里注册
// ============================================================
import { ipcMain, BrowserWindow } from 'electron'
import type { UserMessageInput, AutoApproveMode, ReasoningEffort } from '../../shared/types'
import { AgentAbortedError } from '../../shared/types'
import * as db from '../store/db'
import { runAgent } from '../agent/runner'
import { fetchContextWindow, planAutoCompact } from '../agent/context'
import { buildEffectiveConversation } from '../agent/history'
import { sanitizeHistoryWithIds } from '../agent/history'
import { log } from '../llm/logger'
import { getMcpConnectionStatus } from '../mcp/client'
import { getSkillsSystemPrompt } from '../skill/manager'
import { buildAgentCallbacks, createIpcAgentEventSink, createIpcPermissionPresenter } from './agentCallbacks'
import { generateId } from '../id'
import type { ApplicationServices } from '../composition'
import { AgentIpcRuntime } from './runtime'
import { mapPersistedHistory } from '../agent/messageMapper'
import { registerGeneralIpc } from './registerGeneralIpc'
import { ensureSessionTitle, collectUserTexts } from '../agent/titleService'
import { sessionNeedsTitle as isDefaultTitle } from '../../shared/sessionTitle'
import { complete } from '../llm/provider'

export function setupIpc(win: BrowserWindow, services: ApplicationServices): void {
  const runtime = new AgentIpcRuntime((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
  services.permissions.addPresenter(createIpcPermissionPresenter(win.webContents))
  const botEventSink = createIpcAgentEventSink(win.webContents)
  for (const bot of services.bots) {
    bot.setAgentEventSink(botEventSink)
    bot.setActivityListener(({ sessionId, state }) => {
      if (state === 'running') {
        if (runtime.runningSessions.has(sessionId)) return false
        runtime.setRunning(sessionId, true)
      } else if (state === 'complete') {
        runtime.setRunning(sessionId, false)
      } else if (state === 'aborted') {
        runtime.setRunning(sessionId, false)
        if (!win.isDestroyed()) win.webContents.send('agent:aborted', { sessionId })
      } else {
        runtime.setRunning(sessionId, false)
      }
    })
  }
  registerGeneralIpc(win, runtime, services)

  // ============================================================
  // Agent 对话
  // ============================================================
  ipcMain.handle('agent:run', (e, sessionId: string, userMessage: UserMessageInput, options?: { providerId?: string; modelOverride?: string; approveMode?: AutoApproveMode; reasoningEffort?: ReasoningEffort }) => {
    // 同一会话同一时刻只允许一个运行（UI 已禁用运行中的输入；这里是防御性检查）。
    // 不同会话之间完全并行，互不阻塞。
    if (runtime.runningSessions.has(sessionId)) {
      return { error: 'This session already has a running agent.' }
    }
    // 只接受合法的 data URL 图片（渲染进程已过滤，这里二次防御）
    const inputImages = (userMessage.images || []).filter(u => typeof u === 'string' && u.startsWith('data:image/'))
    // 初始化批准模式（renderer 传入的值作为初始值，之后通过 agent:set-approve-mode 动态更新）
    if (options?.approveMode) {
      runtime.setApproveMode(sessionId, options.approveMode)
    }
    log('info', `agent:run — sessionId=${sessionId}, approveMode=${runtime.getApproveMode(sessionId)}, providerId=${options?.providerId || '(active)'}, modelOverride=${options?.modelOverride || '(default)'}, images=${inputImages.length}`)
    const settings = db.getSettings()
    // 优先用 options.providerId（聊天页下拉框选择），否则用 settings.activeProviderId
    const providerId = options?.providerId || settings.activeProviderId
    const provider = settings.providers.find(p => p.id === providerId)
    if (!provider) {
      return { error: 'No active provider. Please configure one in Settings.' }
    }

    // 保存用户消息
    const persistedUserMessage = {
      id: generateId(),
      sessionId,
      role: 'user',
      content: userMessage.text,
      images: inputImages.length > 0 ? inputImages : undefined,
      timestamp: Date.now(),
      status: 'done'
    } as const
    db.addMessage(persistedUserMessage)

    // 获取历史消息（完整保留，绝不删除 —— 压缩只影响发给 LLM 的上下文）
    const history = db.getMessages(sessionId)
    const { messages: chatMessages, ids: messageIds } = mapPersistedHistory(history)
    const compaction = db.getSessionCompaction(sessionId)

    // 获取 session 的工作目录（优先用 session 的，没有再用 settings 的默认值）
    const session = db.getSession(sessionId)
    const workspacePath = session?.workspacePath || settings.workspacePath
    // 仍是默认标题 → 提醒 LLM 调 set_title；运行结束后还有兜底生成
    const needsTitle = isDefaultTitle(session?.title)

    // 构建回调（流式 token / 工具调用 / DB 持久化）
    const { callbacks } = buildAgentCallbacks(sessionId, e.sender)

    // 构建权限检查闭包 — 使用动态 getter，运行中切换模式即时生效
    const permissionCheck = services.permissions.createCheck({
      sessionId,
      mode: () => runtime.getApproveMode(sessionId),
      registry: services.tools
    })

    const abortController = new AbortController()
    runtime.abortControllers.set(sessionId, abortController)
    runtime.setRunning(sessionId, true)

    // fire-and-forget：立即返回 ok，agent 在后台独立运行。
    // 多个会话可以各自同时跑；结果通过 agent:complete / agent:error /
    // agent:aborted 事件 + 事件流推送给渲染进程（opencode 同款模式）。
    void runAgent(
      {
        messages: chatMessages,
        messageIds,
        compaction,
        provider,
        workspacePath,
        sessionId,
        permissionCheck,
        signal: abortController.signal,
        modelOverride: options?.modelOverride,
        reasoningEffort: options?.reasoningEffort,
        memoryEnabled: settings.memoryEnabled !== false,
        maxRounds: settings.maxRounds,
        skillsPrompt: getSkillsSystemPrompt(),
        promptRuntime: {
          tools: services.tools.definitions(),
          builtinTools: services.tools.definitionsBySource('builtin'),
          mcpTools: services.tools.definitionsBySource(source => source.startsWith('mcp:')),
          mcpServers: getMcpConnectionStatus()
        },
        toolRegistry: services.tools,
        sessionNeedsTitle: needsTitle,
        onSessionTitleUpdate: (sid, title) => {
          win.webContents.send('session:title_updated', { sessionId: sid, title })
        },
        // 运行中 auto compact 成功 → 持久化新压缩状态（只折叠 LLM 上下文，不动消息表）
        onAutoCompact: (state) => {
          db.setSessionCompaction({ sessionId, ...state, createdAt: Date.now() })
        }
      },
      callbacks
    ).catch((err) => {
      if (err instanceof AgentAbortedError) {
        // 用户主动中止：错误回调不会触发（provider 层按部分内容正常完成），
        // 这里显式通知前端该会话已停止
        e.sender.send('agent:aborted', { sessionId })
        return
      }
      log('error', `agent:run unhandled (sessionId=${sessionId}): ${err instanceof Error ? err.message : String(err)}`)
      // onError 回调已把错误存入 DB 并广播 agent:error
    }).finally(() => {
      runtime.abortControllers.delete(sessionId)
      runtime.setRunning(sessionId, false)
      // 清理该会话的悬挂权限请求（以 false resolve，避免内存泄漏）
      services.permissions.cancelSession(sessionId)
      // 注意：不删除 approveModeMap —— 会话的批准模式需跨运行保留，
      // 运行中切换的模式在下次运行时直接生效
      // 标题兜底：LLM 没调 set_title 时根据用户消息自动生成（幂等，失败静默）
      if (needsTitle) {
        void ensureSessionTitle({
          provider,
          sessionId,
          modelOverride: options?.modelOverride,
          completeFn: complete,
          userTexts: collectUserTexts(chatMessages),
          store: {
            getSessionTitle: sid => db.getSession(sid)?.title ?? null,
            applyGeneratedTitle: (sid, title) => {
              if (db.tryUpdateSessionTitleIfDefault(sid, title)) {
                if (!win.isDestroyed()) win.webContents.send('session:title_updated', { sessionId: sid, title })
              }
            }
          }
        })
      }
    })

    return { ok: true, userMessage: persistedUserMessage }
  })

  // 查询正在运行的会话集合（渲染进程启动时恢复侧边栏运行指示；状态是进程内易失的）
  ipcMain.handle('agent:running', () => {
    return [...runtime.runningSessions]
  })

  // 中止某个会话的运行（只影响该会话，其他会话继续并行执行）
  ipcMain.handle('agent:abort', (_e, sessionId: string) => {
    const ctrl = runtime.abortControllers.get(sessionId)
    if (ctrl) {
      runtime.abort(sessionId)
      // 立即通知前端该会话已停止（runAgent 的 finally 也会清理一次，幂等）
      win.webContents.send('agent:aborted', { sessionId })
    } else {
      for (const bot of services.bots) {
        if (bot.abortSession(sessionId)) break
      }
    }
    // 只清理该会话的悬挂权限请求（以 false resolve，避免内存泄漏；
    // 其他并行会话的权限弹窗不受影响）
    services.permissions.cancelSession(sessionId)
    return true
  })

  // 动态切换批准模式（运行中即时生效）
  ipcMain.handle('agent:set-approve-mode', (_e, sessionId: string, mode: AutoApproveMode) => {
    runtime.setApproveMode(sessionId, mode)
    log('info', `approveMode changed: sessionId=${sessionId}, mode=${mode}`)
    return true
  })

  // 手动压缩上下文（非破坏性：只持久化"边界 + 摘要"，不删除/不改写消息表）。
  // 用户侧始终看到完整历史；下次构建 LLM 上下文时边界之前的消息被摘要替换。
  ipcMain.handle('agent:compact-now', async (e, sessionId: string) => {
    // 运行中不允许手动压缩：workingMessages 与压缩状态会不一致
    if (runtime.abortControllers.has(sessionId)) {
      return { error: 'Agent is running. Wait for it to finish before compacting.' }
    }

    const settings = db.getSettings()
    const provider = settings.providers.find(p => p.id === settings.activeProviderId)
    if (!provider) {
      return { error: 'No active provider. Please configure one in Settings.' }
    }

    try {
      const history = db.getMessages(sessionId)
      if (history.length < 4) {
        return { ok: true, info: { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: history.length } }
      }
      // 与 agent:run 相同的组装：图片转多模态
      const { messages: chatMessages, ids } = mapPersistedHistory(history)

      // 清洗非法序列（ids 平行对齐）→ 构建当前 effective 上下文（含已有压缩）
      const { messages: sanitized, ids: sanitizedIds } = sanitizeHistoryWithIds(chatMessages, ids)
      const compaction = db.getSessionCompaction(sessionId)
      const built = buildEffectiveConversation(sanitized, sanitizedIds, compaction)
      const effective = built.effective
      // effectiveIds 与 effective 平行对齐（虚拟摘要位 = null）
      const effectiveIds: Array<string | null> = built.hasSummary
        ? [null, ...sanitizedIds.slice(built.keptFromIndex)]
        : [...sanitizedIds]

      const contextWindow = await fetchContextWindow(provider)
      const plan = await planAutoCompact(effective, provider, undefined, contextWindow)
      if (plan.compressedCount <= 0) {
        return { ok: true, info: { beforeTokens: plan.beforeTokens, afterTokens: plan.afterTokens, compressedCount: 0, keptCount: plan.keptCount } }
      }

      // 新边界 = 被折叠进摘要的最后一条真实历史消息 id（effective[keptOffset-1]）；
      // 若该位是虚拟摘要（null，即只折叠了旧摘要），沿用旧边界
      const boundaryId = effectiveIds[plan.keptOffset - 1] || compaction?.upToMessageId || null
      if (!boundaryId || !plan.summary) {
        // 摘要生成失败 → 不持久化（避免丢失旧摘要），提示错误
        return { error: 'Summary generation failed. Check the LLM provider settings and try again.' }
      }
      db.setSessionCompaction({ sessionId, upToMessageId: boundaryId, summary: plan.summary, createdAt: Date.now() })

      // 通知前端展示压缩提示（source=manual：压缩状态已更新，消息列表本身不变；
      // 前端用 boundaryMessageId 在完整历史里渲染"历史已折叠"标记）
      e.sender.send('agent:compact', { sessionId, source: 'manual', boundaryMessageId: boundaryId, beforeTokens: plan.beforeTokens, afterTokens: plan.afterTokens, compressedCount: plan.compressedCount, keptCount: plan.keptCount })
      log('info', `Manual compact done: sessionId=${sessionId}, boundary=${boundaryId}, ${plan.beforeTokens} → ${plan.afterTokens} tokens`)
      return { ok: true, info: { beforeTokens: plan.beforeTokens, afterTokens: plan.afterTokens, compressedCount: plan.compressedCount, keptCount: plan.keptCount } }
    } catch (err) {
      const msg = (err as Error).message
      log('error', `Manual compact failed: ${msg}`)
      return { error: msg }
    }
  })

  // 权限响应
  ipcMain.handle('agent:permission_response', (_e, permId: string, allowed: boolean) => {
    return services.permissions.respond(permId, allowed)
  })

}
