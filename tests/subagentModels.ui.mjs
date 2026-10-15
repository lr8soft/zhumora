import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'

const output = resolve('.temp/subagent-models-ui')
await mkdir(output, { recursive: true })
const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 18766, strictPort: true } })
let browser, page
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.FLOW_BROWSER_CHANNEL ? { channel: process.env.FLOW_BROWSER_CHANNEL } : {}) })
  page = await browser.newPage({ viewport: { width: 1450, height: 1050 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(installFlowUiFixture)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  await page.locator('.conversation-flow').waitFor()
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const state = useAppStore.getState()
    const provider = (id, name, enabled = true, allowSubagents = true) => ({ id, name, enabled, allowSubagents,
      baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: `${id}-default`, maxConcurrency: id === 'local' ? 2 : null })
    useAppStore.setState({ settings: { ...state.settings, subagentModels: [
      { providerId: 'local', model: 'custom-a' }, { providerId: 'removed', model: 'old-model' }, { providerId: 'cheap', model: 'cheap-default' }
    ], providers: [provider('local', 'Provider A'), provider('cheap', 'Provider B'), provider('expensive', 'Main only', true, false), provider('disabled', 'Disabled', false)] } })
    window.api.provider.listModels = async provider => {
      flowUiFixture.calls.push(['catalog', provider.id]); return { models: [{ id: `${provider.id}-remote` }] }
    }
    window.api.settings.save = async settings => { flowUiFixture.savedSettings = structuredClone(settings); return structuredClone(settings) }
    state.setTheme('light')
  })
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('tab', { name: '通用', exact: true }).click()
  const panel = page.locator('.subagent-models'), rows = panel.locator('li')
  await panel.scrollIntoViewIfNeeded()
  assert.equal(await rows.count(), 3)
  assert.match(await rows.nth(1).innerText(), /提供商不可用/)
  assert.match(await rows.first().innerText(), /上限：2/)
  await rows.nth(2).getByRole('button', { name: '上移', exact: true }).click()
  await rows.nth(1).getByRole('button', { name: '上移', exact: true }).click()
  assert.match(await rows.first().innerText(), /cheap-default/)
  await rows.first().getByRole('button', { name: '拖动排序', exact: true }).dragTo(rows.nth(2))
  assert.match(await rows.nth(2).innerText(), /cheap-default/)
  await rows.filter({ hasText: 'old-model' }).getByRole('button', { name: '移除模型', exact: true }).click()
  const add = panel.getByRole('combobox', { name: '添加子模型…', exact: true })
  await add.focus()
  const remoteValue = JSON.stringify(['local', 'local-remote'])
  await add.locator(`option[value='${remoteValue}']`).waitFor({ state: 'attached' })
  await add.selectOption(remoteValue)
  assert.match(await rows.last().innerText(), /local-remote/)
  await panel.getByRole('button', { name: '添加各供应商默认模型', exact: true }).click()
  await panel.getByRole('button', { name: '添加各供应商默认模型', exact: true }).click()
  assert.equal(await rows.count(), 4, 'default model addition is deduplicated')
  const dispatch = panel.getByRole('combobox', { name: '分配策略', exact: true })
  await dispatch.selectOption('spread')
  assert.deepEqual(await page.evaluate(() => flowUiFixture.calls.filter(call => call[0] === 'catalog').map(call => call[1]).sort()), ['cheap', 'local'])
  await panel.screenshot({ path: resolve(output, 'priority-light.png') })
  await page.evaluate(async () => (await import('/src/store/index.ts')).useAppStore.getState().setTheme('dark'))
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await panel.screenshot({ path: resolve(output, 'priority-dark.png') })
  await page.setViewportSize({ width: 900, height: 900 })
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  await panel.screenshot({ path: resolve(output, 'priority-narrow.png') })
  const draft = await page.evaluate(async () => (await import('/src/store/index.ts')).useAppStore.getState().settingsDraft.subagentModels)
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.locator('.conversation-flow').waitFor()
  const saved = await page.evaluate(() => flowUiFixture.savedSettings)
  assert.deepEqual(saved.subagentModels, draft)
  assert.equal(saved.subagentDispatch, 'spread')
  assert.equal(saved.activeProviderId, 'local'); assert.equal('subagentModel' in saved, false)
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('tab', { name: '通用', exact: true }).click()
  assert.equal(await dispatch.inputValue(), 'spread')
  assert.equal(await rows.count(), 4)
  await page.getByRole('checkbox', { name: '启用子 Agent', exact: true }).uncheck()
  assert.equal(await dispatch.isDisabled(), true); assert.equal(await add.isDisabled(), true)
  assert.equal(await rows.first().getByRole('button', { name: '移除模型', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log(`Subagent model UI passed: add, drag/keyboard reorder, unavailable retention, eligibility, shared limits, save/reopen, disabled state and light/dark/narrow. ${output}`)
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: resolve(output, 'failure.png') }) }
  throw error
} finally { await browser?.close(); await server.close() }
