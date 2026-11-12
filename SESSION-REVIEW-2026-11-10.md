# Zhumora 会话部分代码审查报告（2026-11-10）

审查范围：`src/main/agent/`（SessionService 及全部 session* 周边、runner、persistedCallbacks、history/messageMapper、permissionBroker、subagentScope/taskProtocol）、`src/main/ipc/`、`src/main/bot/`、`src/main/store/`、`src/main/composition.ts`、`src/main/index.ts`（窗口生命周期）、`src/main/shutdown.ts`、`src/main/mcpServer/service.ts`、`src/preload/index.ts`、`src/renderer/src/`（store/agentEvents/App/模型偏好）。

方法：对照 `AGENTS.md` / `ARCHITECTURE.md` 的强制不变量逐条核查 + 三路并行精读（主进程核心、renderer 状态归并、IPC/Bot/store 边界）；所有 P0/P1 结论均经主代理逐条复核行号属实。未修改任何代码。

测试基线：会话相关 27 个测试文件全部通过（sessionService / subagents / history / permission / persistedCallbacks / migrations / botInfrastructure / compaction / turnDecision 等）。`npm test` 整体在 `toolOutputIntegration.test.ts` 失败于 `spawn EPERM`——为 DSH 沙箱对 piped-stdio spawn 的已知边界，非代码回归；正式修复后请在普通终端复跑 `npm test` 与 `npm run build`。

---

## P0 —— 违反架构不变量 / 数据正确性

### P0-1 主进程：窗口引用生命周期缺陷 + 事件 sink 无异常隔离，可把会话永久钉死为 busy、挂死删除与退出

这是一条组合链，单独看每处都可解释，叠加后破坏 §6 的"有界 settle"和 AGENTS.md"事件发送使用可更新的窗口引用"：

1. **引用冻结**：`src/main/ipc/index.ts:16-28` 在启动时一次性把 `win.webContents` 固化进 `createIpcAgentEventSink`（`src/main/ipc/agentCallbacks.ts:9-54`，事件 sink 全部 `sender.send(...)` 无 `isDestroyed()` 守卫；同文件的 permission presenter 反而有守卫，说明是 sink 漏写）。而 `src/main/index.ts:40`（second-instance）与 `:210`（activate）在窗口销毁后会 `createWindow()` 但不重跑 `setupIpc` → 重建窗口收不到任何 Agent 事件，旧 sink 永远挂在 `SessionEventHub` 上。`src/main/ipc/registerGeneralIpc.ts:29-38` 的 `window:*` handler 与 maximize 监听同样绑死旧窗口实例。
2. **无错误隔离**：`src/main/agent/persistedCallbacks.ts:31-53`（`combineAgentEventSinks`）与 `src/main/agent/sessionEventHub.ts:18-20`（`publish`）都用 forEach 顺序裸调用，任一 sink 抛错（典型：destroyed webContents 上 `send` 抛 `Object has been destroyed`）→ 后续 sink（含 Avatar/TTS/`desktopControl.release`）被跳过，异常回灌 run 路径。
3. **回灌落点**：
   - `sessionService.ts:104-108`：`active.set` → `createSubagentScope` → `linkExternalSignal` → `events.running(true)` 全部在第 110 行 `try` 之外。108 抛错 = active 表已写入但永不 `cleanupRun` → 该 sessionId **永久 SessionBusyError**，AbortController/监听泄漏。
   - `sessionService.ts:404-415`（`cleanupRun`）：412 `events.running(false)` 抛 → 413 `publishRunOutcome` 与 414 `run.settle()` 被跳过，而 406 已清掉兜底 timer → `deleteSession` 的 `await run.settled`（:248）与 `stopAll`（:257）**永久挂起**（退出仅剩 shutdown step 3s 超时兜底）；`desktopControl.release` 不执行 → 桌面控制独占不释放。
   - `sessionService.ts:392-400`（`abortRun`）：393 先置 `abortNotified=true`，394 `events.aborted` 抛 → 397-400 的 2s 强制 settle 兜底**永远不会 arm**，且后续 abort 因 `abortNotified` 不再重试。§6"有界 settle"整体失效。

