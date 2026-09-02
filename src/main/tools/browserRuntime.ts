import * as fs from 'node:fs'
import * as path from 'node:path'

const MAX_SEARCH_DEPTH = 6

function isChromiumExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  if (platform === 'win32') return normalized.endsWith('/chrome.exe')
  if (platform === 'darwin') {
    return normalized.endsWith('/Chromium.app/Contents/MacOS/Chromium') ||
      normalized.endsWith('/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  }
  return normalized.endsWith('/chrome') && !normalized.includes('crashpad')
}

/** Find Playwright's full Chromium executable inside a packaged browsers resource directory. */
export function findBundledChromium(
  browsersDir: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (!fs.existsSync(browsersDir)) return undefined
  const queue: Array<{ directory: string; depth: number }> = [{ directory: browsersDir, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name)
      if (entry.isFile() && isChromiumExecutable(candidate, platform)) return candidate
      if (entry.isDirectory() && current.depth < MAX_SEARCH_DEPTH) {
        queue.push({ directory: candidate, depth: current.depth + 1 })
      }
    }
  }
  return undefined
}

