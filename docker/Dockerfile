# syntax=docker/dockerfile:1.7
#
# Multi-stage build. The final image is distroless and non-root, and contains no package
# manager, no shell, and no build toolchain.
#
# The base is Debian rather than Alpine deliberately: better-sqlite3 and @node-rs/argon2
# publish no musl prebuilds, so an Alpine runtime would need a C compiler in the shipped
# image. See ADR-0006.

ARG NODE_VERSION=22

# ── deps ─────────────────────────────────────────────────────────────────────────────
# The full `node` image rather than `-slim`: better-sqlite3@13 publishes no prebuild for
# linux/node22, so it falls back to node-gyp and needs Python and a C++ toolchain. The full
# image already ships both, which avoids an `apt-get` round trip entirely. None of it reaches
# the runtime image — that is the point of the multi-stage split.
FROM node:${NODE_VERSION}-bookworm AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json           apps/web/
COPY packages/shared/package.json    packages/shared/
COPY packages/db/package.json        packages/db/
COPY packages/budget-engine/package.json packages/budget-engine/
COPY packages/importers/package.json packages/importers/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm --filter @zerofold/web build

# Next's standalone output keeps pnpm's .pnpm store layout but not the resolution symlinks, so
# `better-sqlite3` is present yet unresolvable from /app. The CLI runs outside the bundle and
# needs it, so dereference one copy into a plain node_modules directory.
RUN mkdir -p /skel && cp -RL /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 /skel/better-sqlite3

# A skeleton data directory. distroless has no shell, so it cannot `RUN mkdir` — the directory
# must arrive as a COPY with the right ownership, otherwise /data is root-owned and the
# non-root user cannot write the session secret or the database.
RUN mkdir -p /skel/data

# ── runtime ──────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12 AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    ZEROFOLD_DATA_DIR=/data \
    ZEROFOLD_MIGRATIONS_DIR=/app/migrations \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Next's standalone output already contains the pruned node_modules it needs.
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nonroot:nonroot /app/apps/web/public ./apps/web/public
# SQL migrations are data, not code, so they are not part of the server bundle.
COPY --from=build --chown=nonroot:nonroot /app/packages/db/migrations ./migrations
COPY --from=build --chown=nonroot:nonroot /app/docker/entrypoint.mjs ./entrypoint.mjs
COPY --from=build --chown=nonroot:nonroot /app/docker/cli.mjs ./cli.mjs
COPY --from=build --chown=nonroot:nonroot /skel/better-sqlite3 ./node_modules/better-sqlite3
# Ships an empty, correctly-owned /data. A named volume mounted here inherits this ownership
# on first use, so `docker run -v zerofold-data:/data` works with no host-side chown.
COPY --from=build --chown=nonroot:nonroot /skel/data /data

USER nonroot
VOLUME ["/data"]
EXPOSE 3000

# distroless' entrypoint is already node, so CMD is just the script.
CMD ["/app/entrypoint.mjs"]
