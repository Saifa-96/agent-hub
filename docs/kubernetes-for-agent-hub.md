# Kubernetes 入门：从 Agent Hub 场景理解 K8s、PVC 与服务部署

本文不追求完整介绍 Kubernetes，而是帮助没有 K8s 经验的开发者理解
`agent-platform` 如何运行 Agent，以及 `agent-hub` 将来可能用到哪些能力。

## 先建立整体认识

Kubernetes，简称 K8s，是一个容器调度平台。

如果 Docker 解决的是：

> 如何把一个应用及其依赖打包成容器？

那么 Kubernetes 解决的是：

> 应该在哪台机器运行容器、运行几个、如何访问、挂掉后如何恢复，
> 以及数据如何持久保存？

在 Agent 平台中，可以先把 Kubernetes 理解成一个远程的 Agent 进程管理器：

```text
Agent Hub
   ↓ 提交期望状态
Kubernetes
   ├── 启动 Agent 容器
   ├── 重启崩溃的 Agent
   ├── 为 Agent 分配 CPU 和内存
   ├── 为 Agent 挂载工作目录
   └── 提供固定的内部访问地址
```

## Kubernetes 集群

一个 Kubernetes 集群通常由两部分组成：

```text
Control Plane
  管理集群状态和调度决策

Worker Node
  真正运行容器的服务器
```

这里的 Kubernetes Control Plane 与 `agent-platform` 的 Control Plane
不是同一个概念：

- Kubernetes Control Plane 管理容器和服务器。
- Agent Platform Control Plane 管理用户、Workspace、Session 和 Agent。

Agent Platform Control Plane 通过 Kubernetes API 操作集群。

## Kubernetes API 与声明式模型

Kubernetes 的核心思想不是执行“启动一个容器”命令，而是提交期望状态：

```yaml
replicas: 1
image: example/agent:latest
```

Kubernetes 会不断比较：

```text
期望状态：应该运行 1 个 Agent
实际状态：当前运行 0 个 Agent
```

发现不一致后，Kubernetes 会创建容器，使实际状态逐渐接近期望状态。
这个过程叫作 **reconcile（状态收敛）**。

`agent-platform` 在 Kubernetes 之外又实现了一层类似机制：

```text
PostgreSQL 中的 desired state
              ↓
Env Runner reconcile
              ↓
Kubernetes 中的实际资源
              ↓
PostgreSQL 中的 observed state
```

## Namespace：资源分组

Namespace 是 Kubernetes 中的逻辑分组。

例如：

```text
namespace: nap
  ├── control-plane
  ├── postgres
  ├── scheduler
  └── workspace-agent-123
```

不同 Namespace 中可以存在同名资源。权限、网络策略和资源配额也可以按
Namespace 管理。

它不是虚拟机级别的隔离，不能单独作为强安全边界。

常用命令：

```bash
kubectl get namespaces
kubectl get pods -n nap
```

## Pod：最小运行单位

Pod 是 Kubernetes 可以调度的最小单位。

一个 Pod 可以包含一个或多个容器：

```text
Agent Pod
  ├── Agent 主容器
  ├── Memory Fuse sidecar
  └── AgentFS sidecar
```

同一 Pod 中的容器：

- 在同一台 Node 上运行。
- 共享网络地址。
- 可以共享挂载的 Volume。
- 生命周期通常绑定在一起。

Pod 不是稳定的服务器。Pod 被删除或重建后：

- Pod 名称和 IP 可能改变。
- 容器内部未持久化的数据会丢失。
- 挂载在持久化存储中的数据可以保留。

因此不要依赖 Pod IP，也不要把重要数据只写进容器文件系统。

常用命令：

```bash
kubectl get pods -n nap
kubectl describe pod <pod-name> -n nap
kubectl logs <pod-name> -n nap
```

## Deployment：管理无状态或可重建的 Pod

Deployment 用来描述如何运行和维护 Pod。

