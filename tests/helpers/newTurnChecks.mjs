import assert from 'node:assert/strict'
import { settleViewport } from './flowCameraChecks.mjs'

export async function assertNewTurnVisible(page, viewer = page) {
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: false })
    const history = useAppStore.getState().messages.parent.map(message => ({ ...message, status: 'done' }))
    flowUiFixture.histories.parent = structuredClone(history)
    useAppStore.setState(state => ({ messages: { ...state.messages, parent: history } }))
  })
  await viewer.getByRole('button', { name: '最新输出', exact: true }).click()
  await settleViewport(viewer)
  const follow = viewer.getByRole('button', { name: '跟随运行', exact: true })
  if (await follow.getAttribute('aria-pressed') === 'true') await follow.click()
  await viewer.waitForFunction(() => document.querySelector('.flow-toolbar-actions button[aria-label="跟随运行"]')?.getAttribute('aria-pressed') === 'false')
  assert.equal(await follow.getAttribute('aria-pressed'), 'false')
  const before = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const run = window.api.agent.run
    window.api.agent.run = async (...args) => {
      window.api.agent.run = run
      const result = await run(...args)
      await new Promise(resolve => setTimeout(resolve, 250))
      return result
    }
    return useAppStore.getState().messages.parent.map(message => message.id)
  })
  await page.locator('.chat-textarea').fill('新一轮输入，画布应该保持可见。')
  await page.locator('.chat-textarea').press('Enter')
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.some(message => message.content === '新一轮输入，画布应该保持可见。' && message.id.startsWith('pending-'))
  })
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.some(message => message.content === '新一轮输入，画布应该保持可见。' && !message.id.startsWith('pending-'))
  })
  await viewer.waitForFunction(() => [...document.querySelectorAll('.flow-user')].some(card => {
    if (!card.textContent.includes('新一轮输入，画布应该保持可见。')) return false
    const rect = card.getBoundingClientRect(), area = document.querySelector('.flow-canvas').getBoundingClientRect()
    return rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom
  }))
  assert.equal(await viewer.getByRole('button', { name: '跟随运行', exact: true }).getAttribute('aria-pressed'), 'false', 'blank recovery does not change the follow preference')
  assert.equal(await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().activeSessionId
  }), 'parent', 'the graph recovers without switching sessions')
  const after = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.map(message => message.id)
  })
  assert.deepEqual(after.slice(0, before.length), before, 'folding preserves every historical message ID')
}
