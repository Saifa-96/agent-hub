# Agent Hub — Implementation Roadmap

基于 Neutree Agent Platform 架构，使用 pi-agent SDK 作为 agent core 的实现路线。

## 架构定位

整个平台分为 control-plane（管理层）和 data-plane（执行层）。本 roadmap 聚焦 data-plane 中的 agent runtime 部分——即 architecture.png 中每个 workspace 容器内的「agent core sidecar + agent core」。

control-plane 通过写入 desired state 来驱动 agent：创建 workspace、启动 session、发送消息。agent runtime 不主动联系 CP，它被动响应：收到 HTTP 请求就干活，没请求就空转等待。CP 是调度者，agent runtime 是执行者。

两者之间的协议是 **UniversalEvent**——一套标准化的 SSE 事件流格式。无论底层是 Claude Code、Codex、还是 pi-agent，对 CP 来说都是同一套接口。这意味着只要你的 runtime 能吐出正确的 UniversalEvent 流，就能无缝接入平台。

---

## Phase 1: Agent Core + Sidecar

**目标**：一个独立进程，能接收用户消息、调用 pi-agent 跑对话、以 SSE 流式返回标准事件。不依赖 control-plane，本地可独立验证。

### 1.1 Agent Core

**是什么**：对 pi SDK `createAgentSession()` 的封装层。它负责创建 agent session、驱动对话、管理中断。

**需要做的事**：

- 初始化 pi SDK 的 `AuthStorage`、`ModelRegistry`、`SessionManager`，调用 `createAgentSession()` 创建一个可用的 session 实例。
- 调用 `session.prompt(message)` 发起对话。这是一个 async 调用，会阻塞直到 agent 完成整轮（包括所有工具调用）。
- 通过 `session.subscribe(listener)` 订阅实时事件流。pi SDK 在 agent 工作过程中会持续推送事件（文本 delta、工具调用开始/结束、错误等），你需要捕获每一个事件并转发给翻译层。
- 通过 `session.abort()` 支持中断正在进行的对话。
- 管理 session 生命周期：什么时候创建新 session、什么时候复用已有 session（基于请求中的 session_id）。

**为什么需要这一层**：pi SDK 的事件通过 `session.subscribe()` 回调推送，但 sidecar 需要把这些事件写入 HTTP response 的 SSE stream。agent core 层桥接 subscribe 回调与 SSE response writer——在收到 HTTP 请求时设置 subscriber，将回调中产生的事件逐条写入 response stream，直到 `prompt()` resolve 表示整轮完成。

**生命周期注意**：

- `session.isStreaming` 可用于判断当前是否正在处理 prompt，避免重复调用。
- session 不再使用时需调用 `session.dispose()` 释放资源（MCP 连接、内存等）。

### 1.2 事件翻译层

**是什么**：一个有状态的翻译器，将 pi SDK 推送的 `AgentSessionEvent` 逐条转换为平台标准的 `UniversalEvent`。

**为什么需要**：pi SDK 的事件格式是 pi 自己的（`message_update`、`tool_execution_start` 等），而 control-plane 和 web 前端只认 `UniversalEvent`（`item.started`、`item.delta`、`item.completed` 等）。这一层做格式转换，保证协议兼容。

**有状态的原因**：UniversalEvent 中每个 item 有 `item_id`，且 `item.started` 必须在第一个 `item.delta` 之前发出。翻译器需要追踪「当前是否已经发过 item.started」「当前 item 的 id 是什么」这类状态。一个对话 turn 结束后重置。

**具体映射关系**：

| pi SDK 事件 | 含义 | 转换为 UniversalEvent |
|---|---|---|
| `agent_start` | agent 开始处理 prompt | `session.started`（携带 session_id） |
| `message_start` | 新的 assistant message 开始 | 内部状态重置，不单独发事件（为后续 text_delta 做准备） |
| `message_update` 且 `assistantMessageEvent.type === "text_delta"` | assistant 正在生成文字，增量推送 | 首次触发时先发 `item.started`（kind: message），随后每次发 `item.delta`（type: text） |
| `message_update` 且 `assistantMessageEvent.type === "thinking_delta"` | 思考过程增量（仅启用 thinking 时） | `item.delta`（type: reasoning） |
| `message_end` | 一条完整的 assistant message 生成完毕 | `item.completed`（kind: message，携带完整文本） |
| `tool_execution_start` | agent 开始执行一个工具调用 | `item.started`（kind: tool_call，携带 tool name） |
| `tool_execution_update` | 工具执行过程中的流式输出（长时间工具） | `item.delta`（type: tool_output）—— 可选，用于 UI 实时展示工具进度 |
| `tool_execution_end` | 工具执行完毕，有结果 | `item.completed`（kind: tool_call）+ `item.completed`（kind: tool_result，携带 output 和 is_error） |
| `turn_start` | 一轮 LLM 响应开始（含工具调用） | 不映射，内部追踪用 |
| `turn_end` | 一轮 LLM 响应结束，携带 usage 信息 | 不映射为独立事件，usage 数据累积到 `session.ended` 的 TurnStats 中 |
| `agent_end` | 整轮对话结束（所有工具调用链完成） | `session.ended`（携带 reason 和 usage stats） |

