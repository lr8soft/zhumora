import type { ChatMessage } from '../../shared/types.ts'
import type { WorkingConversation } from './workingConversation.ts'

export interface CoordinationMessage { message: ChatMessage; id: string | null }
export interface QueuedGuidance { deliveryId: string; content: string; parentSessionId: string; taskId: string }

/** Owned and disposed by one ActiveSessionRun. Bounded text, no silent eviction or agent-count cap. */
export class RunInbox {
  private queue: QueuedGuidance[] = []
  private characters = 0
  private sequence = 0
  private closed = false

  enqueue(content: string, parentSessionId: string, taskId: string): string {
    if (this.closed) throw new Error('This agent run has ended.')
    if (typeof content !== 'string' || !content.trim() || content.length > 12000) throw new Error('message must contain 1–12000 characters.')
    if (this.characters + content.length > 48000) throw new Error('Pending coordination messages exceed the text budget. Wait for delivery before sending more.')
    const deliveryId = `delivery-${++this.sequence}`
    this.queue.push({ deliveryId, content, parentSessionId, taskId })
    this.characters += content.length
    return deliveryId
  }

  drain(): QueuedGuidance[] {
    const pending = this.queue
    this.queue = []; this.characters = 0
    return pending
  }

  close(): void { this.closed = true; this.queue = []; this.characters = 0 }
}

/** Only call at a complete assistant/tool boundary; message IDs stay aligned with effective history. */
export function appendCoordinationMessages(conversation: WorkingConversation, messages: readonly CoordinationMessage[]): void {
  for (const item of messages) conversation.append(item.message, item.id)
}
