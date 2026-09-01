// ============================================================
// 内置工具集 — read / write / edit / bash / grep / glob / ls
// ============================================================
import { promises as fs, createReadStream } from 'node:fs'
import * as path from 'node:path'
import { exec } from 'node:child_process'
import { createInterface } from 'node:readline'
import { minimatch } from 'minimatch'
import type { ToolHandler, ToolContext } from './registry'
import { updateSessionTitle } from '../store/db'
import { log } from '../llm/logger'

/** 行尾归一化：CRLF/CR → LF。read 显示与 edit 匹配共用此基准，消除 CRLF/LF 差异 */
function toLF(t: string): string {
  return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// 文本读取工具
export const readTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'read',
      description: [
        'Read a file or directory from the local filesystem.',
        'Usage:',
        '- Call this tool in parallel when you know there are multiple files you want to read.',
        '- The output is prefixed with line numbers ("N: content") — this format is the reference for the edit tool; never copy the line number prefix into oldString/newString.',
        '- By default returns up to 2000 lines from the start. For later sections, call again with a larger offset. Avoid tiny repeated slices; read a larger window if you need more context.',
        '- If you are unsure of the correct file path, use glob to look up filenames first.',
        '- Use grep to find specific content in large files instead of reading them in full.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file, or a path relative to the workspace root' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed), default 1' },
          limit: { type: 'number', description: 'Maximum number of lines to read, default 2000' }
        },
        required: ['file_path']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx: ToolContext) {
    const filePath = args.file_path as string
    const offset = (args.offset as number) || 1
    const limit = (args.limit as number) || 2000
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspacePath, filePath)

    try {
      const content = await fs.readFile(resolved, 'utf-8')
      // 归一化为 LF 再分行显示，确保模型看到的文本与 edit 的匹配基准一致
      const lines = toLF(content).split('\n')
      const start = Math.max(0, offset - 1)
      const end = Math.min(lines.length, start + limit)
      const result = lines.slice(start, end)
        .map((line, i) => `${String(start + i + 1).padStart(6)}: ${line}`)
        .join('\n')
      return result || '(empty file)'
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`
    }
  }
}

// 文件写入工具
export const writeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'write',
      description: [
        'Write a file to the local filesystem. Creates parent directories automatically.',
        'Usage:',
        '- This tool OVERWRITES the existing file if there is one at the provided path.',
        '- If the file already exists, you MUST have read it in this conversation first — read it to confirm its current state before overwriting.',
        '- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
        '- NEVER proactively create documentation files (*.md) or README files. Only create them if the user explicitly asks.',
        '- Use for creating new files from scratch or fully replacing file contents. For partial changes, use the edit tool instead.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file, or a path relative to the workspace root' },
          content: { type: 'string', description: 'The complete content to write to the file' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  permission: 'normal',
  async execute(args, ctx) {
    const filePath = args.file_path as string
    const content = args.content as string
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspacePath, filePath)

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf-8')
      return `File written: ${resolved}`
    } catch (err) {
      return `Error writing file: ${(err as Error).message}`
    }
  }
}

// 文件编辑工具（行尾无关的精确替换）
export const editTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'edit',
      description: [
        'Perform an exact string replacement in a file. The preferred tool for making targeted changes to existing files.',
        'Usage:',
        '- You MUST read the file at least once in this conversation before editing it.',
        '- Copy oldString verbatim from the read output. Preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix (e.g. "12: ") is NOT part of the file content — never include it in oldString or newString.',
        '- Line endings are auto-aligned: CRLF and LF both match, so you can copy from read output directly.',
        '- The edit FAILS if oldString is not found. If it fails, re-read the file and copy the exact text including indentation.',
        '- The edit FAILS if oldString matches multiple locations. Provide more surrounding context to make it unique, or set replaceAll=true.',
        '- Use replaceAll for renaming a variable or string across the whole file.',
        '- Include enough surrounding context (a few lines before/after) to make the match unambiguous.',
        '- If several edits to different files or non-overlapping regions are already known, emit multiple edit calls in the same response.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file, or a path relative to the workspace root' },
          oldString: { type: 'string', description: 'The exact text to be replaced, copied verbatim from the read output (line-number prefixes excluded, indentation preserved)' },
          newString: { type: 'string', description: 'The replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match, default false' }
        },
        required: ['file_path', 'oldString', 'newString']
      }
    }
  },
  permission: 'normal',
  async execute(args, ctx) {
    const oldStr = args.oldString as string
    const newStr = args.newString as string
    const replaceAll = args.replaceAll as boolean
    const rawPath = args.file_path as string
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.workspacePath, rawPath)

    try {
      const content = await fs.readFile(resolved, 'utf-8')
      // 检测文件主导行尾，写回时保持一致，不破坏原文件风格
      const eol = content.includes('\r\n') ? '\r\n' : '\n'
      // 归一化为 LF 再匹配：模型给的 oldString 来自 read（恒为 LF），与文件 CRLF 不再冲突
      const nContent = toLF(content)
      const nOld = toLF(oldStr)
      const nNew = toLF(newStr)
      if (!nOld) return 'Error: oldString is empty'

      const count = nContent.split(nOld).length - 1
      if (count === 0) return 'Error: oldString not found in file. Line endings are auto-aligned (CRLF/LF); if it still fails, re-read the file and copy the exact text including indentation.'
      if (count > 1 && !replaceAll) return `Error: ${count} matches found. Provide more surrounding context to make oldString unique, or set replaceAll=true.`

      // 关键：用函数形式替换，规避 newString 中 "$&"、"$'"、"$$" 等被当作替换模式展开
      const nResult = replaceAll ? nContent.split(nOld).join(nNew) : nContent.replace(nOld, () => nNew)
      await fs.writeFile(resolved, nResult.split('\n').join(eol), 'utf-8')
      return `File edited: ${resolved} (${replaceAll ? count : 1} replacement(s))`
    } catch (err) {
      return `Error editing file: ${(err as Error).message}`
    }
  }
}

// Bash 执行工具
// 描述按实际执行 shell 动态生成（对齐 opencode：shell 语法指导必须与实际执行环境一致）
const bashDescription = (() => {
  const isWin = process.platform === 'win32'
  const shellName = isWin ? 'cmd.exe' : 'bash'
  const lines = [
    `Executes a shell command in a ${shellName} shell and returns stdout, stderr, and the exit code.`,
    `Be aware: OS: ${process.platform}, Shell: ${shellName}.`,
    'Usage:',
    '- This tool is for terminal operations: git, npm, node, docker, running builds/tests, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) — use the dedicated tools instead:',
    '  - File search: use glob (NOT dir /s, find, ls)',
    '  - Content search: use grep (NOT findstr, grep, rg)',
    '  - Read files: use read (NOT type, cat, head, tail)',
    '  - Edit files: use edit (NOT sed, awk)',
    '  - Write files: use write (NOT echo > file, here-docs)',
    '  - Communicate with the user: output text directly (NOT echo / Write-Host)',
    '- Commands must be non-interactive. Never run commands that wait for input (e.g. interactive git rebase, pagers). Use flags like --no-pager, --yes, --non-interactive when available.'
  ]
  if (isWin) {
    lines.push(
      '- Commands run through cmd.exe. Syntax notes:',
      '  - Chain dependent commands with && (e.g. git add . && git commit -m "msg").',
      '  - Use ; only to run sequentially without caring about earlier failures.',
      '  - Quote paths with spaces: mkdir "My Project\\src".',
      '  - Use %VAR% for environment variables; if exist <path> for existence checks.',
      '  - To run a .bat/.cmd file from another command, use: call "script.bat".',
      '  - DO NOT use bash-only syntax: no pipes through unix tools like head/tail/which, no backticks for command substitution, no $(...) (cmd does not expand it).'
    )
  } else {
    lines.push(
      '- If commands depend on each other and must run sequentially, chain them in ONE call with && (e.g. git add . && git commit -m "msg" && git push). Use ; only when later commands must run regardless of earlier failures.',
      '- Always quote file paths that contain spaces.'
    )
  }
  lines.push(
    '- AVOID changing directories inside the command. Use the workdir parameter instead.',
    '  <good-example>workdir="src\\pkg", command: "npm test"</good-example>',
    '  <bad-example>command: "cd src\\pkg && npm test"</bad-example>',
    '- If you need to run independent commands (e.g. "git status" and "git log"), issue multiple parallel bash calls in one response instead of chaining.',
    '- Long-running commands: keep them under the timeout; for very long tasks prefer to split them up.'
  )
  return lines.join('\n')
})()

export const bashTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: bashDescription,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: `The ${process.platform === 'win32' ? 'cmd.exe' : 'shell'} command to execute. Do not include 'cd' — use workdir instead.` },
          workdir: { type: 'string', description: 'Working directory for the command (absolute or relative to the workspace root). Defaults to the workspace root. Use this instead of cd.' },
          timeout: { type: 'number', description: 'Timeout in seconds, default 120' }
        },
        required: ['command']
      }
    }
  },
  permission: 'dangerous',
  async execute(args, ctx) {
    const command = args.command as string
    const timeout = ((args.timeout as number) || 120) * 1000
    const workdir = args.workdir
      ? (path.isAbsolute(args.workdir as string)
          ? args.workdir as string
          : path.join(ctx.workspacePath, args.workdir as string))
      : ctx.workspacePath

    return new Promise((resolve) => {
      exec(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        cwd: workdir,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      }, (err, stdout, stderr) => {
        const parts: string[] = []
        if (stdout && stdout.trim()) parts.push(`[stdout]\n${stdout.trimEnd()}`)
        if (stderr && stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`)
        if (err) {
          const code = typeof err.code === 'number' ? err.code : -1
          parts.push(`[exit code: ${code}]`)
          if (err.killed) parts.push('[Process timed out]')
        } else {
          parts.push('[exit code: 0]')
        }
        if (parts.length === 0) parts.push('(no output)')
        resolve(parts.join('\n'))
      })
    })
  }
}

