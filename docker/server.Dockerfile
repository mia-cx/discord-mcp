# The MCP control plane.
#
# Holds the bot token, the master key, and the database — and no Docker socket. Container control
# lives in the supervisor, reached over a Unix socket, so a bug in a tool handler cannot become
# control of the host.
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

# A shared group, with the same GID in the supervisor image. The two processes talk over a Unix
# socket on a shared volume, and they run as different users on purpose — so the group is what lets
# them reach each other without either one being able to become the other.
RUN addgroup -g 10000 discord-mcp && adduser -D -u 10001 -G discord-mcp discord-mcp

COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps /app/apps
COPY --from=build /src/vendor /app/vendor

# The database lives on a volume, so it survives an image upgrade. Losing it loses every stored
# OAuth2 profile, component binding, and workflow revision.
ENV DATABASE_PATH=/data/discord-mcp.sqlite
# Owned before it is declared: Docker seeds a fresh named volume from the image's directory, so
# without this the volume arrives root-owned and the non-root server cannot create its database.
RUN mkdir -p /data && chown discord-mcp:discord-mcp /data
VOLUME /data

# Where the server serves each execution's capability socket. Deliberately *not* inside
# /run/discord-mcp: that volume is the supervisor's, and a volume nested inside another has the two
# images racing to seed the parent's ownership — whichever container starts first wins, and the
# other then cannot write to its own directory.
ENV DISCORD_MCP_CAPABILITY_DIR=/run/capability
RUN mkdir -p /run/capability && chown discord-mcp:discord-mcp /run/capability

# Loopback by default. Publishing this port without a reverse proxy in front would expose a process
# holding a bot token.
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3000

USER discord-mcp:discord-mcp
WORKDIR /app

CMD ["node", "/app/apps/server/dist/bin.js"]
