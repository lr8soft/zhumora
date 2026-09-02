// Built-in file, search, and command tools.
// Semantics intentionally follow OpenCode V2; ripgrep packaging follows Cline/VS Code.
import { promises as fs } from 'node:fs'
import type { ToolHandler, ToolContext } from './registry'
import { updateSessionTitle } from '../store/db'
import { editFileExact, readPath, resolveToolPath, writeFilePreservingBom } from './fileOperations'
import { globWithRipgrep, grepWithRipgrep } from './ripgrep'
import { executeShellCommand } from './shell'

export const readTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'read',
      description: [
        'Read a UTF-8 text file or list a directory.',
        'File output includes line numbers. It is limited to 2000 lines, 50KB, and 2000 characters per line; use offset to continue when the result says more data is available.',
        'Directories are sorted with folders first and can also be paginated.',
        'Use grep for content discovery and glob for file discovery. Read multiple known files in parallel.',
        'Binary files are rejected instead of returning corrupted text.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path, or path relative to the workspace root' },
          offset: { type: 'number', description: '1-indexed starting line or directory entry, default 1' },
          limit: { type: 'number', description: 'Maximum lines or entries, default/max 2000' }
        },
        required: ['file_path']
      }
    }
  },
  permission: 'safe',
  execute(args, ctx) {
    return readPath(ctx.workspacePath, args.file_path as string, args.offset, args.limit, ctx.signal)
  }
}

export const writeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'write',
      description: [
        'Create or completely overwrite a UTF-8 text file, creating parent directories as needed.',
        'Prefer edit for targeted changes to an existing file. Read an existing file before overwriting it.',
        'An existing UTF-8 BOM is preserved. Do not proactively create documentation unless the user asks.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path, or path relative to the workspace root' },
          content: { type: 'string', description: 'Complete file content' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  permission: 'normal',
  execute(args, ctx) {
    return writeFilePreservingBom(ctx.workspacePath, args.file_path as string, args.content as string)
  }
}

export const editTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'edit',
      description: [
        'Replace exact text in an existing UTF-8 file. This is the preferred tool for targeted edits.',
        'Read the file first, then copy oldString exactly without the read tool line-number prefix.',
        'CRLF/LF differences are normalized for matching; the file line-ending style and UTF-8 BOM are preserved.',
        'The edit fails for no match, ambiguous matches, identical old/new text, or a stale file. Add context to make a match unique, or use replaceAll intentionally.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path, or path relative to the workspace root' },
          oldString: { type: 'string', description: 'Exact text to replace, excluding read line-number prefixes' },
          newString: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence, default false' }
        },
        required: ['file_path', 'oldString', 'newString']
      }
    }
  },
  permission: 'normal',
  execute(args, ctx) {
    return editFileExact(
      ctx.workspacePath,
      args.file_path as string,
      args.oldString as string,
      args.newString as string,
      args.replaceAll === true
    )
  }
}

const shellName = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
const bashDescription = [
  `Execute a non-interactive command using ${shellName}. OS: ${process.platform}.`,
  'Use workdir instead of cd. Use dedicated read/write/edit/grep/glob tools for filesystem work.',
  'stdout and stderr are returned in arrival order with exit metadata. Output is capped at 1MB.',
  'Default timeout is 120 seconds; maximum is 600 seconds. Timeout or user cancellation terminates the whole process tree.',
  process.platform === 'win32'
    ? 'Use cmd.exe syntax (%VAR%, &&, quoted paths); do not use Bash-only syntax.'
    : 'Use POSIX sh syntax and quote paths containing spaces.'
].join('\n')

export const bashTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: bashDescription,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: `Non-interactive ${shellName} command` },
          workdir: { type: 'string', description: 'Working directory, absolute or relative to workspace' },
          timeout: { type: 'number', description: 'Timeout in seconds, default 120, max 600' }
        },
        required: ['command']
      }
    }
  },
  permission: 'dangerous',
  execute(args, ctx) {
    return executeShellCommand({
      workspacePath: ctx.workspacePath,
      command: args.command as string,
      workdir: args.workdir as string | undefined,
      timeoutSeconds: args.timeout,
      signal: ctx.signal
    })
  }
}

export const grepTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description: [
        'Search file contents with ripgrep regular expressions and return path:line: preview.',
        'Search respects .gitignore/.ignore rules, includes hidden files, and always excludes .git.',
        'Use include to constrain file globs and exclude for additional directory names or globs. Results are capped; narrow the pattern/path when truncated.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ripgrep regular expression' },
          path: { type: 'string', description: 'File or directory to search, default workspace root' },
          include: { type: 'string', description: 'File glob such as *.ts or *.{ts,tsx}' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Directory names or glob patterns to exclude' },
          limit: { type: 'number', description: 'Maximum matches, default 200, max 1000' }
        },
        required: ['pattern']
      }
    }
  },
  permission: 'safe',
  execute(args, ctx) {
    return grepWithRipgrep({
      workspacePath: ctx.workspacePath,
      searchPath: args.path as string | undefined,
      pattern: args.pattern as string,
      include: args.include as string | undefined,
      exclude: args.exclude as string[] | undefined,
      limit: args.limit,
      signal: ctx.signal
    })
  }
}

export const globTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description: [
        'Find files with ripgrep glob matching.',
        'Search respects .gitignore/.ignore rules and always excludes .git.',
        'Examples: **/*.ts, **/*AuthManager*, src/**/*.cpp. Results are capped; narrow the pattern/path when truncated.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match file paths' },
          path: { type: 'string', description: 'Directory to search, default workspace root' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Directory names or glob patterns to exclude' },
          limit: { type: 'number', description: 'Maximum files, default 500, max 2000' }
        },
        required: ['pattern']
      }
    }
  },
  permission: 'safe',
  execute(args, ctx) {
    return globWithRipgrep({
      workspacePath: ctx.workspacePath,
      searchPath: args.path as string | undefined,
      pattern: args.pattern as string,
      exclude: args.exclude as string[] | undefined,
      limit: args.limit,
      signal: ctx.signal
    })
  }
}

export const lsTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'ls',
      description: 'List one directory level, with directories first. Returns d/f/l entry markers. Use glob for recursive discovery.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory, default workspace root' },
          ignore: { type: 'array', items: { type: 'string' }, description: 'Entry names to omit' }
        }
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx) {
    const target = (args.path as string) || '.'
    const ignore = new Set((args.ignore as string[]) || [])
    const entries = await fs.readdir(resolveToolPath(ctx.workspacePath, target), { withFileTypes: true })
    const lines = entries
      .filter(entry => !ignore.has(entry.name))
      .sort((a, b) => a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1)
      .map(entry => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'l'} ${entry.name}${entry.isDirectory() ? '/' : ''}`)
    return lines.join('\n') || '(empty directory)'
  }
}

export const setTitleTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'set_title',
      description: 'Set a short title (max 6 words) for the current conversation. Call this early in a new conversation.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Concise conversation title, no more than 6 words' } },
        required: ['title']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx: ToolContext) {
    const title = (args.title as string || '').trim().slice(0, 50)
    if (!title) throw new Error('title is required')
    if (ctx.sessionId) {
      updateSessionTitle(ctx.sessionId, title)
      ctx.onSessionTitleUpdate?.(ctx.sessionId, title)
      return `Session title set to: ${title}`
    }
    return `Title suggestion: ${title} (no active session context)`
  }
}

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