**修法**（同一批次完成）：sink/presenter 不捕获 `WebContents` 而捕获 `() => BrowserWindow | null` getter + `isDestroyed()` 守卫（项目内已有正确范式：`src/main/tts/manager.ts`、`src/main/store/settingsBus.ts`）；`window:*` handler 走同一可变引用；`combineAgentEventSinks`/`SessionEventHub.publish` 逐 sink try/catch + log；`sessionService` 把 `active.set` 之后整段移入 try→`cleanupRun` 后再 rethrow；`cleanupRun` 把 `run.settle()` 放入 finally。补"窗口重建后事件仍达""单 sink 抛错不影响其余 sink 与 settle"回归测试。

### P0-2 renderer：thinking 占位按状态查找——被明令禁止的"位置/状态猜测"，可致历史错序与同 ID 双份

`src/renderer/src/agentEvents.ts:69` `applyAssistantStart` 用 `findIndex(x => x.status === 'thinking')` 替换占位，且 **ID 存在性检查在第 83 行、位于占位分支之后**；`agentEvents.ts:147` `applyToolCallEvent` 用 `filter(x => x.status !== 'thinking')` 全量清除占位。数组同时存在两个 thinking 时（触发路径见 P0-3），第 2 轮 `start(M2)` 命中**更早**的占位，把 M2 插到 M1 之前（顺序错乱）；messageId 已存在时产生两条同权威 ID 消息，后续 `findIndex` 只命中第一条，内容分裂。直接违反 AGENTS.md"消息查找只按权威 ID"与 ARCHITECTURE §11"禁止用最后一条消息推断"。

### P0-3 renderer：同会话互斥是乐观异步守卫 + 失败分支按 status 回滚

`src/renderer/src/store/index.ts:465` 仅靠 `runningIds.has(sid)`（由 main 事件驱动）拦截重入，而加占位（:486）与 invoke（:499）之间还夹着 `await waitForSessionModelSelection`——双击/连击窗口内两次 `agent:run` 都发往 main；第二次拿到 busy `{error}` 后，`:506`（及 catch 分支 `:535`）`filter(m => m.status !== 'thinking')` 会删掉该会话**全部** thinking 占位——包括第一次合法运行的占位；同时第二次的 `pending-user-*` 行无人替换，作为假 ID 留在缓存。违反不变量 1（pending 恰好一次原位替换）与 §6 同会话互斥的 UI 配套。

**P0-2/P0-3 统一修法**：store 增加 per-session 显式槽位 `runSlots: { [sid]: { pendingUserId, thinkingId } }` + 同步发送锁（加占位前置检查、finally 释放）；`applyAssistantStart` 增加显式 `thinkingId` 参数并先做 ID 幂等检查；所有失败路径按 ID 精确回滚，禁止按 status 过滤。该收敛一次消灭 P0-2、P0-3 与 P1-8。

---

## P1 —— 竞态 / 边界缺陷

