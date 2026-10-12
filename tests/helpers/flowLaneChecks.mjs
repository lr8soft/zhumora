import assert from 'node:assert/strict'

export async function assertPassiveLanes(page) {
  const cards = await page.locator('.flow-card').count()
  const edges = await page.locator('.react-flow__edge').count()
  for (const lane of await page.locator('.flow-lane').all()) {
    const box = await lane.boundingBox()
    for (const y of [box.y + 10, box.y + box.height - 5]) {
      // Real pointer input exercises the wrapper even when the inner lane ignores events.
      await page.mouse.click(box.x + box.width / 2, y)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.locator('.flow-inspector').count(), 0, 'lane backgrounds must not open node details')
      assert.equal(await page.locator('.react-flow__node.selected .flow-lane').count(), 0, 'decorative lanes must never become selected')
    }
  }
  assert.equal(await page.locator('.flow-card').count(), cards, 'lane clicks preserve all visible cards')
  assert.equal(await page.locator('.react-flow__edge').count(), edges, 'lane clicks preserve branch and return edges')
  const hitChecks = await page.locator('.flow-lane').evaluateAll(lanes => lanes.map(lane => {
    const box = lane.getBoundingClientRect()
    const cards = [...document.querySelectorAll('.flow-card')].filter(card => {
      const rect = card.getBoundingClientRect()
      return rect.left > box.left && rect.right < box.right && rect.top > box.top && rect.bottom < box.bottom
    })
    return cards.length > 0 && cards.every(card => {
      const rect = card.getBoundingClientRect()
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.flow-card') === card
    })
  }))
  assert.ok(hitChecks.every(Boolean), 'child cards remain above the lane and accept pointer input')
}
