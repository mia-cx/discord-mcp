# The sandbox supervisor.
#
# The only process that touches the Docker socket. It holds no bot token, no master key, and no
# database — its whole authority is over containers, and its whole interface is five commands.
#
# Run this against **rootless** Docker. Under rootful Docker a container escape is a host root
# escape, and none of the restrictions here would compensate.
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# `pnpm prune` refuses to remove a modules directory without a TTY unless it knows it is in CI.
ENV CI=true

# argon2 has no musl prebuild, so it compiles here. It is not optional: personal access tokens are
# hashed with argon2id, and without the binding the auth package does not load at all.
RUN apk add --no-cache python3 make g++

WORKDIR /src

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
# `pnpm build` runs scripts/copy-assets.mjs, which copies the generated catalog schemas into dist.
# Without it the server starts and then fails at the first API call with a missing file.
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine

# The Docker CLI, because the supervisor shells out with argv arrays rather than speaking the HTTP
# API. There is no shell in the path a caller controls, so there is nothing to inject into.
RUN apk add --no-cache docker-cli

RUN addgroup -g 10002 supervisor && adduser -D -u 10002 -G supervisor supervisor

COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps /app/apps

# Shared with the control plane, owner-only. The supervisor creates the socket here at 0600 inside a
# 0700 directory, so filesystem permissions are the first gate and the service credential the second.
VOLUME /run/discord-mcp
ENV DISCORD_MCP_SUPERVISOR_SOCKET=/run/discord-mcp/supervisor.sock

USER supervisor:supervisor
WORKDIR /app

CMD ["node", "/app/apps/sandbox-supervisor/dist/bin.js"]