| # | 位置 | 问题 |
|---|---|---|
| P1-1 | `src/main/agent/sessionService.ts:286-295` | `compact()` 只查 `isRunning` 不查删除门（`deletions.has`）。手动压缩（含 LLM 摘要，秒级）期间删除会话 → 摘要白做、`setSessionCompaction` 撞 FK 报错。修法：入口查门 + 持久化前复查 |
| P1-2 | `src/main/ipc/index.ts:34-74`、`sessionService.ts:323` | renderer 输入零校验：`approveMode`/`reasoningEffort` 不校验枚举（非法值靠 `decidePermission` 默认分支侥幸 fail-safe）；图片仅 `startsWith('data:image/')`，无 MIME 白名单与体积上限（Bot 侧反而有界：telegram 4×20MB）；`text` 非字符串延迟到 better-sqlite3 bind 才炸。违反 AGENTS"对 renderer 输入运行时校验：…批准模式、图片 data URL" |
| P1-3 | `src/main/ipc/registerGeneralIpc.ts:138-141` | `shell:openExternal` 把 renderer 任意字符串交给 `shell.openExternal`，绕过唯一导航判定点 `navigationPolicy.decideNavigation`；可开 `file:`/UNC/任意注册协议（Windows 提权面）。应复用 `decideNavigation` 或 http(s)+mailto 白名单 |
| P1-4 | `src/main/store/db.ts:166-179` | `getOrCreateBotSession` existing 分支投影缺 `modelSelection`/`subagent`（`getSession` :93-94 有）。它是 `resolveExternalSession` 实现，调用方一旦拿返回值走 `resolveSessionModel` 会静默丢会话模型偏好回落全局。抽 `rowToSession` 共用 + 一致性测试 |
| P1-5 | `src/main/store/messageRows.ts:21` | `tool_calls` 的 `JSON.parse` 无兜底（同文件 images/output_ref/generation 都有 try/catch）。单行损坏让该会话的 `session:messages`、`getMessages`、runner 历史构建整体抛错 → 会话彻底不可用 |
| P1-6 | `src/main/mcpServer/service.ts:44,182-215` | MCP 入站 `Conversation` 缓存 `sessionKey` 第二份 external→session 映射（§3 明令禁止）；生产路径仍每轮 `resolveExternalSession`，`resolveSessionId` 仅测试使用，且会话删除后缓存指向已删 id。删访问器或改现解 |
| P1-7 | `src/renderer/src/App.tsx:181-184,208-219` + `agentEvents.ts:194` | 会话缓存不存在时 `assistantStart`/token/reasoning 静默丢弃：打开正在运行的会话，`loadMessages` 只拿到已落库行，当前轮流式内容整段不可见，直到 end/complete 才"跳出"完整回复。不变量无违反（不串会话）但"UI 是投影"失去自愈入口。修法：`agent:running` 携带当前轮权威 messageId 或加载后向 main 要一轮快照 |
| P1-8 | `src/renderer/src/store/sessionModelSlice.ts:35-37` → `store/index.ts:491,533-550` | `waitForSessionModelSelection` await 的 write promise 会 reject：上一次模型保存失败 → 本次发送**未达 main** 就落入 catch，留下永不收敛的 `pending-user-*` 行 + 与本次操作无关的错误气泡。wait 应吞掉写失败（发送前的保存失败另行明确提示并回滚占位） |
| P1-9 | `src/renderer/src/store/index.ts:394` + `agentEvents.ts:35` + `:322-323/:557` | 历史校准"保留活动消息"只看 settle 时刻的会话级 `runningIds`，且 `deleteSession`/`abortAgent` 乐观 `markRunning(false)` 放大窗口 → abort 后迟到的 force 重拉会把读取期间新出现的 streaming/thinking 行丢弃。改为消息级判据；去掉乐观清零（main 的 running:false 必达） |
| P1-10 | `App.tsx:261/270/282` → `store/index.ts:385-401` | 已删会话的迟到 complete/error/aborted 触发 `loadMessages(deletedId)`：不校验会话存在性，把 `messages[deletedId]=[]` 写回（此后 `setActiveSession` 缓存命中判据永久失效）；IPC reject 时是 unhandled rejection。入口加存在性校验，`void` 调用补 catch |
| P1-11 | `src/preload/index.ts:142` + `App.tsx:244` + `persistedCallbacks.ts:14,148` | `tool_call` 事件 `messageId: string | null`，null 时 renderer 直接丢事件（工具调用在 end 前 UI 不可见），与"assistant/tool 事件带 main 分配的 messageId"契约冲突；`persistedCallbacks.ts:148` 还可能发出**空串 messageId** 的 assistantEnd（当前恰好 no-op）。类型收紧非空或由 sink 不发 |
| P1-12 | `store/index.ts:220,564-577` + `App.tsx:313-317` | `permissionRequests` 按 sessionId 单槽（同会话并发请求会被覆盖且 UI 无法裁决，当前工具串行才未触发）；`respondPermission(allowed)` 不带 permId，靠 `permId.localeCompare` 猜最早——`generateId()` 同毫秒内随机，排序假设不严格成立，可能裁决错请求。改 `Record<sessionId, PermissionRequest[]>` + 指名 permId |
| P1-13 | `src/main/store/db.ts:68,93` + `src/shared/sessionModel.ts:9,13` | `model_selection` 读路径无归一化：`validateSessionModelSelection(JSON.parse(raw))` 对非法形状是 **throw**，两个调用点都无 try/catch。一行坏数据 → `getSessions` throw → `session:list` 整体失败（侧边栏全挂，不只该会话）；`getSession` 被发消息/手动压缩/托盘标题共用 → 该会话既不能发也不能压。违反 AGENTS"边界归一化：旧格式只在一个入口转换"。写侧有校验，触发源是旧版本遗留/外部改库。修法：`readModelSelection(raw)` try/catch 返回 null + warn（同 `readGeneration` 风格），migrations 测试加坏 JSON fixture |

