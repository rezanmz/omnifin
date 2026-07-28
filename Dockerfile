# syntax=docker/dockerfile:1.12@sha256:93bfd3b68c109427185cd78b4779fc82b484b0b7618e36d0f104d4d801e66d25

ARG NODE_IMAGE=node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212

FROM ${NODE_IMAGE} AS toolchain

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches patches
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM toolchain AS build

ARG OMNIFIN_GATEWAY_URL=http://gateway:4000
ENV NODE_ENV=production \
    OMNIFIN_BUILD_STANDALONE=true \
    OMNIFIN_GATEWAY_URL=${OMNIFIN_GATEWAY_URL}

COPY apps apps
COPY packages packages
COPY eslint.config.mjs prettier.config.mjs ./

# Next's standalone output expects a public directory even when an installation
# does not ship static public assets yet.
RUN mkdir -p apps/web/public \
    && pnpm build \
    && pnpm --filter @omnifin/gateway deploy --prod --legacy /out/gateway \
    && better_sqlite_dir="$(node -e "const path = require('node:path'); process.stdout.write(path.dirname(require.resolve('better-sqlite3/package.json', { paths: ['/out/gateway'] })))")" \
    && case "$better_sqlite_dir" in /out/gateway/node_modules/*/better-sqlite3) ;; *) exit 70 ;; esac \
    && npm run build-release --prefix "$better_sqlite_dir" \
    && rm -rf "$better_sqlite_dir/prebuilds" \
    && install --directory --mode=0700 \
       /workspace/apps/web/.next/standalone/.next/cache \
       /workspace/apps/web/.next/standalone/apps/web/.next/cache

FROM ${NODE_IMAGE} AS runtime-layout

RUN install --directory --mode=0700 /layout/backups /layout/data \
    && install --directory --mode=0755 /layout/bin

COPY docker/entrypoint.mjs docker/healthcheck.mjs /layout/bin/

RUN chmod 0444 /layout/bin/*.mjs

FROM ${RUNTIME_IMAGE} AS runtime

ARG VERSION=0.0.0-dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Omnifin" \
      org.opencontainers.image.description="Secure control plane for a self-hosted media stack" \
      org.opencontainers.image.source="https://github.com/rezanmz/omnifin" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OMNIFIN_HOST=0.0.0.0 \
    OMNIFIN_PORT=4000 \
    OMNIFIN_DATABASE_URL=/data/omnifin.db \
    OMNIFIN_GATEWAY_URL=http://gateway:4000 \
    OMNIFIN_WEB_TRUST_PROXY_HOPS=0 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY --from=runtime-layout --chown=65532:65532 --chmod=0700 /layout/data /data
COPY --from=runtime-layout --chown=65532:65532 --chmod=0700 /layout/backups /backups
COPY --from=build --chown=65532:65532 /out/gateway /opt/omnifin/gateway
COPY --from=build --chown=65532:65532 /workspace/apps/web/.next/standalone /opt/omnifin/web
COPY --from=build --chown=65532:65532 /workspace/apps/web/.next/static /opt/omnifin/web/.next/static
COPY --from=build --chown=65532:65532 /workspace/apps/web/.next/static /opt/omnifin/web/apps/web/.next/static
COPY --from=build --chown=65532:65532 /workspace/apps/web/public /opt/omnifin/web/public
COPY --from=build --chown=65532:65532 /workspace/apps/web/public /opt/omnifin/web/apps/web/public
COPY --from=runtime-layout --chown=0:0 /layout/bin /opt/omnifin/bin

USER 65532:65532
WORKDIR /opt/omnifin

EXPOSE 3000 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/nodejs/bin/node", "/opt/omnifin/bin/healthcheck.mjs"]

ENTRYPOINT ["/nodejs/bin/node", "/opt/omnifin/bin/entrypoint.mjs"]
CMD ["gateway"]
