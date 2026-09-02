# Zhumora Technical Documentation

This document contains implementation details that are intentionally kept out of the main README.

## 1. Overview

Zhumora is an Electron desktop application built around an LLM tool-calling loop.

The application is split into three runtime boundaries:

- **Electron Main** — LLM providers, agent execution, tools, MCP, storage, memory, and context management
- **Preload** — controlled IPC bridge exposed through `contextBridge`
- **Renderer** — React UI and client-side state

The agent can use built-in local tools, browser automation, desktop capture, memory tools, and tools provided by MCP servers.

## 2. Technology stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 43 |
| Build | electron-vite + Vite 7 + electron-builder |
| UI | React 19 + TypeScript 5.9 |
| Styling | Vanilla CSS |
| State | Zustand |
| i18n | i18next + react-i18next |
| LLM transport | Native `fetch`, OpenAI-compatible `/chat/completions`, SSE streaming |
| Browser automation | Playwright + Chromium |
| Desktop control | Terminator (Windows UI Automation) + Electron `desktopCapturer` |
| MCP | `@modelcontextprotocol/sdk` |
| Storage | better-sqlite3 |
| Skill parsing | gray-matter |

Supported UI languages currently include Chinese, English, Japanese, Spanish, French, and German.

## 3. Runtime architecture

```text
┌─────────────────────────────────────────────┐
│                Electron Main                │
│                                             │
│  LLM Provider     Agent Runner     MCP      │
│       │                │            │       │
│       └──────────┬─────┴─────┬──────┘       │
│                  │ Tool Registry            │
│                  │                          │
│       ┌──────────┴──────────┐               │
│       │                     │               │
│  SQLite Store        Context / Memory       │
│                                             │
│                 IPC handlers                │
├─────────────────────────────────────────────┤
│          Preload / contextBridge            │
├─────────────────────────────────────────────┤
│                React Renderer               │
│                                             │
│  Sidebar / Chat / Settings / Zustand        │
└─────────────────────────────────────────────┘
```

The renderer does not receive unrestricted Electron IPC access. The preload layer exposes a limited application API through `contextBridge`.

## 4. LLM providers

Zhumora uses OpenAI-compatible chat-completions endpoints and SSE streaming.

A provider stores:

- display name
- base URL
- API key
- default model
- temperature
- reasoning effort
- context window

### Reasoning (thinking) content

Reasoning models (DeepSeek-R1, Doubao, Kimi, OpenAI o-series, Ollama) stream a
`reasoning_content` / `reasoning` delta before the visible answer. Zhumora:

- parses it in the SSE reader and routes it to the UI via a dedicated
  `agent:reasoning` event (separate from `agent:token`)
- renders it in a collapsible "Deep thinking" block on the chat page —
  collapsed by default showing only the latest line, expandable for the full text
- persists it in a dedicated `reasoning` column on the `messages` table, aligned
  with the Cline / opencode approach: it is **never** merged into `content` and
  **never** fed back into the LLM context when rebuilding history

The context window may be configured manually or detected from the provider where supported.

Current auto-detection paths include:

- llama.cpp model metadata exposed through `/v1/models`
- Ollama model metadata exposed through `/api/show`

A context window value of `0` means auto-detect.

### Streaming and finish_reason

The SSE stream is accumulated by a pure module (`src/main/llm/sseAccumulator.ts`):
`SseLineBuffer` splits network chunks into complete SSE lines (the tail is
flushed at stream end, because some backends send the final chunk without a
trailing newline), and `applySseData` folds each `data:` payload into the
round result: `content`, `toolCalls` (assembled by tool-call index), `usage`,
and `finish_reason`.

`finish_reason` is a first-class signal (aligned with opencode / Cline). The
agent loop must distinguish "the model genuinely finished the turn" from
"the response was cut off at the per-response output limit", which the
protocol reports as `finish_reason: "length"`.

## 5. Agent execution

The core agent follows a ReAct-style tool loop:

