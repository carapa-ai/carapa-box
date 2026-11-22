# Shared HTTP/SSH ingress. Pure Node TCP forwarding; no shell or Docker client.
FROM alpine:3.23 AS build

# nodejs — runtime for llama-proxy.mjs (no other packages needed; pure
# stdlib http server, no npm install)
RUN apk add --no-cache nodejs

# Collect Node binary and its shared library dependencies
RUN mkdir -p /deps/usr/bin /deps/usr/lib && \
    cp /usr/bin/node /deps/usr/bin/ && \
    for lib in $(ldd /usr/bin/node 2>/dev/null | awk '/=>/{print $3}'); do \
      cp "$lib" /deps/usr/lib/ 2>/dev/null || true; \
    done

# ── Runtime stage — DHI distroless Alpine ───────────────────────────────
# dhi.io/alpine-base:3.23 — pinned 2026-11-21 (same pin as api-relay)
FROM dhi.io/alpine-base:3.23@sha256:8a14cb527704fd6325fae6e92e0bc73a3c64b44a83c36a3abb53730c5757cc72

COPY --from=build /deps/usr/bin/node /usr/bin/node
COPY --from=build /deps/usr/lib/ /usr/lib/
WORKDIR /app
COPY proxy.mjs main.mjs /app/
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const s=JSON.parse(require('fs').readFileSync('/run/ingress-status.json'));process.exit(s.expiresAt>Date.now()?0:1)"]
ENTRYPOINT ["node", "/app/main.mjs"]
