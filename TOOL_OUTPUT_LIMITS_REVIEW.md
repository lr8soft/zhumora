# 内置工具输出限制与 Cline 调研

日期：2026-10-15。对照 Cline GitHub main 中 SDK 实现与当前 Zhumora 源码；main 会变化，以下为本次查看时的行为。

## Cline 的做法

- [output-limits.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/executors/output-limits.ts)：命令输出最多 48,000 字符，保留开头和结尾；文件读取最多 2,000 行、单行 2,000 字符、整体 48,000 字符；搜索也有 48,000 字符上限。截断明确说明遗漏及如何缩小读取范围。
- [bash.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/executors/bash.ts)：流式输出采用有界首尾缓冲，分别解码 stdout/stderr，持续读取而不是在达到预览上限时截断进程，避免漏掉最后的错误。
- [file-read.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/executors/file-read.ts) 与 [search.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/executors/search.ts)：文件按行分页，搜索同时限制匹配数量和整体文本量。仅限制行数无法阻止单行巨量输出。
- [message-builder.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/services/message-builder.ts)：请求组装时另有第二层限制，常规工具结果默认 8,000 字符、文件内容 50,000 字符，另有整体字节保护。它处理请求副本，不能与工具出口的 48,000 字符上限混为一谈，也不等于按具体模型窗口校验 token 预算。

## 本次落实到 Zhumora

| 工具 | 改动前 | 当前边界与续读方式 |
|---|---|---|
| bash | 最多捕获 1 MiB，容易携带巨量上下文；超过后丢失末尾 | 正文最多 500 行 / 48,000 字符，单行 2,000；保留首尾，附退出码/超时。需要完整日志时显式重定向文件，再用 read 分页 |
| read 文件 | 已有 2,000 行 / 50 KiB / 单行 2,000 与 offset/limit | 保留原有边界 |
| read 目录 | 有分页条数，缺少整体字符限制 | 每页增加 48,000 字符预算，续读 offset 按真实返回条目计算 |
| grep / glob | 有匹配条数，但整体输出仍可很大 | 在条数之外增加 48,000 字符 / 2,000 行 / 单行 2,000，并限制错误诊断 |
| ls | 可一次返回整个目录 | 48,000 字符 / 2,000 行 / 单行 2,000，提示用 read 分页 |
| edit | 仅预览前几行，单行可以任意长 | 限制返回预览的字符与行宽，完整文件替换不变 |
| browser_get_text / browser_get_html | 默认长度有限，但调用方可请求极大值 | 默认 5,000 字符，用户请求不能突破 48,000 字符硬上限，再应用行数/行宽限制，提示缩小 selector |

输出限制策略集中在 `src/main/tools/outputLimits.ts`，有状态缓冲只属于单次命令或查询，不跨会话共享。输出提示和工具说明同步告知模型限制及后续读取方法。权限与执行流程不变；Office 工具已有自身输出上限，未在本次重写。

## 验证与边界

- 纯测试验证有界首尾缓冲、超长单行、行数、字符数、Unicode 及浏览器请求长度不能绕过上限。
- 集成测试真实执行超过 1 MiB 的命令输出，验证保留末尾错误和退出码、逐字节 UTF-8、超时、中止；验证长目录跨页不丢项、搜索/glob 长结果有界，以及修改预览不会裁剪文件内容。新测试已加入 `npm test`。
- 字符数不是 token 数；多个有界工具结果仍会累积。源头限制不重写旧历史；后续已增加发送前完整预算复检与旧结果的请求预览，见 [压缩修复记录](./CONTEXT_COMPACTION_FIX.md)。
- 省略内容不会自动另存完整日志；需要完整日志时命令必须显式重定向。没有新增通用字符串截断器去破坏子 Agent/MCP JSON、tool_call_id 或附件结构，也没有删除或改写已有数据库消息。
