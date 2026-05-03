# AgentOS PRD

## 1. 背景

AgentOS 是一套面向多 Agent 协作的运行时框架。它借鉴操作系统的核心抽象，把 Agent 看作受管进程，把多 Agent 协作看作进程与线程调度问题，把 tool use 看作系统调用，把 context window 看作 cache，把 RAG 看作文件系统挂载，把 harness / orchestrator 看作内核与调度器。

本项目目标不是简单制造一个 Agent workflow 工具，而是建立一套可调度、可审计、可扩展、可回放的 Agent 原生操作系统框架。

## 2. 产品目标

AgentOS 需要解决以下问题：

- 多 Agent 任务如何被创建、调度、通信、终止。
- Agent 如何安全、统一、可审计地调用工具。
- 上下文窗口如何被当作有限 cache 管理，而不是简单拼接聊天记录。
- RAG 如何以统一文件系统挂载方式接入不同知识源。
- Orchestrator 如何承担内核职责，管理权限、资源、事件、执行生命周期。
- 整个系统如何支持调试、回放、成本分析和行为审计。

## 3. 核心类比模型

| 操作系统概念 | AgentOS 映射 | 说明 |
|---|---|---|
| Process | Agent 实例 | 独立身份、权限、状态、生命周期 |
| Thread | Agent 的一次任务执行 / 对话分支 | 共享 Agent 配置，拥有独立上下文和执行栈 |
| Kernel | Harness / Orchestrator | 调度、权限、工具调用、上下文装配、审计 |
| Syscall | Tool Use | 统一工具接口、权限校验、参数校验、结果返回 |
| File System | RAG / Knowledge Mount | 文档、记忆、代码库、数据库的统一挂载层 |
| Cache | Context Window | Prompt 装配、短期记忆、摘要、检索结果缓存 |
| IPC | Agent 间通信 | 消息队列、事件总线、共享黑板、RPC |
| Scheduler | 任务调度器 | 优先级、依赖、预算、超时、重试、并发控制 |

## 4. 用户与使用场景

### 4.1 目标用户

- AI 应用开发者。
- 多 Agent 系统研究者。
- 自动化工作流平台开发者。
- 企业内部 Agent 平台团队。
- 需要可观测、可控、可审计 Agent 系统的工程团队。

### 4.2 典型场景

- 使用 Planner / Executor / Reviewer 多 Agent 协作完成代码任务。
- 使用多个研究 Agent 并行检索资料，再由 Synthesizer 汇总。
- 把本地代码库、项目文档、长期记忆挂载为统一知识空间。
- 对所有工具调用进行权限控制和审计。
- 回放一次 Agent 失败执行，定位上下文、工具或调度问题。
- 在 token、时间、工具调用次数受限时执行复杂任务。

## 5. 核心模块

### 5.1 Agent Process Manager

Agent Process Manager 负责 Agent 定义注册与运行时进程管理。

核心能力：

- 注册 AgentSpec。
- 创建 AgentProcess。
- 创建 AgentThread。
- 管理状态：idle、running、blocked、failed、terminated。
- 管理 Agent mailbox。
- 管理 Agent 运行预算。
- 支持暂停、恢复、终止。

建议数据结构：

```ts
type AgentSpec = {
  id: string
  name: string
  role: string
  systemPrompt: string
  tools: string[]
  memoryPolicy: MemoryPolicy
  permissions: Capability[]
  inputSchema?: JSONSchema
  outputSchema?: JSONSchema
}

type AgentProcess = {
  pid: string
  specId: string
  status: "idle" | "running" | "blocked" | "failed" | "terminated"
  mailbox: Message[]
  contextState: ContextState
  budget: {
    maxTokens: number
    maxToolCalls: number
    deadlineMs?: number
  }
}
```

### 5.2 Kernel / Orchestrator

Kernel 是 AgentOS 的中枢。所有工具调用、上下文装配、权限校验、调度决策都必须经过 Kernel。

模块组成：

