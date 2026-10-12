import assert from 'node:assert/strict'

// Browser clicks alone bypass OS drag hit-testing. Also check the native drag rectangles never cover controls.
export async function assertWindowControlHitAreas(page, headerSelector) {
  const result = await page.evaluate(selector => {
    const controls = document.querySelector('.window-controls')
    const buttons = [...controls.querySelectorAll('button')]
    const header = document.querySelector(selector)
    const rect = header.getBoundingClientRect()
    const pseudo = getComputedStyle(header, '::before')
    const left = rect.left + (parseFloat(pseudo.left) || 0)
    const top = rect.top + (parseFloat(pseudo.top) || 0)
    const drag = { left, top, right: left + parseFloat(pseudo.width), bottom: top + parseFloat(pseudo.height) }
    const shell = document.querySelector('.app-shell')
    return {
      headerRegion: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
      pseudoRegion: pseudo.getPropertyValue('-webkit-app-region'),
      ordered: !!(shell.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
      buttons: buttons.map(button => {
        const bounds = button.getBoundingClientRect()
        return {
          region: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
          clear: Number.isFinite(drag.right) && (drag.right <= bounds.left || drag.left >= bounds.right || drag.bottom <= bounds.top || drag.top >= bounds.bottom),
          reachable: [2, bounds.height / 2, bounds.height - 2].every(y =>
            [2, bounds.width / 2, bounds.width - 2].every(x => button.contains(document.elementFromPoint(bounds.x + x, bounds.y + y))))
        }
      })
    }
  }, headerSelector)
  assert.equal(result.ordered, true, 'controls are emitted after the shell drag areas')
  assert.notEqual(result.headerRegion, 'drag', 'the full header cannot claim the control hit area')
  assert.equal(result.pseudoRegion, 'drag', 'the remaining header still moves the window')
  assert.equal(result.buttons.length, 3)
  for (const button of result.buttons) {
    assert.equal(button.region, 'no-drag')
    assert.equal(button.clear, true, 'native drag rectangles do not intersect any window button')
    assert.equal(button.reachable, true, 'button centers and edges remain unobstructed')
  }
}
