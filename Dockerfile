# ── Hardened CarapaBox Controller ─────────────────────────────────────────
# Multi-stage build: bundles the MCP server with DHI Bun, then copies the
# application into the matching hardened Bun runtime.
#
# Requires Docker socket mounted at /var/run/docker.sock for compose
# stack management.  All other filesystem access is read-only.
#
# Security: digest-pinned DHI base and Docker tooling,
# seccomp/AppArmor/cap_drop/read_only applied via compose.

# Matching Bun 1.4.2 build/runtime images, shared with CarapaBoard, pinned 2026-09-22.
FROM dhi.io/bun:1.4.2-alpine3.23-dev@sha256:f622fcf7d9677b071b288b4e57386bc18a45c27798c3a0c2bf2cb8f1a0e3be4a AS bun-dev

# ── OPA toolchain — shared base for both OPA compile stages below ────────
# alpine:3.23 — pinned 2026-10-17
FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0 AS opa-toolchain

RUN apk add --no-cache bash tar
COPY scripts/compile-policies.sh /app/scripts/compile-policies.sh
COPY config/policies/ /app/config/policies/
WORKDIR /app

# ── OPA compiler stage — minimal image for .rego → .wasm compilation ─────
# Used by build.sh in a temp container; never shipped in the runtime image.
#
# OPA is pre-fetched on the HOST by build.sh into .cache/opa/ and COPIED in.
# That dodges a long-standing class of build failures where Alpine/musl's
# resolver inside BuildKit's network namespace can't reach GitHub's
# release-assets CDN. See build.sh for the host-side download.
FROM opa-toolchain AS opa-compiler

ARG OPA_VERSION=v1.14.1

COPY --chmod=0755 .cache/opa/opa /usr/local/bin/opa

# ── Built-in base policy — compiled during `docker compose build` ────────
# Needs no host prefetch, so a fresh build always ships base.wasm. The result
# lives outside /app/config because compose bind-mounts that directory.
# openpolicyagent/opa:1.14.1-static — pinned 2026-10-17
FROM openpolicyagent/opa:1.14.1-static@sha256:5c1a4f535f83ebaf271f51095bc5ac8848519bc84ae3cc7ad81edceca71a4e0a AS opa-bin
FROM opa-toolchain AS policy-build
COPY --from=opa-bin /opa /usr/local/bin/opa
RUN bash /app/scripts/compile-policies.sh --stacks-dir /nonexistent

# ── Build stage — DHI Bun development image ──────────────────────────────
FROM bun-dev AS build

ARG DOCKER_GID=999

# Install production dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Bundle TypeScript source into standalone JS
COPY src/ ./src/
COPY ingress-proxy/proxy.mjs ./ingress-proxy/proxy.mjs
COPY egress-proxy/api-relay/ ./egress-proxy/api-relay/
COPY egress-proxy/provider-login/ ./egress-proxy/provider-login/
COPY tsconfig.json ./
COPY public/ ./public/
RUN bun build ./src/index.ts --outfile ./dist/index.js --target node --bundle && \
    bun build ./src/cli.ts   --outfile ./dist/cli.js   --target node --bundle

# Prepare /etc/group with docker group for the runtime stage.
# DHI has no addgroup — we build the file here and COPY it over.
RUN addgroup -g "${DOCKER_GID}" docker && addgroup nonroot docker

# Prepare runtime directories; the final COPY --chown sets their ownership.
RUN mkdir -p /app/stacks /app/security /app/images /app/generated

# ── Docker CLI binaries ─────────────────────────────────────────────────
# DHI's Buildx carries dependency fixes absent from the standard release.
FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker-cli
FROM dhi.io/docker:29.9.0-cli@sha256:4a85399782ced1f5cd0731e8cc48d5c97101ff1ed2634c1ef6b623df389f8f42 AS buildx
FROM docker/compose-bin:edge@sha256:e6fa999c98cd50d8613c07651242267f5eda1955d85e7b63738956be17d21698 AS compose

# ── Runtime stage — DHI hardened Bun ─────────────────────────────────────
FROM dhi.io/bun:1.4.2-alpine3.23@sha256:eade039763b153d27382026f82563bdcc148970b6dda45993cbf34f096776b05

USER 0

LABEL org.opencontainers.image.title="carapa-box" \
      org.opencontainers.image.description="Hardened MCP server for Docker Compose stack management" \
      org.opencontainers.image.version="0.1.0"

# Preserve DHI's nonroot account; add its Docker supplementary group.
COPY --from=build /etc/group /etc/group

# Install lifecycle-hook tools with their package inventory intact. The matching
# builder's apk and libraries are mounted only for this step, not shipped.
RUN --mount=from=bun-dev,source=/,target=/builder,ro \
    ["/builder/bin/busybox", "sh", "-ec", \
    "/builder/bin/busybox mkdir -p /bin; \
    /builder/bin/busybox cp /builder/bin/busybox /bin/busybox; \
    /bin/busybox ln -sf busybox /bin/sh; \
    LD_LIBRARY_PATH=/builder/usr/lib:/builder/lib /builder/sbin/apk \
    --keys-dir /builder/etc/apk/keys --repositories-file /builder/etc/apk/repositories \
    add --no-cache busybox bash ca-certificates libstdc++ libgcc"]

# Docker CLI + plugins; see docs/dhi-security-scan.md for scan coverage.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=buildx /usr/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
COPY --from=compose    /docker-compose      /usr/local/lib/docker/cli-plugins/docker-compose

# Copy bundled application + prepared dirs
COPY --from=build --chown=65532:65532 /app /app

# Config files (managed-services.yaml, base policies, etc.)
COPY --chown=65532:65532 config/ /app/config/
# Built-in compiled base policy; used only when <config>/policies/base.wasm is
# absent (the compose /app/config bind mount hides anything baked under it).
COPY --from=policy-build --chown=65532:65532 /app/config/policies/base.wasm /app/policies-builtin/base.wasm
ENV CARAPA_BOX_BUILTIN_POLICIES_DIR="/app/policies-builtin"

# Entrypoint only — OPA + compile script live in the opa-compiler stage
COPY --chown=65532:65532 scripts/entrypoint.sh /app/scripts/entrypoint.sh

# BUN_INSTALL_CACHE_DIR + HOME → /tmp so Bun can write in read_only containers
ENV BUN_INSTALL_CACHE_DIR="/tmp/.bun-cache" \
    HOME="/tmp" \
    NODE_ENV="production"

# Build metadata surfaced by /health (late layer: only this one is busted per commit).
ARG GIT_COMMIT=unknown
RUN ["/bin/sh", "-ec", "echo \"$GIT_COMMIT\" > /app/VERSION; /bin/busybox date -u +%Y-%m-%dT%H:%M:%SZ > /app/BUILD_TIME; /bin/busybox chown 65532:65532 /app/VERSION /app/BUILD_TIME; /bin/busybox chmod 644 /app/VERSION /app/BUILD_TIME"]

WORKDIR /app

USER nonroot

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD kill -0 1 || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["bun", "run", "/app/dist/index.js", "--http"]
