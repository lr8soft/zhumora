# Zhumora 开发规范

本项目是 Electron 桌面 AI Agent。所有改动首先保护以下行为：多会话可并行且隔离；ReAct 工具调用序列合法；权限不可绕过；上下文压缩不删除完整历史；用户中止能终止后续工具；main/preload/renderer 的安全边界不退化。

## 必读架构文档

修改会话、消息、Agent、Bot、权限、IPC、renderer 消息状态或数据库会话边界前，必须完整阅读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。该文档记录当前架构、业务时序、状态 owner 和禁止恢复的旧设计。

代码与架构文档必须在同一次变更中保持一致。不得新增绕过架构但未记录的“临时入口”。

## 统一会话系统强制约束

- `SessionService` 是会话消息、核心会话 CRUD、外部会话映射和 Agent 运行的唯一应用 API。UI、Telegram、QQ 以及未来入口都只是它的适配器；Avatar/TTS 的按会话展示配置仍归各自适配器。
- 只有 `SessionService` 可以调用注入的 Agent executor；`composition.ts` 只负责导入 `runAgent` 并注入。IPC、Bot、工具和展示模块不得直接调用 `runAgent`。
- 活跃运行、AbortController 和 approve mode 只能由 `SessionService` 按 `sessionId` 持有。禁止在 IPC 或 Bot 中维护第二套 `activeSessions`、`runningSessions`、`abortControllers`。
- 同一 session 必须互斥，不同 session 必须可并行。不得引入进程级 Agent 全局锁。
- Bot 的 `BotMessageQueue` 只负责外部 conversation FIFO 和 transport AbortSignal，不拥有 session、权限、运行状态或活动展示状态。
- Bot 输入必须通过 `BotSessionAdapter → SessionService`；Bot 不直接读写消息历史、不组装 provider/prompt/tools、不创建持久化消息 ID。
- 全局运行输出通过 `SessionEventHub` 分发。平台 local sink 只负责把本次回复送回来源平台，不得成为另一套全局事件总线。
- user message 必须标明 `renderer` 或 `external` 来源。renderer 输入靠 invoke 返回的权威消息替换 `pending-*`；只有 external 输入通过 `agent:user_message` 追加到 UI，禁止双写。
- 删除活动会话必须先中止并等待 completion settle，再删数据库。应用退出必须停止新 Bot 输入并调用 `SessionService.stopAll()`。
- 不得恢复已删除的 `BotAgentBridge`、`BotRunCoordinator`、`AgentIpcRuntime`，也不得用新名字重建相同职责。
- 当前没有 scheduler、定时任务 runtime 或 scheduled-job 表。未来若明确重新引入，scheduler 只能作为 `SessionService` 输入适配器，并先更新 `ARCHITECTURE.md`、migration 和并发/取消测试。

## 架构与依赖方向

代码按“领域核心 → 应用编排 → 适配器 → 组合根”组织：

- `src/shared/`：跨进程契约和纯函数，不导入 Electron、数据库或 main/renderer 模块。
- `src/main/agent/`：Agent 用例、状态机、历史和上下文策略。优先接收显式依赖，不直接读取 UI、IPC 或数据库状态。
- `src/main/tools/`、`llm/`、`mcp/`、`store/`、`desktop/`：外部能力适配器。适配器可以维护自身生命周期状态，但不得把该状态泄漏为领域规则。
- `src/main/ipc/`：传输层，只做输入校验、调用用例和事件适配；不持久化会话消息，不注册工具，不实现 Agent 决策。
- `src/main/composition.ts` 和 `src/main/index.ts`：唯一组合根。进程级服务的构造、注册和启动顺序放在这里。
- `src/preload/`：最小化、强类型的 IPC API。不得暴露通用 `ipcRenderer`。
- `src/renderer/`：展示和交互。main 是持久化消息、运行状态和权限结果的权威来源。