**边界情况**：

- 一轮对话中 agent 可能多次调用工具（agentic loop），每次工具调用都是独立的 tool_call + tool_result item 对。
- 如果 prompt 失败（model 报错、API key 无效），需要发 `error` 事件 + `session.ended`（reason: error）。注意：pi SDK 中 prompt 被接受后的失败通过事件流报告（不是 throw），翻译层需要监听错误类事件。
- 如果用户调用 interrupt，需要发 `session.ended`（reason: interrupted）。
- `compaction_start` / `compaction_end`：长对话触发自动压缩时产生，映射为 `item.started`/`item.completed`（kind: status, content: "compacting"）让 UI 显示状态。

### 1.3 Agent Core Sidecar（HTTP Server）

**是什么**：一个 HTTP server，对外暴露标准端点，是 control-plane 与 agent core 之间的通信界面。

**为什么是 sidecar 而不是直接暴露 pi SDK**：因为协议需要标准化。CP 不关心底层是什么 agent，它只知道往 `/chat` 发消息、从 SSE 流读事件。sidecar 把 pi SDK 的 Node.js 调用模式包装成 HTTP 协议。

**需要实现的端点**：

**GET /health**

- 用途：Kubernetes liveness probe / CP 存活检测。
- 返回 `{ status: "ok" }`，无业务逻辑。
- 如果这个端点不响应，orchestrator 会重启容器。

**GET /info**

- 用途：CP 需要知道这个 workspace 里跑的是什么 agent、用什么 model、支持哪些能力。
- 返回 AgentInfo 结构：agent_type（如 "pi-agent"）、model（当前使用的模型 ID）、capabilities 对象。
- capabilities 告诉 CP 这个 agent 支不支持 system_prompt 注入、MCP、skills、human-in-the-loop 问答、断线重连、权限控制、流式增量等。CP 会据此决定 UI 展示和功能开关。

**POST /chat**

- 用途：核心端点。接收用户消息，驱动 agent 对话，以 SSE（Server-Sent Events）格式流式返回整轮对话的所有事件。
- 请求体：`{ message, session_id?, images?, session_token? }`。session_id 为空时创建新 session，有值时继续已有对话。
- 响应：Content-Type 为 `text/event-stream`。每个 SSE frame 格式为 `event: message\ndata: <UniversalEvent JSON>\n\n`。
- 生命周期：SSE 流从第一个 `session.started` 开始，到 `session.ended` 结束。流结束后连接关闭。
- 一个 turn 可能持续数十秒甚至数分钟（agent 可能执行多个工具、读文件、写代码）。整个过程中 SSE 流持续推送增量事件。
- 如果 TCP 连接中途断开（客户端掉线），agent 应继续执行不中断，事件暂存 buffer，等待 reconnect 来 flush。

**POST /sessions/:id/interrupt**

- 用途：用户点击「停止」按钮时 CP 调用此端点。
- 行为：调用 pi SDK 的 `session.abort()`，终止当前正在执行的 prompt。agent 会尽快停下来并通过事件流发出 `session.ended`（reason: interrupted）。

**POST /sessions/:id/reconnect**

- 用途：CP 断线重连后恢复事件流。
- 行为：打开一个新的 SSE 流，先 flush 断线期间 buffer 的所有事件，然后接管后续实时事件的推送。CP 对用户无感知地恢复实时更新。
- 为什么需要：Kubernetes pod 重启、网络抖动、CP 自身重新部署都会导致 SSE 连接中断。agent 不能因为 CP 掉线就停止工作，也不能丢弃掉线期间的事件。

**POST /sessions/:id/respond**

- 用途：回答 agent 发出的 human-in-the-loop 问题。
- 场景：agent 执行过程中可能需要人工确认（例如「是否删除这个文件？」）。agent 暂停并通过事件流发出 `question.requested`，前端展示给用户，用户回答后 CP 调用此端点把答案传回 agent。
- 行为：将答案传递给 pi SDK 中等待的 resolve 回调，agent 继续执行。

