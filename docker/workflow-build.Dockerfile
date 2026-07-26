# The image workflow builds run in.
#
# This one has a network and a package manager, because resolving arbitrary npm is the whole job.
# What it does not have is any credential: no bot token, no master key, no database, and no
# control-plane source. A malicious install script runs here or nowhere.
FROM node:24-alpine

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# The SDK's type declarations, so a workflow can import it without resolving it from the registry —
# and so the version it compiles against is the one the control plane will run it under.
COPY packages/workflow-sdk/dist /sdk/dist
COPY packages/workflow-sdk/package.json /sdk/package.json
RUN cd /build 2>/dev/null || mkdir -p /build; \
    mkdir -p /build/node_modules/@discord-mcp && \
    ln -s /sdk /build/node_modules/@discord-mcp/workflow-sdk && \
    chown -R 65534:65534 /build

# The TypeScript the build compiles with, pinned here rather than resolved per build: a workflow
# that could choose its own compiler could choose one that does not typecheck.
RUN cd /build && pnpm add --save-dev typescript@7.0.2 && chown -R 65534:65534 /build

USER 65534:65534
WORKDIR /build

CMD ["/bin/sh", "/build/build.sh"]
