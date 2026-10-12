import { previewRowCount, previewSteps } from './nestedSteps.ts'
import type { FlowData } from './types.ts'

export interface SpeechSizing { width: number; fontSize: number }
export const DEFAULT_SPEECH_SIZE: SpeechSizing = { width: 352, fontSize: 15 }

export function responsiveSpeechWidth(canvasWidth: number): number {
  return Math.round(Math.max(280, Math.min(420, canvasWidth * .42)))
}

/** Offscreen nodes need a bounded estimate before their actual DOM size is available. */
export function estimateSpeechHeight(data: FlowData, width: number, fontSize = 15): number {
  const scale = fontSize / 15
  const text = data.message?.content?.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').trim() ?? ''
  const columns = Math.max(1, Math.floor((width - 26) / (12 * scale)))
  const lines = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / columns)), 0)
  const body = Math.min(6, lines) * 18.6 * scale
  const { visible, hidden } = previewSteps(data)
  const rows = previewRowCount(data, width - 26 < 286 ? 1 : 2)
  const tools = visible.length ? Math.min(180 * scale, rows * 28 * scale + Math.max(0, rows - 1) * 6) : 0
  return Math.ceil(Math.max(112 * scale, 70 * scale + 18 + body + tools + (hidden ? 24 : 0)))
}