**GET /sessions/:id/pending-question**

- 用途：UI 刷新后恢复未回答的问题。
- 场景：用户刷新页面，但 agent 还在等待一个问题的回答。前端重新加载后调用此端点获取未回答的问题，重新展示给用户。

**POST /reload-config**

- 用途：CP 更新了 workspace 配置（换 model、加 skill、更新 credentials）后通知 agent 热加载。
- 行为：重新从 CP 拉取配置并注入运行中的 session（更新 model、刷新 skills 文件、更新 API key 等）。不需要重启进程。

### 1.4 验证标准

Phase 1 完成的标志：本地启动进程，用 curl 往 `/chat` 发一条消息，能收到完整的 SSE 事件流（session.started → 若干 item.delta → item.completed → session.ended），且 agent 实际执行了工具调用（如列出文件）。不需要 CP，不需要 K8s，纯本地验证。

---

## Phase 2: 配置与 Skills 加载

**目标**：agent 不再硬编码配置，而是从 control-plane 动态拉取 workspace 配置、skills 文件、API credentials，并注入 pi session。

### 2.1 配置加载器

**是什么**：启动时和收到 `/reload-config` 时，向 CP 的 API 拉取当前 workspace 的配置。

**需要拉取的内容**：

- **Runtime 配置**：使用哪个 model（如 claude-sonnet-4-20250514）、thinking level、允许的工具列表。agent 据此初始化或切换 model。
- **System Prompt**：workspace 级别的系统指令。注入方式是通过 `DefaultResourceLoader` 的 `agentsFilesOverride` 选项，把 CP 下发的 prompt 当作虚拟的 AGENTS.md 文件注入。注意这是 ResourceLoader 构造选项，不是 session 级别参数：

  ```typescript
  const loader = new DefaultResourceLoader({
    agentsFilesOverride: (current) => ({
      agentsFiles: [...current.agentsFiles, { path: "/virtual/AGENTS.md", content: cpPrompt }],
    }),
  });
  await loader.reload();
  const { session } = await createAgentSession({ resourceLoader: loader });
  ```

- **MCP Servers**：workspace 配置的 MCP server 列表（URL + transport）。需要确认 pi SDK 的 `createAgentSession()` 是否支持 `mcpServers` 选项直接传入，或者需要通过 ResourceLoader / 写 `.mcp.json` 文件的方式注入。这是 Phase 2 的一个待验证点。
- **Skills**：workspace 绑定的 skill 文件列表。需要从 skills-content-service 下载 `.md` 文件到本地磁盘，然后通过 `DefaultResourceLoader` 的 `skillsOverride` 选项注入：

  ```typescript
  const loader = new DefaultResourceLoader({
    skillsOverride: (current) => ({
      skills: [...current.skills, { name, description, filePath, baseDir, source: "custom" }],
      diagnostics: current.diagnostics,
    }),
  });
  ```

- **Credentials**：API keys（Anthropic、OpenAI 等）。通过 `authStorage.setRuntimeApiKey(provider, key)` 注入（不持久化到磁盘），pi SDK 在调用模型时自动使用对应的 key。

### 2.2 启动重试机制

**为什么需要**：在 Kubernetes 环境中，agent pod 和 CP pod 可能同时启动。agent 启动时 CP 可能还没 ready。需要重试机制（如 5 次，每次间隔 3 秒）确保配置最终加载成功。

**失败处理**：如果 skills 下载反复失败（网络问题、service 不可用），agent 应该退出让 kubelet 重启，而不是带着残缺配置运行。这是从 claude-code 的真实事故学来的——静默降级比崩溃更危险，用户可能在残缺状态下工作数小时才发现。

### 2.3 热更新

CP 修改了 workspace 配置后会调用 `/reload-config`，可以带 scope 参数指定只刷新 config/skills/credentials 中的某些。agent 不需要重启，在下一轮对话开始前更新即可。

---

## Phase 3: Session 管理与连接韧性

**目标**：支持多 session 并发、断线不丢事件、长时间运行不超时。

### 3.1 Session 池

**是什么**：一个 workspace 可能同时有多个活跃的对话 session（用户开多个 tab、或 scheduler 触发多个任务）。需要一个 session 池来管理多个 pi AgentSession 实例，按 session_id 索引。

**生命周期**：session 在首次 `/chat` 时创建，在 `session.ended` 后可以选择保留（multi-turn 对话）或销毁。pi SDK 的 `SessionManager` 负责持久化，session 池只管内存中的活跃引用。

### 3.2 断线重连与 Buffer 机制

