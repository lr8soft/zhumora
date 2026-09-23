import type { BrowserTarget } from '../../shared/browser'

export interface BrowserLaunchCandidate {
  key: string
  label: string
  profileName: string
  launchOptions: { channel: 'chrome' | 'msedge' } | { executablePath: string }
}

/** Edge 渠道（msedge）是 Windows 专有；Linux 上候选链不含它。 */
function isEdgeAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

function chromeCandidate(): BrowserLaunchCandidate {
  return {
    key: 'chrome',
    label: 'Google Chrome',
    profileName: 'browser-profile',
    launchOptions: { channel: 'chrome' }
  }
}

function edgeCandidate(): BrowserLaunchCandidate {
  return {
    key: 'msedge',
    label: 'Microsoft Edge',
    profileName: 'browser-profile-edge',
    launchOptions: { channel: 'msedge' }
  }
}

function customCandidate(executablePath: string): BrowserLaunchCandidate {
  return {
    key: `custom:${executablePath}`,
    label: `custom browser (${executablePath})`,
    profileName: 'browser-profile-custom',
    launchOptions: { executablePath }
  }
}

/**
 * The setting controls only the first candidate. Remaining browsers keep the
 * stable Chrome -> Edge -> custom order (Edge is Windows-only). An empty
 * custom path is not a launch candidate, so it cannot prevent installed
 * system browsers from being tried.
 */
export function resolveBrowserCandidates(
  target: BrowserTarget | undefined,
  customPath: string | undefined,
  platform: NodeJS.Platform = process.platform
): BrowserLaunchCandidate[] {
  const preferred = target ?? 'chrome'
  const executablePath = customPath?.trim() ?? ''
  const candidates = new Map<BrowserTarget, BrowserLaunchCandidate>()
  candidates.set('chrome', chromeCandidate())
  if (isEdgeAvailable(platform)) candidates.set('msedge', edgeCandidate())
  if (executablePath) candidates.set('custom', customCandidate(executablePath))

  const order: BrowserTarget[] = [preferred, 'chrome', 'msedge', 'custom']
  return order.flatMap(browser => {
    const candidate = candidates.get(browser)
    if (!candidate) return []
    candidates.delete(browser)
    return [candidate]
  })
}

export function browserConfigurationKey(
  target: BrowserTarget | undefined,
  customPath: string | undefined
): string {
  return `${target ?? 'chrome'}:${customPath?.trim() ?? ''}`
}
