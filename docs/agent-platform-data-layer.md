# Agent Platform 数据层与 Kubernetes 实现分析

本文记录 `agent-platform` 的核心数据模型、Kubernetes 运行机制及其对 `agent-hub` 的参考价值。

参考项目路径：`/Users/saifa_96/Documents/Workspace/agent-platform`

## 核心结论

`agent-platform` 并不是使用 Kubernetes 作为数据层，而是把系统拆成三个部分：

1. **PostgreSQL**：保存平台业务数据和 Agent 的期望状态。
2. **Kubernetes**：承载 Agent 进程和实际运行状态。
3. **PVC / AFS / Memory Fuse**：保存 Agent 工作目录、共享文件和长期记忆。

其核心闭环是：

```text
PostgreSQL 保存期望状态
        ↓
Env Runner 持续执行 reconcile
        ↓
Kubernetes 承载实际 Agent
        ↓
PVC / AFS 保存文件
        ↓
实际状态写回 PostgreSQL
```

## PostgreSQL 控制数据

核心代码：

- `control-plane/migrations/001_init.sql`
- `control-plane/migrations/120_byoi_environments.sql`
- `control-plane/migrations/122_environment_tokens.sql`
- `control-plane/src/services/db/pool.ts`
- `control-plane/src/services/db/`

### 数据访问方式

Control Plane 使用 `node-postgres (pg)` 直接访问 PostgreSQL，没有使用 Prisma、Drizzle 等 ORM。

各领域模块负责自己的参数化 SQL，例如：

- `workspaces.ts`
- `sessions.ts`
- `messages.ts`
- `credentials.ts`
- `templates.ts`
- `prompts.ts`
- `environments.ts`

### 数据迁移

Control Plane 启动时自动执行迁移：

1. 创建 `schema_migrations` 表。
2. 读取已经执行的迁移 ID。
3. 按文件名排序读取 `migrations/*.sql`。
4. 每个新迁移在独立事务中执行。
5. 成功后将文件名记录到 `schema_migrations`。

项目没有单独的迁移 CLI；迁移逻辑位于 `control-plane/src/services/db/pool.ts`。

### 核心实体关系

```text
User
 ├── Workspace
 │    ├── WorkspaceConfig
 │    ├── Session
 │    │    ├── Message
 │    │    └── SessionEvent
 │    ├── WorkspacePlacement
 │    ├── WorkspaceSkill
 │    ├── MemoryAttachment
 │    └── UsageEvent
 ├── Prompt / Template / Skill
 ├── ModelProvider / Credential
 └── Team / Grants
```

一个重要设计是：数据库中没有单独的核心 `agents` 表。

> Agent 是进入运行状态的 Workspace。

Workspace 保存稳定配置和文件，Session 表示一次对话或任务，Agent 则是 Workspace 的运行形态。

## Environment 与 WorkspacePlacement

环境抽象由以下表组成：

```text
environments
environment_grants
environment_tokens
workspace_placements
```

`environment` 表示可以运行 Workspace 的基础设施，例如平台内置 Kubernetes 集群或客户自己的远程集群。

### WorkspacePlacement

`workspace_placements` 是 PostgreSQL 与 Kubernetes 之间的桥梁，每个 Workspace 对应一条 placement。

Control Plane 写入期望状态：

```text
desired_phase   running | stopped | deleted
spec            Agent 类型、镜像和资源配置
spec_version    期望配置版本
```

Env Runner 写回实际状态：

```text
observed_phase    pending | starting | running | stopped | error | unknown
observed_version  已部署配置版本
endpoint          Agent 服务地址
message           状态或错误信息
reported_at       最后上报时间
```

数据流如下：

```text
用户操作
   ↓
Control Plane 更新 workspace_placements
   ↓
Env Runner 读取 desired state
   ↓
Env Runner 操作 Kubernetes
   ↓
Env Runner 写回 observed state
```

这相当于一个简化的 Kubernetes Operator，不过期望状态保存在 PostgreSQL，而不是 Kubernetes CRD。

## Env Runner 状态收敛

核心代码：

- `internal/env-runner-core/reconcile.ts`
- `internal/k8s-provider/provider.ts`
- `env-runner-k8s/src/index.ts`

主要规则：

