# Stateless Discord MCP relay. HTTP credentials arrive with each request.
# Debian rather than Alpine: script isolates run workerd, which ships glibc binaries only.
FROM node:24.22.1-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# `pnpm prune` refuses to remove a modules directory without a TTY unless it knows it is in CI.
ENV CI=true

# The workspace retains the legacy auth library, whose native dependency may build from source.
# The relay entrypoint does not load that library.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.22.1-bookworm-slim

# workerd refuses to start without the system CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Run the relay as an unprivileged user.
RUN groupadd -g 10000 discord-mcp && useradd -M -u 10001 -g discord-mcp discord-mcp

COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps /app/apps
COPY --from=build /src/vendor /app/vendor

# Bind inside the container; Compose publishes only the host loopback interface.
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3000

USER discord-mcp:discord-mcp
WORKDIR /app

CMD ["node", "/app/apps/server/dist/bin.js"]
