# Multi-target build for every orchestrator image (contract §19). Build context: repository root.
#   docker build -f docker/Dockerfile --target <api|worker|egress-proxy|db-cli|web> .
# docker-compose.yml builds the same targets. The worker image also runs the sandbox launcher
# (`node dist/runner.js`, §10.11) and carries git, util-linux (prlimit), the pinned Claude Code
# CLI and the checksum-verified codebase-memory-mcp binary.

ARG NODE_IMAGE=node:24.18.0-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# ---- manifests: package.json files + lockfile only, so `npm ci` stays cached across source edits
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /out \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents '{}' /out/ ';' \
 && cp package-lock.json /out/

# ---- deps: complete install (tsup, vite and TypeScript are dev dependencies)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

FROM deps AS source
COPY . .

# ---- per-app builds (BuildKit only runs the ones a target needs)
FROM source AS build-api
RUN npm run build --workspace @orc/api

FROM source AS build-worker
RUN npm run build --workspace @orc/worker \
 && npm run build --workspace @orc/runner

FROM source AS build-egress-proxy
RUN npm run build --workspace @orc/egress-proxy

FROM source AS build-db-cli
RUN npx tsup --config docker/db-cli/tsup.config.mjs \
 && mkdir -p /out/database \
 && cp -R packages/database/package.json packages/database/dist /out/database/ \
 && for dir in migrations seed; do \
      if [ -d "packages/database/$dir" ]; then cp -R "packages/database/$dir" /out/database/; fi; \
    done

FROM source AS build-web
RUN npm run build --workspace @orc/web

# ---- production node_modules per image (workspace packages themselves are bundled by tsup)
FROM ${NODE_IMAGE} AS prod-deps-base
WORKDIR /app
COPY --from=manifests /out/ ./

FROM prod-deps-base AS prod-deps-api
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund --workspace @orc/api \
 && mkdir -p apps/api/node_modules \
 && rm -rf node_modules/@orc

FROM prod-deps-base AS prod-deps-worker
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund --workspace @orc/worker --workspace @orc/runner \
 && mkdir -p apps/worker/node_modules \
 && rm -rf node_modules/@orc

FROM prod-deps-base AS prod-deps-egress-proxy
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund --workspace @orc/egress-proxy \
 && mkdir -p apps/egress-proxy/node_modules \
 && rm -rf node_modules/@orc

FROM prod-deps-base AS prod-deps-db-cli
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund --workspace @orc/database \
 && rm -rf node_modules/@orc