```text
AgentOS Kernel
├─ Agent Registry
├─ Process Manager
├─ Scheduler
├─ Context Manager
├─ Tool Dispatcher
├─ Memory Manager
├─ RAG FileSystem
├─ Permission Manager
├─ Event Log
└─ Runtime Adapter
```

设计原则：

- Agent 不能直接调用工具，必须通过 Tool Dispatcher。
- Agent 不能直接读取全部记忆，必须通过 Context Manager。
- Agent 不能绕过权限访问文件、网络或数据库。
- Kernel 负责记录所有关键执行事件。

### 5.3 Tool Dispatcher / Syscall Layer

Tool use 在 AgentOS 中被视为 syscall。

核心能力：

- 工具注册。
- 参数 schema 校验。
- 权限检查。
- 副作用分级。
- 超时控制。
- 结果结构化。
- 调用审计。
- 支持异步任务。

建议数据结构：

```ts
type ToolManifest = {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema: JSONSchema
  permissions: Capability[]
  sideEffects: "none" | "read" | "write" | "network" | "destructive"
  timeoutMs: number
}

type SyscallRequest = {
  pid: string
  syscall: string
  args: unknown
  reason?: string
}

type SyscallResult = {
  ok: boolean
  data?: unknown
  error?: {
    code: string
    message: string
  }
  cost?: {
    timeMs: number
    tokens?: number
  }
}
```

权限要求：

- 只读工具默认风险较低。
- 写入工具必须声明写入范围。
- 网络工具必须声明域名或资源边界。
- 破坏性工具必须支持人工审批或更高权限。

### 5.4 Context Manager / Cache Layer

Context window 被抽象为 cache，而不是聊天记录容器。

上下文分层：

```text
L0: Immediate Prompt
    当前用户输入、当前任务、系统指令

L1: Working Context
    最近消息、当前 scratchpad、任务状态

L2: Summarized Memory
    会话摘要、项目摘要、Agent 自身状态

L3: Retrieved Memory
    RAG 检索结果、文件片段、代码片段、历史案例

L4: Durable Store
    数据库、文件系统、向量库、事件日志
```

核心能力：

- 根据任务编译 prompt。
- 按 token budget 选择上下文片段。
- 对历史对话和任务状态进行摘要。
- 对低优先级上下文进行淘汰。
- 将关键结果写回长期记忆。
- 记录 prompt 由哪些上下文片段组成。

建议接口：

```ts
type ContextManager = {
  buildPrompt(run: Run): Promise<CompiledContext>
  selectMemories(query: string, budget: TokenBudget): Promise<MemoryChunk[]>
  summarizeThread(threadId: string): Promise<Summary>
  evict(strategy: "lru" | "priority" | "deadline" | "semantic"): void
}
```

### 5.5 RAG FileSystem / Knowledge Mount

RAG 在 AgentOS 中被抽象为文件系统挂载层。

知识空间示例：

```text
/mounts
├─ /workspace
├─ /docs
├─ /memory
├─ /web
├─ /db
└─ /events
```

文件系统操作映射：

| 文件系统操作 | RAG 操作 |
|---|---|
| mount | 接入知识源 |
| ls | 列出知识空间 |
| stat | 查看文档元数据 |
| read | 读取原文片段 |
| grep/search | 关键词或语义检索 |
| inode | 文档 chunk ID |
| permission | 知识访问控制 |
| snapshot | 固定某次检索视图 |

建议接口：

```ts
interface KnowledgeFS {
  mount(path: string, driver: FileSystemDriver): void
  stat(path: string): Promise<FileStat>
  read(path: string, range?: Range): Promise<ContentChunk>
  search(query: SearchQuery): Promise<SearchResult[]>
  watch(path: string, callback: EventHandler): void
}
```

核心要求：

- 每个知识源实现独立 driver。
- 检索结果必须携带路径、版本、来源和可信度。
- RAG 搜索结果不直接进入 prompt，必须由 Context Manager 编译。
- 支持 read-after-search。
- 支持 snapshot，保证一次 Run 内知识视图稳定。