```text
User message
    │
    ▼
LLM request
    │
    ├─ no tool calls ─────────────► final response
    │
    └─ tool calls
           │
           ▼
      execute tools
           │
           ▼
      append results
           │
           └──────────────► next LLM request
```

The configured default limit is 20 tool rounds per conversation. A value of `0` can be used for no fixed round limit.

Repeated-call loop protection is also implemented:

- repeated calls trigger a warning after 3 occurrences
- the loop is stopped after 5 occurrences
- when execution is stopped by the guard, the model is asked to produce a final text-only summary

### Output truncation (finish_reason = length)

When a single LLM response hits the provider-side `max_tokens` limit, the
stream ends with `finish_reason: "length"`. Without handling, such a turn
looks exactly like a normal completion, so the agent silently stops with the
job unfinished. The runner therefore treats truncation as a recoverable
condition, per round:

- **truncated tool turn** — the (incomplete) assistant message with its
  tool calls is kept in context, every call is answered with an explanatory
  tool error telling the model to re-issue the call with smaller output
  (e.g. split large file writes), and the loop continues
- **truncated text turn** — a "continue exactly where you stopped" system
  notice is appended and the loop continues
- at most 2 automatic recoveries per round
  (`MAX_TRUNCATION_CONTINUATIONS`), after which the run finalizes normally
- the renderer shows a transient warning notice for each truncated turn
  (`agent:truncated` IPC event), so the user always sees that a turn was
  cut off

All of this is keyed on `finish_reason`, so normal turns are unaffected.

## 6. Built-in tools

### 6.1 Workspace and shell

Built-in local tools currently include:

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `glob`
- `ls`
- `set_title`

File operations are relative to the configured workspace path.

### 6.2 Browser automation

Playwright Chromium is bundled with the application.

Available browser tools currently include:

