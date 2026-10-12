import assert from 'node:assert/strict'
import type { Session, ToolCall, UIMessage } from '../src/shared/types.ts'
import { COMPACT_SUMMARY_PREFIX } from '../src/shared/types.ts'
import { buildConversationGraph, type GraphInput } from '../src/renderer/src/flow/buildGraph.ts'
import { decodeTaskReferences, messageNodeId, toolNodeId } from '../src/renderer/src/flow/history.ts'
import { nestedSteps, previewRowCount, previewSteps, primaryStep } from '../src/renderer/src/flow/nestedSteps.ts'
import { estimateSpeechHeight, responsiveSpeechWidth } from '../src/renderer/src/flow/speechSizing.ts'
import { hasVisibleFlowNodes, shouldRecoverFlowViewport } from '../src/renderer/src/flow/viewportRecovery.ts'
import type { ConversationGraph } from '../src/renderer/src/flow/types.ts'

const message = (id: string, overrides: Partial<UIMessage> = {}): UIMessage => ({
  id, sessionId: 'parent', role: 'user', content: id, timestamp: 1, status: 'done', ...overrides
})

{
  const graphAt = (x: number, kind: 'user' | 'lane' = 'user'): ConversationGraph => ({ nodes: [{
    id: `n${x}`, data: { kind, sessionId: 'parent', title: '', preview: '', status: 'done' },
    position: { x, y: 80 }, width: 238, height: 144
  }], edges: [], turnIds: ['u'], childCount: 0 })
  const previous = graphAt(20000), folded = graphAt(48), viewport = { x: -19900, y: 0, zoom: 1 }
  assert.ok(shouldRecoverFlowViewport(previous, folded, viewport, 900, 600), 'folding a long previous turn recovers its now-empty viewport')
  assert.equal(shouldRecoverFlowViewport(previous, previous, viewport, 900, 600), false)
  assert.equal(shouldRecoverFlowViewport(previous, { ...previous, nodes: [...previous.nodes, ...graphAt(21000).nodes] }, viewport, 900, 600), false,
    'ordinary new nodes preserve a paused camera while existing nodes remain in view')
  assert.equal(shouldRecoverFlowViewport(previous, folded, { ...viewport, y: -5000 }, 900, 600), false,
    'intentional navigation to blank space remains under user control')
  assert.equal(hasVisibleFlowNodes(graphAt(20000, 'lane'), viewport, 900, 600), false, 'decorative lanes cannot stand in for visible cards')
  assert.equal(shouldRecoverFlowViewport(previous, { ...folded, nodes: [] }, viewport, 900, 600), false)
  assert.ok(shouldRecoverFlowViewport(previous, folded, { ...viewport, x: NaN }, 900, 600), 'a malformed camera cannot permanently hide a nonempty graph')
}
const call = (id: string, name = 'read'): ToolCall => ({ id, type: 'function', function: { name, arguments: '{}' } })
const assistant = (id: string, calls: ToolCall[] = []): UIMessage => message(id, { role: 'assistant', toolCalls: calls })
const result = (id: string, callId: string, content = 'ok'): UIMessage => message(id, { role: 'tool', toolCallId: callId, content })
const child: Session = { id: 'child', title: 'Research', createdAt: 1, updatedAt: 1, messageCount: 3,
  origin: 'renderer', avatarEnabled: false, ttsEnabled: false, subagent: { parentSessionId: 'parent', providerId: 'p', model: 'm' } }
const task = { task_id: 'task-1', session_id: 'child', parentSessionId: 'parent', status: 'running' }
const input = (messages: UIMessage[], overrides: Partial<GraphInput> = {}): GraphInput => ({
  sessionId: 'parent', sessions: [], messages: { parent: messages }, runningIds: new Set(), detailLevel: 'steps', ...overrides
})

