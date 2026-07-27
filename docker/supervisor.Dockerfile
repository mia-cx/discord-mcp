FROM docker:29-cli AS docker-cli

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @discord-mcp/sandbox-supervisor deploy --prod --legacy /prod

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /prod /app
CMD ["dist/main.js"]
