import assert from 'node:assert/strict'
import { constrainPanel, dockTargetAt, initialPanelLayout, placePanel } from '../src/renderer/src/docking/layout.ts'
import { isPanelId, isPanelTicketKey, isPanelWindowAction } from '../src/shared/panels.ts'

const initial = initialPanelLayout()
const floated = placePanel(initial, 'details', 'floating')
assert.equal(floated.details.home, 'right')
assert.equal(initial.details.mode, 'right', 'layout transitions do not mutate the prior layout')
const left = placePanel(floated, 'details', 'left')
const separate = placePanel(left, 'details', 'window')
assert.equal(separate.details.home, 'left', 'closing an independent window returns to its last dock')
assert.equal(separate.conversation.mode, 'center', 'moving one panel preserves the other')
const size = { width: 1000, height: 700 }
assert.deepEqual(constrainPanel({ x: -10, y: 800, width: 500, height: 400 }, size), { x: 0, y: 300, width: 500, height: 400 })
assert.deepEqual(constrainPanel({ x: 50, y: 50, width: 500, height: 400 }, { width: 120, height: 80 }),
  { x: 0, y: 0, width: 120, height: 80 }, 'small workspaces never leave the title/resize controls outside their bounds')
assert.equal(dockTargetAt(-1, 100, size), null)
assert.equal(dockTargetAt(20, 100, size), 'left')
assert.equal(dockTargetAt(990, 100, size), 'right')
assert.equal(dockTargetAt(100, 20, size), 'top')
assert.equal(dockTargetAt(100, 690, size), 'bottom')
assert.equal(dockTargetAt(500, 350, size), 'center')
assert.equal(dockTargetAt(434, 350, size), 'left')
assert.equal(dockTargetAt(300, 300, size), null, 'dropping elsewhere leaves a floating panel')
assert.equal(isPanelId('details'), true)
assert.equal(isPanelId('settings'), false)
assert.equal(isPanelWindowAction('execute'), false)
assert.equal(isPanelWindowAction('close'), true)
assert.equal(isPanelTicketKey('zhumora-panel-12345678-1234-1234-1234-123456789abc'), true)
assert.equal(isPanelTicketKey('file:///secret'), false)
console.log('Panel layout, dock targets, return placement, bounds and IPC contract validation passed')
