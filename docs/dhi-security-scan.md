# CarapaBox image security audit — 2026-10-27

## CVE refresh

Trivy 0.69.3 on `carapa-box:latest` before this change: the Alpine/DHI Bun layer
was clean; findings were in JavaScript packages and the Go tooling binaries
(1 critical, ~14 high, ~20 medium, ~60 with duplicates across binaries).

Changes (the Bun 1.4.2 DHI base is unchanged — it reports no OS findings):

- Docker CLI `docker:29.8.1-cli` → `docker:29.9.2-cli` (Go 1.26.9+; `docker`
  binary scans clean).
- Buildx: DHI `dhi.io/docker:29.8.0-cli` (0.37.0) → `dhi.io/docker:29.9.0-cli`
  (0.38.0). The plugin now lives at `/usr/libexec/docker/cli-plugins/` in that
  image, and the DHI image's own dpkg inventory hides it from Trivy.
- Compose edge re-pinned to the current digest (`golang.org/x/net` fix; clean).
- `@modelcontextprotocol/sdk` 1.26.0 → 1.32.2, `@anthropic-ai/sandbox-runtime`
  0.0.79 → 0.0.81, `zod` 3 → 4.6.7 (single copy via override; `z.record` now
  takes an explicit key schema). Overrides raised for `body-parser` 2.4.0,
  `proxy-addr` 2.0.8 (critical IP-spoofing fix), `fast-uri` 3.1.9,
  `hono` 4.13.11, `ip-address` 10.7.4.

Remaining findings, none with an available fix:

- `node-forge` 1.4.0, CVE-2026-85393 (HIGH) — no fixed release; pulled in by
  `@anthropic-ai/sandbox-runtime`.
- Buildx 0.38.0: 4 high / 6 medium — `github.com/docker/docker` 28.5.2 (no fix
  for the legacy module line), `golang.org/x/net` 0.59.0 (fixed in 0.60.0) and
  Go stdlib 1.26.9 (fixed in 1.26.10). Standalone `docker/buildx-bin:0.38.1`
  has the same set plus an unpatched `go-archive`. Recheck on the next DHI
  Docker release.

The test suite shows the same 17 environment-dependent failures (relay,
WebSocket, tmux, compose-path tests) before and after.

# CarapaBox image security audit — 2026-09-22

## Bun base follow-up

The controller now uses the same matched, digest-pinned DHI Bun images as
CarapaBoard:

- Build: `dhi.io/bun:1.4.2-alpine3.23-dev@sha256:f622fcf7d9677b071b288b4e57386bc18a45c27798c3a0c2bf2cb8f1a0e3be4a`
- Runtime: `dhi.io/bun:1.4.2-alpine3.23@sha256:eade039763b153d27382026f82563bdcc148970b6dda45993cbf34f096776b05`

Bun comes from the DHI package at `/usr/local/bin/bun`; the build no longer
downloads an installer or copies a separate Bun installation. Bash, BusyBox,
certificates and supporting libraries are installed into the runtime's own APK
inventory using a temporary read-only mount of the matching development image.
Neither APK nor the builder mount is retained. DHI's nonroot account remains
UID 65532 with the configured Docker supplementary group. Compose's UID/GID
override remains supported.

The ingress, egress and Git/SSH helpers and the OPA compiler stage are unchanged
by this follow-up. The Docker CLI, Buildx and Compose pins also remain unchanged.

Candidate: `carapa-box-controller:bun-dhi-audit`, image ID
`sha256:adc933b29c146984d2a38946b5c44b025d449ed106db4ed5cd84c2f28cca9a7e`.
Built and verified for Linux amd64; no production retag, deployment or publish
was performed. The running controller and `carapa-box:latest` remained on
`sha256:330a07137dd105696019632077e7f3a4a1b3f72061b2663665f35341eefd5f93`.

### Follow-up scan

Trivy 0.69.3 reported **0 critical, 2 high, 3 medium, 0 low and 2 unknown** findings,
with no suppressions. The findings are the same Buildx/Compose advisories listed
in the earlier audit below. No OS-package, JavaScript-package or Docker CLI
findings were reported. The complete OS inventory is now present in the final
controller image, so a separate package-donor scan is unnecessary for this
controller; helper images still require their donor scans.

### Follow-up verification

- Full Bun suite on DHI Bun 1.4.2: **507 passed, 0 failed, 0 skipped**, across
  59 files. `bun run typecheck` passed, including the CarapaBot runtime types.
- Actual entrypoint, shell healthcheck, Bash lifecycle hook, HTTP health,
  unauthenticated MCP rejection and authenticated MCP initialization passed.
- Docker CLI, Compose configuration parsing and Buildx bake parsing passed.
- Both the image's default UID 65532 and Compose's UID 1000 with supplementary
  Docker group passed under read-only rootfs, dropped capabilities,
  no-new-privileges, and the existing controller AppArmor/seccomp profiles.
