import type { DesktopAdapter } from './types'

let adapterPromise: Promise<DesktopAdapter> | null = null

export function getDesktopAdapter(): Promise<DesktopAdapter> {
  if (!adapterPromise) adapterPromise = createDesktopAdapter()
  return adapterPromise
}

export async function disposeDesktopAdapter(): Promise<void> {
  if (!adapterPromise) return
  const adapter = await adapterPromise
  adapterPromise = null
  await adapter.dispose()
}

async function createDesktopAdapter(): Promise<DesktopAdapter> {
  switch (process.platform) {
    case 'win32': {
      const { WindowsTerminatorAdapter } = await import('./windowsTerminatorAdapter')
      return WindowsTerminatorAdapter.create()
    }
    case 'darwin':
      throw new Error('[UNSUPPORTED_PLATFORM] macOS desktop control adapter is not implemented yet.')
    case 'linux':
      throw new Error('[UNSUPPORTED_PLATFORM] Linux desktop control adapter is not implemented yet.')
    default:
      throw new Error(`[UNSUPPORTED_PLATFORM] Desktop control is not supported on ${process.platform}.`)
  }
}
