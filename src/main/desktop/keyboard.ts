const namedKeys: Readonly<Record<string, string>> = {
  arrowup: 'UP', up: 'UP', arrowdown: 'DOWN', down: 'DOWN',
  arrowleft: 'LEFT', left: 'LEFT', arrowright: 'RIGHT', right: 'RIGHT',
  enter: 'ENTER', return: 'ENTER', escape: 'ESC', esc: 'ESC', tab: 'TAB',
  space: 'SPACE', spacebar: 'SPACE', backspace: 'BACKSPACE', delete: 'DELETE', del: 'DELETE',
  home: 'HOME', end: 'END', pageup: 'PAGEUP', pgup: 'PAGEUP',
  pagedown: 'PAGEDOWN', pgdn: 'PAGEDOWN', insert: 'INSERT', ins: 'INSERT'
}
const modifierNames: Readonly<Record<string, string>> = {
  ctrl: 'CTRL', control: 'CTRL', alt: 'ALT', shift: 'SHIFT',
  win: 'WIN', windows: 'WIN', meta: 'WIN', super: 'WIN'
}

// Only this boundary knows Terminator's send_keys grammar. Never forward raw
// LLM strings: unbraced key names are typed as text by the native parser.
export function encodeKeyboardInput(key: unknown, modifiers: unknown = [], repeat: unknown = 1) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('key must be a named key or a letter/digit.')
  if (!Array.isArray(modifiers) || modifiers.some(value => typeof value !== 'string')) {
    throw new Error('modifiers must be an array, e.g. ["Ctrl"].')
  }
  if (!Number.isInteger(repeat) || Number(repeat) < 1 || Number(repeat) > 20) {
    throw new Error('repeat must be an integer from 1 to 20.')
  }
  const parts = key.trim().split('+').map(part => part.trim())
  const base = parts.pop()!
  const holds = [...new Set([...modifiers, ...parts].map(value => {
    const modifier = modifierNames[value.toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${value}". Use Ctrl, Alt, Shift or Win.`)
    return modifier
  }))]
  const token = base.toLowerCase().replace(/[_ -]/g, '')
  const named = namedKeys[token] || (/^f([1-9]|1[0-9]|2[0-4])$/.test(token) ? token.toUpperCase() : undefined)
  const body = named ? `{${named}}` : /^[a-z0-9]$/i.test(base) ? base.toLowerCase() : undefined
  if (!body) throw new Error(`Unknown key "${base}". Use ArrowUp/Down/Left/Right, Enter, Escape, Tab, Space, navigation keys, F1-F24, or a letter/digit. Use desktop_type for text.`)
  return { sequence: holds.map(value => `{${value}}`).join('') + body, repeat: Number(repeat) }
}
