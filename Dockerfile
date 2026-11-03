# Multi-target image: --target api | cloud-worker | indexer | runner-daemon
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY skills ./skills
RUN pnpm install --frozen-lockfile && pnpm -r --filter './packages/**' build && pnpm -r --filter './apps/**' --filter '!@jj/web' build

FROM base AS api
ENV API_PORT=4000
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM base AS cloud-worker
CMD ["node", "packages/workflows/dist/worker.cloud.js"]

FROM base AS indexer
CMD ["node", "apps/indexer/dist/main.js"]

# The runner daemon is meant for a host you own (laptop, Mac mini, EC2). This target is for an
# always-on Linux box; mount the project workdirs and pass vendor keys as env.
FROM base AS runner-daemon
RUN npm i -g @google/gemini-cli >/dev/null 2>&1 || true
CMD ["node", "apps/runner-daemon/dist/main.js"]