例如：

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  replicas: 1
```

Deployment 负责：

- 创建 Pod。
- Pod 崩溃后重新创建。
- 调整副本数量。
- 更新镜像或配置。
- 执行滚动更新。

在 `agent-platform` 中，每个 Workspace 对应一个 Deployment。

```text
启动 Agent    replicas = 1
停止 Agent    replicas = 0
重启 Agent    rollout restart
```

设置 `replicas = 0` 后，Agent 不再占用 CPU 和内存，但 PVC 可以继续保留。
下次恢复为 `replicas = 1` 时，可以重新挂载原来的工作目录。

常用命令：

```bash
kubectl get deployments -n nap
kubectl scale deployment <name> --replicas=0 -n nap
kubectl rollout restart deployment <name> -n nap
kubectl rollout status deployment <name> -n nap
```

## Service：为 Pod 提供稳定地址

Pod 会被重建，IP 也会变化，因此不能让其他服务直接依赖 Pod IP。

Service 为一组 Pod 提供稳定的 DNS 名称和虚拟 IP：

```text
Service
   ↓ 根据 label 选择 Pod
Agent Pod
```

典型的集群内部地址：

```text
workspace-agent-123.nap.svc:3001
```

`agent-platform` 为每个 Workspace 创建一个 `ClusterIP Service`，提供：

```text
3001  Agent HTTP
9101  AgentFS
9102  Memory Fuse
```

`ClusterIP` 默认只能从集群内部访问。

其他常见 Service 类型：

| 类型 | 用途 |
| --- | --- |
| ClusterIP | 仅集群内部访问 |
| NodePort | 通过节点 IP 和固定端口访问 |
| LoadBalancer | 由云平台创建外部负载均衡器 |

常用命令：

```bash
kubectl get services -n nap
kubectl describe service <name> -n nap
```

## Volume：为容器挂载文件

Volume 是挂载到 Pod 中的一段文件存储。

最简单的临时 Volume 会随着 Pod 消失。要保存 Agent 工作目录，需要使用
持久化 Volume。

为了把“应用需要多少存储”与“存储具体来自哪里”分开，Kubernetes 提供：

```text
StorageClass
    ↓ 动态创建
PersistentVolume
    ↑ 绑定
PersistentVolumeClaim
    ↑ 被 Pod 挂载
```

下面分别解释这些概念。

## PV：实际存储

PV 是 PersistentVolume 的缩写，表示 Kubernetes 集群中的一块持久存储。

它可能来自：

- 云硬盘。
- 本地磁盘。
- NFS。
- CephFS。
- 其他 CSI 存储系统。

PV 关注的是存储基础设施本身，例如容量、访问模式和回收策略。

通常应用开发者不会手动创建 PV，而是通过 PVC 请求存储，交给
StorageClass 动态创建 PV。

## PVC：应用的存储申请

PVC 是 PersistentVolumeClaim 的缩写，可以理解为：

> 应用向 Kubernetes 提交的一张硬盘申请单。

示例：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: agent-123-workspace
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard
  resources:
    requests:
      storage: 10Gi
```

它表达的是：

```text
我要一块 10Gi 的存储
使用 standard 存储类型
允许单个节点读写
```

Pod 通过 PVC 挂载存储：

```yaml
spec:
  containers:
    - name: agent
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: agent-123-workspace
```

容器看到的是 `/workspace`，但数据实际保存在 PVC 对应的存储系统中。

在 `agent-platform` 中，每个 Workspace 都有独立 PVC：

```text
Workspace 123
  ├── Deployment
  ├── Service
  └── PVC
       └── Agent 工作目录
```

Pod 被重建后，新 Pod 会重新挂载这个 PVC，所以工作目录仍然存在。

需要注意：`agent-platform` 删除 Workspace 时也会删除对应 PVC。这意味着
Workspace 删除后，文件是否还能恢复取决于底层 PV 的回收策略和备份方案。

常用命令：