// Grep 内容搜索工具
export const grepTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description: [
        'Fast content search across the workspace using regular expressions. Returns file paths with line numbers and matching lines.',
        'Usage:',
        '- Use this tool when you need to find code containing a specific pattern (function names, class definitions, imports, string literals, error messages).',
        '- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Narrow, specific patterns beat broad ones — results are truncated at 200 matches.',
        '- Filter files with the include parameter (e.g. "*.ts", "*.{ts,tsx}") to narrow scope and reduce noise.',
        '- Use exclude to skip heavy directories (e.g. ["node_modules", ".git", "dist", "release"]) — this dramatically speeds up the search.',
        '- It is always better to speculatively perform multiple independent searches as a batch in one response than to wait for one result before searching for another.',
        '- After finding candidate locations with grep, use read to see the full context around the matches.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for in file contents' },
          path: { type: 'string', description: 'Directory to search in, defaults to the workspace root' },
          include: { type: 'string', description: 'Filename glob filter, e.g. "*.ts" or "*.{h,cpp}"' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Directory names to skip, e.g. ["node_modules", ".git", "dist", "release"]' }
        },
        required: ['pattern']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx) {
    const pattern = args.pattern as string
    const searchPath = args.path as string || ctx.workspacePath
    const include = args.include as string
    const exclude = new Set((args.exclude as string[]) || [])
    const resolved = path.isAbsolute(searchPath) ? searchPath : path.join(ctx.workspacePath, searchPath)

    const regex = new RegExp(pattern)
    const results: string[] = []
    const maxResults = 200

    async function searchDir(dir: string) {
      if (results.length >= maxResults) return
      let entries: import('node:fs').Dirent[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) }
      catch { return }

      for (const entry of entries) {
        if (results.length >= maxResults) break
        if (entry.isDirectory() && exclude.size > 0 && exclude.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await searchDir(fullPath)
        } else if (entry.isFile()) {
          if (include && !minimatch(entry.name, include)) continue
          try {
            const rl = createInterface({ input: createReadStream(fullPath, { encoding: 'utf-8' }), crlfDelay: Infinity })
            let lineNum = 0
            for await (const line of rl) {
              lineNum++
              if (regex.test(line)) {
                const display = path.relative(ctx.workspacePath, fullPath)
                results.push(`${display}:${lineNum}: ${line.trim().slice(0, 200)}`)
                if (results.length >= maxResults) break
              }
            }
          } catch { /* skip binary/unreadable */ }
        }
      }
    }

    await searchDir(resolved)
    if (results.length === 0) return 'No matches found'
    if (results.length >= maxResults) results.push(`... (truncated at ${maxResults} results)`)
    return results.join('\n')
  }
}

