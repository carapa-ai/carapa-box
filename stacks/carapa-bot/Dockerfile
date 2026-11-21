# syntax=docker/dockerfile:1
# Public runtime: harnesses are installed separately into immutable volumes.
FROM node:26-trixie@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS bun-build
# To bump Bun, change BUN_VERSION and both sha256 ARGs (from the release's SHASUMS256.txt).
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) BUN_ASSET=bun-linux-x64; BUN_SHA256="${BUN_SHA256_AMD64}" ;; \
      arm64) BUN_ASSET=bun-linux-aarch64; BUN_SHA256="${BUN_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: '${TARGETARCH}'" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ASSET}.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -D -m 755 "/tmp/bun/${BUN_ASSET}/bun" /opt/bun/bin/bun \
    && ln -s bun /opt/bun/bin/bunx \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && test "$(/opt/bun/bin/bun --version)" = "${BUN_VERSION}"

FROM dhi.io/node:26-dev@sha256:6d1c8db117086399179ccc021bb73dd11c027760d5625befe75e2ed5f8105372 AS carapa-bot-runtime

ARG NPM_VERSION=12.0.2
RUN npm install --global --prefix /opt/npm "npm@${NPM_VERSION}" \
    && mkdir -p /usr/local/bin \
    && ln -sf /opt/npm/bin/npm /usr/local/bin/npm \
    && ln -sf /opt/npm/bin/npx /usr/local/bin/npx \
    && test "$(/opt/npm/bin/npm --version)" = "${NPM_VERSION}"

