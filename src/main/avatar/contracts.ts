import type { AvatarActivity, AvatarCommand } from '../../shared/avatar'
import type { ToolExecutionResult } from '../../shared/types'

export interface AvatarController {
  execute(sessionId: string | undefined, command: AvatarCommand, signal?: AbortSignal): Promise<ToolExecutionResult>
  buildSystemPrompt(sessionId: string): Promise<string>
}

export interface AvatarMessageTarget {
  setMessage(sessionId: string, message: string): void
  setActivity(sessionId: string, activity: AvatarActivity): void
}