// Glob 文件匹配工具
export const globTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description: [
        'Fast file pattern matching that works with any codebase size. Returns matching file paths.',
        'Usage:',
        '- Use this tool when you need to find files by name patterns, e.g. "**/*.ts", "**/*AuthManager*", "src/**/*.cpp".',
        '- Pattern syntax: ** matches any number of subdirectories, * matches any characters except / (but also matches filenames across segments), ? matches a single character.',
        '- Use exclude to skip heavy directories like ["node_modules", ".git", "dist", "release"] to speed up the search.',
        '- It is always better to speculatively perform multiple independent searches as a batch in one response than to wait for one result before searching for another.',
        '- After finding candidate files with glob, use read to open the relevant ones (in parallel when possible).'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match file paths, e.g. "**/*.ts", "**/*Scene*.h", "src/**/*.cpp"' },
          path: { type: 'string', description: 'Directory to search in, defaults to the workspace root' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Directory names to skip, e.g. ["node_modules", ".git", "dist", "release"]' }
        },
        required: ['pattern']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx) {
    const pattern = args.pattern as string
    const searchPath = args.path as string || ctx.workspacePath
    const exclude = new Set((args.exclude as string[]) || [])
    const resolved = path.isAbsolute(searchPath) ? searchPath : path.join(ctx.workspacePath, searchPath)

    try {
      const results: string[] = []
      await walkDir(resolved, pattern, results, ctx.workspacePath, exclude)
      return results.length ? results.slice(0, 500).join('\n') : 'No files found'
    } catch (err) {
      return `Error: ${(err as Error).message}`
    }
  }
}

