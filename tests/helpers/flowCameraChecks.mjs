import assert from 'node:assert/strict'

export async function assertFollowedNode(page, text) {
  await page.waitForFunction(words => {
    const card = [...document.querySelectorAll('.flow-speech')].find(node => node.querySelector('.flow-speech-text')?.textContent === words)
    const canvas = document.querySelector('.flow-canvas')
    if (!card || !canvas) return false
    const box = card.getBoundingClientRect(), area = canvas.getBoundingClientRect()
    const visible = (start, size, extent) => size <= extent - 32
      ? start >= 8 && start + size <= extent - 8
      : start + size / 2 >= 8 && start + size / 2 <= extent - 8
    return visible(box.x - area.x, box.width, area.width) && visible(box.y - area.y, box.height, area.height)
  }, text)
  await settleViewport(page)
  assert.equal(await page.getByRole('button', { name: '自动跟随', exact: true }).getAttribute('aria-pressed'), 'true')
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
