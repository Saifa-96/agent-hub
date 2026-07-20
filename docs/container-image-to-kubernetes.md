# 从源码到 Kubernetes：Agent 镜像构建、注册、发布与拉取

本文面向第一次接触容器镜像和 Kubernetes 镜像部署的开发者，目标是解释
`agent-hub` 的代码如何变成一个可以被 Kubernetes 运行的 Agent Pod。

读完后，你应该能够理解下面这条链路：

```text
源码 + Dockerfile
        ↓ build
本地容器镜像
        ↓ push
镜像仓库 Registry
        ↓ pull
Kubernetes Node
        ↓ run
Agent Container / Pod
```

本文只讨论镜像生命周期。Deployment、Service、PVC 等 Kubernetes 概念见 [Kubernetes 入门](kubernetes-for-agent-hub.md)。

## 先区分几个概念

### Dockerfile

Dockerfile 是构建镜像的说明书，描述：

- 使用哪个基础镜像。
- 安装哪些系统包和依赖。
- 复制哪些代码和构建产物。
- 容器启动时执行什么命令。

本项目的 Dockerfile 位于：

```text
agent/Dockerfile
```

Dockerfile 本身不是镜像，也不能直接被 Kubernetes 运行。

### Image：镜像

镜像是只读的应用包，通常包含：

- Linux 基础文件系统。
- Node.js。
- 生产依赖。
- Agent 构建产物。
- Git、curl、ripgrep 等工具。
- 默认启动命令。

可以把镜像理解为一个不可变的应用安装包。

### Container：容器

容器是镜像运行后的进程实例：

```text
镜像 = 安装包
容器 = 安装包启动后的进程
```

同一个镜像可以同时启动许多容器。`agent-platform` 为每个 Workspace 创建
独立的 Agent Pod，但这些 Pod 可以使用同一个 Agent 镜像。

### Registry：镜像仓库

Registry 是专门保存和分发镜像的服务，作用类似代码领域的 Git Server。

常见 Registry：

- Docker Hub。
- AWS ECR。
- Google Artifact Registry。
- Azure Container Registry。
- 阿里云 ACR。
- 腾讯云 TCR。
- 自托管 Harbor。

Git 仓库保存源码，Registry 保存构建后的镜像。Kubernetes 通常从 Registry 拉取镜像，而不是从 Git 仓库构建源码。

### Repository、Tag 与 Digest

完整镜像名称通常是：

```text
registry.example.com/agent-platform/nap-agent-pi:a1b2c3d4e5f6
└────── Registry ──────┘ └── Repository ──┘ └─── Tag ────┘
```

Tag 是方便人阅读的版本名称：

```text
:latest
:dev
:v1.2.0
:a1b2c3d4e5f6
```

Digest 是镜像内容的加密摘要：

```text
registry.example.com/agent-platform/nap-agent-pi@sha256:abc123...
```

同一个 Tag 可以被重新指向另一个镜像，但 Digest 永远表示相同内容。因此：

- 开发环境可以使用 `dev`。
- 正式发布建议使用 Git SHA 或版本号。
- 对可复现要求最高时使用 Digest。
- 不建议生产环境长期依赖会变化的 `latest`。

## build、push、pull、run 分别是什么

### build：构建

构建读取源码和 Dockerfile，生成镜像：

```bash
docker build -f agent/Dockerfile -t agent-hub/pi-agent:dev .
```

参数含义：

```text
-f agent/Dockerfile       使用哪个 Dockerfile
-t agent-hub/pi-agent:dev 给镜像命名和打 Tag
.                         构建上下文是仓库根目录
```

最后的 `.` 很重要。它表示 Docker 可以读取仓库根目录下的文件。本项目是
monorepo，Dockerfile 需要根目录的 `package.json`、workspace 配置和
lockfile，所以必须从仓库根目录构建。

构建完成后，镜像只存在于当前机器，还不能被远程 Kubernetes 集群使用。

### push：推送

Push 将本地镜像上传到 Registry：

```bash
docker push registry.example.com/agent-platform/nap-agent-pi:dev
```

推送之前需要：

1. Registry 中存在对应项目或 Repository。
2. 当前用户有写入权限。
3. 执行过 `docker login`。

### pull：拉取

Pull 从 Registry 下载镜像：

```bash
docker pull registry.example.com/agent-platform/nap-agent-pi:dev
```

在 Kubernetes 中通常不需要人工执行。Pod 被调度到某个 Node 后，该 Node 上的容器运行时会自动拉取镜像。

### run：运行

本地运行镜像：

```bash
docker run --rm \
  --env-file .env \
  -p 3001:3001 \
  -v "$(pwd)/workspace:/workspace" \
  agent-hub/pi-agent:dev
```

参数含义：