### 5.6 Multi-Agent IPC

多 Agent 协作应被建模为进程通信问题。

AgentOS 需要支持三类 IPC：

- Message Queue：Agent 之间发送结构化消息。
- Blackboard：多个 Agent 共享任务状态、计划、发现和结论。
- RPC / Future：一个 Agent 请求另一个 Agent 完成子任务并等待结果。

消息结构：

```ts
type AgentMessage = {
  from: string
  to: string | "broadcast"
  type: "task" | "result" | "question" | "event" | "error"
  payload: unknown
  correlationId?: string
  priority: number
  createdAt: string
}
```

推荐协作模式：

- Supervisor / Worker。
- Planner / Executor / Reviewer。
- MapReduce。
- Debate。
- Pipeline。

### 5.7 Scheduler

Scheduler 负责决定任务何时运行、由谁运行、用多少资源运行。

核心能力：

- FIFO 调度。
- 优先级调度。
- 依赖 DAG。
- 并发 worker pool。
- token budget。
- tool call budget。
- deadline。
- timeout。
- retry。
- fallback。
- human approval checkpoint。

任务结构：

```ts
type Task = {
  id: string
  goal: string
  assignedTo?: string
  dependencies: string[]
  priority: number
  status: "pending" | "running" | "blocked" | "done" | "failed"
  budget: Budget
}
```

### 5.8 Event Log / Observability

AgentOS 必须使用事件日志记录关键执行过程。没有 Event Log，多 Agent 系统将很难调试。

事件类型：

```text
agent.created
agent.started
agent.terminated
agent.message.sent
agent.message.received
context.compiled
model.called
model.completed
tool.requested
tool.completed
memory.written
rag.searched
task.scheduled
task.completed
error.raised
human.approved
```

事件结构：

```ts
type Event = {
  id: string
  runId: string
  pid?: string
  type: string
  timestamp: string
  payload: unknown
}
```

事件日志需要支持：

- 按 runId 查询。
- 按 pid 查询。
- 按 event type 查询。
- 回放一次执行。
- 分析 token 与工具调用成本。
- 对比不同 prompt、model、scheduler 策略。

### 5.9 Runtime Adapter

Runtime Adapter 负责对接不同模型供应商和本地模型。

核心能力：

- 统一 chat/completion 接口。
- 统一 tool calling 协议。
- 统一 token 计算。
- 统一 streaming。
- 统一错误和重试。
- 支持多模型路由。

## 6. MVP 范围

第一阶段实现一个微内核 AgentOS。

必须包含：

- Agent Registry。
- Process Manager。
- 单 Agent 执行。
- Tool Registry。
- Tool Dispatcher。
- Event Log。
- Context Manager。
- Local File RAG Driver。
- Runtime Adapter 抽象。

暂不包含：

- 分布式执行。
- 复杂权限策略。
- 可视化调试 UI。
- 多租户。
- 企业 SSO。
- 自动评测平台。

## 7. 里程碑

### Milestone 1: Core Interfaces

目标：确定系统骨架。

交付物：

- AgentSpec。
- AgentProcess。
- ToolManifest。
- SyscallRequest / SyscallResult。
- Event。
- ContextManager 接口。
- KnowledgeFS 接口。
- RuntimeAdapter 接口。

验收标准：

- 类型定义完整。
- 模块边界清晰。
- 可以用 mock runtime 跑通一次空任务。

### Milestone 2: Single Agent Runtime

目标：跑通单 Agent 执行链路。

交付物：

- Agent 注册。
- Agent 启动。
- Prompt 编译。
- Model 调用。
- Tool 调用。
- Event 记录。

验收标准：

- 一个 Agent 可以完成一次简单任务。
- 工具调用必须经过 dispatcher。
- 执行过程可以通过 event log 查看。

### Milestone 3: Local KnowledgeFS

目标：把本地代码库或文档作为挂载知识源。

交付物：

- LocalFileSystemDriver。
- read/stat/search。
- Context Manager 集成检索结果。

验收标准：

