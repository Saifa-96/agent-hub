# === Build stage ===
FROM node:24.18.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY agent/package.json ./agent/package.json
RUN pnpm install --frozen-lockfile

COPY agent/src/ ./agent/src/
COPY agent/tsconfig.json agent/vite.config.ts ./agent/
RUN pnpm --filter @agent-hub/pi-agent build

# === Runtime stage ===
FROM node:24.18.0-slim

RUN corepack enable && corepack prepare pnpm@11.13.1 --activate \
    && apt-get update && apt-get install -y --no-install-recommends \
        git bash curl ca-certificates ripgrep jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY agent/package.json ./agent/package.json
RUN pnpm install --prod --frozen-lockfile --filter @agent-hub/pi-agent

COPY --from=builder /build/agent/dist/ ./agent/dist/

RUN mkdir -p /workspace && chown -R node:node /workspace
ENV WORKSPACE_DIR=/workspace HOME=/workspace

USER node

EXPOSE 3001
WORKDIR /workspace

CMD ["node", "/app/agent/dist/index.js"]