```text
desired=deleted
  → 删除 Kubernetes 资源和 placement

desired=stopped
  → 将 Deployment replicas 调整为 0

desired=running
  → 配置版本变化时重新 apply
  → 资源不存在时创建
  → 当前停止时将 replicas 调整为 1
  → 已经运行时不执行操作
```

每轮 reconcile 会优先通过一次 Kubernetes `LIST` 批量获取所有 Workspace 状态，避免为每个 Workspace 单独发送查询。

### Built-in 模式

```text
Env Runner
 ├── 直接访问 PostgreSQL
 └── 操作平台所在 Kubernetes 集群
```

Built-in Runner 只处理 `is_builtin = true` 的 Environment，避免错误处理远程集群中的 Workspace。

### Remote / BYOI 模式

```text
客户 Kubernetes 集群
   └── Env Runner
        ├── 使用 Environment Token 调用 /env/v1 API
        ├── 只主动向 Control Plane 建立连接
        └── 操作客户自己的 Kubernetes 集群
```

远程 Runner 不访问平台 PostgreSQL。Control Plane 根据 Environment Token 将所有请求限制在对应环境内。

## Agent 的 Kubernetes 资源

`internal/k8s-provider/provider.ts` 中的 `KubernetesProvider` 为每个 Workspace 创建：

```text
PersistentVolumeClaim
Deployment
ClusterIP Service
```

Service 端口：

```text
3001  Agent HTTP
9101  AgentFS
9102  Memory Fuse
```

生命周期通过 Deployment 管理：

```text
启动    replicas = 1
停止    replicas = 0
重启    rollout restart
删除    删除 Deployment、Service 和 Workspace PVC
```

这使常驻 Agent 和按需启动 Agent 可以复用同一套资源模型。

## 文件与记忆存储

关系数据和文件数据被明确分开：

| 存储 | 用途 |
| --- | --- |
| PostgreSQL | 用户、Workspace、Session、Message、配置、权限、期望状态 |
| Workspace PVC | 单个 Agent 的工作目录和本地文件 |
| AFS + RWX PVC | 多个 Agent 之间共享的文件 |
| Memory Fuse | 以文件系统形式暴露长期记忆 |

AFS Controller 使用独立 PVC 保存 SQLite 元数据。该元数据记录目录 ID 与实际存储路径的映射，丢失后即使共享数据仍存在，挂载也无法正常工作。

多节点部署通常接入支持 `ReadWriteMany` 的外部存储；单节点 k3s 模式可以部署内置 NFS Server。

## PostgreSQL 的 Kubernetes 部署

相关文件：`self-host/manifests/postgres.yaml`

PostgreSQL 不是手写 StatefulSet，而是通过 CloudNativePG Operator 管理：

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
```

默认配置：

```text
实例数       3
单实例存储   10Gi
访问模式     ReadWriteOnce
```

单节点 k3s 模式会使用一个 PostgreSQL 实例。

## Self-host 安装流程

主安装器：`self-host/install.sh`

安装顺序大致为：

```text
1. 安装 CloudNativePG Operator
2. 安装 NFS Provisioner
3. 使用 envsubst 渲染 manifests
4. 创建 Namespace 和 Secrets
5. 创建 PostgreSQL Cluster
6. 等待 PostgreSQL Ready
7. 部署 Control Plane、Env Runner、Scheduler、AFS 等服务
8. Control Plane 启动并执行数据库迁移
9. 运行 Seed Jobs，创建管理员、OAuth Client 和 MCP Catalog
```

主平台使用：

```text
静态 YAML 模板 + envsubst + kubectl server-side apply
```

Helm 主要用于基础组件和远程 `env-runner-k8s` Chart，而不是管理整个主平台。

## 对 Agent Hub 的参考

Agent Hub 最值得借鉴的是以下最小模型：

```text
Workspace
Session
Message
Environment
WorkspacePlacement
```

建议优先实现：

1. PostgreSQL 保存 Workspace、Session 和 Message。
2. `WorkspacePlacement` 保存 desired/observed 状态。
3. 独立 Runner 将期望状态收敛到实际运行环境。
4. Runner 接口与 Kubernetes 解耦，以便后续支持 Docker、本地进程或远程环境。

首个版本不需要复制完整的 Kubernetes、AFS、Browser、Sandbox 和多集群体系。
先形成“创建 Workspace → 启动 Agent → 建立 Session → 保存消息 → 停止 Agent”
的最小闭环即可。
