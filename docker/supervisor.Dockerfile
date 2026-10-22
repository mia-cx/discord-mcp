# The sandbox supervisor.
#
# The only process that touches the Docker socket. It holds no bot token, no master key, and no
# database — its whole authority is over containers, and its whole interface is five commands.
#
# Run this against **rootless** Docker. Under rootful Docker a container escape is a host root
# escape, and none of the restrictions here would compensate.
FROM node:24.22.1-alpine AS build

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

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.22.1-alpine

# The Docker CLI, because the supervisor shells out with argv arrays rather than speaking the HTTP
# API. There is no shell in the path a caller controls, so there is nothing to inject into.
RUN apk add --no-cache docker-cli

# The same GID as the control plane's image. Different users, one shared group: that is what makes
# the socket reachable by exactly those two processes and nothing else on the host.
RUN addgroup -g 10000 discord-mcp && adduser -D -u 10002 -G discord-mcp supervisor

COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps /app/apps

# Shared with the control plane. The supervisor creates the socket here at 0660 inside a 0770
# directory, both group-owned by `discord-mcp` — so filesystem permissions are the first gate and
# the service credential the second, and the two are the only processes that pass either.
RUN mkdir -p /run/discord-mcp && chown supervisor:discord-mcp /run/discord-mcp
VOLUME /run/discord-mcp
ENV DISCORD_MCP_SUPERVISOR_SOCKET=/run/discord-mcp/supervisor.sock

USER supervisor:discord-mcp
WORKDIR /app

CMD ["node", "/app/apps/sandbox-supervisor/dist/bin.js"]
