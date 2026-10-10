import assert from 'node:assert/strict'
import type { Session, ToolCall, UIMessage } from '../src/shared/types.ts'
import { COMPACT_SUMMARY_PREFIX } from '../src/shared/types.ts'
import { buildConversationGraph, type GraphInput } from '../src/renderer/src/flow/buildGraph.ts'
import { decodeTaskReferences, messageNodeId, toolNodeId } from '../src/renderer/src/flow/history.ts'

const message = (id: string, overrides: Partial<UIMessage> = {}): UIMessage => ({
  id, sessionId: 'parent', role: 'user', content: id, timestamp: 1, status: 'done', ...overrides
})
const call = (id: string, name = 'read'): ToolCall => ({ id, type: 'function', function: { name, arguments: '{}' } })
const assistant = (id: string, calls: ToolCall[] = []): UIMessage => message(id, { role: 'assistant', toolCalls: calls })
const result = (id: string, callId: string, content = 'ok'): UIMessage => message(id, { role: 'tool', toolCallId: callId, content })
const child: Session = { id: 'child', title: 'Research', createdAt: 1, updatedAt: 1, messageCount: 3,
  origin: 'renderer', avatarEnabled: false, ttsEnabled: false, subagent: { parentSessionId: 'parent', providerId: 'p', model: 'm' } }
const task = { task_id: 'task-1', session_id: 'child', parentSessionId: 'parent', status: 'running' }
const input = (messages: UIMessage[], overrides: Partial<GraphInput> = {}): GraphInput => ({
  sessionId: 'parent', sessions: [], messages: { parent: messages }, runningIds: new Set(), ...overrides
})