# socat: powers native relay sidecars such as the Gemini proxy harness.
# debianutils is Essential, but the hardened base never ran its postinst, so the
# /usr/bin/which alternative is missing; register it explicitly.
# Install toolchains once; optional harness packages live in a separate volume.
# The hardened base ships gcc-14 runtime libs as "+dhi5", which apt orders above the
# mirror's "+deb13u0+dhi6" build, so build-essential's gcc-14 dependency looks like an
# impossible downgrade. Move those packages to the mirror's gcc-14 version together.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && GCC_V="$(apt-cache policy gcc-14 | awk '/Candidate:/{print $2}')" \
  && apt-get install -y --no-install-recommends --allow-downgrades \
  gcc-14-base="$GCC_V" libatomic1="$GCC_V" libgcc-s1="$GCC_V" libstdc++6="$GCC_V" \
  bash git jq curl wget python3 python3-pip python3-venv ripgrep ca-certificates procps coreutils debianutils passwd dropbear-bin openssh-client openssh-sftp-server util-linux \
  mc htop socat gzip unzip tmux bubblewrap chromium libnss3-tools build-essential pulseaudio pulseaudio-utils xvfb \
  && update-alternatives --install /usr/bin/which which /usr/bin/which.debianutils 0 \
  && rm -rf /var/lib/apt/lists/*

# npm 12.0.2 still bundles vulnerable releases of these dependencies. Update
# them within their supported major versions until npm ships patched bundles.
# Remove build-only metadata: npm's unpublished docs workspace prevents npm
# from resolving its installed runtime tree, even with --omit=dev.
RUN node -e 'const fs=require("fs"),p="/opt/npm/lib/node_modules/npm/package.json",j=JSON.parse(fs.readFileSync(p)); delete j.devDependencies; delete j.workspaces; j.carapaRuntimePatches="Bundled dependencies updated by CarapaBot; see Dockerfile"; fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' \
    && /opt/npm/bin/npm install --prefix /opt/npm/lib/node_modules/npm \
       --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact \
       brace-expansion@5.0.11 ip-address@10.3.1 tar@7.5.21 undici@6.29.1 \
    && /opt/npm/bin/npm cache clean --force

# Yarn is workspace package-manager tooling, not a volume-installed harness.
ARG YARN_VERSION=1.22.22
RUN /opt/npm/bin/npm install --global --prefix /opt/yarn --no-fund --no-audit \
      "yarn@${YARN_VERSION}" \
    && ln -sf /opt/yarn/bin/yarn /usr/local/bin/yarn \
    && ln -sf /opt/yarn/bin/yarnpkg /usr/local/bin/yarnpkg \
    && test "$(/opt/yarn/bin/yarn --version)" = "${YARN_VERSION}"

# ast-grep: structural code search/rewrite usable by every harness through bash.
# Only `ast-grep` is linked; its `sg` alias would shadow the login `sg` command.
# Run its postinstall explicitly: npm may skip install scripts, leaving a
# per-invocation warning on stderr.
ARG AST_GREP_VERSION=0.45.3
RUN /opt/npm/bin/npm install --global --prefix /opt/ast-grep --no-fund --no-audit \
      "@ast-grep/cli@${AST_GREP_VERSION}" \
    && (cd /opt/ast-grep/lib/node_modules/@ast-grep/cli && node postinstall.js) \
    && ln -sf /opt/ast-grep/bin/ast-grep /usr/local/bin/ast-grep \
    && test "$(/opt/ast-grep/bin/ast-grep --version 2>&1)" = "ast-grep ${AST_GREP_VERSION}"

COPY --link --from=bun-build /opt/bun /opt/bun

# Immutable control-plane baseline. Deployments may overlay newer, host-owned
# tools at /usr/local/stack-cli-bin without hiding this rollback copy.
COPY --chmod=755 bin/ /usr/local/ai-cli-bin/

# ── Playwright CLI backend + Chromium ────────────────────────────────────
# The image-owned bin/playwright-cli wrapper depends on the open/goto flag surface.
# Its final-image smoke check must catch an incompatible upstream release.
RUN mkdir -p /opt/google/chrome \
  && ln -s /usr/bin/chromium /opt/google/chrome/chrome
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

# Non-root user (1000:1000)
RUN id -u node >/dev/null 2>&1 && userdel -r node || true && useradd -m -u 1000 -s /bin/bash ubuntu

# The hardened base omits /etc/shells. Dropbear checks getusershell() before
# public-key authentication and otherwise rejects ubuntu's /bin/bash shell.
RUN printf '/bin/sh\n/bin/bash\n/usr/bin/sh\n/usr/bin/bash\n' > /etc/shells \
  && chmod 644 /etc/shells

ENV BUN_INSTALL="/opt/bun"
ENV PATH="/usr/local/stack-cli-bin:/usr/local/ai-cli-bin:/opt/carapa-harness/bin:/opt/carapa-harness/venv/bin:/opt/bun/bin:/home/ubuntu/.local/bin:$PATH"
ENV PRIME_AGENT_KERNEL_PYTHON="/opt/carapa-harness/harnesses/prime-agent/venv/bin/python" \
  PI_SKIP_VERSION_CHECK="1" \
  OMP_SKIP_SETUP="1"

# Login shells may replace PATH. Stable compatibility links keep the historical
# command locations while their targets are replaced with the harness payload.
RUN mkdir -p /usr/local/bin \
  && for command in claude codex opencode pi cursor-agent agent \
  hermes hermes-agent hermes-acp prime-agent omp; do \
  ln -sf "/opt/carapa-harness/bin/$command" "/usr/local/bin/$command"; \
  done

# Hardening: Strip SUID/SGID
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

WORKDIR /home/ubuntu

# Security hardening: strip SUID/SGID bits from all binaries
RUN find / -xdev -perm -4000 -exec chmod u-s {} + 2>/dev/null; \
  find / -xdev -perm -2000 -exec chmod g-s {} + 2>/dev/null; \
  true

# Non-root PTY support requires Dropbear 2024.84 or newer.
RUN dpkg --compare-versions "$(dpkg-query -W -f='${Version}' dropbear-bin)" ge 2024.84

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
RUN install -d -m 755 /usr/local/share/carapa
COPY --chmod=644 pi-models.json /usr/local/share/carapa/pi-models.json
COPY --chmod=644 prime-models.json /usr/local/share/carapa/prime-models.json
COPY --chmod=644 prime-settings.json /usr/local/share/carapa/prime-settings.json
COPY --chmod=644 omp-models.json /usr/local/share/carapa/omp-models.json
COPY --chmod=644 omp-settings.json /usr/local/share/carapa/omp-settings.json
COPY --chmod=644 omp-lsp.json /usr/local/share/carapa/omp-lsp.json

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/bin/bash", "-l"]

# Installer code is shipped with the runtime, but never runs at agent startup.
ARG CARAPA_BOT_VERSION=0.1.0
LABEL org.opencontainers.image.title="carapa-bot" \
    org.opencontainers.image.version="${CARAPA_BOT_VERSION}" \
    ai.carapa.harness-layout="1" \
    ai.carapa.harness-store-layout="1"
COPY --chmod=755 harness/install.py harness/verify.py install-antigravity-acp.sh /usr/local/lib/carapa-harness/
RUN mkdir -p /opt/carapa-harness /usr/local/share/carapa \
    && python3 -c 'import json,platform,sys,subprocess; json.dump({"layout": 1, "arch": platform.machine(), "python": list(sys.version_info[:2]), "node": subprocess.check_output(["node", "-p", "process.versions.node.match(/^[0-9]+/)[0]"], text=True).strip(), "libc": list(platform.libc_ver())}, open("/usr/local/share/carapa/harness-abi.json", "w"))'

# CarapaBot's license applies to its own software. Third-party components keep
# their upstream licenses and notices; this image is not wholly Apache-licensed.
COPY --chmod=644 LICENSE THIRD-PARTY-NOTICES.md /usr/share/licenses/carapa-bot/
RUN chmod 755 /usr/share/licenses /usr/share/licenses/carapa-bot \
    && test -s /usr/share/common-licenses/Apache-2.0 \
    && ln -s /usr/share/common-licenses/Apache-2.0 /usr/share/licenses/carapa-bot/Apache-2.0
USER ubuntu