// 目录列表工具
export const lsTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'ls',
      description: [
        'List the contents of a directory. Returns one entry per line: "d name/" for directories, "f name" for files.',
        'Usage:',
        '- Use to get a quick overview of a directory when exploring an unfamiliar project (ls first, then glob for specific files, then read relevant files).',
        '- Use glob instead of ls when you need to find files matching a pattern recursively.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list, defaults to the workspace root' },
          ignore: { type: 'array', items: { type: 'string' }, description: 'Directory or file names to ignore, e.g. ["node_modules", ".git"]' }
        }
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx) {
    const target = args.path as string || ctx.workspacePath
    const ignore = new Set((args.ignore as string[]) || [])
    const resolved = path.isAbsolute(target) ? target : path.join(ctx.workspacePath, target)

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const lines = entries
        .filter(e => !ignore.has(e.name))
        .map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort()
      return lines.join('\n') || '(empty)'
    } catch (err) {
      return `Error: ${(err as Error).message}`
    }
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 递归遍历目录，用 minimatch 匹配完整相对路径 */
async function walkDir(dir: string, pattern: string, results: string[], workspacePath: string, exclude: Set<string> = new Set()) {
  if (results.length >= 500) return
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) }
  catch { return }

  for (const entry of entries) {
    if (results.length >= 500) break
    if (entry.isDirectory() && exclude.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, pattern, results, workspacePath, exclude)
    } else if (entry.isFile()) {
      const relative = path.relative(workspacePath, fullPath)
      if (minimatch(relative, pattern, { matchBase: true })) {
        results.push(relative)
      }
    }
  }
}

// 设置会话标题工具
export const setTitleTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'set_title',
      description: 'Set a short title (max 6 words) for the current conversation. Call this early at the start of a new conversation, before doing anything else, to name the session.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A concise conversation title, no more than 6 words' }
        },
        required: ['title']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx: ToolContext) {
    const title = (args.title as string || '').trim().slice(0, 50)
    if (!title) return 'Error: title is required'
    const sid = ctx.sessionId
    if (sid) {
      updateSessionTitle(sid, title)
      ctx.onSessionTitleUpdate?.(sid, title)
      return `Session title set to: ${title}`
    }
    return `Title suggestion: ${title} (no active session context)`
  }
}
// 导出所有内置工具
export const builtinTools: { name: string; handler: ToolHandler }[] = [
  { name: 'read', handler: readTool },
  { name: 'write', handler: writeTool },
  { name: 'edit', handler: editTool },
  { name: 'bash', handler: bashTool },
  { name: 'grep', handler: grepTool },
  { name: 'glob', handler: globTool },
  { name: 'ls', handler: lsTool },
  { name: 'set_title', handler: setTitleTool }
]