**问题**：SSE 是单向长连接。如果 CP → agent 的 TCP 连接断开（CP pod 重启、网络抖动），agent 正在执行的工作不应中断，已产生的事件不应丢失。

**解决方案（SessionSink 模式）**：

- 每个活跃 session 有一个 sink 对象，持有当前的 SSE writer 函数。
- 正常时 sink.write 直接写 SSE frame。
- TCP 断开时 sink 切换到 buffer 模式：事件暂存内存数组。
- `/reconnect` 端点：新建 SSE 流 → flush buffer 中所有事件 → 替换 sink.write 为新流的 writer → 后续事件实时推送。
- agent 的工作（`session.prompt()`）全程不受影响。

**断线时不中断 agent 的原因**：一次 agent turn 可能涉及多个工具调用链，耗时数分钟。如果因为 CP 短暂掉线就中断，用户需要重新发送 prompt、重新执行所有工具调用。代价远大于 buffer 几个事件。

### 3.3 SSE Keepalive

**问题**：agent 执行长时间工具调用（编译项目、运行测试）时，SSE 流可能数分钟没有数据。中间的代理/负载均衡器（kube-proxy、conntrack、Nginx）会因为 idle timeout 断开连接。

**解决方案**：每 15 秒检查一次，如果 writer 空闲超过 15 秒就写一个 SSE comment frame（`:\n\n`）。SSE 规范中 comment frame 被客户端忽略，但足以让 TCP 连接保持活跃。

### 3.4 Human-in-the-Loop

**流程**：

1. agent 执行中遇到需要用户确认的操作，pi SDK 触发某种权限询问机制。
2. agent core 将其包装为 `question.requested` 事件通过 SSE 流发给 CP。
3. CP 转发给 web 前端，用户看到弹窗。
4. 用户回答后 CP 调用 `/sessions/:id/respond`。
5. agent core 收到答案，resolve 等待中的 promise，agent 继续执行。
6. 如果用户刷新页面，前端调用 `/sessions/:id/pending-question` 恢复未回答的问题。

---

## Phase 4: Env Runner 对接（Reconcile Loop）

**目标**：让 control-plane 能通过 desired-state 模型管理 agent workspace 的生命周期（创建、启动、停止、销毁），而不是手动启停进程。

### 4.1 Reconcile 模型

这是整个平台的核心运维模型，类似 Kubernetes controller：

- CP 在数据库中写入 desired state（如 `desired_phase = "running"`）。
- env-runner 定期扫描所有 placement，对比 desired 和 observed，执行调和动作。
- 调和完成后 runner 将 observed state 写回。

这意味着 CP 永远不直接 SSH 到容器里启停 agent。它只管写意图，runner 负责实现。

### 4.2 EnvironmentProvider

**是什么**：env-runner-core 的 reconcile loop 是通用的，它通过 `EnvironmentProvider` 接口与具体基础设施交互。你需要实现这个接口来告诉 runner「如何在你的环境中创建/启动/停止/销毁一个 workspace」。

**接口方法**：

- `apply(workspaceId, spec)`：根据 spec 创建或更新一个 workspace 环境。spec 包含镜像、资源限制、环境变量、挂载等。具体实现取决于你的基础设施（K8s StatefulSet、Docker container、bare process）。
- `start(workspaceId)`：启动一个已停止的 workspace（如 scale up replica）。
- `stop(workspaceId)`：停止一个运行中的 workspace（如 scale down，保留持久化数据）。
- `destroy(workspaceId)`：彻底删除 workspace 及其所有资源。
- `observe(workspaceId)`：观察当前实际状态（running / stopped / pending / error / unknown）。
- `observeAll()`（可选）：批量观察所有 workspace 状态，减少 API 调用次数（如 K8s 一次 LIST 获取所有 Pod 状态）。
- `capabilities()`：报告当前 runner 支持的能力（用于 CP 调度决策）。

### 4.3 PlacementTransport

**是什么**：runner 与 CP 之间的通信层。两种模式：

- **DbTransport**（同集群部署）：runner 直接读写 PostgreSQL 中的 `workspace_placements` 表。延迟最低，但 runner 必须和 CP 在同一网络能访问同一 DB。
- **HttpTransport**（BYOI / 远程部署）：runner 通过 CP 的 `/env/v1` HTTP API 获取 placement 列表、上报 observed state、发送 heartbeat。CP 通过 env token 鉴权并限制每个 runner 只能看到分配给它的 placement。

### 4.4 架构图中的 push vs pull

