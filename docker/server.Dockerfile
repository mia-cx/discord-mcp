# The MCP control plane.
#
# Holds the bot token, the master key, and the database — and no Docker socket. Container control
# lives in the supervisor, reached over a Unix socket, so a bug in a tool handler cannot become
# control of the host.
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /src

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-alpine

RUN addgroup -g 10001 discord-mcp && adduser -D -u 10001 -G discord-mcp discord-mcp

COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps /app/apps
COPY --from=build /src/vendor /app/vendor

# The database lives on a volume, so it survives an image upgrade. Losing it loses every stored
# OAuth2 profile, component binding, and workflow revision.
ENV DATABASE_PATH=/data/discord-mcp.sqlite
VOLUME /data

# Loopback by default. Publishing this port without a reverse proxy in front would expose a process
# holding a bot token.
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3000

USER discord-mcp:discord-mcp
WORKDIR /app

CMD ["node", "/app/apps/server/dist/bin.js"]
