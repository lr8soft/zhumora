import type { ToolDefinition } from '../../shared/types'
import type { ToolHandler } from './registry'
import type { DesktopControlCoordinator } from '../desktop/controlCoordinator'
import { encodeKeyboardInput } from '../desktop/keyboard.ts'

const evidence = {
  after: { type: 'string', enum: ['none', 'screenshot', 'observe'], description: 'Default screenshot.' },
  display_id: { type: 'string' }
}
const target = {
  target_ref: { type: 'string', description: 'Optional observed target to focus. Omit to keep current focus.' }
}
export const desktopInputDefinitions: ToolDefinition[] = [
  define('desktop_key', 'Press a keyboard key in the focused app. Do not use UI component actions for arrow keys. Examples: {"key":"ArrowDown","repeat":3}, {"key":"s","modifiers":["Ctrl"]}. Observe/focus the intended app first.', {
    ...target, ...evidence,
    key: { type: 'string', description: 'ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Escape, Tab, Space, Backspace, Delete, Home, End, PageUp, PageDown, Insert, F1-F24, or a letter/digit.' },
    modifiers: { type: 'array', items: { type: 'string', enum: ['Ctrl', 'Alt', 'Shift', 'Win'] } },
    repeat: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 1.' }
  }, ['key']),
  define('desktop_type', 'Type literal text into the focused field. Use desktop_key for shortcuts or navigation. No implicit mouse click.', {
    ...target, ...evidence, text: { type: 'string' }, clear_before_typing: { type: 'boolean' }
  }, ['text']),
  define('desktop_mouse', 'Move, click, scroll or drag the mouse. With frame_id, coordinates are screenshot pixels; otherwise physical desktop pixels. Drag requires x,y (start) and end_x,end_y (destination).', {
    ...target, ...evidence,
    action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'move', 'scroll', 'drag'] },
    frame_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
    end_x: { type: 'number' }, end_y: { type: 'number' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 100 }
  }, ['action']),
  define('desktop_action', 'Act on an observed UI component: focus, invoke, set_value, select_option, set_toggled. For physical keyboard/mouse input use desktop_key, desktop_type or desktop_mouse.', {
    ...target, ...evidence,
    action: { type: 'string', enum: ['focus', 'invoke', 'set_value', 'select_option', 'set_toggled'] },
    process: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' },
    toggled: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 250, maximum: 30000 }
  }, ['action'])
]

function define(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

export function createDesktopInputTools(execute: ToolHandler['execute'], control: DesktopControlCoordinator) {
  return desktopInputDefinitions.map(definition => ({
    name: definition.function.name,
    handler: {
      definition, permission: 'dangerous' as const,
      async execute(args, ctx) {
        try {
          const name = definition.function.name
          const action = name === 'desktop_key' ? 'key' : name === 'desktop_type' ? 'type' : args.action
          // Old persisted desktop_action calls remain valid at this one boundary.
          if (action === 'key') encodeKeyboardInput(args.key, args.modifiers, args.repeat)
          if (name === 'desktop_mouse' && !['click', 'double_click', 'right_click', 'move', 'scroll', 'drag'].includes(String(action))) {
            throw new Error('Unsupported mouse action.')
          }
          validateInput(action, args)
          const result = await control.run(ctx.sessionId, ctx.signal, () => execute({ ...args, action }, ctx))
          return typeof result === 'string' ? { content: result } : result
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true }
        }
      }
    } satisfies ToolHandler
  }))
}

function validateInput(action: unknown, args: Record<string, unknown>): void {
  for (const field of ['target_ref', 'process', 'selector', 'frame_id', 'display_id']) {
    if (args[field] !== undefined && (typeof args[field] !== 'string' || !args[field].trim())) throw new Error(`${field} must be a non-empty string.`)
  }
  for (const field of ['clear_before_typing', 'toggled']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') throw new Error(`${field} must be boolean.`)
  }
  if (!['key', 'type', 'click', 'double_click', 'right_click', 'move', 'scroll', 'drag', 'focus', 'invoke', 'set_value', 'select_option', 'set_toggled'].includes(String(action))) throw new Error('Unsupported desktop action.')
  if (['type', 'set_value', 'select_option'].includes(String(action)) && typeof args.text !== 'string') throw new Error('text must be a string.')
  for (const field of ['x', 'y', 'end_x', 'end_y']) {
    if (args[field] !== undefined && (typeof args[field] !== 'number' || !Number.isFinite(args[field]))) throw new Error(`${field} must be a finite number.`)
  }
  if ((args.x === undefined) !== (args.y === undefined)) throw new Error('Provide both x and y.')
  if (action === 'drag' && (args.end_x === undefined || args.end_y === undefined)) throw new Error('drag requires end_x and end_y.')
  if (args.amount !== undefined && (!Number.isInteger(args.amount) || Number(args.amount) < 1 || Number(args.amount) > 100)) throw new Error('amount must be an integer from 1 to 100.')
  if (args.direction !== undefined && !['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new Error('Invalid scroll direction.')
  if (args.after !== undefined && !['none', 'screenshot', 'observe'].includes(String(args.after))) throw new Error('after must be none, screenshot or observe.')
}
