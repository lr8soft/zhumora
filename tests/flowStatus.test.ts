import assert from 'node:assert/strict'
import type { Session, UIMessage, ToolCall } from '../src/shared/types.ts'
import { buildConversationGraph } from '../src/renderer/src/flow/buildGraph.ts'
import { messageNodeId, toolNodeId } from '../src/renderer/src/flow/history.ts'
import { createMcpTaskSession } from '../src/main/agent/taskProtocol.ts'

const message = (id: string, role: UIMessage['role'], extra: Partial<UIMessage> = {}): UIMessage => ({
  id, role, sessionId: 'parent', content: id, timestamp: 1, status: 'done', ...extra
})
const call = (id: string, name = 'bash'): ToolCall => ({ id, type: 'function', function: { name, arguments: '{}' } })
const assistant = (id: string, calls: ToolCall[] = [], extra: Partial<UIMessage> = {}) => message(id, 'assistant', { toolCalls: calls, ...extra })
const result = (id: string, toolCallId: string, extra: Partial<UIMessage> = {}) => message(id, 'tool', { toolCallId, ...extra })
const failedTool = [message('u', 'user'), assistant('speech', [call('bad')]), result('bad-result', 'bad', { status: 'error' }), assistant('final')]
const child: Session = { id: 'child', title: 'child', createdAt: 1, updatedAt: 1, messageCount: 0,
  origin: 'renderer', avatarEnabled: false, ttsEnabled: false, subagent: { parentSessionId: 'parent', providerId: 'p', model: 'm' } }
const task = { task_id: 'task', session_id: 'child', parentSessionId: 'parent', status: 'running' }
const spawn = [message('pu', 'user'), assistant('spawn', [call('spawn-call', 'spawn_subagent')]),
  result('spawn-result', 'spawn-call', { content: JSON.stringify(task) })]
function graph(parent: UIMessage[], childHistory: UIMessage[] = [], options: {
  expanded?: boolean; steps?: boolean; running?: string[]; collapsed?: string[]
} = {}) {
  return buildConversationGraph({ sessionId: 'parent', sessions: [child], messages: { parent, child: childHistory },
    runningIds: new Set(options.running), showChildren: options.expanded, detailLevel: options.steps ? 'steps' : undefined,
    collapsedTurns: new Set(options.collapsed) })
}
const childMessages = (messages = failedTool) => messages.map(m => ({ ...m, sessionId: 'child' }))
const wait = (status: string, id = 'task', extra: object = {}) => [assistant(`wait-${id}`, [call(`wait-call-${id}`, 'wait_subagents')]),
  result(`wait-result-${id}`, `wait-call-${id}`, { content: JSON.stringify([{ ...task, task_id: id, status, ...extra }]) })]

