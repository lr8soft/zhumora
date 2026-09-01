# Zhumora

开源 Windows 桌面 AI 智能体。

Zhumora 可以连接 OpenAI 兼容模型，并操作你的文件、终端、浏览器和桌面。程序本体以本地运行为主，同时支持 MCP、Skills、长期记忆和权限控制。

[English](./README.md) · [技术文档](./TECHNICAL.md)

<p align="center">
  <img src="./img/image-main.png" alt="Zhumora — AI 智能体聊天界面" width="960" />
</p>

## 功能

- 支持 OpenAI 兼容 API，也可接入 Ollama、llama.cpp、vLLM 等本地端点
- 在指定工作目录内读取、编辑、搜索和管理文件
- 执行终端命令
- 使用 Playwright 自动化 Chromium
- 截取桌面屏幕截图用于视觉分析（仅观察，不含鼠标/键盘控制）
- 通过 MCP 扩展工具
- 从 Markdown 文件加载 Skills
- 本地保存会话、长期记忆和 Token 用量
- 对高风险操作进行权限确认
- 支持深色 / 浅色主题与多语言界面

## 快速开始

### 环境要求

- Windows 10 / 11
- Node.js 22.12+（推荐 Node.js 24 LTS）
- npm

### 安装

```bash
npm install
```

### 开发

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 打包 Windows 安装包

```bash
npm run build:win
```

安装包输出到 `release/`。

## 模型配置

在 **设置** 中添加 OpenAI 兼容 Provider：

- Base URL
- API Key（如需要）
- 模型名称
- Temperature
- Reasoning Effort
- Context Window

本地和远程模型端点均可使用。

## 文档

架构、工具系统、上下文管理、长期记忆、MCP 和构建细节见 [TECHNICAL.md](./TECHNICAL.md)。

## License

[MIT](https://opensource.org/licenses/MIT)
