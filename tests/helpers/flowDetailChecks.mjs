import assert from 'node:assert/strict'

export async function assertStreamingDetail(owner, viewer, messageId, finish = false) {
  const body = viewer.locator('.flow-detail-body')
  const emit = (event, token) => owner.evaluate(({ event, token, messageId }) => {
    flowUiFixture.emit(event, { sessionId: 'parent', messageId, token })
  }, { event, token, messageId })
  const longText = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行，验证实时输出的滚动位置。\n\n`).join('')
  const bottom = () => viewer.waitForFunction(() => {
    const body = document.querySelector('.flow-detail-body')
    return body && body.scrollHeight > body.clientHeight && body.scrollHeight - body.clientHeight - body.scrollTop <= 2
  })
  if (await body.evaluate(element => element.scrollHeight <= element.clientHeight)) {
    const area = await body.boundingBox()
    await viewer.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
    await viewer.mouse.wheel(0, -100)
  }
  await emit('agent.onToken', longText)
  await body.getByText('第 60 行，验证实时输出的滚动位置。', { exact: true }).waitFor()
  await bottom()
  await emit('agent.onToken', '\n\n正文最新位置。')
  await body.getByText('正文最新位置。', { exact: true }).waitFor()
  await bottom()

  const rect = await body.boundingBox()
  await viewer.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await viewer.mouse.wheel(0, -600)
  await viewer.waitForFunction(() => {
    const body = document.querySelector('.flow-detail-body')
    return body.scrollHeight - body.clientHeight - body.scrollTop > 100
  })
  const readingTop = await body.evaluate(element => element.scrollTop)
  await emit('agent.onToken', '\n\n向上阅读时新增的内容。')
  await body.getByText('向上阅读时新增的内容。', { exact: true }).waitFor()
  assert.ok(Math.abs(await body.evaluate(element => element.scrollTop) - readingTop) < 2, 'new tokens preserve the manually chosen reading position')
  await viewer.mouse.wheel(0, 20000)
  await bottom()
  await emit('agent.onToken', '\n\n回到底部后继续跟随。')
  await body.getByText('回到底部后继续跟随。', { exact: true }).waitFor()
  await bottom()

  await emit('agent.onReasoning', longText)
  await viewer.getByRole('tab', { name: '思考', exact: true }).click()
  await bottom()
  await emit('agent.onReasoning', '\n\n思考最新位置。')
  await body.getByText('思考最新位置。', { exact: true }).waitFor()
  await bottom()
  await viewer.getByRole('tab', { name: '内容', exact: true }).click()
  await bottom()
  if (finish) {
    await owner.evaluate(async messageId => {
      const { useAppStore } = await import('/src/store/index.ts')
      const message = useAppStore.getState().messages.parent.find(message => message.id === messageId)
      flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId, phase: 'end',
        content: `${message.content}\n\n完成时的最后一段。`, reasoning: message.reasoning, toolCalls: [] })
      flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: false })
    }, messageId)
    await body.getByText('完成时的最后一段。', { exact: true }).waitFor()
    await bottom()
  }
}

export async function assertFoldedAppearance(page) {
  const folded = page.locator('.flow-turn')
  assert.match(await folded.innerText(), /已折叠/)
  assert.match(await folded.innerText(), /点击展开/)
  const colors = await page.locator('.flow-turn, .flow-speech').evaluateAll(cards => cards.map(card => getComputedStyle(card).backgroundColor))
  assert.notEqual(colors[0], colors[1], 'folded rounds have a distinct surface in either theme')
}
