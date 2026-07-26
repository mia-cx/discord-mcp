# The image workflow builds run in.
#
# This one has a network and a package manager, because resolving arbitrary npm is the whole job.
# What it does not have is any credential: no bot token, no master key, no database, and no
# control-plane source. A malicious install script runs here or nowhere.

# The SDK is built here rather than copied from the host: `dist/` is gitignored, so a `COPY` of it
# only works on a machine that happens to have run `pnpm build` first — which is never true of a
# clean CI checkout.
FROM node:24-alpine AS sdk

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /src

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile --ignore-scripts
# Only the SDK: this image needs its type declarations, not the control plane.
RUN pnpm exec tsc --build packages/workflow-sdk

FROM node:24-alpine

# Installed globally rather than through corepack: corepack resolves and downloads on first use,
# and this image runs as a user with no writable home and — by the time a build runs — a package
# manager it must not be fetching over the network anyway.
# Both global, because a workflow's own `pnpm install` recreates /build/node_modules and would
# otherwise delete the toolchain out from under the build. Pinning the compiler also means a
# workflow cannot choose one that does not typecheck.
RUN npm install -g pnpm@10.20.0 typescript@7.0.2

# The SDK's type declarations, so a workflow can import it without resolving it from the registry —
# and so the version it compiles against is the one the control plane will run it under.
COPY --from=sdk /src/packages/workflow-sdk/dist /sdk/dist
COPY --from=sdk /src/packages/workflow-sdk/package.json /sdk/package.json

# /build/src exists in the image because `docker cp` writes a file and will not create the
# directory above it.
RUN mkdir -p /build/src /build/node_modules/@discord-mcp && \
    ln -s /sdk /build/node_modules/@discord-mcp/workflow-sdk

# /artifact is a named volume the supervisor mounts. Docker seeds a fresh volume from the image's
# directory, so it has to exist here and be owned by the build user — otherwise the volume arrives
# root-owned and the build cannot write its own output.
RUN mkdir -p /artifact && chown -R 65534:65534 /build /sdk /artifact

# The build user owns /build and nothing else, so that is where its home and its package store go.
ENV HOME=/build
ENV PNPM_HOME=/build/.pnpm
ENV npm_config_store_dir=/build/.pnpm-store

USER 65534:65534
WORKDIR /build

CMD ["/bin/sh", "/build/build.sh"]
