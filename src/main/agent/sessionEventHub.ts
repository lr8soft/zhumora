import { combineAgentEventSinks, type AgentEventSink } from './persistedCallbacks.ts'

/** Process-wide typed event outlet for every session, independent of its input adapter. */
export class SessionEventHub {
  private readonly subscribers = new Set<AgentEventSink>()

  subscribe(sink: AgentEventSink): () => void {
    this.subscribers.add(sink)
    return () => this.subscribers.delete(sink)
  }

  forRun(localSink?: AgentEventSink): AgentEventSink {
    const sinks = [...this.subscribers]
    if (localSink) sinks.push(localSink)
    return combineAgentEventSinks(...sinks)
  }

  publish(publish: (sink: AgentEventSink) => void): void {
    for (const sink of this.subscribers) publish(sink)
  }
}
