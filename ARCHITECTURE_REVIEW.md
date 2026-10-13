# 新版架构与工程规范审查

审查日期：2026-10-13。审查版本：`fcaf736`，包含新版流程图、可移动面板、provider 并发控制与单文件子任务协作。依据为 `AGENTS.md`、`ARCHITECTURE.md` 和当前实现。

本次没有修改运行代码。复现脚本和验证日志保存在 `.temp/`，下面区分已复现缺陷、工程债务和已经符合规范的设计。

## 结论

新版的总体方向可以保留。流程图仍是权威消息的展示投影，独立窗口没有另建 Agent 系统，子任务通过 SessionService 运行，权限仍归 PermissionBroker。当前问题集中在新旧协议边界、异步资源生命周期和依赖装配，适合分批重构。

需要优先处理三项已复现的问题：大批子结果丢失汇合信息、后台补全占住共享 provider 额度、同一面板重复开窗及迟到开窗覆盖停靠选择。

## 1. P1：大批子任务结果使汇合信息消失

代码位置：[history.ts](./src/renderer/src/flow/history.ts:30)、[subagentScope.ts](./src/main/agent/subagentScope.ts:172)、[subagent.ts](./src/main/tools/subagent.ts:11)、[buildGraph.ts](./src/renderer/src/flow/buildGraph.ts:86)。

`wait_subagents` 可以返回任意数量的当前运行任务，每个回复最多 12,000 字符。但是 renderer 的 `decodeTaskReferences` 遇到超过 150,000 字符的整个工具结果时，直接返回空数组。

复现结果：13 个已完成任务，每个回复 12,000 字符，整个结果为 157,346 字符。图中有 13 条派工分支、0 条结果汇合线。相同数据的前 12 项可以正常解码。这不是消息丢失，而是显示投影误丢了可验证的任务关系。

问题在于工具的正文体积决定了执行拓扑是否存在。取消固定任务数量限制之后，旧解码假设不再成立。

保留功能的重构方式：

1. 在 `shared/subagents.ts` 建立唯一的任务引用 DTO、状态枚举和运行时校验。现在 main 的 `SubagentTaskResult` 与 renderer 的 `TaskReference` 各自声明跨边界形状，应统一契约。
2. 将小型拓扑引用与完整回复正文分离。任务 ID、子会话 ID、状态与具体工具调用关联不应因 reply 长度而一起消失。完整正文仍进入原历史和详情，LLM 工具序列不变。
3. 先建立兼容旧 JSON 历史的单一解码适配器，再加入新格式生产者，最后切换 renderer 消费。不要同时重写执行协议和整套 UI。
4. 如需新增持久化字段，通过单调 SQLite migration 完成，并验证 fresh / legacy 数据升级。不能在普通 repository 中临时补列。

验收：覆盖超过旧解码边界的结果，验证派工与对应的实际终态 wait 仍有精确关联。数量不再受额外固定上限约束，running 快照不能伪装成汇合，完整历史保持不变。

## 2. P1：后台非流式补全能够长期阻塞同一 provider

代码位置：[provider.ts](./src/main/llm/provider.ts:276)、[requestRuntime.ts](./src/main/llm/requestRuntime.ts:9)、[titleService.ts](./src/main/agent/titleService.ts:46)、[sessionService.ts](./src/main/agent/sessionService.ts:350)。

流式请求有应用级空闲超时；`complete` 没有对应的响应 / 响应体超时。标题生成等后台调用没有传入取消信号。共享并发限制引入后，后台补全可以占住一个 provider 请求额度，而停止后续主任务无法取消这个后台请求。

复现使用真实 `complete` 适配器和未结束的模拟响应体：provider 上限为 1，后台标题请求占住额度，主任务请求没有发到网络；取消主任务只取消它的排队，后台请求仍占用额度。后台响应体结束后，后续请求才能继续。

这不是限流队列算法失效，而是拥有共享资源的请求缺少可靠的结束边界。真实网络的传输层可能自行超时，但应用没有明确保证，不能用它代替资源生命周期设计。

保留功能的重构方式：

- 给非流式 HTTP 尝试建立明确的应用级响应 / 响应体超时，并将调用者 signal 与超时 signal 合并。超时预算限制请求生命周期，不限制子 Agent 数量。
- 后台标题、记忆提取使用有明确 owner 的取消信号，支持删除、退出等生命周期清理。该 owner 只管理辅助请求，不拥有第二套 Agent 会话或控制器。
- 继续保证流式正文读取结束后才释放额度、网络退避不占额度、已取消排队不发送网络请求。
- 所有请求继续共享保存的 provider 上限。不要给后台调用绕过额度，也不要引入另一个固定子任务上限。

