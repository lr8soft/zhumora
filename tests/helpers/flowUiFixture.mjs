/** Browser-only fixture: exercises the real renderer through the same typed event payloads as preload. */
export function installFlowUiFixture() {
  localStorage.setItem('zhumora-language', 'zh')
  localStorage.setItem('zhumora.theme', 'light')
  const sessions = ['parent', 'child-a', 'child-b', 'other'].map((id, index) => ({
    id, title: ['项目架构分析', '架构梳理', '权限审查', '浏览器任务'][index], createdAt: 1, updatedAt: 1,
    workspacePath: 'D:\\mini-agent', messageCount: 8, origin: 'renderer', avatarEnabled: false, ttsEnabled: false,
    ...(id.startsWith('child') ? { subagent: { parentSessionId: 'parent', providerId: 'local', model: '默认模型' } } : {})
  }))
  let clock = 1
  const m = (id, sessionId, role, content, extra = {}) => ({ id, sessionId, role, content, timestamp: clock++, status: 'done', ...extra })
  const c = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const ta = { task_id: 'task-a', session_id: 'child-a', parentSessionId: 'parent', status: 'running' }
  const tb = { task_id: 'task-b', session_id: 'child-b', parentSessionId: 'parent', status: 'running' }
  const histories = {
    parent: [m('old-u', 'parent', 'user', '介绍一下项目。'), m('old-a', 'parent', 'assistant', '这是一个桌面 AI Agent。'),
      m('u', 'parent', 'user', '分析项目架构与权限边界。'),
      m('a', 'parent', 'assistant', '分别委托架构梳理和权限审查。', { reasoning: '两项审查可以独立进行，最终统一整理结果。',
        toolCalls: [c('spawn-a', 'spawn_subagent', { description: '架构梳理', prompt: '阅读架构文档，梳理会话边界。' }),
          c('spawn-b', 'spawn_subagent', { description: '权限审查', prompt: '检查权限裁决与中止行为。' })] }),
      m('sa', 'parent', 'tool', JSON.stringify(ta), { toolCallId: 'spawn-a', toolName: 'spawn_subagent' }),
      m('sb', 'parent', 'tool', JSON.stringify(tb), { toolCallId: 'spawn-b', toolName: 'spawn_subagent' }),
      m('w', 'parent', 'assistant', '接收两个子任务的分析结果。', { toolCalls: [c('wait', 'wait_subagents', { task_ids: ['task-a', 'task-b'] })] }),
      m('wr', 'parent', 'tool', JSON.stringify([{ ...ta, status: 'completed', reply: 'SessionService 是会话入口。' },
        { ...tb, status: 'completed', reply: '权限由 PermissionBroker 裁决。' }]), { toolCallId: 'wait', toolName: 'wait_subagents' }),
      m('final', 'parent', 'assistant', '## 架构分析结果\n\n- **SessionService** 统一管理会话与运行。\n- **SessionEventHub** 分发按会话隔离的事件。\n- **PermissionBroker** 统一裁决工具权限。\n\n两个子任务的结果已经接收，完整历史保留在各自会话中。')],
    'child-a': [m('ca-u', 'child-a', 'user', '梳理会话与消息事件链路。'),
      m('ca-a', 'child-a', 'assistant', '读取架构说明。', { toolCalls: [c('read', 'read', { file_path: 'ARCHITECTURE.md' })] }),
      m('ca-t', 'child-a', 'tool', 'SessionService 是唯一会话入口。消息与运行事件由 SessionEventHub 分发。', { toolCallId: 'read', toolName: 'read' }),
      m('ca-final', 'child-a', 'assistant', '会话边界与事件链路已梳理。')],
    'child-b': [m('cb-u', 'child-b', 'user', '检查权限和取消语义。'),
      m('cb-a', 'child-b', 'assistant', '搜索权限裁决入口。', { toolCalls: [c('grep', 'grep', { pattern: 'PermissionBroker' })] }),
      m('cb-t', 'child-b', 'tool', '权限唯一入口：PermissionBroker；中止后不得执行新工具。', { toolCallId: 'grep', toolName: 'grep' }),
      m('cb-final', 'child-b', 'assistant', '权限确认入口与中止约束已验证。')],
    other: [m('other-u', 'other', 'user', '打开浏览器。'), m('other-a', 'other', 'assistant', '独立会话内容。')]
  }
  const callbacks = new Map()
  const calls = []
  const section = (name, methods) => new Proxy(methods, {
    get(target, key) {
      if (key in target) return target[key]
      if (String(key).startsWith('on')) return callback => {
        const event = `${name}.${String(key)}`
        if (!callbacks.has(event)) callbacks.set(event, new Set())
        callbacks.get(event).add(callback)
        return () => callbacks.get(event).delete(callback)
      }
      return async (...args) => { calls.push([name, key, args]); return null }
    }
  })
  window.api = section('root', {
    platform: 'win32', session: section('session', { list: async () => sessions, messages: async id => structuredClone(histories[id] ?? []),
      compaction: async () => null, get: async id => sessions.find(session => session.id === id) }),
    settings: section('settings', { get: async () => {
      const { initialSettingsProjection } = await import('/src/store/settingsDefaults.ts')
      return { ...initialSettingsProjection(), language: 'zh', workspacePath: 'D:\\mini-agent',
        providers: [{ id: 'local', name: '本地模型', enabled: true, defaultModel: '默认模型', baseUrl: 'http://fixture.invalid', apiKey: '' }], activeProviderId: 'local' }
    } }),
    window: section('window', { isMaximized: async () => false }),
    agent: section('agent', { running: async () => [], abort: async id => { calls.push(['abort', id]); return true } }),
    provider: section('provider', { listModels: async () => ['默认模型'] }),
    tts: section('tts', {}), avatar: section('avatar', {}), memory: section('memory', {}), mcp: section('mcp', {})
  })
  window.flowUiFixture = {
    emit: (event, payload) => callbacks.get(event)?.forEach(callback => callback(payload)), histories, calls,
    nodes: () => document.querySelectorAll('.react-flow__node').length
  }
}
