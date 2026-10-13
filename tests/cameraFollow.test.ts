import assert from 'node:assert/strict'
import { activeCameraNodes, planCameraFollow } from '../src/renderer/src/flow/cameraFollow.ts'
import type { ConversationGraph, FlowNode } from '../src/renderer/src/flow/types.ts'

const node = (id: string, sessionId: string, x: number, y: number, status: FlowNode['data']['status'] = 'running'): FlowNode => ({
  id, position: { x, y }, width: 300, height: 180, data: { kind: 'speech', sessionId, title: '', preview: '', status }
})
const graph = (nodes: FlowNode[], latestNodeId = 'main'): ConversationGraph => ({ nodes, latestNodeId, edges: [], childCount: 0, turnIds: [] })
const main = node('main', 'root', 100, 100)
const view = { x: 0, y: 0, zoom: 1 }
assert.equal(planCameraFollow(graph([main]), view, 1000, 700, 1).viewport, null, 'already visible card is not recentered')
const advanced = { ...main, position: { x: 850, y: 100 } }
const moved = planCameraFollow(graph([advanced]), view, 1000, 700, 1).viewport!
assert.equal(moved.zoom, 1); assert.equal(moved.y, 0)
assert.equal(moved.x, 1000 - 48 - (850 + 300), 'only translate enough to expose the new right edge')
assert.equal(planCameraFollow(graph([advanced]), moved, 1000, 700, 1).viewport, null, 'containment settles without oscillation')

const childA = node('a', 'child-a', 120, 350), childB = node('b', 'child-b', 140, 620)
const concurrent = graph([main, childA, childB])
const overview = planCameraFollow(concurrent, view, 1000, 700, null).viewport!
assert.ok(overview.zoom < 1)
for (const current of concurrent.nodes) {
  assert.ok(current.position.x * overview.zoom + overview.x >= 47)
  assert.ok((current.position.y + current.height) * overview.zoom + overview.y <= 653)
}
assert.equal(planCameraFollow(concurrent, overview, 1000, 700, null).viewport, null, 'parallel overview remains stable')
const finishedB = { ...childB, data: { ...childB.data, status: 'done' as const } }
assert.deepEqual(activeCameraNodes(graph([main, childA, finishedB])).map(item => item.id), ['main', 'a'])
const afterFinish = planCameraFollow(graph([main, childA, finishedB]), overview, 1000, 700, null)
assert.equal(afterFinish.viewport, null, 'one finished sibling does not zoom or recenter remaining work')

const custom = planCameraFollow(concurrent, view, 1000, 700, 1)
assert.equal(custom.hiddenCount, 1); assert.equal(custom.viewport, null)
const changedB = { ...childB, position: { x: 2000, y: 1200 } }
const stable = planCameraFollow(graph([main, childA, changedB]), view, 1000, 700, 1)
assert.equal(stable.viewport, null, 'offscreen sibling updates do not steal the camera')
assert.equal(stable.hiddenCount, 1)
assert.equal(planCameraFollow(concurrent, view, 1000, 700, 1, true).viewport!.zoom, 1, 'explicit resume also preserves custom zoom')

const lane = { ...node('lane', 'child-b', 5000, 5000), data: { ...childB.data, kind: 'lane' as const } }
const old = node('old', 'child-a', 0, 350, 'done')
const queued = node('queued', 'child-a', 1000, 350, 'queued')
assert.deepEqual(activeCameraNodes(graph([lane, old, queued, main, childA])).map(item => item.id), ['main', 'a'], 'current execution wins over queued steps and decorative history')
const preparing = { ...node('preparing-input', 'child-c', 100, 600, 'done'), data: { ...node('x', 'child-c', 100, 600, 'done').data, taskId: 'preparing' } }
const preparingLane = { ...node('preparing-lane', 'child-c', 5000, 5000), data: { ...lane.data, sessionId: 'child-c', taskId: 'preparing' } }
assert.deepEqual(activeCameraNodes(graph([main, preparing, preparingLane])).map(item => item.id), ['main', 'preparing-input'], 'preparing children stay visible before their first model token')
const oversized = { ...main, width: 1000, height: 1000 }
const centered = planCameraFollow(graph([oversized]), view, 400, 300, 1.8, true).viewport!
assert.equal(planCameraFollow(graph([oversized]), centered, 400, 300, 1.8).viewport, null, 'oversized custom-zoom cards have a stable reading region')
assert.equal(planCameraFollow(graph([]), view, 1000, 700, null).viewport, null)
console.log('Camera follow: minimal panning, concurrent frontiers, stable zoom, hidden siblings and oversized cards passed')
