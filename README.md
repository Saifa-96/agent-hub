# Agent Hub

基于 Neutree Agent Platform 架构、使用 pi SDK 实现的 agent runtime。项目聚焦 data plane：接收 control plane 请求，运行 agent，并通过 SSE 输出标准化的 UniversalEvent 事件流。

## 项目结构

```text
agent/    pi-agent runtime（唯一的 pnpm workspace package）
docs/     架构与 Kubernetes 设计文档
roadmap/  实现路线
```

`docs/` 和 `roadmap/` 仅用于文档管理，不属于 pnpm workspace。

## 环境要求

- Node.js 24
- pnpm 11.13.1

## 开始使用

```bash
cp .env.example .env
pnpm install
pnpm --dir agent dev
```

在根目录 `.env` 中配置 `DEEPSEEK_API_KEY`。工作目录在开发/测试时固定为 `./workspace`，生产环境固定为 `/workspace`，模型固定为 `deepseek-v4-flash`。`.env` 已被 Git 忽略。

## 全局命令

```bash
pnpm build       # 构建所有 workspace package
pnpm typecheck   # 检查所有 package 的 TypeScript 类型
pnpm test        # 运行所有 package 的测试
pnpm test:watch  # 监听所有 package 的测试
pnpm lint        # 检查所有 package
pnpm lint:fix    # 自动格式化并修复所有 package
```

## Agent 命令

```bash
pnpm --dir agent dev    # 使用 Vite 热更新启动 agent
pnpm --dir agent start  # 运行 agent 编译产物
```

## Docker

从仓库根目录构建：

```bash
docker build -f agent/Dockerfile -t agent-hub/pi-agent .
```

容器默认使用 `/workspace` 作为 agent 工作目录，并监听 `3001` 端口。

## 文档

- [实现路线](roadmap/step-1.md)
- [Agent Platform data layer](docs/agent-platform-data-layer.md)
- [Kubernetes 设计](docs/kubernetes-for-agent-hub.md)