禁止形成反向依赖。例如 prompt builder 不读取 MCP client，runner 不读取 renderer/store，领域模块不通过全局 setter 注入另一个模块。遇到循环依赖时提取契约或在组合根注入，不能用延迟 setter、动态 `require` 或吞异常掩盖初始化顺序。

## 状态与依赖注入

- 新增的可变进程状态必须有明确 owner，优先封装为类实例，并由组合根或所属适配器创建。
- 禁止新增裸露的模块级可变 `Map`、`Set`、数组或可替换单例。只读常量、带边界的缓存和硬件/连接生命周期状态例外，但要提供清理方法。
- Agent 用例依赖工具表、策略或服务时，使用参数/接口注入。测试应能传入隔离实例。
- 不允许用 `try/catch` 处理“服务可能还没初始化”。初始化失败应在组合根尽早失败；确需预初始化默认值时，由存储/配置边界明确提供。
- 缓存必须说明 key、失效条件和生命周期。设置缓存由 `store/db.ts` 维护，保存后同步刷新。

## Agent 循环不变量

- OpenAI 消息序列中，带 `tool_calls` 的 assistant 后必须紧邻对应的全部 tool 结果。中止、拒绝、解析失败和 hard stop 也必须生成占位 tool 结果。
- `sanitizeHistoryWithIds` 后的消息与 ID 必须平行对齐。任何增删消息操作同时更新两者；不要在不同模块复制这套映射。
- 压缩只改变发给 LLM 的 effective conversation。不得删除或改写 `messages` 表；持久化内容只有 `{upToMessageId, summary}`。
- `finish_reason=length`、空响应、循环检测、最大轮次和用户中止是不同终止原因。各自有独立预算/信号，不得把恢复逻辑改成无上限重试。
- 用户中止后不执行新的工具。provider 返回部分内容时，runner 仍需在工具执行前再次检查 signal。
- Agent 每轮使用运行时注册表的完整工具快照。内置工具与 MCP 工具必须独立注册、平等组合；任何领域工具不得筛选、禁用、改写或影响其他工具的可见性和执行。
- 对恢复、压缩、权限或消息顺序的修改必须补纯函数/状态机测试，不能只依赖手工启动 Electron。

## 工具契约

- 新工具的 `execute` 返回 `ToolExecutionResult`：`{ content, attachments?, isError? }`。纯字符串仅用于兼容旧工具，新增代码不得依赖它。
- 图片等二进制通过结构化 `attachments` 返回。禁止在字符串中嵌入 base64、魔法前缀、XML 标签或让 runner 用正则解析私有协议。
- `content` 是可持久化、可展示的文本；附件默认只进入当前 LLM 上下文，不把大段 base64 写入数据库或 renderer store。
- 权限元数据定义在 handler：静态 `permission`、参数相关的 `getPermission`、能力边界变更使用 `alwaysConfirm`。工具内部不得绕过统一权限检查自行弹窗。
- `safe` 必须真正只读且无外部副作用；写文件、发网络变更或控制桌面至少为 `normal`；修改 Agent 自身能力边界为 `dangerous + alwaysConfirm`。
- 长耗时工具必须接收并响应 `ToolContext.signal`。预期内失败优先返回 `isError: true`；异常只表示未预期故障。
- 新增内置工具只修改工具模块和 `composition.ts`，不修改 IPC handler。

## 消息与 IPC 契约

- 数据库/main 分配持久化 `UIMessage.id`。renderer 不为 user、assistant、tool 的最终记录制造另一套 ID。
- renderer 可使用 `pending-*` 的临时占位 ID，但收到 main 返回的消息后必须原位替换；临时 ID 不写数据库、不参与压缩边界和跨事件关联。
- assistant 的 `start/end/token/reasoning` 和 tool 事件都携带 main 分配的 `messageId`。renderer 按 ID 精确归并，禁止回退到“最后一条 streaming 消息”。
- 每个 Agent 事件必须携带 `sessionId`；处理事件时不能假设它属于当前可见会话。
- 新增或修改 IPC 时同步更新 main handler、preload 类型和 renderer 调用方。载荷使用 shared 类型或命名接口，避免扩散 `any`。
- IPC handler 只注册一次。若支持窗口重建，事件发送使用可更新的窗口引用，不能重复 `ipcMain.handle`。
- 对 renderer 输入进行运行时校验，尤其是路径、URL、图片 data URL、批准模式和 provider 配置。