- `browser_navigate`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_get_text`
- `browser_get_html`
- `browser_wait`
- `browser_close`

### 6.3 Desktop control

Desktop control is exposed through a platform-neutral `DesktopAdapter`. The
current `WindowsTerminatorAdapter` uses Terminator for Windows UI Automation,
semantic element targeting, mouse input, and keyboard input. macOS and Linux
have explicit adapter slots but are not implemented yet.

The model-facing API contains two tools:

- `desktop_observe` lists applications, reads a window accessibility tree, and
  optionally attaches a display screenshot.
- `desktop_action` clicks, types, presses keys, scrolls, drags, invokes, or sets
  controls. It is classified as a dangerous tool by the permission layer.

Screenshots still use Electron `desktopCapturer`, are scaled to at most 1280px
wide, and carry a short-lived `frame_id`. Coordinate actions use that frame to
map image pixels back to the selected display's physical coordinate space,
including mixed-DPI and negative-origin multi-monitor layouts. Semantic
`target_ref` values are preferred because they are less brittle than pixels.

## 7. Permission model

Tools are divided by risk.

Safe operations can be auto-approved. Potentially dangerous operations require explicit confirmation unless the user enables automatic approval.

The permission layer is part of the agent execution path rather than the renderer itself.

## 8. MCP

Zhumora can mount Model Context Protocol servers and expose their tools to the agent.

Supported transports:

### stdio

Configuration fields:

- command
- arguments
- environment variables

Example command:

```text
npx
```

Example arguments:

```text
-y @playwright/mcp@latest
```

Environment variables use one `KEY=VALUE` entry per line.

### SSE

Remote MCP servers can be configured with an SSE endpoint URL.

## 9. Skills

Skills are Markdown files with frontmatter.

Zhumora parses the frontmatter and Markdown body with `gray-matter`, then injects the skill content into the agent system prompt.

This mechanism is intended for reusable instructions and workflows rather than executable plugins.

## 10. Context management

Before a request is sent to the model, Zhumora estimates context usage.

The current compact threshold is 60% of the configured or detected context window.

When compaction is required:

1. the system message is preserved
2. the most recent 8 messages are preserved
3. older messages are summarized by the LLM
4. the old message range is replaced with the summary
5. execution continues with the compacted history

The split point is aligned to complete tool-call rounds so an assistant `tool_calls` message is not separated from its tool results.

Current token estimation uses an approximate character-based calculation.

## 11. Long-term memory

Conversation memory is stored locally in SQLite.

Memory categories currently include:

- `preference`
- `habit`
- `fact`
- `skill`
- `context`

Each entry has an importance value from 1 to 5.

### Retrieval

Before a model call, relevant memories are selected using keyword matching and importance, then injected into the system prompt.

### Extraction

After a conversation completes, the LLM analyzes the conversation and extracts information worth remembering.

Similar memories are deduplicated before insertion.

### Agent-accessible memory tools

The agent can also use:

- `memory_search`
- `memory_save`
- `memory_list`
- `memory_delete`

Memory entries can be viewed, searched, filtered, deleted, and reprioritized in Settings.

## 12. Local storage

Zhumora uses `better-sqlite3`.

The local database stores application data including:

- sessions
- messages
- settings
- memory entries
- token usage

Token usage is recorded per LLM request and can be summarized per model and by daily usage over the most recent 30 days.

## 13. IPC boundary

Electron Main owns privileged functionality.

Preload exposes a restricted API through `contextBridge`, and the React renderer calls that API instead of importing Electron APIs directly.

This separation is important for:

- context isolation
- limiting renderer privileges
- keeping desktop and filesystem operations in the privileged process
- maintaining a clear TypeScript boundary between Node/Electron code and browser code

## 14. Concurrent sessions

Multiple sessions can run the agent at the same time. Session isolation follows the
pattern used by Cline and opencode:

- **Main process is the authority.** `agent:run` is fire-and-forget: it returns
  `{ ok: true }` immediately and the agent loop runs in the background. One run per
  session at a time (per-session guard), unlimited cross-session concurrency.
  `agent:running` exposes the set of active session IDs so the renderer can restore
  state after a reload (running state is process-local, not persisted).
- **Every event carries `sessionId` and is routed per session.** The renderer keeps a
  per-session message cache (`Record<sessionId, UIMessage[]>`); background sessions
  keep accumulating stream events even while another session is displayed, so switching
  back shows live progress. UI components subscribe only to the active session's slice.
- **Per-round message IDs.** Before the first token of an LLM round, the main process
  emits `agent:assistant_message { phase: 'start' }` with a fresh messageId; all tokens
  of that round carry it, and `phase: 'end'` finalizes the message. This makes token
  routing exact (no "append to last message" guessing) even with concurrent sessions
  and multi-round tool loops.
- **Per-session UI state.** Running indicators, retry status, permission requests, and
  compact notices are all keyed by sessionId. The sidebar shows a spinner for every
  running session; permission dialogs for non-active sessions show which session they
  belong to (confirmed FIFO). Stop / abort only affects the targeted session.
- **Abort semantics.** `agent:abort` cancels only that session's run. The agent loop
  checks the abort signal between rounds and after each LLM stream, persisting partial
  text and emitting `agent:aborted` so the renderer clears the session's running state.

## 15. UI state and localization

Renderer state is managed with Zustand.

The UI supports:

- light theme
- dark theme
- follow-system theme
- configurable font size from 13px to 18px
- automatic system-language detection
- manual language override

## 16. Development

### Requirements

- Windows 10 / 11
- Node.js 22.12+
- Node.js 24 LTS recommended
- npm

Install dependencies:

```bash
npm install
```

Run development mode:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Package Windows installer:

```bash
npm run build:win
```

The installer is written to `release/`.

## 17. Playwright / Electron install notes

`postinstall` configures the Electron download mirror and installs Playwright Chromium under:

```text
node_modules/playwright-core/.local-browsers
```

If Electron downloads are slow on Windows PowerShell, the mirror can be set manually:

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

## 18. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | Insert a new line |
| `Ctrl+N` | Create a new session |

## 19. Current scope

Zhumora is currently Windows-focused.

The architecture already separates model access, agent execution, browser automation, desktop capture, MCP, memory, storage, and the renderer, so these components can evolve independently without turning the README into an implementation manual.