# ---- Claude Code CLI: native linux-x64 build of the pinned version, verified against its
#      npm registry integrity (sha512) before extraction.
FROM ${NODE_IMAGE} AS claude-cli
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CLAUDE_CODE_LINUX_X64_INTEGRITY=sha512-RQDM6N285IjNKcmlPRriayNzpTkEJreAw5/vBU+V0R3qljkQ5z6/pSbzcVUAXvasoOlvub0RIma3NWvSuZA8Cg==
WORKDIR /tmp/claude
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu \
 && npm pack "@anthropic-ai/claude-code-linux-x64@${CLAUDE_CODE_VERSION}" --silent >/dev/null \
 && tarball="anthropic-ai-claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz" \
 && expected="$(printf '%s' "${CLAUDE_CODE_LINUX_X64_INTEGRITY#sha512-}" | base64 -d | od -An -v -tx1 | tr -d ' \n')" \
 && echo "${expected}  ${tarball}" | sha512sum -c - \
 && tar -xzf "${tarball}" package/claude \
 && install -D -m 0755 package/claude /out/claude \
 && rm -rf /tmp/claude/*

# ---- codebase-memory-mcp: release asset verified against the release's checksums.txt, whose own
#      SHA-256 and the asset's entry are pinned here.
FROM ${NODE_IMAGE} AS cbm
ARG CBM_VERSION=0.12.0
ARG CBM_ASSET=codebase-memory-mcp-linux-amd64-portable.tar.gz
ARG CBM_CHECKSUMS_SHA256=e97a42c2f1889aca027ce028c339da97a0bfca45f74c742a934bcf61afba37ae
ARG CBM_ASSET_SHA256=7024e585132760f383e3e25237e2b2ac6f5185f7e466f8dc66a085bb25f8d0be
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/cbm
RUN set -eu \
 && base="https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}" \
 && curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o checksums.txt "${base}/checksums.txt" \
 && curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "${CBM_ASSET}" "${base}/${CBM_ASSET}" \
 && echo "${CBM_CHECKSUMS_SHA256}  checksums.txt" | sha256sum -c - \
 && awk -v asset="${CBM_ASSET}" '$2 == asset' checksums.txt > asset.sha256 \
 && test "$(wc -l < asset.sha256)" -eq 1 \
 && echo "${CBM_ASSET_SHA256}  ${CBM_ASSET}" | cmp -s - asset.sha256 \
 && sha256sum -c asset.sha256 \
 && tar -xzf "${CBM_ASSET}" codebase-memory-mcp \
 && install -D -m 0755 codebase-memory-mcp /out/codebase-memory-mcp \
 && rm -rf /tmp/cbm/*

# ---- common Node runtime: no package managers, healthcheck probe, non-root by default
FROM ${NODE_IMAGE} AS node-runtime
ARG APP_VERSION=0.1.0
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY docker/healthcheck.mjs /opt/orc/healthcheck.mjs

# ==== api ==========================================================================================
FROM node-runtime AS api
WORKDIR /app/apps/api
COPY --from=prod-deps-api /app/node_modules /app/node_modules
COPY --from=prod-deps-api /app/apps/api/node_modules ./node_modules
COPY --from=build-api /app/apps/api/dist ./dist
ENV API_HOST=0.0.0.0 \
    API_PORT=4000
EXPOSE 4000
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ==== worker (+ runner entry) ======================================================================
FROM node-runtime AS worker
ARG RUNNER_UID_BASE=20000
ARG RUNNER_MAX_LEASES=64
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && command -v prlimit >/dev/null
# Sandbox uids orc-s0..orc-s<N-1> (§10.11 item 2): primary gid = uid, no home, no login shell.
RUN set -eu; i=0; \
    while [ "$i" -lt "${RUNNER_MAX_LEASES}" ]; do \
      uid=$((RUNNER_UID_BASE + i)); \
      groupadd --gid "$uid" "orc-s$i"; \
      useradd --uid "$uid" --gid "$uid" --no-create-home --home-dir /nonexistent \
              --shell /usr/sbin/nologin --no-log-init "orc-s$i"; \
      i=$((i + 1)); \
    done
# Image-owned, empty, read-only git hooks dir (core.hooksPath, §11.1) and the volume mount points
# with the modes of §10.11 item 4/5 (copied into fresh named volumes on first use).
RUN install -d -o root -g root -m 0755 /opt/orc/git /var/lib/orc /var/lib/orc/projects \
 && install -d -o root -g root -m 0555 /opt/orc/git/empty-hooks \
 && install -d -o node -g node -m 0711 /var/lib/orc/workspaces /var/lib/orc/claude /var/lib/orc/cbm-cache \
 && install -d -o root -g node -m 0750 /run/orc-runner
COPY --from=claude-cli /out/claude /usr/local/bin/claude
COPY --from=cbm /out/codebase-memory-mcp /usr/local/bin/codebase-memory-mcp
WORKDIR /app/apps/worker
COPY --from=prod-deps-worker /app/node_modules /app/node_modules
COPY --from=prod-deps-worker /app/apps/worker/node_modules ./node_modules
COPY --from=build-worker /app/apps/worker/dist ./dist
COPY --from=build-worker /app/apps/runner/dist/ ./dist/
ENV WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=4100 \
    GIT_HOOKS_DIR=/opt/orc/git/empty-hooks \
    CLAUDE_BIN=/usr/local/bin/claude \
    CODEBASE_MEMORY_MCP_BIN=/usr/local/bin/codebase-memory-mcp \
    DISABLE_AUTOUPDATER=1
EXPOSE 4100
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ==== egress-proxy =================================================================================
FROM node-runtime AS egress-proxy
WORKDIR /app/apps/egress-proxy
COPY --from=prod-deps-egress-proxy /app/node_modules /app/node_modules
COPY --from=prod-deps-egress-proxy /app/apps/egress-proxy/node_modules ./node_modules
COPY --from=build-egress-proxy /app/apps/egress-proxy/dist ./dist
ENV EGRESS_HOST=0.0.0.0 \
    EGRESS_PORT=3128
EXPOSE 3128
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ==== db-cli (db-bootstrap, migrator, operator commands) ===========================================
FROM node-runtime AS db-cli
WORKDIR /app/packages/database
COPY --from=prod-deps-db-cli /app/node_modules /app/node_modules
COPY --from=build-db-cli /out/database/ ./
USER node
ENTRYPOINT ["node", "--enable-source-maps", "/app/packages/database/dist/orc-db.js"]
CMD ["--help"]

# ==== web: built SPA on nginx-unprivileged (uid 101), TLS on 8443, 8080 redirects (ADR-0025) =======
FROM ${NGINX_IMAGE} AS web
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/snippets/ /etc/nginx/orc/
COPY docker/nginx/templates/ /etc/nginx/templates/
COPY --from=build-web /app/apps/web/dist/ /usr/share/nginx/html/
RUN chmod -R a+rX,go-w /etc/nginx/nginx.conf /etc/nginx/orc /etc/nginx/templates /usr/share/nginx/html
# envsubst renders templates/orc/site.conf.template to /tmp/orc/site.conf (tmpfs; rootfs is
# read-only) and substitutes only these two variables, never nginx's own $variables.
ENV API_UPSTREAM=http://api:4000 \
    WEB_SERVER_NAME=localhost \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|WEB_SERVER_NAME)\$"
EXPOSE 8080 8443
USER 101