```text
--rm                         停止后删除容器
--env-file .env              运行时注入环境变量
-p 3001:3001                 将本机 3001 映射到容器 3001
-v 本地目录:/workspace        将工作目录挂载进容器
```

不要把 `.env` 或 API Key 构建进镜像。

## 为什么会看到 linux/amd64 和 linux/arm64

一个操作系统需要为具体 CPU 指令集编译程序。容器镜像也有目标操作系统和 CPU 架构。

常见组合：

| 平台 | 常见机器 |
| --- | --- |
| `linux/amd64` | Intel/AMD Linux 服务器、大多数云服务器 |
| `linux/arm64` | ARM 云服务器、树莓派、Apple Silicon 对应的 ARM 架构 |
| `darwin/arm64` | Apple Silicon macOS，不是 Kubernetes Linux 容器平台 |

这里容易混淆的地方是：在 M 系列 Mac 上构建容器时，宿主机是
`darwin/arm64`，但 Docker Desktop 运行的是 Linux 虚拟机，因此构建出的
容器平台通常是 `linux/arm64`。

### 架构不匹配会发生什么

如果 Kubernetes Node 是 AMD64，但镜像只有 ARM64 版本，容器可能启动失败并出现：

```text
exec format error
```

因此构建前应先查看 Kubernetes Node 架构：

```bash
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,OS:.status.nodeInfo.operatingSystem,ARCH:.status.nodeInfo.architecture'
```

输出示例：

```text
NAME       OS      ARCH
worker-1   linux   amd64
worker-2   linux   amd64
```

此时应构建：

```text
linux/amd64
```

### 单架构镜像

如果所有集群节点都是 AMD64，只构建 AMD64 最简单：

```bash
docker buildx build \
  --platform linux/amd64 \
  -f agent/Dockerfile \
  -t registry.example.com/agent-platform/nap-agent-pi:dev \
  --push \
  .
```

即使在 ARM64 Mac 上，Docker Buildx 通常也能通过模拟器构建 AMD64 镜像，只是速度可能更慢。

### 多架构镜像

如果集群同时有 AMD64 和 ARM64 Node，可以发布同一个 Tag 的多架构镜像：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f agent/Dockerfile \
  -t registry.example.com/agent-platform/nap-agent-pi:dev \
  --push \
  .
```

Registry 保存一个 manifest list。Kubernetes Node 拉取时会自动选择匹配自身架构的版本。

当前阶段如果集群架构统一，不需要为了“以后可能用到”而构建多架构镜像。

## Docker Buildx 是什么

传统 `docker build` 主要构建当前机器对应的平台。Buildx 是 Docker 官方的增强构建工具，支持：

- 指定目标平台。
- 构建多架构镜像。
- 直接推送到 Registry。
- 远程构建缓存。

确认 Buildx 可用：

```bash
docker buildx version
docker buildx inspect --bootstrap
```

常见输出方式：

```text
--load   构建后加载到本地 Docker，适合本地测试
--push   构建后直接推送 Registry，适合发布
```

例如本地测试：

```bash
docker buildx build \
  -f agent/Dockerfile \
  -t agent-hub/pi-agent:dev \
  --load \
  .
```

发布到 Registry：

```bash
docker buildx build \
  --platform linux/amd64 \
  -f agent/Dockerfile \
  -t registry.example.com/agent-platform/nap-agent-pi:dev \
  --push \
  .
```

使用 `--push` 时，镜像不一定同时出现在本地 `docker images` 中，但已经存在于 Registry。

## 不使用 GitHub Actions 的完整发布流程

GitHub Actions 只是代替人执行构建命令，不是镜像发布的必要组件。当前项目可以先使用本地 Buildx。

### 第一步：确定 Registry

假设 Registry 地址是：

```text
registry.example.com
```

项目路径是：

```text
agent-platform
```

Agent 镜像名是：

```text
nap-agent-pi
```

完整 Repository 为：

```text
registry.example.com/agent-platform/nap-agent-pi
```

### 第二步：登录 Registry

```bash
docker login registry.example.com
```

Registry 会要求用户名和密码或 Access Token。

不要把密码写进仓库、Dockerfile 或 Shell 脚本。

### 第三步：确定版本 Tag

使用当前 Git Commit 的前 12 位：

```bash
TAG=$(git rev-parse --short=12 HEAD)
echo "$TAG"
```

例如：

```text
671ce63f19ab
```

### 第四步：构建并推送

先确认集群架构，然后执行：

```bash
REGISTRY=registry.example.com/agent-platform
TAG=$(git rev-parse --short=12 HEAD)

docker buildx build \
  --platform linux/amd64 \
  --file agent/Dockerfile \
  --tag "$REGISTRY/nap-agent-pi:$TAG" \
  --push \
  .
```

这条命令同时完成：

```text
读取源码
  ↓
