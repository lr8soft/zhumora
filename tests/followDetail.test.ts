import assert from 'node:assert/strict'
import { followedDetailStep, defaultDetailTab } from '../src/renderer/src/flow/followDetail.ts'
import { primaryStep } from '../src/renderer/src/flow/nestedSteps.ts'
import type { FlowNode, FlowStep } from '../src/renderer/src/flow/types.ts'

const speech: FlowStep = { id: 'speech', data: { kind: 'llm', sessionId: 's', title: '', preview: '', status: 'done',
  message: { id: 'speech', sessionId: 's', role: 'assistant', content: 'I will inspect the files.', timestamp: 1 } } }
const call = (id: string, status: FlowStep['data']['status']): FlowStep => ({ id, data: {
  kind: 'tool', sessionId: 's', title: 'read', preview: '', status,
  call: { id: 'reused-call-id', type: 'function', function: { name: 'read', arguments: '{}' } }
} })
const node = (steps: FlowStep[]): FlowNode => ({ id: 'speech', width: 300, height: 200, position: { x: 0, y: 0 },
  data: { ...speech.data, kind: 'speech', steps } })
const first = call('tool:assistant-1:reused-call-id', 'running'), queued = call('tool:assistant-1:next', 'queued')
assert.equal(followedDetailStep(node([speech, first, queued])).id, first.id, 'running tool wins over queued calls and initial speech')
assert.equal(defaultDetailTab(first.data), 'args')
const finished: FlowStep = { ...first, data: { ...first.data, status: 'done', result: {
  id: 'result', sessionId: 's', role: 'tool', content: 'read completed', timestamp: 2
} } }
assert.equal(followedDetailStep(node([speech, finished, queued])).id, finished.id)
assert.equal(defaultDetailTab(finished.data), 'result')
const second = { ...queued, data: { ...queued.data, status: 'running' as const } }
assert.equal(followedDetailStep(node([speech, finished, second])).id, second.id)
const reasoning: FlowStep = { ...speech, id: 'thinking', data: { ...speech.data, status: 'running',
  message: { ...speech.data.message!, id: 'thinking', content: '', reasoning: 'Checking the next action.' } } }
assert.equal(followedDetailStep(node([speech, finished, reasoning])).id, reasoning.id)
assert.equal(defaultDetailTab(reasoning.data), 'reasoning')
assert.equal(defaultDetailTab({ ...reasoning.data, message: { ...reasoning.data.message!, content: 'New reply' } }), 'content')
const reused = call('tool:assistant-2:reused-call-id', 'running')
assert.equal(followedDetailStep(node([speech, finished, reasoning, reused])).id, reused.id, 'authoritative step IDs distinguish reused provider call IDs')
assert.equal(primaryStep(node([speech, finished, reused])).id, speech.id, 'manual card selection continues to show the speech')
assert.equal(followedDetailStep(node([])).id, 'speech')
console.log('Detail follow: active tools, queued exclusion, results, reasoning and stable authoritative step IDs passed')
