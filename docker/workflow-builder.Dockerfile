FROM node:24-bookworm-slim AS sdk-build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim
RUN npm install --global --ignore-scripts pnpm@11.13.1 \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /builder
RUN pnpm add --allow-build=esbuild esbuild@0.28.1
COPY --from=sdk-build /app/packages/workflow-sdk /sdk
COPY --from=sdk-build /app/packages/discord-presentations /discord-presentations
RUN chmod -R a+rX /sdk /discord-presentations
COPY docker/workflow-builder.mjs /builder/workflow-builder.mjs
WORKDIR /build
CMD ["node", "/builder/workflow-builder.mjs"]