- Runtime checks confirmed package inventory and the absence of APK and the
  temporary builder mount. No Docker socket, host ports or external network
  were provided to the smoke containers.
- `git diff --check` passed. Live Docker lifecycle operations and ARM64 execution
  were not exercised.

The disposable test image added test-only Node, Git, OPA, GNU tar and OpenSSL.
Native Node must precede DHI's Bun-as-Node fallback on `PATH`, and the tmux tests
require `ENABLE_SANDBOX_TMUX=1`. Initial Git worktree timeouts were traced to
hostname DNS lookup with `--network none`; a local hostname entry resolved them.
The final suite used the original test tools and retained network isolation.
No production code or tests were changed to bypass these fixture requirements.

### Generated-config write verification

A follow-up checked the actual deployment's numeric user (`1000:1000`), Docker
supplementary group (`1001`), and writable `/app/generated` bind mount. Its host
state directory is owned by `1000:1000` with mode `0700`; the existing
`squid-generated.conf` is owned by `1000:1000` with mode `0644`.

The candidate's real generation functions passed against disposable bind mounts
with those permissions, under the same AppArmor/seccomp profiles, read-only
rootfs, dropped capabilities and no-new-privileges:

- Created `squid-generated.conf`, then replaced its contents in place while
  preserving its inode and truncating stale bytes. An unchanged policy skipped
  the reconfigure command.
- Created and atomically replaced a generated Nginx route.
- Appended network-policy audit records through the audit-log bind mount.
- The real Squid helper successfully parsed the resulting configuration.

Only Docker discovery/reload calls were stubbed in the generation check; file
generation and writes used the candidate's actual implementation. No live
configuration was written and no running proxy was reconfigured. Logs are
`generated-writes.log` and `generated-squid-parse.log` in the follow-up evidence
directory below. Compose's numeric user override is essential for these host
mounts; the image's standalone default UID 65532 does not own them.

Follow-up evidence and temporary verification Dockerfiles are under
`/tmp/carapa-box-bun-audit/`: `build.log`, `scan.json`, `tests-final.log`,
`typecheck.log`, `smoke.log` and `smoke-compose-user.log`. This is temporary
host storage. Rebuild and rescan from the repository root with:

```sh
docker build --progress plain -t carapa-box-controller:bun-dhi-audit .
trivy image --scanners vuln --format json --output controller-bun.json carapa-box-controller:bun-dhi-audit
```

## Earlier Alpine-base audit

The remaining sections record the earlier audit, before the Bun base follow-up.

The controller and its six helper images were rebuilt locally for `linux/amd64`.
These are candidate builds, not a deployment. Existing production image tags were
left unchanged. This audit excludes the separately packaged CarapaBot runtime.

### Changes

- Updated every CarapaBox Alpine DHI runtime and the example stack to
  `dhi.io/alpine-base:3.23@sha256:b9d3f74989db66757080994a59c89268bd2e72e83b5d4784969addec65ab3530`.
- Updated the Docker CLI from 29.5.3 to 29.8.1, pinned by digest.
- Replaced standard Buildx 0.37.1 with Docker's dependency-patched DHI Buildx
  0.37.0, copied from digest-pinned `dhi.io/docker:29.8.0-cli`. This removes
  CVE-2026-17106 in `github.com/moby/go-archive` and updates `golang.org/x/crypto`.
  The binary runs on the existing Alpine runtime; no Debian libraries are copied.
- Pinned the existing Compose edge binary by digest to preserve the audited build.
- Updated vulnerable JavaScript dependencies within their existing major versions:
  `fast-uri` 3.1.8, `hono` 4.13.8, `ip-address` 10.7.2,
  `@hono/node-server` 1.19.17, `ajv` 8.20.0, `body-parser` 2.3.0,
  `qs` 6.16.0, and YAML 2.9.1 / 1.10.3. OPA retains its YAML 1.x dependency.

### Scan results

Trivy 0.69.3, vulnerability database updated `2026-09-22T02:00:05Z`.
All severities were included; no findings were suppressed and `--ignore-unfixed`
was not used. Counts are finding instances, so the same advisory can appear in
multiple installed package locations or binaries.

| Image / stage | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous local controller | 0 | 28 | 76 | 8 | 2 |
| Updated controller | 0 | 2 | 3 | 0 | 2 |
| Ingress, API relay, Llama proxy, Squid, socat, Git/SSH — each | 0 | 0 | 0 | 0 | 0 |
| All seven Alpine package-donor stages — each | 0 | 0 | 0 | 0 | 0 |

The controller's distinct advisory count fell from 66 to 6. Its final image ID is
`sha256:7204db9b74bc0f577f145bd629fa0b77a1551ac1633ab97d2589bb1ef41d2044`;
the baseline was `sha256:edd6d639f3af9e35dd31d5ab32ea8637ba47280b2304249efa8a53f1db2914c7`.

