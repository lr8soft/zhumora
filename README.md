# Zhumora

An open-source desktop AI agent for Windows.

Zhumora connects to OpenAI-compatible models and can work with your files, terminal, browser, and desktop. It is designed as a local-first agent runtime with support for MCP, skills, memory, and user-controlled permissions.

[简体中文](./README.zh-CN.md) · [Technical documentation](./TECHNICAL.md)

<p align="center">
  <img src="./img/image-main.png" alt="Zhumora — AI agent chat interface" width="960" />
</p>

## Features

- Connect to OpenAI-compatible APIs, including local endpoints such as Ollama, llama.cpp, and vLLM
- Read, edit, search, and manage files in the selected workspace
- Read and write Word, Excel, PowerPoint, and PDF artifacts with format-specific built-in tools
- Run terminal commands
- Automate Chromium with Playwright
- Observe and control Windows applications with accessibility targets, screenshots, mouse, and keyboard input
- Extend tools through MCP servers
- Load reusable skills from Markdown files
- Local session history, long-term memory, and token usage records
- Chat with the same agent from your phone through a Telegram bot, with live progress updates
- Permission prompts for potentially dangerous actions
- Light / dark themes and multilingual UI

## Chat from Telegram

Connect a Telegram bot in **Settings** and talk to the same local agent from your phone — no need to sit at the desktop.

- **See it working** — thinking streams live (`💭 …`) and every tool call shows up as it happens (`🔧 bash: npm test`), turning into `✅ 1.2s` when it finishes, so a long task never looks frozen
- **Approve from anywhere** — risky actions send inline Allow / Deny buttons straight to the chat
- **Stay in control** — the bot only answers users you whitelist (send it `/id` to get your ID), and `/stop` cancels the current run at any moment

## Desktop control

Zhumora can operate the Windows desktop directly:

- **Observe** — list running applications, capture screens, and read the UI accessibility tree of any window (with stable element targets)
- **Act** — click, double-click, right-click, type, press keys, scroll, drag, focus, and toggle controls, targeting elements by accessibility reference or screenshot coordinates
- **Verify** — attach a screenshot after each action so the agent can confirm the result before continuing

This lets Zhumora drive native Windows apps that have no API or CLI — not just files, shell, and the browser.

## Quick start

### Requirements

- Windows 10 / 11
- Node.js 22.12+ (Node.js 24 LTS recommended)
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Package for Windows

```bash
npm run build:win
```

The Windows installer is written to `release/`.

## Model configuration

Open **Settings** and add an OpenAI-compatible provider:

- Base URL
- API key, if required
- Model name
- Temperature
- Reasoning effort
- Context window

Local and remote endpoints are both supported.

## Documentation

Implementation details, architecture, tool interfaces, context management, memory, MCP, and build notes are documented in [TECHNICAL.md](./TECHNICAL.md).

## License

[MIT](https://opensource.org/licenses/MIT)
