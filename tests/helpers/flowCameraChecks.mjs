import assert from 'node:assert/strict'

export async function assertFocusedNode(page, text) {
  await page.waitForFunction(words => {
    const card = [...document.querySelectorAll('.flow-speech')].find(node => node.querySelector('.flow-speech-text')?.textContent === words)
    const canvas = document.querySelector('.flow-canvas')
    if (!card || !canvas) return false
    const box = card.getBoundingClientRect(), area = canvas.getBoundingClientRect()
    return Math.abs(box.x + box.width / 2 - area.x - area.width / 2) < 8
      && Math.abs(box.y + box.height / 2 - area.y - area.height / 2) < 8
      && box.x >= area.x && box.right <= area.right && box.y >= area.y && box.bottom <= area.bottom
  }, text)
  await settleViewport(page)
  assert.equal(await page.getByRole('button', { name: '跟随运行', exact: true }).getAttribute('aria-pressed'), 'true')
}

export async function viewportStyle(page) {
  return page.locator('.react-flow__viewport').getAttribute('style')
}

export async function settleViewport(page) {
  await page.evaluate(() => new Promise(resolve => {
    let previous = '', stable = 0
    const tick = () => {
      const transform = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? ''
      stable = transform === previous ? stable + 1 : 0
      previous = transform
      if (stable >= 6) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
}