---

## P2 —— 质量 / 一致性（按修复价值排序）

1. `App.tsx:41-44` token 批缓冲是裸露模块级可变 Map/Set + 定时器（违反 AGENTS"禁止新增裸露的模块级可变 Map"精神）；`App.tsx` 事件接线（flush 顺序、complete 校准、多会话交错）**零测试覆盖**，`agentEvents.test.ts` 只测纯 reducer。
2. `preload/index.ts` `any` 扩散 13+ 处（事件载荷 `data: any`、`toolCall: any`、`mcp.connect(config: any)` 等）；事件载荷形状在 main/preload/App 三处内联，仅 `AgentToolResultEvent`/`AgentRetryEvent` 走 shared——main 改字段不会编译报错。建议 `shared/agentEvents.ts` 定义 `AgentIpcEventMap`。
3. `src/renderer/src/store/index.ts` 676 行、`sendMessage` ~96 行、`registerGeneralIpc.ts` 单函数 212 行混合六个变化原因——均超 AGENTS 80 行线；错误气泡逻辑与"退出运行态"语义各复制 2-3 份。
4. 删除会话 renderer 键清理不完整（store:335-346 不删 `retryStatus`/`compactNotices`/`truncatedNotices`/`loadingMessages` 残留）；`thinking-*`/`err-*` 是规范外的第三/四套临时 ID 命名空间且同毫秒可碰撞。
5. `agentEvents.ts:41` 用 `>=`、`:30`/`:115` 用 `>`——revision 比较三处不一致；`sessionService` 协调 user 消息只落库不广播（:144-145），renderer 重拉前后顺序跳变。
6. `store/index.ts:438-447` `setApproveMode` 只发给 active 会话，后台会话保留旧模式而 UI 恒显示全局值。
7. `settingsNormalization.ts:91-119` `...raw` 未收敛：`maxRounds` 直传（超大值等价削弱 hard stop）、`mcpServers`/`skills` 只 `Array.isArray`、providers 非对象元素原样保留。
8. `shutdown.ts` 顺序与文档措辞偏离（`begin()` 里就 `sessions.beginShutdown()`，step3 再调一次靠幂等；step 名 `sessions` 调的是 beginShutdown）；行为可接受，代码与文档需同批对齐。
9. `session:delete`（registerGeneralIpc:45-50）前置 `avatar.hide`/`tts.stop` 非原子；`approveModes` 可对不存在的 sessionId 写入仅 forgetSession 清理；invoke 错误面不统一（agent:* 返回 `{error}`、session:* reject）。
10. `db.ts` 10 处 `as any`；`memory:query` category 未校验；`mcp:connect` config 未校验即 stdio spawn。
11. `db.ts:143-148` `deleteSession` 三条 DELETE 未包事务（部分失败留孤儿行；migrations 有事务规范可对齐）；`db.ts:197-200 addMessage` 的 `insertMessage`+`touchSession` 同样非事务（SQLITE_BUSY 时留下"消息已写、updated_at 未推进"的排序偏移）。
12. `db.ts:207-217` `updateMessageGeneration`/`updateMessageContent` 按 `id` 全表更新无 `session_id` 约束，仅靠调用方 `isCurrent()` 守卫，存储层无兜底（建议 `WHERE id = ? AND session_id = ?`）；`db.ts:102-106 readSubagentProvenance` 三列缺任一即静默返回 undefined → 子会话隐藏投影失效且无日志（至少 warn）；`migrations.ts:148-153` v6 的 `CREATE INDEX` 无 `IF NOT EXISTS`、ALTER 无列判断，与 v2/v4/v5 防御风格不一致（当前靠 user_version 不可达，但拆版本发布即启动崩）；`messageRows.ts:40 readGeneration` 只校验 version/status，其余嵌套字段未经校验直出 renderer 强类型投影；热点路径 `prepare` 每次重建 + `SELECT *` 行形状与列顺序耦合。
13. 工作区噪音：`research/` 下有整套被 gitignore 的源码副本，会被 rg/审查命中。