构建 linux/amd64 镜像
  ↓
命名为 nap-agent-pi:<Git SHA>
  ↓
推送到 Registry
```

### 第五步：确认镜像

```bash
docker buildx imagetools inspect \
  "$REGISTRY/nap-agent-pi:$TAG"
```

重点确认：

- Tag 正确。
- Digest 存在。
- Platform 与集群 Node 匹配。

### 第六步：让 Kubernetes 使用镜像

普通 Deployment 会直接指定：

```yaml
containers:
  - name: agent
    image: registry.example.com/agent-platform/nap-agent-pi:671ce63f19ab
```

`agent-platform` 则通过两个配置拼接镜像：

```text
AGENT_IMAGE_PREFIX=registry.example.com/agent-platform/nap-agent
AGENT_IMAGE_TAG=671ce63f19ab
```

当 Workspace 的 `agent_type` 是 `pi` 时：

```text
<AGENT_IMAGE_PREFIX>-<agent_type>:<AGENT_IMAGE_TAG>
```

最终得到：

```text
registry.example.com/agent-platform/nap-agent-pi:671ce63f19ab
```

Env Runner 创建 Deployment 后，Kubernetes 会自动完成拉取和启动。

## 私有 Registry 认证

如果 Registry 是私有的，开发机登录成功并不代表 Kubernetes Node 也有权限。

需要在目标 Namespace 创建 `imagePullSecret`：

```bash
kubectl create secret docker-registry agent-registry \
  --namespace nap \
  --docker-server="$REGISTRY_HOST" \
  --docker-username="$REGISTRY_USER" \
  --docker-password="$REGISTRY_PASSWORD"
```

Pod 模板引用该 Secret：

```yaml
spec:
  imagePullSecrets:
    - name: agent-registry
```

`agent-platform` 对应配置是：

```text
IMAGE_PULL_SECRET=agent-registry
```

这个 Secret 只负责 Registry 拉取认证，不是模型 API Key。

## 运行时 Secret 与镜像 Secret 的区别

这里存在两类完全不同的 Secret。

### Registry Secret

作用：允许 Kubernetes 拉取私有镜像。

```text
用户名
密码 / Registry Token
```

由 `imagePullSecrets` 使用。

### Agent Runtime Secret

作用：Agent 运行后访问模型 API。

```text
DEEPSEEK_API_KEY
```

通过环境变量或 Secret Volume 注入 Agent 容器：

```yaml
env:
  - name: DEEPSEEK_API_KEY
    valueFrom:
      secretKeyRef:
        name: pi-agent-runtime
        key: DEEPSEEK_API_KEY
```

创建示例：

```bash
kubectl create secret generic pi-agent-runtime \
  --namespace nap \
  --from-literal=DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY"
```

当前 `agent-hub` 从运行时环境读取 `DEEPSEEK_API_KEY`。在实现从 Agent
Platform Control Plane 动态拉取凭据之前，Kubernetes Pod 模板必须显式注入
这个 Secret。

以下做法都不安全：

```dockerfile
COPY .env /app/.env
ENV DEEPSEEK_API_KEY=真实密钥
```

也不要将真实密钥作为普通 Docker build argument，因为它可能进入镜像历史和构建缓存。

## Kubernetes 什么时候拉取镜像

大致流程：

```text
Env Runner 创建 Deployment
        ↓
Deployment Controller 创建 Pod
        ↓
Scheduler 选择一个 Node
        ↓
Node 上的 kubelet 检查本地是否有镜像
        ↓
必要时从 Registry pull
        ↓
容器运行时启动 Agent Container
```

`imagePullPolicy` 控制拉取行为：

| 策略 | 行为 |
| --- | --- |
| `Always` | 每次启动都向 Registry 检查镜像 |
| `IfNotPresent` | Node 本地不存在时才拉取 |
| `Never` | 永远不拉取，只使用 Node 本地镜像 |

使用不可变 Git SHA Tag 时，推荐：

```yaml
imagePullPolicy: IfNotPresent
```

每次发布使用新 Tag，Deployment 镜像变化后 Kubernetes 会拉取新镜像，不需要依赖 `Always`。

## 发布与部署不是同一件事

这两个词经常被混用：

```text
发布镜像
  = build + push
  = Registry 中出现新版本

部署镜像
  = 修改 Kubernetes 期望镜像
  = 创建或更新 Deployment