验收：在 provider 上限为 1 时，让辅助响应卡住，确认超时后释放额度且主任务继续；同时覆盖响应体卡住、取消、失败、退出和动态修改上限。

## 3. P2：开窗与停靠缺少统一的异步生命周期

代码位置：[usePanelWindows.ts](./src/renderer/src/docking/usePanelWindows.ts:33)、[DockWorkspace.tsx](./src/renderer/src/docking/DockWorkspace.tsx:22)。

`open` 只检查已经创建的 portal，没有登记“正在打开”的请求。在 `prepare` 返回前，第二次点击仍然可以发出另一个请求。`DockWorkspace` 在任意开窗 Promise 完成后又无条件把布局设为 window，没有判断用户是否已经选择了新的布局。

真实隐藏 Electron 窗口复现结果：

- 延迟 prepare，同时打开同一个详情面板两次，创建了 2 个原生窗口，其中只有 1 个承载详情，另一个为空窗口。
- 延迟 prepare，先请求独立窗口，再选择停靠左侧。迟到的 prepare 返回后，面板仍然进入独立窗口，覆盖了较新的用户选择。

保留功能的重构方式：

- 为每个 panelId 建立一个工作区内的状态机：docked / floating / opening / detached / closing。可以用纯 reducer 实现，不新增全局 Agent 状态。
- 每个开窗请求有 generation 或 operationId。同面板的在途开窗去重，停靠、关闭、卸载使旧 generation 失效。
- 迟到响应不能提交布局。如果旧请求已经创建了窗口，需要显式回收该窗口和票据。
- 布局与 portal 不再分别无条件写入。开窗成功、开窗失败、窗口关闭等事件通过同一状态转移提交。

验收：快速双击只创建一个窗口；开窗期间停靠以最后选择为准；关闭、切换会话或卸载后没有残留窗口；草稿、附件、主题、缩放和选中详情保持原有行为。

## 4. P2 工程债务：Provider 的依赖装配不完整

代码位置：[requestRuntime.ts](./src/main/llm/requestRuntime.ts:7)、[composition.ts](./src/main/composition.ts:58)、[runner.ts](./src/main/agent/runner.ts:15)。

`ProviderRequestConcurrency` 内部状态已经封装为类，有取消与 dispose，这部分符合 owner 原则。但生产请求仍使用 import 时创建的进程实例，`withProviderRequest` 自行读取数据库设置，组合根只是返回这个既有实例。Runner、压缩、记忆等路径仍通过具体模块导入 LLM 实现，只有部分补全由应用层注入。

这不能简单说成“新增了裸露可变 Map”：Map 有 owner，适配器也允许管理自身状态。实际不足在于生产 LLM 客户端无法按应用实例完整装配、替换和测试隔离。测试需要模块 loader 替换配置与网络模块；实例 dispose 后也没有组合根创建新实例的正常路径。

建议将其重构为 `createProviderClient({ getProviderSettings, getFetch, requestGate })` 或等价的类接口。由组合根构造 gate 与 client，stream / complete / 辅助补全共用它，并通过显式依赖进入 Runner、压缩和记忆用例。初始化失败在组合根暴露，不添加全局 setter 或迟到初始化回退。

会话运行 owner 继续是 SessionService，provider 客户端只拥有网络请求资源。

## 5. P2 性能债务：隐藏子分支仍订阅完整历史

代码位置：[useFlowGraph.ts](./src/renderer/src/flow/useFlowGraph.ts:18)、[graphLayout.ts](./src/renderer/src/flow/graphLayout.ts:25)。

`showChildren=false` 只影响图的展开结果，没有进入需要加载历史的子会话 ID 集合。隐藏子分支仍然加载、订阅完整子历史，子消息变化仍能触发整个图的投影与布局。

布局又对每条泳道重复扫描全部节点查找成员。存在 B 条泳道、N 个节点时，这部分扫描随 B×N 增长。当前只渲染可见节点有助于降低 DOM 成本，但不能减少已经发生的整图计算。这里确认的是代码路径和复杂度，没有声称测得具体卡顿阈值。

保留功能的重构方式：

- 分离“任务摘要所需订阅”和“已展开历史所需订阅”。隐藏分支仍保留准确的任务状态与引用，只有展开时加载完整历史。
- 一次建立 `taskId → 节点集合`、`nodeId → 节点` 索引，复用到布局与连接处理。
- 将结构变化与正文增量区分。仅正文变化时更新目标节点预览和必要测量，避免重复解码所有派工历史；节点边界或尺寸变化时再做相应布局。
- 所有缓存都限定在当前工作区实例，说明 key、失效条件与清理方式，不把缓存变成新的事实来源。

验收需要增加多分支流式输出场景，并确认隐藏分支不会触发不必要的完整历史加载或整图计算。性能改造不能省略原始工具结果、修改消息 ID 或影响分叉 / 汇合语义。