{
  const history = [message('u'), assistant('a', [call('c')]), result('t', 'c'), assistant('answer')]
  const before = JSON.stringify(history)
  const graph = buildConversationGraph(input(history))
  assert.equal(graph.nodes.length, 4, 'tool result belongs to its call, not another disconnected step')
  assert.equal(graph.nodes.find(node => node.id === toolNodeId('parent', 'c', 'a'))?.data.result?.id, 't')
  assert.equal(JSON.stringify(history), before, 'the graph never rewrites authoritative history')
  assert.deepEqual(graph.edges.map(edge => edge.kind), ['sequence', 'sequence', 'sequence'])
  assert.ok(graph.edges.every(edge => graph.nodes.find(node => node.id === edge.source)!.position.x
    < graph.nodes.find(node => node.id === edge.target)!.position.x), 'execution order is left to right')
}
{
  const history = [message('u'), assistant('a', [call('c1'), call('c2')])]
  const graph = buildConversationGraph(input(history, { runningIds: new Set(['parent']) }))
  assert.equal(graph.nodes.find(node => node.data.call?.id === 'c1')?.data.status, 'running')
  assert.equal(graph.nodes.find(node => node.data.call?.id === 'c2')?.data.status, 'queued', 'ordinary tools are serial')
  const stopped = buildConversationGraph(input(history))
  assert.ok(stopped.nodes.filter(node => node.data.call).every(node => node.data.status === 'unresolved'), 'idle history cannot pretend tools are running')
}
{
  const base = [message('u'), assistant('a', [call('spawn', 'spawn_subagent')]), result('s', 'spawn', JSON.stringify(task)),
    assistant('b', [call('wait', 'wait_subagents')])]
  const children = [message('cu', { sessionId: 'child' }), message('ca', { sessionId: 'child', role: 'assistant' })]
  const options = { sessions: [child], messages: { parent: base, child: children }, runningIds: new Set(['parent', 'child']) }
  const pending = buildConversationGraph(input(base, options))
  assert.equal(pending.edges.filter(edge => edge.kind === 'delegate').length, 1)
  assert.equal(pending.edges.filter(edge => edge.kind === 'return').length, 0, 'completion does not itself return results')
  const snapshot = [...base, result('w', 'wait', JSON.stringify([task]))]
  assert.equal(buildConversationGraph(input(snapshot, { ...options, messages: { parent: snapshot, child: children } }))
    .edges.filter(edge => edge.kind === 'return').length, 0, 'running snapshots never join')
  const completed = [...base, result('w', 'wait', JSON.stringify([{ ...task, status: 'completed', reply: 'done' }])), assistant('final')]
  const joined = buildConversationGraph(input(completed, { ...options, messages: { parent: completed, child: children } }))
  const edge = joined.edges.find(edge => edge.kind === 'return')!
  assert.equal(edge.source, messageNodeId('child', 'ca'))
  assert.equal(edge.target, toolNodeId('parent', 'wait', 'b'))
  assert.ok(joined.nodes.find(node => node.id === edge.source)!.position.x < joined.nodes.find(node => node.id === edge.target)!.position.x)
}
{
  const history = [assistant('a', [call('spawn', 'spawn_subagent')]), result('s', 'spawn', JSON.stringify(task))]
  const hostile = { ...child, subagent: { ...child.subagent!, parentSessionId: 'unrelated' } }
  assert.equal(buildConversationGraph(input(history, { sessions: [hostile] })).childCount, 0)
  const other = result('s', 'spawn', JSON.stringify({ ...task, parentSessionId: 'unrelated' }))
  assert.equal(buildConversationGraph(input([history[0], other], { sessions: [child] })).childCount, 0)
  const arbitrary = [assistant('a', [call('ordinary', 'read')]), result('s', 'ordinary', JSON.stringify(task))]
  assert.equal(buildConversationGraph(input(arbitrary, { sessions: [child] })).childCount, 0, 'arbitrary tools cannot inject graph branches')
}
{
  const second = { ...task, task_id: 'task-2' }
  const parent = [message('u'), assistant('a', [call('spawn', 'spawn_subagent')]), result('s', 'spawn', JSON.stringify(task)),
    assistant('b', [call('continue', 'continue_subagent')]), result('c', 'continue', JSON.stringify(second))]
  const children = [message('cu1', { sessionId: 'child' }), message('ca1', { sessionId: 'child', role: 'assistant' }),
    message('cu2', { sessionId: 'child' }), message('ca2', { sessionId: 'child', role: 'assistant' })]
  const graph = buildConversationGraph(input(parent, { sessions: [child], messages: { parent, child: children } }))
  assert.equal(graph.nodes.find(node => node.id === messageNodeId('child', 'ca1'))?.data.taskId, 'task-1')
  assert.equal(graph.nodes.find(node => node.id === messageNodeId('child', 'ca2'))?.data.taskId, 'task-2')
  assert.equal(graph.nodes.filter(node => node.id === messageNodeId('child', 'cu1')).length, 1)
}
{
  const history = [message('u1'), assistant('a1'), message('u2'), assistant('a2', [call('c')]), result('t', 'c')]
  const graph = buildConversationGraph(input(history, { collapsedTurns: new Set(['u1', 'u2']) }))
  assert.equal(graph.nodes[0].data.kind, 'turn')
  assert.equal(graph.nodes[0].data.messageCount, 2)
  assert.ok(graph.nodes.some(node => node.id === messageNodeId('parent', 'u2')), 'the latest turn stays expanded')
  const compaction = buildConversationGraph(input(history, { compaction: { upToMessageId: 't', summary: 'summary' } }))
  assert.equal(compaction.nodes.at(-1)?.data.kind, 'compaction', 'a merged result remains a valid compaction boundary')
  const summary = buildConversationGraph(input([message('s', { content: `${COMPACT_SUMMARY_PREFIX} compacted` })]))
  assert.equal(summary.nodes[0].data.kind, 'summary')
}
{
  const graph = buildConversationGraph(input([result('orphan', 'missing')]))
  assert.equal(graph.nodes[0].data.message?.id, 'orphan', 'orphan results remain inspectable')
  assert.deepEqual(decodeTaskReferences('bad JSON'), [])
  assert.deepEqual(decodeTaskReferences('{"task_id":"x"}'), [])
  assert.deepEqual(decodeTaskReferences('x'.repeat(150001)), [])
  const a = buildConversationGraph(input([assistant('a', [call('same')])]))
  const b = buildConversationGraph(input([assistant('a', [call('same')])], { sessionId: 'other', messages: { other: [assistant('a', [call('same')])] } }))
  assert.notEqual(a.nodes.at(-1)?.id, b.nodes.at(-1)?.id, 'IDs cannot collide between sessions')
}
{
  const history = [message('u'), assistant('a1', [call('repeat')]), result('t1', 'repeat', 'first result'),
    assistant('a2', [call('repeat')]), result('t2', 'repeat', 'second result'), message('u2'), result('orphan-repeat', 'repeat', 'orphan')]
  const graph = buildConversationGraph(input(history))
  const tools = graph.nodes.filter(node => node.data.call)
  assert.equal(new Set(tools.map(node => node.id)).size, 2, 'reused provider call IDs still describe two independent executions')
  assert.deepEqual(tools.map(node => node.data.result?.id), ['t1', 't2'])
  assert.ok(graph.nodes.some(node => node.data.message?.id === 'orphan-repeat'), 'a matching ID outside a legal call group remains orphaned')
  const secondChild = { ...child, id: 'child-2' }
  const parent = [assistant('a1', [call('repeat', 'spawn_subagent')]), result('s1', 'repeat', JSON.stringify(task)),
    assistant('a2', [call('repeat', 'spawn_subagent')]), result('s2', 'repeat', JSON.stringify({ ...task, task_id: 'task-2', session_id: 'child-2' }))]
  assert.equal(buildConversationGraph(input(parent, { sessions: [child, secondChild] })).childCount, 2,
    'reusing a provider call ID cannot attach both dispatches to the later child')
}
console.log('Conversation graph sequencing, delegation, joins, continuation, isolation, folding and repeated provider ID tests passed')