```

只 Push 镜像不会自动修改正在运行的 Pod。

使用新 Git SHA Tag 时，需要让 `AGENT_IMAGE_TAG` 或 Deployment 的 `image`
指向新 Tag，然后触发 Workspace rebuild。这样版本变化清晰，也容易回滚。

## 回滚

使用不可变 Tag 后，回滚只是重新选择旧 Tag：

```text
当前：nap-agent-pi:bad123
回滚：nap-agent-pi:good456
```

不需要重新构建旧代码，因为旧镜像仍在 Registry 中。

Registry 应配置合理的保留策略，不要立即删除所有旧版本。

## 本地 Kind 或 Minikube 可以不使用 Registry

本地学习时可以把镜像直接加载进本地集群。

Kind：

```bash
docker build -f agent/Dockerfile -t nap-agent-pi:dev .
kind load docker-image nap-agent-pi:dev
```

Minikube：

```bash
docker build -f agent/Dockerfile -t nap-agent-pi:dev .
minikube image load nap-agent-pi:dev
```

Pod 使用：

```yaml
image: nap-agent-pi:dev
imagePullPolicy: IfNotPresent
```

这种方式适合本地单集群调试，不适合生产集群或多节点共享。

## 常见问题排查

### Docker daemon 未运行

典型错误：

```text
failed to connect to the docker API
```

先启动 Docker Desktop、Colima 或对应 Docker daemon，再执行构建。

### 构建找不到 package.json 或 lockfile

确认在仓库根目录执行，并保留最后的 `.`：

```bash
docker build -f agent/Dockerfile -t agent-hub/pi-agent:dev .
```

不要在 `agent/` 目录内把构建上下文设置为 `.`，因为 Dockerfile 需要读取 monorepo 根文件。

### unauthorized

发生在 Push 时，通常表示：

- 没有执行 `docker login`。
- Token 没有写权限。
- Registry 项目或 Repository 名称错误。

### ImagePullBackOff

发生在 Kubernetes Pull 时，检查：

```bash
kubectl describe pod <pod-name> -n nap
kubectl get events -n nap --sort-by=.lastTimestamp
```

常见原因：

- 镜像名称或 Tag 不存在。
- Registry Secret 错误。
- `imagePullSecrets` 未配置。
- Node 无法访问 Registry。

### exec format error

通常是镜像 CPU 架构与 Node 不匹配。分别检查：

```bash
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,ARCH:.status.nodeInfo.architecture'

docker buildx imagetools inspect <image>
```

### Pod 启动但 Agent 无法调用模型

这通常不是镜像拉取问题，而是运行时没有注入：

```text
DEEPSEEK_API_KEY
```

检查 Pod 环境变量来源和 Kubernetes Secret，不要通过重新构建镜像解决运行时密钥问题。

### Tag 已 Push，但 Pod 仍运行旧版本

如果重复使用相同 Tag，并且 `imagePullPolicy: IfNotPresent`，Node 可能继续使用本地缓存。

最简单的解决方式不是清缓存，而是每次发布使用新的 Git SHA Tag。

## 当前项目推荐的最小流程

第一次完成下面这条链路即可，不需要先建设 CI：

```text
1. 确认 Kubernetes Node 架构
2. 选择一个 Registry
3. docker login
4. 使用 Git SHA 构建并 push nap-agent-pi
5. 配置 Kubernetes imagePullSecret
6. 给 Agent Pod 注入 DEEPSEEK_API_KEY
7. 配置 AGENT_IMAGE_PREFIX 和 AGENT_IMAGE_TAG
8. 创建或重建一个 pi Workspace
9. 检查 Pod、日志、健康接口和聊天请求
```

发布命令模板：

```bash
REGISTRY=registry.example.com/agent-platform
TAG=$(git rev-parse --short=12 HEAD)
IMAGE="$REGISTRY/nap-agent-pi:$TAG"

docker buildx build \
  --platform linux/amd64 \
  --file agent/Dockerfile \
  --tag "$IMAGE" \
  --push \
  .

echo "Published $IMAGE"
```

这条手动命令稳定运行后，再根据发布频率决定是否迁移到 Jenkins、GitLab CI、Tekton 或其他自动化系统。

## 概念速查表

| 概念 | 简单理解 |
| --- | --- |
| Dockerfile | 镜像构建说明书 |
| Build context | 构建时 Docker 可以读取的文件范围 |
| Image | 只读应用安装包 |
| Container | 镜像运行后的进程实例 |
| Registry | 保存和分发镜像的服务 |
| Repository | Registry 中某一类镜像的集合 |
| Tag | 可读的镜像版本名称 |
| Digest | 不可变的镜像内容标识 |
| Build | 从源码生成镜像 |
| Push | 把镜像上传到 Registry |
| Pull | 从 Registry 下载镜像 |
| Run | 从镜像启动容器 |
| `linux/amd64` | Intel/AMD Linux 平台 |
| `linux/arm64` | ARM Linux 平台 |
| Buildx | 支持跨平台和多架构的 Docker 构建工具 |
| imagePullSecret | Kubernetes 拉取私有镜像的认证信息 |
| Runtime Secret | Agent 运行时使用的模型密钥等敏感配置 |