## 6. 工程规范债务：大文件继续增长，检查门禁不完整

代码位置：[sessionService.ts](./src/main/agent/sessionService.ts:48)、[store/index.ts](./src/renderer/src/store/index.ts:257)、[runner.ts](./src/main/agent/runner.ts:85)、[package.json](./package.json:15)。

当前 SessionService 为 410 行，本次相关提交又净增加了 2 行，未遵循“现有大文件相关修改应缩小”的约束。Renderer store 为 676 行，其中 store 创建回调覆盖 419 行；`runAgent` 为 138 行，超过规范中必须拆分的 120 行函数边界。后两项属于已有技术债，不应全部归因于新版 UI。

建议：

- SessionService 保留 active map、AbortController、approve mode 和运行 / 删除 / 退出编排。提取运行准备、选项构建、子任务 host 装配等协作者，禁止让协作者再持有一套 active sessions。
- Renderer 保留一个最终 Zustand store，拆成 session/messages、agent runtime、settings draft、UI preferences 等 slice。消息读取的在途去重归 store 实例管理，既有 reducer 和权威 ID 归并继续复用。
- Runner 提取单轮编排或收尾用例，恢复预算与工具合法序列继续使用原有策略，不通过重构改变恢复次数和终止原因。

本次验证：`npm test`、`npm run build` 通过，renderer TypeScript 检查通过。Main TypeScript 检查仍有 12 条错误，涉及恢复原因类型、Notification、mainWindow 空值和对话框 parent 类型。这些是现存问题，并非本次只读审查引入；最后一次功能提交没有修改其中的恢复原因和通知实现。

`npm run build` 没有执行完整 TypeScript 类型检查，所以构建成功不足以说明类型契约全部正确。建议先修正现存类型错误，再把 main / renderer typecheck 纳入正式检查；面板和镜头 UI 测试也应有可重复的自动运行入口，不能仅靠普通 npm test 覆盖。

另外，当前中英文 README 链接到 `docs/VISION.md` 与 `docs/PROMOTION.md`，但这两个目标在当前 checkout 中均不存在，Git 也没有跟踪 docs 内文件。这是可直接确认的文档交付问题。应恢复需要随项目交付的文档及素材，或改为可用的实际发布地址，并把 README 的本地链接检查加入发布验证。本次不推测文件缺失的原因，也没有修改这些链接或恢复可能由维护者移除的文件。

## 已经符合规范、应保留的设计

- 对话图由主进程权威消息、任务结果和子会话关系生成，图 key 的编码不改变原始消息 ID。
- 折叠与上下文压缩没有删除完整历史，图没有成为第二份持久化会话事实。
- 子 Agent 通过 SessionService 创建 / 运行，父 scope 只拥有任务引用和状态投影，不复制控制器或执行器。
- 文件派工持有到子运行实际 settle，路径规范化能防止常见 Windows 大小写 / 相对路径重复认领。
- 权限仍经过 PermissionBroker，委托没有裁剪完整工具注册表。
- 独立面板是同一 React 树的 portal，复用 store、主题和事件订阅，不启动第二个 App。
- 原生开窗票据与控制接口校验 owner，不开放任意 BrowserWindow 控制。辅助窗口安全选项与当前主窗口一致，本次没有发现新增 Node 权限。
- Provider 额度按 provider ID 隔离，流式响应占用到读取结束，排队取消、动态修改上限和释放采用已有统一适配器。

单文件派工目前是协作契约，浏览器和桌面也仍然共享。这是已声明的能力边界，不能误报成“代码保证了文件系统隔离”；本次不建议通过隐藏工具、增加另一套权限系统或加全局 Agent 锁来制造隔离。

## 建议实施顺序

1. **先固定缺陷边界**：把三个复现转为正式回归测试，修复结果引用丢失、辅助请求结束边界和面板开窗竞态。保持 provider 配置是唯一并发数量来源。
2. **再调整依赖与契约**：建立共享子任务 DTO 和兼容适配器，注入 ProviderClient，统一面板状态转移。每一批同步架构文档与相应测试。
3. **再拆分大文件和优化投影**：拆 store / 运行准备 / 单轮编排，按可见历史订阅，增加图索引与增量更新。不要同时重写消息协议和 UI。
4. **最后固化质量门禁**：清理现存 main 类型错误，加入类型检查及镜头 / 面板 / 输入区 UI 检查。重新验证同会话互斥、跨会话并行、权限、中止、完整历史、退出清理和原生窗口生命周期。

重构完成后，现有流程图、嵌套步骤、任务分叉 / 汇合、深浅主题、移动 / 停靠 / 独立窗口、最新输出滚动、自定义缩放跟随和 provider 并发配置均应继续保留。
