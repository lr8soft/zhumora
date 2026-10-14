import assert from 'node:assert/strict'

async function prepare(owner) {
  await owner.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const history = [
      { id: 'inner-u', sessionId: 'parent', role: 'user', content: '检查几个文件', timestamp: 1, status: 'done' },
      { id: 'inner-speech', sessionId: 'parent', role: 'assistant', content: '准备执行多个工具。', timestamp: 2, status: 'streaming' }
    ]
    flowUiFixture.histories.parent = history
    useAppStore.setState(state => ({ activeSessionId: 'parent', view: 'chat', runningIds: new Set(['parent']),
      retryStatus: {}, compactionMarkers: {}, messages: { ...state.messages, parent: history } }))
  })
}

async function toolResult(owner, id, callId, toolName, result) {
  await owner.evaluate(data => flowUiFixture.emit('agent.onToolResult', data), {
    sessionId: 'parent', messageId: id, toolCallId: callId, toolName, result, isError: false, durationMs: 1
  })
}

async function selectedRow(viewer, toolName) {
  await viewer.waitForFunction(name => document.querySelector('.flow-step-list button[aria-pressed="true"]')?.textContent.includes(name), toolName)
  await viewer.waitForFunction(() => {
    const list = document.querySelector('.flow-step-list'), selected = list?.querySelector('[aria-pressed="true"]')
    if (!selected) return false
    const row = selected.getBoundingClientRect(), area = list.getBoundingClientRect()
    return row.top >= area.top - 1 && row.bottom <= area.bottom + 1
  })
}

export async function assertInnerDetailFollow(owner, { detach } = {}) {
  const follow = owner.getByRole('button', { name: '自动跟随', exact: true })
  if (await follow.getAttribute('aria-pressed') !== 'true') await follow.click()
  await prepare(owner)
  await owner.getByRole('button', { name: '最新输出', exact: true }).click()
  let viewer = detach ? await detach() : owner
  await viewer.locator('.flow-detail-body').getByText('准备执行多个工具。', { exact: true }).waitFor()
  const nodeId = () => owner.locator('.flow-speech.is-selected').evaluate(element => element.closest('.react-flow__node')?.dataset.id)
  const stableNode = await nodeId()
  assert.ok(stableNode)
  await owner.evaluate(() => {
    const calls = Array.from({ length: 9 }, (_, index) => ({ id: index === 0 ? 'repeat' : `inner-call-${index}`,
      type: 'function', function: { name: index === 1 ? 'grep' : 'read', arguments: JSON.stringify(index === 1 ? { pattern: 'latest-call' } : { file_path: `file-${index}` }) } }))
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'inner-speech', phase: 'end',
      content: '准备执行多个工具。', toolCalls: calls })
  })
  await selectedRow(viewer, 'read')
  await viewer.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '参数')
  assert.match(await viewer.locator('.flow-detail-body').innerText(), /file-0/)
  await toolResult(owner, 'inner-result-0', 'repeat', 'read', 'first call result')
  await selectedRow(viewer, 'grep')
  assert.match(await viewer.locator('.flow-detail-body').innerText(), /latest-call/)
  for (let index = 1; index < 9; index++) await toolResult(owner, `inner-result-${index}`, `inner-call-${index}`,
    index === 1 ? 'grep' : 'read', index === 8 ? 'latest batch result' : `result-${index}`)
  await viewer.locator('.flow-detail-body').getByText('latest batch result', { exact: true }).waitFor()
  await selectedRow(viewer, 'read')
  assert.equal(await viewer.getByRole('tab', { name: '结果', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await nodeId(), stableNode, 'internal calls do not replace the speech node')
  await follow.click()
  assert.match(await viewer.locator('.flow-detail-body').innerText(), /latest batch result/, 'pausing keeps the last followed step and tab')
  await follow.click()
  await owner.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'inner-thinking', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onReasoning', { sessionId: 'parent', messageId: 'inner-thinking', token: '继续检查第三项' })
  })
  await viewer.locator('.flow-detail-body').getByText('继续检查第三项', { exact: true }).waitFor()
  await owner.evaluate(() => flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'inner-thinking', phase: 'end', content: '',
    reasoning: '继续检查第三项', toolCalls: [{ id: 'repeat', type: 'function', function: { name: 'bash', arguments: '{"command":"echo step3"}' } }] }))
  await selectedRow(viewer, 'bash')
  assert.match(await viewer.locator('.flow-detail-body').innerText(), /step3/)
  assert.doesNotMatch(await viewer.locator('.flow-detail-body').innerText(), /first call result/, 'reused tool IDs retain their assistant-message association')
  await owner.locator('.flow-speech').filter({ hasText: '准备执行多个工具。' }).locator('header').click()
  await viewer.locator('.flow-detail-body').getByText('准备执行多个工具。', { exact: true }).waitFor()
  assert.equal(await follow.getAttribute('aria-pressed'), 'false', 'manual main-card selection still shows the speech')
  await follow.click(); await selectedRow(viewer, 'bash')
  await viewer.locator('.flow-step-list button').filter({ hasText: 'read' }).first().click()
  await viewer.getByRole('tab', { name: '参数', exact: true }).click()
  await toolResult(owner, 'inner-bash-result', 'repeat', 'bash', 'step3 result')
  await owner.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'inner-next', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onReasoning', { sessionId: 'parent', messageId: 'inner-next', token: '新的思考输出' })
  })
  assert.match(await viewer.locator('.flow-detail-body').innerText(), /file-0/, 'new work cannot override manual reading')
  assert.equal(await follow.getAttribute('aria-pressed'), 'false')
  await follow.click()
  await viewer.locator('.flow-detail-body').getByText('新的思考输出', { exact: true }).waitFor()
  if (!detach) {
    await owner.getByRole('button', { name: '关闭详情', exact: true }).click()
    await owner.evaluate(() => flowUiFixture.emit('agent.onReasoning', { sessionId: 'parent', messageId: 'inner-next', token: '，继续' }))
    assert.equal(await owner.locator('.flow-inspector').count(), 0, 'closed details stay closed')
  } else await viewer.close()
}