- Agent 可以搜索本地文件。
- 搜索结果带路径和片段。
- Prompt 中的 RAG 内容可追踪来源。

### Milestone 4: Multi-Agent IPC

目标：支持多 Agent 协作。

交付物：

- Message Queue。
- Blackboard。
- AgentMessage。
- Supervisor / Worker 示例。

验收标准：

- Supervisor 可以拆分任务给 Worker。
- Worker 结果可以返回并汇总。
- 所有消息进入 event log。

### Milestone 5: Scheduler

目标：引入任务调度能力。

交付物：

- Task 模型。
- FIFO 调度。
- priority。
- dependency DAG。
- timeout / retry。

验收标准：

- 多个任务可以按优先级和依赖执行。
- 失败任务可以重试或进入 failed 状态。
- 调度决策可以审计。

## 8. 非功能需求

### 8.1 可观测性

- 所有关键动作必须写入 event log。
- 每次模型调用必须记录输入摘要、输出摘要、token 估算和耗时。
- 每次工具调用必须记录参数摘要、结果摘要、耗时和错误。

### 8.2 安全性

- Agent 必须通过权限系统访问工具。
- 高风险工具必须显式声明 sideEffects。
- 破坏性操作必须支持人工审批。
- RAG mount 必须支持路径级权限。

### 8.3 可扩展性

- 工具、知识源、模型供应商必须可插拔。
- Scheduler 策略必须可替换。
- Context 编译策略必须可替换。

### 8.4 可回放性

- Run 必须可重建关键输入。
- Tool result 可以选择记录完整结果或摘要结果。
- RAG snapshot 可以固定一次执行期间的知识视图。

### 8.5 成本控制

- 每个 AgentProcess 可以设置 token budget。
- 每个 Task 可以设置 deadline。
- 每个 Tool 可以设置 timeout。
- Scheduler 可以根据预算暂停或终止任务。

## 9. 建议目录结构

```text
agentos/
├─ kernel/
│  ├─ orchestrator.ts
│  ├─ scheduler.ts
│  ├─ process-manager.ts
│  └─ event-log.ts
├─ agents/
│  ├─ planner.ts
│  ├─ executor.ts
│  └─ reviewer.ts
├─ tools/
│  ├─ registry.ts
│  └─ dispatcher.ts
├─ context/
│  ├─ context-manager.ts
│  └─ memory-store.ts
├─ rag/
│  ├─ knowledge-fs.ts
│  └─ drivers/
├─ ipc/
│  ├─ message-queue.ts
│  └─ blackboard.ts
├─ runtime/
│  └─ model-adapter.ts
└─ examples/
   ├─ single-agent.ts
   └─ multi-agent.ts
```

## 10. 第一版开发顺序

建议按以下顺序开发：

1. 定义核心类型。
2. 实现 Event Log。
3. 实现 Tool Registry 和 Tool Dispatcher。
4. 实现 Runtime Adapter mock。
5. 实现 Context Manager 最小版本。
6. 实现 Agent Process Manager。
7. 跑通 Single Agent 示例。
8. 实现 Local KnowledgeFS。
9. 加入 Message Queue。
10. 加入 Scheduler。

## 11. 成功标准

AgentOS 第一版成功的标准：

- 可以注册 Agent、工具和知识源。
- 可以执行一个单 Agent 任务。
- 可以通过 syscall 风格调用工具。
- 可以把本地文档或代码作为 RAG mount 使用。
- 可以记录完整 event log。
- 可以回放或检查一次执行过程。
- 可以扩展到 Supervisor / Worker 多 Agent 示例。

## 12. 核心设计原则

- Agent 是受管进程，不是自由 prompt。
- Tool use 是 syscall，必须有 schema、权限和审计。
- Context window 是 cache，需要编译、淘汰和写回。
- RAG 是文件系统挂载，不只是向量搜索。
- Orchestrator 是 kernel，负责调度、隔离和资源管理。
- Event log 是内核日志，没有它系统不可调试。
- 所有模块都应优先采用可插拔接口，而不是硬编码实现。