{
  const short = buildConversationGraph(input([assistant('short')], { detailLevel: undefined })).nodes[0]
  const long = { ...short.data, message: { ...short.data.message!, content: '完整输出。\n'.repeat(80) } }
  assert.ok(short.height < 144, 'a short utterance without tools has no reserved tool space')
  assert.ok(estimateSpeechHeight(long, 352) > short.height, 'text grows the card within its limit')
  const max = estimateSpeechHeight(long, 352)
  assert.equal(estimateSpeechHeight({ ...long, message: { ...long.message, content: long.message.content.repeat(10) } }, 352), max,
    'longer output scrolls instead of growing the card indefinitely')
  assert.equal(responsiveSpeechWidth(500), 280)
  assert.equal(responsiveSpeechWidth(2000), 420)
  const narrow = buildConversationGraph(input([assistant('one'), assistant('two')], {
    detailLevel: undefined, speechSizing: { width: 280, fontSize: 18 }
  }))
  assert.ok(narrow.nodes.every(node => node.width === 280))
  assert.ok(narrow.nodes[0].position.x + narrow.nodes[0].width < narrow.nodes[1].position.x,
    'responsive widths preserve space between consecutive nodes')
}

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
  assert.ok(!messageNodeId('session"\\', 'message\n"').match(/["\\\n]/), 'graph keys are safe for dynamic port DOM lookup')
  assert.notEqual(messageNodeId('a', 'b:c'), messageNodeId('a:b', 'c'), 'encoding retains unambiguous session/message boundaries')
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

// Actual spoken messages own their internal execution trace; silent rounds do not lengthen the main chain.
{
  const history: UIMessage[] = [message('u')]
  for (let index = 0; index < 20; index++) history.push({ ...assistant(`a${index}`, [call(`c${index}`)]),
    content: index === 0 ? 'I will check the configuration.' : '', reasoning: `thinking ${index}` }, result(`t${index}`, `c${index}`))
  history.push(assistant('reply'))
  const before = JSON.stringify(history)
  const graph = buildConversationGraph(input(history, { detailLevel: undefined }))
  assert.deepEqual(graph.nodes.map(node => node.data.kind), ['user', 'speech', 'speech'])
  assert.equal(graph.nodes[1].data.steps?.length, 40, 'all LLM and tool steps remain inspectable in order')
  assert.equal(graph.nodes[1].data.toolCount, 20)
  assert.equal(graph.nodes[1].data.llmCount, 20)
  assert.deepEqual(graph.nodes[1].data.steps?.filter(step => step.data.result).map(step => step.data.result?.id),
    Array.from({ length: 20 }, (_, index) => `t${index}`))
  assert.equal(JSON.stringify(history), before)
  assert.equal(graph.nodes[2].position.x - graph.nodes[0].position.x, 738, 'inner steps reclaim horizontal layout space')
  assert.equal(graph.nodes[1].data.preview, 'I will check the configuration.', 'reasoning is never substituted for spoken text')
  assert.equal(primaryStep(graph.nodes[1]).data.message?.id, 'a0')
  assert.equal(nestedSteps(graph.nodes[1].data).length, 40, 'reasoning and tools are distinct inner actions')
  assert.equal(previewSteps(graph.nodes[1].data).visible.length, 6)
  assert.equal(previewSteps(graph.nodes[1].data).hidden, 34)
  const growing = buildConversationGraph(input(history.slice(0, -3), { detailLevel: undefined }))
  assert.equal(growing.nodes[1].id, graph.nodes[1].id, 'appending steps does not replace the stage anchor')
  const compacted = buildConversationGraph(input(history, { detailLevel: undefined, compaction: { upToMessageId: 't9' } }))
  assert.deepEqual(compacted.nodes.map(node => node.data.kind), ['user', 'speech', 'compaction', 'speech'])
  assert.equal(compacted.nodes[1].data.steps?.length, 20)
  assert.equal(compacted.nodes[3].data.steps?.length, 21, 'the silent prefix after compression belongs to the next actual utterance')
  assert.equal(compacted.nodes[3].data.message?.id, 'reply')
}
{
  const secondChild = { ...child, id: 'child-2' }
  const secondTask = { ...task, task_id: 'task-2', session_id: 'child-2' }
  const parent = [message('u'), assistant('dispatch', [call('s1', 'spawn_subagent'), call('s2', 'spawn_subagent')]),
    result('r1', 's1', JSON.stringify(task)), result('r2', 's2', JSON.stringify(secondTask)),
    assistant('waiting', [call('wait', 'wait_subagents')]), result('wr', 'wait', JSON.stringify([
      { ...task, status: 'completed' }, { ...secondTask, status: 'completed' }])), assistant('reply')]
  const histories = { parent, child: [message('cu', { sessionId: 'child' }), message('ca', { sessionId: 'child', role: 'assistant' })],
    'child-2': [message('cu2', { sessionId: 'child-2' }), message('ca2', { sessionId: 'child-2', role: 'assistant' })] }
  const graph = buildConversationGraph(input(parent, { detailLevel: undefined, sessions: [child, secondChild], messages: histories }))
  const root = graph.nodes.filter(node => node.data.sessionId === 'parent')
  assert.deepEqual(root.map(node => node.data.kind), ['user', 'speech', 'speech', 'speech'])
  assert.equal(graph.edges.filter(edge => edge.kind === 'delegate').length, 2)
  assert.equal(graph.edges.filter(edge => edge.kind === 'return').length, 2)
  assert.deepEqual(graph.edges.filter(edge => edge.kind === 'delegate').map(edge => edge.sourceStepId),
    [toolNodeId('parent', 's1', 'dispatch'), toolNodeId('parent', 's2', 'dispatch')])
  assert.ok(graph.edges.filter(edge => edge.kind === 'return').every(edge => edge.targetStepId === toolNodeId('parent', 'wait', 'waiting')))
  assert.equal(root[2].data.returnedTaskCount, 2)
  assert.equal(root[1].data.preview, 'dispatch', 'task metadata does not overwrite spoken words')
  assert.deepEqual(root[1].data.ports, [
    { role: 'source', stepId: toolNodeId('parent', 's1', 'dispatch') },
    { role: 'source', stepId: toolNodeId('parent', 's2', 'dispatch') }])
  assert.ok(graph.edges.filter(edge => edge.kind !== 'delegate').every(edge => graph.nodes.find(node => node.id === edge.source)!.position.x
    < graph.nodes.find(node => node.id === edge.target)!.position.x), 'sequences and returns to a later utterance advance horizontally')
  assert.ok(graph.edges.filter(edge => edge.kind === 'delegate').every(edge => graph.nodes.find(node => node.id === edge.source)!.position.y
    < graph.nodes.find(node => node.id === edge.target)!.position.y), 'inner dispatch ports branch downward into child lanes')
  const tallParent = parent.map(item => item.id === 'dispatch' ? { ...item, content: '长正文。\n'.repeat(80) } : item)
  const tall = buildConversationGraph(input(tallParent, { detailLevel: undefined, sessions: [child, secondChild],
    messages: { ...histories, parent: tallParent } }))
  const lanes = tall.nodes.filter(node => node.data.kind === 'lane').sort((a, b) => a.position.y - b.position.y)
  assert.equal(lanes[1].position.y - lanes[0].position.y - lanes[0].height, 20,
    'a tall parent does not reserve equally tall blank space between short child lanes')
}
{
  const spoken = Array.from({ length: 20 }, (_, index) => assistant(`said-${index}`, [call(`call-${index}`)]))
  const graph = buildConversationGraph(input(spoken, { detailLevel: undefined }))
  assert.equal(graph.nodes.length, 20, 'twenty actual utterances remain twenty speech nodes')
  assert.deepEqual(graph.nodes.map(node => node.data.message?.content), spoken.map(item => item.content))
  const prefix = { ...assistant('silent', [call('read')]), content: '', reasoning: 'Inspecting the file.' }
  const live = { ...assistant('live'), content: '', status: 'streaming' as const }
  const history = [assistant('first'), prefix, result('r', 'read'), live]
  const pending = buildConversationGraph(input(history, { detailLevel: undefined, runningIds: new Set(['parent']) }))
  const delta = buildConversationGraph(input([...history.slice(0, -1), { ...live, content: 'Hello' }], {
    detailLevel: undefined, runningIds: new Set(['parent']) }))
  assert.deepEqual(pending.nodes.map(node => [node.id, node.position, node.width]),
    delta.nodes.map(node => [node.id, node.position, node.width]), 'first live text delta preserves node IDs and the horizontal topology')
  assert.ok(pending.nodes.at(-1)!.height > delta.nodes.at(-1)!.height,
    'the waiting mini-row releases its space when the first spoken text arrives')
  const toolEnd = buildConversationGraph(input([...history.slice(0, -1), { ...live, status: 'done', toolCalls: [call('late')] }], { detailLevel: undefined }))
  assert.equal(toolEnd.nodes.length, 1, 'a transient live round which ends tool-only folds back into its owner')
  const beforeWords = buildConversationGraph(input([prefix, result('r', 'read'), assistant('spoken')], { detailLevel: undefined }))
  assert.equal(beforeWords.nodes.length, 1)
  assert.equal(beforeWords.nodes[0].id, messageNodeId('parent', 'silent'), 'a silent prefix retains its authoritative stable anchor')
  assert.equal(primaryStep(beforeWords.nodes[0]).data.message?.id, 'spoken')
}
{
  const parent = [message('u'), assistant('speech', [call('spawn', 'spawn_subagent')]), result('s', 'spawn', JSON.stringify(task))]
  for (let index = 0; index < 10; index++) parent.push({ ...assistant(`silent-${index}`, [call(`c-${index}`)]), content: '' }, result(`r-${index}`, `c-${index}`))
  parent.push({ ...assistant('wait', [call('w', 'wait_subagents')]), content: '' },
    result('wr', 'w', JSON.stringify([{ ...task, status: 'completed' }])), assistant('final'))
  const childHistory = [message('cu', { sessionId: 'child' }), message('ca', { sessionId: 'child', role: 'assistant' })]
  const graph = buildConversationGraph(input(parent, { detailLevel: undefined, sessions: [child], messages: { parent, child: childHistory } }))
  const owner = graph.nodes.find(node => node.id === messageNodeId('parent', 'speech'))!
  const returned = graph.edges.find(edge => edge.kind === 'return')!
  assert.equal(returned.target, owner.id, 'spawn and later silent wait can belong to the same utterance')
  assert.equal(returned.targetStepId, toolNodeId('parent', 'w', 'wait'))
  const visible = previewSteps(owner.data).visible.map(item => item.step.id)
  assert.ok(visible.includes(toolNodeId('parent', 'spawn', 'speech')))
  assert.ok(visible.includes(toolNodeId('parent', 'w', 'wait')), 'connected ports stay visible beyond the regular six-item preview')
  assert.equal(previewRowCount(owner.data), 5, 'each connected tool owns a full row beside its clear side port')
  assert.ok(owner.height > graph.nodes.find(node => node.id === messageNodeId('parent', 'final'))!.height,
    'tool rows consume actual bounded space rather than reserving a fixed tall card')
  assert.ok(graph.nodes.find(node => node.id === messageNodeId('parent', 'final'))!.position.x
    > graph.nodes.find(node => node.id === returned.source)!.position.x, 'the next spoken message follows the returned child')
  const noJoin = buildConversationGraph(input(parent.slice(0, -2), { detailLevel: undefined, sessions: [child], messages: { parent: parent.slice(0, -2), child: childHistory } }))
  assert.equal(noJoin.edges.filter(edge => edge.kind === 'return').length, 0, 'child completion cannot synthesize a wait result')
}
console.log('Speech containers retain actual utterances, inner reasoning/tools, streaming anchors, exact fork/return ports and compression boundaries')