Scanning the package-donor stages matters: copying binaries and libraries into
DHI does not copy their Alpine package inventory. A final-image OS scan alone can
therefore miss those packages. These extra scans cover the package installations
that supplied the copied files, while the controller scan also inspects embedded
Go modules and JavaScript package metadata. Scanner results do not prove absence
of vulnerabilities or exploitability of a reported dependency.

### Remaining upstream findings

| Advisory | Severity | Component in the controller | Status |
| --- | --- | --- | --- |
| CVE-2026-41567 | High | Buildx: `github.com/docker/docker` 28.5.2 | No fixed version reported for this legacy module line. |
| CVE-2026-42306 | High | Buildx: `github.com/docker/docker` 28.5.2 | No fixed version reported for this legacy module line. |
| CVE-2026-33997 | Medium | Buildx: `github.com/docker/docker` 28.5.2 | Scanner lists 29.3.1; requires an upstream tool rebuild/module migration. |
| CVE-2026-41568 | Medium | Buildx: `github.com/docker/docker` 28.5.2 | No fixed version reported for this legacy module line. |
| CVE-2026-53495 | Medium | Buildx: `github.com/containerd/containerd/v2` 2.3.4 | Fixed in 2.3.5; the published DHI binary still embeds 2.3.4. |
| GO-2026-5932 | Unknown | Buildx and Compose: `golang.org/x/crypto` 0.56.0 | Unmaintained OpenPGP package advisory; no fixed version listed. |

The current standard Buildx release also contains the legacy Docker module and
containerd 2.3.4, plus the vulnerable go-archive version. The DHI binary improves
the result but does not eliminate all findings. The DHI catalog already specifies
containerd 2.3.5; that change was not reflected in the inspected published binary.
`dhi.io/docker:29.8.1-cli` was not published at audit time. Recheck the DHI tag and
rescan before replacing this pin. No private fork of Docker tooling was introduced.

A supplementary `govulncheck` 1.8.0 binary scan also flags CVE-2026-34040 in the
legacy Docker module, in addition to the remaining advisory families above.
Its database and matching differ from Trivy. Binary symbol matching does not
establish whether a vulnerable daemon operation is reachable through Buildx;
these findings have not been dismissed as false positives. Updating the CLI in
this image does not update the host Docker daemon.

Upstream references:

- [Docker Engine release notes](https://docs.docker.com/engine/release-notes/29/)
- [DHI Docker build definition](https://github.com/docker-hardened-images/catalog/blob/main/image/docker/debian-13/29.yaml)
- [Standard Buildx 0.37.1 dependencies](https://github.com/docker/buildx/blob/v0.37.1/go.mod)
- [go-archive advisory](https://github.com/moby/go-archive/security/advisories/GHSA-hfg8-hc9c-6c3h)
- [Go advisory database](https://pkg.go.dev/vuln/)

### Verification and reproduction

- All seven image builds succeeded.
- Complete Bun suite: **504 passed, 0 failed, 0 skipped**; typechecking passed.
- Isolated, read-only containers without a Docker socket or external network:
  controller startup, health endpoint and authentication rejection; Docker CLI,
  Compose configuration and Buildx bake parsing; two native Node ingress tests
  including TCP forwarding; nine Llama transformation tests; API relay startup and
  invalid-route rejection; Squid binary execution; socat byte forwarding; Git init
  and status. No SSH connections were made.
- An initial restricted host test invocation lacked fixture socket/process
  permissions. The complete final suite passed with the required local permissions.
  Smoke fixture expectations for the relay's HTTP 400 response and writable Git
  temporary storage were corrected before the final checks.

Audit-only image tags use `carapa-box-<component>:dhi-audit`, with components
`controller`, `ingress`, `api-relay`, `llama-proxy`, `squid`, `socat`, and `git-ssh`.
Their package-donor tags append `-packages` and were built with `--target build`.
Raw JSON reports, build logs, smoke logs and the summary are in
`/tmp/carapa-box-dhi-audit/` on the audit host; this directory is temporary.

Example commands, from the repository root:

```sh
docker build --pull -t carapa-box-controller:dhi-audit .
docker build --target build -t carapa-box-controller:dhi-audit-packages .
trivy image --scanners vuln --format json --output controller.json carapa-box-controller:dhi-audit
trivy image --scanners vuln --format json --output controller-packages.json carapa-box-controller:dhi-audit-packages
ENABLE_INGRESS_PROXY=false CARAPA_BOX_CONFIG_DIR="$PWD/config" bun --no-env-file test
bun run typecheck
```

Build and scan the other Dockerfiles with their own contexts in `egress-proxy/`,
`ingress-proxy/`, and `git-ssh/` in the same way. Registry authentication to
`dhi.io` is required for these builds. ARM64 images were not built or smoke-tested.