{
  const before = JSON.stringify(failedTool)
  const compact = graph(failedTool)
  assert.equal(compact.nodes.find(n => n.id === messageNodeId('parent', 'speech'))!.data.status, 'done',
    'a failed tool must not turn its successful LLM utterance into a failed generation')
  const leaf = compact.nodes.flatMap(n => n.data.steps ?? []).find(n => n.id === toolNodeId('parent', 'bad', 'speech'))!
  assert.equal(leaf.data.status, 'error'); assert.equal(leaf.data.result!.id, 'bad-result')
  assert.equal(graph(failedTool, [], { steps: true }).nodes.find(n => n.id === messageNodeId('parent', 'speech'))!.data.status, 'done')
  assert.equal(JSON.stringify(failedTool), before, 'status projection never rewrites persisted results')
  const folded = graph([...failedTool, message('next', 'user')], [], { collapsed: ['u'] }).nodes[0]
  assert.equal(folded.data.status, 'done', 'a recovered tool failure does not poison an entire folded turn')
}
for (const expanded of [true, false]) {
  const built = graph(spawn, childMessages(), { expanded })
  assert.equal(built.nodes.find(n => n.data.kind === 'lane')!.data.status, 'done')
  if (!expanded) assert.equal(built.nodes.find(n => n.data.kind === 'delegate' && n.data.sessionId === 'child')!.data.status, 'done')
  const running = graph(spawn, childMessages(failedTool.slice(0, -1)), { expanded, running: ['child'] })
  assert.equal(running.nodes.find(n => n.data.kind === 'lane')!.data.status, 'running')
  const unfinished = graph(spawn, childMessages(failedTool.slice(0, -1)), { expanded })
  assert.equal(unfinished.nodes.find(n => n.data.kind === 'lane')!.data.status, 'unresolved', 'stopping after a tool is not a final deliverable')
  const failure = graph(spawn, childMessages([message('u', 'user'), assistant('actual-error', [], { status: 'error' })]), { expanded })
  assert.equal(failure.nodes.find(n => n.data.kind === 'lane')!.data.status, 'error')
}
for (const [status, expected] of [['completed', 'done'], ['failed', 'error'], ['aborted', 'unresolved']] as const) {
  for (const expanded of [true, false]) {
    const parent = [...spawn, ...wait(status)]
    const built = graph(parent, [], { expanded })
    assert.equal(built.nodes.find(n => n.data.kind === 'lane')!.data.status, expected,
      'matched task snapshots remain authoritative even before child history has loaded')
    const waiting = built.nodes.flatMap(n => n.data.steps ?? [{ id: n.id, data: n.data }])
      .find(n => n.id === toolNodeId('parent', 'wait-call-task', 'wait-task'))!
    assert.equal(waiting.data.status, 'done', 'successfully retrieving a failed child is not a failed wait invocation')
    assert.equal(built.edges.filter(e => e.kind === 'return').length, 1)
  }
}
{
  const stopped = graph([...spawn, ...wait('aborted')], childMessages([
    message('u', 'user'), assistant('partial', [], { status: 'streaming' })
  ]), { running: ['child'] })
  assert.equal(stopped.nodes.find(n => n.data.kind === 'speech' && n.data.sessionId === 'child')!.data.status, 'unresolved',
    'terminal task evidence prevents stale running flags from animating a cancelled child')
}
{
  const parent = [...spawn, assistant('list', [call('list-call', 'list_subagents')]),
    result('list-result', 'list-call', { content: JSON.stringify({ tasks: [{ ...task, status: 'failed' }], next_cursor: null }) })]
  assert.equal(graph(parent).nodes.find(n => n.data.kind === 'lane')!.data.status, 'error')
  const spoof = [...spawn, assistant('read', [call('read-call', 'read')]),
    result('read-result', 'read-call', { content: JSON.stringify({ ...task, status: 'failed' }) })]
  assert.equal(graph(spoof, childMessages()).nodes.find(n => n.data.kind === 'lane')!.data.status, 'done', 'arbitrary tools cannot set task status')
  const failedQuery = [...spawn, assistant('query', [call('query-call', 'wait_subagents')]),
    result('query-result', 'query-call', { status: 'error', content: JSON.stringify([{ ...task, status: 'failed' }]) })]
  assert.equal(graph(failedQuery, childMessages()).nodes.find(n => n.data.kind === 'lane')!.data.status, 'done')
  assert.equal(graph(failedQuery, childMessages()).nodes.flatMap(n => n.data.steps ?? [])
    .find(n => n.id === toolNodeId('parent', 'query-call', 'query'))!.data.status, 'error', 'a failed wait remains a failed leaf')
  for (const mismatch of [{ session_id: 'other' }, { task_id: 'other' }, { parentSessionId: 'other' }]) {
    assert.equal(graph([...spawn, ...wait('failed', 'task', mismatch)], childMessages()).nodes.find(n => n.data.kind === 'lane')!.data.status, 'done')
  }
  const stale = graph([...spawn, ...wait('completed'), assistant('stale', [call('stale-call', 'wait_subagents')]),
    result('stale-result', 'stale-call', { content: JSON.stringify([task]) })])
  assert.equal(stale.nodes.find(n => n.data.kind === 'lane')!.data.status, 'done', 'stale running snapshots cannot erase a terminal result')
}
{
  const continued = { ...task, task_id: 'continued' }
  const parent = [...spawn, ...wait('failed'), assistant('continue', [call('continue-call', 'continue_subagent')]),
    result('continue-result', 'continue-call', { content: JSON.stringify(continued) }), ...wait('completed', 'continued')]
  const history = childMessages([message('u1', 'user'), assistant('failed', [], { status: 'error' }),
    message('u2', 'user'), assistant('recovered')])
  const lanes = graph(parent, history, { running: ['child'] }).nodes.filter(n => n.data.kind === 'lane')
  assert.deepEqual(lanes.map(n => [n.data.taskId, n.data.status]), [['task', 'error'], ['continued', 'done']],
    'continuations keep their own task IDs and cannot recolor an earlier failed run')
}
{
  const startup = { ...task, status: 'failed', diagnostics: { failure: { stage: 'startup' } } }
  const parent = [spawn[0], spawn[1], { ...spawn[2], status: 'error' as const, content: JSON.stringify(startup) },
    assistant('continue', [call('continue-call', 'continue_subagent')]),
    result('continue-result', 'continue-call', { content: JSON.stringify({ ...task, task_id: 'continued' }) })]
  const built = graph(parent, childMessages([message('u', 'user'), assistant('first-real-reply')]))
  assert.equal(built.nodes.find(n => n.data.kind === 'lane' && n.data.taskId === 'task')!.data.status, 'error')
  assert.equal(built.nodes.find(n => n.data.message?.id === 'first-real-reply')!.data.taskId, 'continued',
    'a startup failure without persisted user input must not shift continuation/history associations')
}
{
  const pending = [message('u', 'user'), assistant('a', [call('bad'), call('later')]), result('r', 'bad', { status: 'error' })]
  assert.equal(graph(pending, [], { running: ['parent'] }).nodes.find(n => n.data.kind === 'speech')!.data.status, 'running')
  assert.equal(graph(pending).nodes.find(n => n.data.kind === 'speech')!.data.status, 'unresolved')
  assert.equal(graph([message('u', 'user'), assistant('actual-error', [], { status: 'error' })]).nodes.at(-1)!.data.status, 'error')
  assert.equal(graph([message('u', 'user'), assistant('reasoning', [], { content: '', reasoning: 'only thought' }),
    message('next', 'user')], [], { collapsed: ['u'] }).nodes[0].data.status, 'unresolved')
}
{
  const task = createMcpTaskSession('runtime')
  task.sink.toolResult?.(message('r', 'tool', { status: 'error' }), 'bad', 'bash', 'exit 1', true, 1)
  assert.equal(task.status().status, 'running', 'a tool failure is an activity, not an Agent failure')
  task.sink.complete?.('child', 'final', 'Recovered and completed')
  assert.equal(task.status().status, 'completed')
}
console.log('Flow status: leaf failures, speech/turn/task isolation, authoritative snapshots, abort and continuation history passed')
