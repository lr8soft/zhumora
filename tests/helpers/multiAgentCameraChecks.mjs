import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertFollowedNode, settleViewport, viewportStyle } from './flowCameraChecks.mjs'

export async function assertMultiAgentCamera(page) {
  const output = resolve('.temp/multi-follow')
  await mkdir(output, { recursive: true })
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const m = (id, sessionId, role, content, extra = {}) => ({ id, sessionId, role, content, timestamp: 1, status: 'done', ...extra })
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    const a = { task_id: 'camera-a', session_id: 'child-a', parentSessionId: 'parent', status: 'running' }
    const b = { task_id: 'camera-b', session_id: 'child-b', parentSessionId: 'parent', status: 'running' }
    const parent = [m('camera-u', 'parent', 'user', '同时进行两个子任务'),
      m('camera-spawn', 'parent', 'assistant', '派发独立工作', { toolCalls: [call('spawn-a', 'spawn_subagent', {}), call('spawn-b', 'spawn_subagent', {})] }),
      m('camera-ra', 'parent', 'tool', JSON.stringify(a), { toolCallId: 'spawn-a', toolName: 'spawn_subagent' }),
      m('camera-rb', 'parent', 'tool', JSON.stringify(b), { toolCallId: 'spawn-b', toolName: 'spawn_subagent' }),
      m('camera-wait', 'parent', 'assistant', '主 Agent 等待汇总', { toolCalls: [call('camera-w', 'wait_subagents', { task_ids: ['camera-a', 'camera-b'] })] })]
    const childA = [m('camera-au', 'child-a', 'user', '调查 A'), m('camera-a-live', 'child-a', 'assistant', '子任务 A', { status: 'streaming' })]
    const childB = [m('camera-bu', 'child-b', 'user', '调查 B'), m('camera-b-live', 'child-b', 'assistant', '子任务 B', { status: 'streaming' })]
    Object.assign(flowUiFixture.histories, { parent, 'child-a': childA, 'child-b': childB })
    useAppStore.setState(state => ({ activeSessionId: 'parent', runningIds: new Set(['parent', 'child-a', 'child-b']),
      retryStatus: {}, compactionMarkers: {}, messages: { ...state.messages, parent, 'child-a': childA, 'child-b': childB } }))
    useAppStore.getState().setTheme('light')
  })
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.getByRole('button', { name: '自动跟随', exact: true }).click()
  for (const text of ['主 Agent 等待汇总', '子任务 A', '子任务 B']) await assertFollowedNode(page, text)
  const overview = await viewportStyle(page)
  await page.screenshot({ path: resolve(output, 'parallel-light.png') })
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onToken', { sessionId: 'child-a', messageId: 'camera-a-live', token: '，调查中' })
    flowUiFixture.emit('agent.onToken', { sessionId: 'child-b', messageId: 'camera-b-live', token: '，调查中' })
  })
  await assertFollowedNode(page, '子任务 A，调查中'); await assertFollowedNode(page, '子任务 B，调查中')
  assert.equal(await viewportStyle(page), overview, 'interleaved child tokens do not move the overview')
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'child-a', messageId: 'camera-a-live', phase: 'end', content: '子任务 A，调查中', toolCalls: [] })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'child-a', messageId: 'camera-a-next', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'child-a', messageId: 'camera-a-next', token: '子任务 A 下一步' })
  })
  for (const text of ['主 Agent 等待汇总', '子任务 A 下一步', '子任务 B，调查中']) await assertFollowedNode(page, text)
  await page.evaluate(async () => { const { useAppStore } = await import('/src/store/index.ts'); useAppStore.getState().setTheme('dark') })
  await page.screenshot({ path: resolve(output, 'parallel-dark.png') })
  for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '放大', exact: true }).click(); await settleViewport(page) }
  const zoom = await page.evaluate(() => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a)
  await page.locator('.flow-follow-overflow').waitFor()
  const custom = await viewportStyle(page)
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'child-b', messageId: 'camera-b-live', phase: 'end', content: '子任务 B，调查中', toolCalls: [] })
    for (let i = 0; i < 8; i++) {
      const messageId = `camera-b-far-${i}`
      flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'child-b', messageId, phase: 'start', content: '', toolCalls: [] })
      flowUiFixture.emit('agent.onToken', { sessionId: 'child-b', messageId, token: `子任务 B 推进 ${i}` })
      if (i < 7) flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'child-b', messageId, phase: 'end', content: `子任务 B 推进 ${i}`, toolCalls: [] })
    }
  })
  await page.waitForFunction(async () => (await import('/src/store/index.ts')).useAppStore.getState().messages['child-b'].at(-1)?.content === '子任务 B 推进 7')
  await settleViewport(page)
  assert.equal(await viewportStyle(page), custom, 'offscreen child progress does not steal the custom-zoom viewport')
  assert.equal(await page.getByRole('button', { name: '自动跟随', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(() => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a), zoom)
  await page.screenshot({ path: resolve(output, 'custom-zoom-dark.png') })
  await page.getByRole('button', { name: '显示活跃节点', exact: true }).click()
  for (const text of ['主 Agent 等待汇总', '子任务 A 下一步', '子任务 B 推进 7']) await assertFollowedNode(page, text)
  assert.equal(await page.locator('.flow-follow-overflow').count(), 0, 'explicit overview restores all active frontiers')
}