```bash
kubectl get pvc -n nap
kubectl describe pvc <pvc-name> -n nap
kubectl get pv
```

## StorageClass：如何提供存储

StorageClass 描述 Kubernetes 应该如何创建存储。

示例：

```text
standard     云硬盘或默认磁盘
local-path   节点本地目录
nfs-csi      NFS 存储
cephfs       CephFS 共享存储
```

PVC 指定 StorageClass 后，StorageClass 对应的 provisioner 会动态创建 PV。

```text
PVC 请求 nfs-csi
       ↓
NFS CSI Provisioner 创建 PV
       ↓
PVC 与 PV 绑定
       ↓
Pod 挂载
```

查看集群中的 StorageClass：

```bash
kubectl get storageclass
```

## RWO 与 RWX

PVC 最容易混淆的是访问模式。

### ReadWriteOnce（RWO）

表示存储卷可以被一个节点以读写方式挂载。

适合：

- 单个 Agent 的独立工作目录。
- PostgreSQL 单实例的数据盘。
- 不需要多个节点同时读写的状态数据。

RWO 不是严格的“只能被一个 Pod 使用”。它主要限制的是节点；同一节点上的
多个 Pod 是否能同时挂载，还取决于存储驱动。

### ReadWriteMany（RWX）

表示多个节点可以同时以读写方式挂载同一个存储卷。

适合：

- 多个 Agent 共享文件。
- AFS 共享文件系统。
- 需要跨节点访问的公共目录。

常见支持 RWX 的存储包括：

- NFS。
- CephFS。
- 部分云厂商共享文件系统。

普通云硬盘和本地磁盘通常只支持 RWO。

### Agent Platform 中的选择

```text
单 Workspace 工作目录    RWO PVC
多个 Workspace 共享 AFS  RWX PVC
PostgreSQL 实例数据       RWO PVC
```

如果 AFS 使用了不支持 RWX 的 StorageClass，相关 Pod 通常会一直处于
`Pending` 状态。

## ConfigMap 与 Secret

ConfigMap 和 Secret 都用于向 Pod 注入配置。

### ConfigMap

保存非敏感配置：

```text
服务地址
功能开关
配置文件
日志级别
```

### Secret

保存敏感数据：

```text
数据库密码
API Key
Token
加密密钥
```

两者都可以作为环境变量或文件挂载到容器中。

需要注意：Kubernetes Secret 默认只是 Base64 编码，不等于加密。生产环境还应
配置 etcd 静态加密、权限控制或外部 Secret 管理系统。

常用命令：

```bash
kubectl get configmaps -n nap
kubectl get secrets -n nap
kubectl describe configmap <name> -n nap
```

不要把 Secret 内容复制到日志或终端共享记录中。

## ServiceAccount 与 RBAC

Kubernetes 内部的程序通过 ServiceAccount 表明自己的身份。

RBAC 决定这个身份可以操作哪些资源：

```text
ServiceAccount
      ↓ RoleBinding
Role
  ├── 可以读取 Pod
  ├── 可以创建 Deployment
  ├── 可以调整副本数
  └── 可以创建 PVC
```

`env-runner-k8s` 使用 Namespace 范围的 Role，主要管理：

```text
pods
services
events
persistentvolumeclaims
deployments
deployments/scale
```

这比授予整个集群管理员权限更安全。

## Job 与 CronJob

Job 用于执行一次性任务，并等待任务成功结束。

`agent-platform` 使用 Job 完成：

- 创建管理员。
- 初始化 OAuth Client。
- 初始化 MCP Catalog。

CronJob 则按时间周期创建 Job，适合定时清理或维护任务。

```bash
kubectl get jobs -n nap
kubectl logs job/<job-name> -n nap
```

## CRD 与 Operator

Kubernetes 内置 Deployment、Service 和 PVC 等资源，但也允许扩展新的资源类型。

CRD 是 CustomResourceDefinition，用于定义自定义资源。
Operator 是负责管理这些资源的控制器。