## Settings 与数据库

- settings 当前仍为单行 JSON，但读取必须经过 `normalizeSettings`，由 `schemaVersion` 补默认值并完成前向迁移。业务模块不要自行用可选链实现迁移。
- 配置变更比较使用语义比较：对象 key 顺序和配置列表展示顺序不应触发重连；`args` 等本身有序的嵌套数组保持顺序语义。
- SQLite schema 只能通过 `src/main/store/migrations.ts` 的单调版本迁移。每个版本必须事务执行、可从旧库升级、对新库可重复建立最终结构。
- 禁止在普通 repository 函数里临时执行 `PRAGMA table_info` 或 `ALTER TABLE`。
- 修改 schema 时至少测试“空数据库升级”和“上一版结构升级”；涉及数据转换时验证关键数据保留。
- repository 返回的对象不得允许调用方意外修改缓存；读取设置返回副本，保存时归一化后再更新缓存。

## Renderer 状态

- Zustand 可以有一个最终 store，但新增状态按 `session/messages`、`agent runtime`、`settings draft`、`UI preferences` 等 slice 组织；跨 slice 动作保持少量且显式。
- Agent IPC 事件归并逻辑应是可测试的 reducer/adapter，不继续堆进 `App.tsx`。
- 高频 token 只批量刷新目标消息；结构事件先 flush。消息查找只按权威 ID，不使用位置猜测。
- DB 是完整历史权威来源；renderer cache 是投影。complete/error/abort 后允许重拉校准，但不能依赖重拉来修复日常 ID 冲突。

## 文件和代码规模

- 文件以单一变化原因划分。runner 只保留循环编排；工具执行、恢复策略、上下文状态、持久化回调分别放置。
- 新函数建议不超过 80 行；超过 120 行必须拆分状态或用例。新文件建议不超过 350 行；现有大文件每次相关修改应缩小而不是继续增长。
- 公共类型只有在确实跨边界时放 `shared/types.ts`；模块内部类型与实现同目录。
- 删除无调用者的接口、转导出和兼容入口前先用 `rg` 验证。确需兼容时写明移除条件并加边界测试。
- 注释解释不变量、原因和失败模式，不复述代码。不要以“方便”为由创建符号的第二个导出位置。

## 验证流程

改动前先运行并记录基线；改动后至少执行：

```powershell
npm test
npm run build
```

按风险追加验证：

- Agent 循环：合法 tool-call 序列、中止、权限拒绝、length/空响应恢复、hard stop。
- 工具协议：纯文本兼容、结构化图片、`isError`、附件不进入持久化文本。
- 消息协议：多会话交错事件、start 先于 token、完成后与 DB 记录 ID 一致。
- 数据库：fresh + legacy migration，settings 默认值与缓存失效。
- IPC：启动失败不留下伪持久化消息，同一 session 防重入，不同 session 可并行。

测试失败时先确定是既有基线还是本次回归。不得删除测试、放宽断言、吞异常或只改快照来获得绿色结果。Office 测试出现 pdf.js `standardFontDataUrl` warning 是已知非失败警告；若变为错误再处理。

## 修改工作流

1. 用 `rg` 找到调用者、事件消费者和持久化边界，先写出需要保持的不变量。
2. 先提取纯函数/接口并补测试，再移动副作用代码；避免同时重写协议和 UI。
3. 兼容迁移采用“边界归一化”：旧格式只在一个入口转换，核心逻辑只处理新格式。
4. 每个批次运行相关测试；结束时运行完整测试和生产构建。
5. 不顺手修改无关用户代码，不执行破坏性 Git 命令，不提交或推送，除非用户明确要求。
