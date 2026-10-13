import assert from 'node:assert/strict'

export async function assertProviderConcurrencySettings(page, output) {
  await page.evaluate(() => {
    window.api.settings.save = async settings => {
      flowUiFixture.calls.push(['settings', 'save', [structuredClone(settings)]])
      return structuredClone(settings)
    }
  })
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('tab', { name: 'LLM 提供商', exact: true }).click()
  const field = page.getByRole('spinbutton', { name: '并发上限', exact: true })
  await field.waitFor()
  assert.equal(await field.inputValue(), '', 'legacy providers display an empty unlimited field')
  await field.fill('2')
  assert.equal(await field.getAttribute('aria-invalid'), 'false')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.locator('.conversation-flow').waitFor()
  assert.equal(await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().settings.providers[0].maxConcurrency
  }), 2)
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  assert.equal(await field.inputValue(), '2', 'saved limits survive settings remount')
  await field.fill('0')
  assert.equal(await field.getAttribute('aria-invalid'), 'true')
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true)
  await field.fill('')
  assert.equal(await field.getAttribute('aria-invalid'), 'false')
  await field.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${output}/provider-concurrency.png` })
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.locator('.conversation-flow').waitFor()
  const saved = await page.evaluate(() => flowUiFixture.calls.filter(call => call[0] === 'settings' && call[1] === 'save').map(call => call[2][0].providers[0].maxConcurrency))
  assert.deepEqual(saved, [2, null], 'clearing the field persists the unlimited value')
}