---

## 已核实满足的关键不变量（抽样定心）

- **所有权**：`runAgent` 仅 `composition.ts:19,94` 注入、`SessionService` 消费；全仓无第二套 `activeSessions`/`abortControllers`；`approveModes` 唯一在 `SessionService`。§11 禁用的旧设计无复活。
- **双写禁止**：main 仅对 `external` 回推 `agent:user_message`；renderer 输入只靠 invoke 返回值经 `applyAuthoritativeUserMessage` 三分支原位替换一次（快运行先入快照的情形有测试锁定）。
- **事件协议**：全部事件带 sessionId；`ensureRoundId` 保证 start 先于首个 token 并重置轮缓存；结构事件处理前一律先 flush；token 缓冲按 `sessionId+messageId` 键控、按会话分组落 store。
- **Bot**：`BotMessageQueue` 只有 per-conversation FIFO + transport AbortController + generation；`/stop` 信号经 `linkExternalSignal` 连到目标 run；presenters 只展示+`respond` 唯一入口；QQ 入队前拦 `y/n` 防 FIFO 死锁。
- **并发/生命周期**：同 session 互斥（含删除门并发共享）、跨 session 并行、卡死 runner 2s 兜底、shutdown 幂等，均有 `sessionService.test.ts` 回归覆盖。
- **历史/压缩**：`sanitizeHistoryWithIds` 组内闭合、消息/ID 平行；压缩仅存 `{upToMessageId, summary}`，不触 messages 表。
- **store**：migrations 单调+每版事务+事务内 bump `user_version`，v6-v10（subagent_*/model_selection/coordination_*/generation/output_ref）与文档一致，`migrations.test.ts` 覆盖空库/v5/v6/v7/v9→最新/重复执行；repository 每次读构造新对象，`getSettings` 返回 `structuredClone`，settings 唯一写点 `saveSettings`（normalize→落库→刷缓存，写库失败不污染缓存），`settingsBus` 广播"请重拉"信号而非内容；settings 语义比较（key 排序递归、列表按 id、args 保序）实现正确。
- **模型偏好**：renderer 按会话串行保存 + 判等释放 + 失败反馈，`sessionModel.test.ts` 覆盖。

## 建议修复顺序

1. **P0-1**（窗口 getter 引用 + sink 隔离 + sessionService 启动段/cleanupRun 防护，一次变更）+ 回归测试。
2. **P0-2/P0-3**（renderer `runSlots` + 同步发送锁 + 按 ID 回滚，顺带解决 P1-8）。
3. **P1-2/P1-3**（renderer 输入边界校验：`validateAgentRunRequest` 纯函数 + `decideNavigation` 复用）。
4. P1-1/4/5/13（compact 删除门、Bot session 投影、messageRows 兜底、model_selection 读归一化——后三条同属"存储读路径边界归一化"，一批做）。
5. P1-7/9/10/11/12（renderer 竞态组）。
6. P2 清单按机会性收敛（每次相关改动缩小一处）。
