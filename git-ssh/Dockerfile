# ── Hardened git + SSH image for ephemeral containers ─────────────────────
# Replaces alpine/git which lacks openssh-client
#
# Build:  docker build -t carapa/git-ssh git-ssh/
# Usage:  Used by sandbox_git MCP tool and before-start.sh remote operations
#
# Security: non-root user, SUID/SGID stripped, minimal packages
# Runtime security (seccomp, AppArmor, cap_drop, read_only) applied via compose.

FROM alpine:3.23 AS build

LABEL org.opencontainers.image.title="git-ssh" \
      org.opencontainers.image.description="Minimal git + openssh for ephemeral sandbox git operations"

RUN apk add --no-cache \
    git \
    openssh-client

# ── Runtime stage — DHI distroless Alpine ───────────────────────────────
# dhi.io/alpine-base:3.23 — pinned 2026-11-21
FROM dhi.io/alpine-base:3.23@sha256:8a14cb527704fd6325fae6e92e0bc73a3c64b44a83c36a3abb53730c5757cc72

USER 0:0

COPY --from=build /usr/bin/git /usr/bin/git
COPY --from=build /usr/lib/libpcre2-8.so.0 /usr/lib/libpcre2-8.so.0
COPY --from=build /usr/lib/libz.so.1 /usr/lib/libz.so.1
COPY --from=build /usr/lib/libcrypto.so.3 /usr/lib/libcrypto.so.3
COPY --from=build /usr/lib/libssl.so.3 /usr/lib/libssl.so.3
COPY --from=build /usr/bin/ssh /usr/bin/ssh

# Configure git for non-root operation in mounted workspaces
# Local file:// transfers (pinned-remote staging repo) exec these by name
RUN ln -s git /usr/bin/git-receive-pack && \
    ln -s git /usr/bin/git-upload-pack

RUN git config --system init.defaultBranch main && \
    git config --system safe.directory '*'

# Security hardening: strip SUID/SGID bits from all binaries
RUN find / -xdev -perm -4000 -exec chmod u-s {} + 2>/dev/null; \
    find / -xdev -perm -2000 -exec chmod g-s {} + 2>/dev/null; \
    true

# Create agent user (UID 1000) — sandbox_git runs as --user 1000:1000
# to match workspace volume ownership. SSH requires a passwd entry.
RUN adduser -D -u 1000 -s /sbin/nologin -h /tmp agent

WORKDIR /workspace

USER 1000:1000

ENTRYPOINT ["git"]