`agent-platform` 使用 CloudNativePG Operator 管理 PostgreSQL：

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
```

这里的 `Cluster` 不是 Kubernetes 内置资源，而是 CloudNativePG 提供的 CRD。

CloudNativePG Operator 负责把这个声明转换成实际的：

- PostgreSQL Pod。
- PVC。
- Service。
- 主从复制。
- 故障恢复。

因此项目不需要自己维护 PostgreSQL StatefulSet 和高可用逻辑。

## StatefulSet 是什么

StatefulSet 与 Deployment 类似，但更适合有状态服务：

- Pod 名称稳定。
- Pod 启动顺序稳定。
- 每个 Pod 可以拥有独立 PVC。
- 适合数据库和有固定身份的集群节点。

不过 `agent-platform` 没有直接编写 PostgreSQL StatefulSet，而是交给
CloudNativePG Operator 生成和管理。

Agent Workspace 使用 Deployment，因为 Agent 只需要一个可以重建的运行实例，
持久状态放在独立 PVC 中。

## NodePort、Ingress 与外部访问

集群内部通过 ClusterIP Service 通信，但浏览器在集群外部。

常见暴露方式：

```text
NodePort
  节点 IP + 固定端口

Ingress
  域名和路径转发到 ClusterIP Service

LoadBalancer
  云平台提供外部负载均衡器
```

`agent-platform` 自托管安装支持：

- 默认使用 NodePort。
- 使用外部 Ingress 时改为 ClusterIP。

生产环境通常更适合：

```text
用户
  ↓ HTTPS
Ingress / Load Balancer
  ↓
Control Plane Service
  ↓
Control Plane Pod
```

## Kubernetes 中的 Agent 生命周期

以一个 Workspace 为例：

### 创建

```text
Control Plane 创建 workspace_placements
  desired_phase = running
        ↓
Env Runner 发现资源不存在
        ↓
创建 PVC
创建 Deployment
创建 Service
        ↓
Deployment 创建 Agent Pod
        ↓
Runner 写回 observed_phase
```

### 停止

```text
desired_phase = stopped
        ↓
Deployment replicas = 0
        ↓
Agent Pod 消失
PVC 保留
Service 可以保留
```

### 恢复

```text
desired_phase = running
        ↓
Deployment replicas = 1
        ↓
新 Pod 挂载原 PVC
        ↓
Agent 恢复工作目录
```

### 删除

```text
desired_phase = deleted
        ↓
删除 Deployment
删除 Service
删除 PVC
删除 placement
```

## 常见状态与排查思路

### Pod 一直 Pending

常见原因：

- 没有足够 CPU 或内存。
- PVC 无法绑定。
- StorageClass 不存在。
- 请求 RWX，但存储不支持。
- Node Selector 找不到匹配节点。

```bash
kubectl describe pod <pod-name> -n nap
kubectl describe pvc <pvc-name> -n nap
kubectl get events -n nap --sort-by=.lastTimestamp
```

### Pod 反复重启

常见原因：

- 应用启动失败。
- 环境变量缺失。
- 健康检查失败。
- 内存超限，被标记为 `OOMKilled`。

```bash
kubectl get pods -n nap
kubectl describe pod <pod-name> -n nap
kubectl logs <pod-name> -n nap --previous
```

### ImagePullBackOff

表示镜像拉取失败：

- 镜像名称或 Tag 错误。
- 私有仓库认证失败。
- 节点无法访问镜像仓库。

### PVC 一直 Pending

重点检查：

```bash
kubectl get storageclass
kubectl describe pvc <pvc-name> -n nap
```

常见原因是 StorageClass 名称错误、Provisioner 未运行或访问模式不受支持。

### Service 无法连接

检查：

- Service Selector 是否匹配 Pod Label。
- Pod 是否 Ready。
- Service 端口和容器端口是否一致。
- 请求是否来自允许访问 ClusterIP 的网络。

```bash
kubectl describe service <service-name> -n nap
kubectl get endpoints <service-name> -n nap
```

## 阅读 YAML 的最小方法

看到 Kubernetes YAML 时，先找四个位置：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: nap
spec:
  # 资源具体配置
```