- **Push 模式**（左图）：CP 直接部署 workspace。适合 CP 和 data-plane 在同一集群的场景。
- **Pull 模式**（右图）：远程 env-runner 主动从 CP 拉取 workspace config，在自己的环境中部署。适合 BYOI（Bring Your Own Infrastructure）场景——用户的 agent 跑在他们自己的机房/VPC 里。

你先实现哪种取决于部署场景。单机开发推荐先做一个最简单的 provider（如 bare process：apply = spawn 进程，stop = kill，observe = check PID exists）。

---

## Phase 5: 扩展能力

这些都是 agent 容器内的附加能力，按需实现，不影响核心对话流。

### 5.1 Terminal Proxy

**用途**：让 web 用户通过浏览器操作 workspace 里的终端。
**实现**：容器内运行 ttyd（WebSocket 终端），sidecar 提供 `/terminal/ws` 端点做 WebSocket 代理。支持多个 tmux session（通过 URL 参数指定 session name）。

### 5.2 File Browser

**用途**：让用户通过 web UI 浏览和上传 workspace 中的文件。
**实现**：容器内运行 dufs（HTTP 文件服务），sidecar 提供 `/files/*` 端点做反向代理。支持 GET（下载）、PUT（上传）、MKCOL（创建目录）、DELETE、MOVE（重命名）。

### 5.3 Sandbox 接入

**用途**：agent 执行不可信代码时需要隔离环境。
**实现**：对接 sandbox-service，agent 的代码执行工具调用 sandbox API 而不是直接在 workspace 里 exec。

### 5.4 Remote Browser

**用途**：agent 需要浏览网页、操作 DOM。
**实现**：对接 browser-service，agent 通过 MCP 工具驱动远程浏览器实例，截图通过 WebRTC 流式传回。

### 5.5 Memory / AgentFS

**用途**：跨 session 持久化 agent 的知识和记忆；多 agent 之间共享文件。
**实现**：memory-fuse 通过 FUSE 将 agent 的 memory store 挂载为文件系统路径，agent 像读写普通文件一样操作记忆。AgentFS 提供跨 workspace 的共享文件夹。

---

## 关键参考文件

| 文件 | 参考价值 |
|------|---------|
| `agents/claude-code/src/server.ts` | HTTP 端点的完整实现，包括 SSE 流、reconnect、keepalive、file proxy 的全部细节 |
| `agents/claude-code/src/agent.ts` | agent core 参考——但注意它用的是 Claude Agent SDK 的 `query()` 返回 async iterable（pull 模型），与 pi SDK 的 `subscribe()` + `prompt()`（push 模型）模式不同。参考其 session 管理、中断处理、human-in-the-loop 的整体结构，不照搬调用方式 |
| `agents/claude-code/src/universal-events.ts` | UniversalEventTranslator 的 **output 格式**参考（如何构造 UniversalEvent）。注意：其 input 是 Claude Agent SDK 的 `SDKMessage`（`assistant`/`tool_use`/`tool_result`/`stream_event` 类型），与 pi SDK 的 `AgentSessionEvent` 完全不同。翻译逻辑的 input 映射需从零实现，只参考其 output 构造模式 |
| `agents/claude-code/src/config.ts` | 从 CP 拉配置的 HTTP 调用、retry 逻辑、skills 下载和原子替换 |
| `agents/claude-code/src/index.ts` | 启动流程：config retry → server start → ttyd/dufs 子进程 |
| `internal/types/events.ts` | UniversalEvent、UniversalItem、ContentDelta、AgentInfo 等平台标准类型定义 |
| `internal/env-runner-core/reconcile.ts` | reconcile loop 完整实现：spec drift / lifecycle drift / observe / heartbeat |
| `internal/env-runner-core/transport.ts` | PlacementTransport 接口定义和 PlacementRow 数据结构 |
| pi SDK `docs/sdk.md` | createAgentSession、AgentSession、事件类型、ResourceLoader 等完整 API 文档 |

---

## 实现原则

1. **Data plane first** — 先让 agent 能独立跑对话，再接管理层。没有可工作的 runtime，CP 管什么都是空操作。
2. **接口契约驱动** — UniversalEvent 协议是硬合约。只要事件格式正确，CP 和 web 前端立刻可用，不需要它们做任何适配。
3. **最小功能集启动** — Phase 1 端到端跑通就能验证整个 data-plane 层的可行性。后续 phase 都是增量功能，不改变核心架构。
4. **崩溃优于静默降级** — 配置加载失败时宁可退出重启，不要带着残缺状态运行。用户在残缺状态下工作数小时才发现的损失远大于 pod 重启的几秒延迟。
