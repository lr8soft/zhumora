export type PanelId = 'conversation' | 'details' | 'composer'
export const PANEL_IDS: readonly PanelId[] = ['conversation', 'details', 'composer']
export type PanelWindowAction = 'minimize' | 'maximize' | 'close'
export interface PanelWindowTicket { key: string }

export function isPanelId(value: unknown): value is PanelId {
  return value === 'conversation' || value === 'details' || value === 'composer'
}

export function isPanelWindowAction(value: unknown): value is PanelWindowAction {
  return value === 'minimize' || value === 'maximize' || value === 'close'
}

export function isPanelTicketKey(value: unknown): value is string {
  return typeof value === 'string' && /^zhumora-panel-[\da-f-]{36}$/.test(value)
}