阅读顺序：

1. `kind`：它是什么资源？
2. `metadata.name`：资源叫什么？
3. `metadata.namespace`：它在哪个 Namespace？
4. `spec`：希望 Kubernetes 如何运行它？

对于 Deployment，再重点看：

```text
replicas
containers[].image
containers[].env
containers[].ports
containers[].resources
containers[].volumeMounts
volumes
```

对于 PVC，重点看：

```text
storageClassName
accessModes
resources.requests.storage
```

对于 Service，重点看：

```text
type
selector
ports
```

## Agent Hub 第一阶段需要多少 Kubernetes

如果当前目标是验证 Agent Hub 的业务模型，不必一开始部署完整 K8s 架构。

推荐演进顺序：

```text
第一阶段
  本地进程或 Docker
  PostgreSQL
  Workspace / Session / Message

第二阶段
  抽象 Runner 接口
  desired / observed placement

第三阶段
  Kubernetes Runner
  Deployment + Service + PVC

第四阶段
  多集群、AFS、远程浏览器、Sandbox
```

真正需要 Kubernetes 的信号包括：

- 需要在多台服务器调度 Agent。
- 需要 Agent 崩溃后自动恢复。
- 需要统一管理 CPU、内存和存储配额。
- 需要大量 Agent 按需启动和停止。
- 需要隔离不同用户或团队的运行环境。

在这些需求出现前，本地 Runner 或 Docker Runner 更容易开发和调试。

## 概念速查表

| 概念 | 简单理解 | Agent Platform 中的用途 |
| --- | --- | --- |
| Cluster | 一组被统一管理的服务器 | 运行整个平台和 Agent |
| Node | 集群中的一台服务器 | 实际承载 Pod |
| Namespace | 资源逻辑分组 | 隔离平台资源和权限 |
| Pod | 最小运行单位 | 运行 Agent 和 Sidecar |
| Deployment | Pod 管理器 | 启停、更新 Agent |
| Service | 稳定网络地址 | 访问不断重建的 Agent Pod |
| Volume | Pod 挂载的文件存储 | 提供工作目录 |
| PV | 实际持久存储 | 云盘、NFS 或 CephFS |
| PVC | 应用的存储申请 | 为 Workspace 申请硬盘 |
| StorageClass | 存储创建规则 | 决定 PVC 使用哪种存储 |
| RWO | 单节点读写 | Workspace 和数据库存储 |
| RWX | 多节点共享读写 | AFS 共享文件 |
| ConfigMap | 非敏感配置 | 服务地址和配置文件 |
| Secret | 敏感配置 | 密码、Token、密钥 |
| ServiceAccount | Pod 的集群身份 | Env Runner 身份 |
| RBAC | Kubernetes 权限规则 | 限制 Runner 可操作的资源 |
| Job | 一次性任务 | 初始化管理员和系统数据 |
| CRD | 自定义资源类型 | CloudNativePG Cluster |
| Operator | 自定义资源控制器 | 管理 PostgreSQL 集群 |
| Reconcile | 让实际状态追上期望状态 | 启停和更新 Agent |

## 推荐阅读顺序

结合 `agent-platform` 源码，建议依次阅读：

1. `self-host/manifests/control-plane.yaml`
2. `internal/k8s-provider/provider.ts`
3. `internal/env-runner-core/reconcile.ts`
4. `self-host/manifests/postgres.yaml`
5. `self-host/manifests/afs.yaml`
6. `charts/env-runner-k8s/templates/`

先理解 Deployment、Service 和 PVC，再看 AFS、Operator 和远程 Runner，
会比直接阅读完整安装脚本容易得多。
