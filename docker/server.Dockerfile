FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @discord-mcp/server deploy --prod --legacy /prod

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod /app
CMD ["dist/main.js"]
