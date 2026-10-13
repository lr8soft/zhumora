import { posix, win32 } from 'node:path'

const windowsPath = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path)

export function validateSubagentTargetFile(target: unknown): void {
  if (target === undefined) return
  if (typeof target !== 'string' || !target.trim() || target.length > 4096 || /[\0\r\n*?]/.test(target)
    || /[\\/]$|(?:^|[\\/])\.{1,2}$|^[a-z]:(?![\\/])/i.test(target.trim())) {
    throw new Error('targetFile must name one file, not a directory or a list of files.')
  }
}

export function resolveSubagentTargetFile(workspace: string, target?: string): string | undefined {
  if (target === undefined) return undefined
  validateSubagentTargetFile(target)
  return (windowsPath(workspace) || windowsPath(target) ? win32 : posix).resolve(workspace, target.trim())
}

export function subagentFileKey(target: string): string {
  return windowsPath(target) ? target.toLowerCase() : target
}

export function subagentWorkOrder(prompt: string, target?: string): string {
  if (!target) return prompt
  return `Assigned file: ${target}\nModify only this assigned project file. Read surrounding code only as needed for context. Do not edit other files, run repository-wide autofixes, or expand the task. Report dependency changes and blockers to the parent instead.\n\nTask and acceptance criteria:\n${prompt}`
}
