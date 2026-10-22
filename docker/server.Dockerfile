# Stateless Discord MCP relay. HTTP credentials arrive with each request.
FROM node:24.22.1-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# `pnpm prune` refuses to remove a modules directory without a TTY unless it knows it is in CI.
ENV CI=true

# The workspace retains the legacy auth library, whose native dependency needs a musl build.
# The relay entrypoint does not load that library.
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

# Run the relay as an unprivileged user.
RUN addgroup -g 10000 discord-mcp && adduser -D -u 10001 -G discord-mcp discord-mcp

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
