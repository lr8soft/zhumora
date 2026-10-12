import assert from 'node:assert/strict'

export async function assertResponsiveSpeech(page, output) {
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const history = structuredClone(flowUiFixture.histories.parent)
    const owner = history.find(message => message.id === 'a')
    owner.content = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行实时正文。`).join('\n')
    const extra = Array.from({ length: 8 }, (_, index) => [
      { ...owner, id: `rs-a${index}`, content: '', reasoning: '', toolCalls: [{ id: `rs-c${index}`, type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { id: `rs-t${index}`, sessionId: 'parent', role: 'tool', content: 'ok', toolName: 'read', toolCallId: `rs-c${index}`, timestamp: 1, status: 'done' }
    ]).flat()
    history.splice(history.findIndex(message => message.id === 'w'), 0, ...extra)
    history.find(message => message.id === 'w').content = ''
    history.find(message => message.id === 'final').content = '完成。'
    useAppStore.setState(state => ({ activeSessionId: 'parent', runningIds: new Set(),
      messages: { ...state.messages, parent: history } }))
  })
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  const card = page.locator('.flow-speech').filter({ hasText: '第 60 行实时正文。' })
  await card.waitFor()
  const text = card.locator('.flow-speech-text')
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll('.flow-speech-text')].find(text => text.textContent.includes('第 60 行实时正文。'))
    return text && text.scrollHeight > text.clientHeight && text.scrollHeight - text.clientHeight - text.scrollTop <= 2
  })
  const sizes = await card.evaluate(card => ({ height: card.offsetHeight, width: card.offsetWidth,
    body: card.querySelector('.flow-speech-text').offsetHeight, tools: card.querySelector('.flow-inner-steps').offsetHeight }))
  assert.ok(sizes.body > 52 && sizes.body <= 113, 'body grows to six lines and then scrolls to its tail')
  assert.ok(sizes.tools <= 180, 'tool area has a bounded height')
  assert.ok(sizes.width >= 280 && sizes.width <= 420)
  await page.evaluate(() => flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'a', token: '\n最新追加输出。' }))
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll('.flow-speech-text')].find(text => text.textContent.includes('最新追加输出。'))
    return text && text.scrollHeight - text.clientHeight - text.scrollTop <= 2
  })
  assert.equal(await card.evaluate(card => card.offsetHeight), sizes.height, 'at the height limit, new tokens follow the tail without inflating the card')
  const short = page.locator('.flow-speech').filter({ has: page.locator('.flow-speech-text', { hasText: /^完成。$/ }) })
  assert.ok(await short.evaluate(card => card.offsetHeight) < 140, 'a short message has no blank tool area')
  assert.equal(await short.locator('.flow-inner-region').count(), 0)
  const before = await page.locator('.react-flow__edge-path').evaluateAll(edges => edges.map(edge => edge.getAttribute('d')))
  await card.locator('.flow-inner-steps').evaluate(area => { area.scrollTop = area.scrollHeight })
  await page.waitForFunction(() => {
    const area = [...document.querySelectorAll('.flow-inner-steps')].find(area => area.scrollHeight > area.clientHeight)
    return area && area.scrollHeight - area.clientHeight - area.scrollTop <= 2
  })
  await page.waitForFunction(before => JSON.stringify([...document.querySelectorAll('.react-flow__edge-path')].map(edge => edge.getAttribute('d'))) !== JSON.stringify(before), before)
  assert.equal(await card.locator('.flow-inner-port').count(), 3, 'scrolling retains both dispatch ports and the exact wait return')
  assert.ok(await card.locator('.flow-inner-port').evaluateAll(handles => handles.every(handle => {
    const region = handle.parentElement.getBoundingClientRect(), rect = handle.getBoundingClientRect()
    return rect.y >= region.y && rect.bottom <= region.bottom && rect.x + rect.width / 2 > handle.closest('.flow-card').getBoundingClientRect().right
  })), 'named ports remain visible outside the card and within the tool viewport')
  await page.screenshot({ path: `${output}/responsive-speech-dark.png` })
  await page.setViewportSize({ width: 900, height: 760 })
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => [...document.querySelectorAll('.flow-speech')].some(card => card.offsetWidth < 312))
  const narrowWidth = await card.evaluate(card => card.offsetWidth)
  assert.ok(narrowWidth >= 280 && narrowWidth < sizes.width, 'cards shrink with the available canvas width')
  const narrow = await card.evaluate(card => getComputedStyle(card.querySelector('.flow-inner-steps')).gridTemplateColumns.split(' ').length)
  assert.equal(narrow, 1, 'narrow cards use one tool column')
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.getState().setTheme('light'); useAppStore.getState().setFontSize(18)
  })
  await page.waitForFunction(() => document.documentElement.style.fontSize === '18px')
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll('.flow-speech-text')].find(text => text.textContent.includes('最新追加输出。'))
    return text && text.scrollHeight - text.clientHeight - text.scrollTop <= 2
  })
  assert.ok(await card.evaluate(card => card.offsetHeight <= 38 * 18), 'large fonts still respect the card height limit')
  await page.screenshot({ path: `${output}/responsive-speech-light-narrow.png` })
}
