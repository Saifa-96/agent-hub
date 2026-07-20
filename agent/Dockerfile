# === Build stage ===
FROM node:24.18.0-slim AS builder

RUN npm install --global pnpm@11.13.1

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY agent/package.json ./agent/package.json
RUN pnpm install --frozen-lockfile

COPY agent/src/ ./agent/src/
COPY agent/tsconfig.json agent/vite.config.ts ./agent/
RUN pnpm --filter @agent-hub/pi-agent build

# === Runtime stage ===
FROM node:24.18.0-slim

RUN npm install --global pnpm@11.13.1 \
    && apt-get update && apt-get install -y --no-install-recommends \
        git bash curl ca-certificates ripgrep jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY agent/package.json ./agent/package.json
RUN pnpm install --prod --frozen-lockfile --filter @agent-hub/pi-agent

COPY --from=builder /build/agent/dist/ ./agent/dist/

RUN mkdir -p /workspace && chown -R node:node /workspace
ENV HOME=/workspace

USER node

EXPOSE 3001

CMD ["node", "/app/agent/dist/index.js"]
