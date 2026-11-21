# Public runtime scan — 2026-09-22

## Alpine candidate

The modernized `carapa-bot:0.1.0-alpine` passes `./build.sh --alpine`, including
the HIGH/CRITICAL gate. Local image ID:
`sha256:41c6f39f9cc4c9a951e0a4b91a734000dbcc22a1cdb2aab4c126c9e131dc2275`.
Nothing was pushed and existing Debian consumers were not recreated.

Trivy 0.69.3 with its database updated at `2026-09-22T02:00:05Z`, without VEX or
ignore-list suppression, reports:

| Raw package/CVE findings | Debian with browser audio | Alpine with browser audio and FFmpeg |
| --- | ---: | ---: |
| HIGH | 232 | 0 |
| CRITICAL | 4 | 0 |
| Distinct CVE IDs | 145 | 0 |

The Debian comparison is image
`sha256:51110c57f8e0bb14e99e65dcfd0ccb447832dd76499e603483627c6d76df5af5`.
The Alpine runtime uses pinned DHI Node 26.9.0 and Bun 1.4.2 bases, musl 1.2.5-r23,
Python 3.14.7, PulseAudio 17.0-r5, FFmpeg 8.0.1-r1, and Chromium 149.0.7827.53-r0.
Packages come from DHI's Alpine 3.23 repository and Alpine's 3.23 main/community
repositories. Optional harness volumes and the host kernel are outside this scan.

These are scanner results, not proof that all Debian findings were fixed or that
the Alpine image has no vulnerabilities. Distro advisory coverage differs. In
particular, Alpine's available Chromium 149 is older than the Debian image's
Chromium 153; zero reported findings must not be read as a browser-security
comparison. Keep Alpine optional and review browser updates before rollout.

See [Alpine setup and verification](ALPINE.md) for the compatibility boundary and
the reproducible integration command. The real x86_64 Docker check passed Codex,
Pi, OpenCode and Playwright installation, shared browser input, live audio and
isolation, resizing during recording, video finalization, and failed-install
rollback. Disposable volumes were removed afterward.

## Earlier Debian refresh (before browser audio)

The local Debian candidate **does not pass the HIGH/CRITICAL publication gate**. Nothing
was pushed. This assessment covers the runtime image, not optional harness volumes
or the Docker host kernel.

## Changes and evidence

- Updated `dhi.io/node:26-dev` from index digest `ed16f610dac6454851c7f002edf5a057d27f898cdf42693d330be2550149f6a7`
  to `96edc33ef481be918701de73aaedf073b7d6bc133b3a5637dc334fb5144e7a38`
  (Node 26.9.0).
- Run `apt-get upgrade` before installing runtime packages. The candidate includes
  OpenSSL `3.5.7-1~deb13u2+dhi1` and Expat `2.8.3-1~deb13u1+dhi4`.
- Updated npm to 12.0.2 and its still-vulnerable bundled dependencies using npm:
  `brace-expansion` 5.0.9, `ip-address` 10.3.1, and `tar` 7.5.21. This removes
  CVE-2026-14257, CVE-2026-69152, CVE-2026-69192, and CVE-2026-73566 from the scan.
  npm's development-workspace metadata is removed before updating its runtime
  dependencies; lifecycle scripts are disabled. License files are retained.
- Both scanner paths enforce failure status. Missing scanners fail the build unless
  the operator explicitly selects `--no-scan` for development.

The tested tag is `carapa-bot:0.1.0-cve-test`, image ID
`sha256:efebca2cdd8336a4e910e5de6fb881a8fe700d0eebb191dfef5aab0977402af1`.
Trivy 0.69.3, using its current database, reports:

| Raw package/CVE findings | Before | After |
| --- | ---: | ---: |
| HIGH | 242 | 184 |
| CRITICAL | 4 | 4 |
| Total | 246 | 188 |
| Findings listing a fixed version | 35 | 0 |
| npm findings | 4 | 0 |

There are 129 distinct CVE IDs in the remaining 188 findings. Counts include
multiple binary packages from one source package. DHI also retains some older
`status.d` package records alongside the current dpkg database; scan counts are
not a count of independently exploitable defects. Package metadata was retained.

## Remaining critical findings

| CVE | Reported packages | Upstream assessment |
| --- | --- | --- |
| CVE-2026-6653 | libxml2 | Debian stable still lists this XML parsing use-after-free as vulnerable, with no DSA planned. |
| CVE-2026-60002 | openssh-client, openssh-sftp-server | Debian stable still lists this client-side host-key re-exchange use-after-free as vulnerable; upstream OpenSSH fixes it in 10.4. The source-package match also flags SFTP server. |
| CVE-2026-43185 | linux-libc-dev | A kernel ksmbd finding attributed to a development headers package. The image does not ship or run a kernel; host-kernel exposure needs a separate host assessment. |

Sources: [Debian libxml2 assessment](https://security-tracker.debian.org/tracker/CVE-2026-6653),
[Debian OpenSSH assessment](https://security-tracker.debian.org/tracker/CVE-2026-60002).
The absence of a listed distro fix does not mean a finding is harmless or that no
upstream patch exists. Further remediation requires individual review and
compatible backports or package changes, beyond refreshing stable packages.

For comparison, applying Docker's Node and Debian-base VEX documents suppresses
42 findings, leaving **142 HIGH and 4 CRITICAL**. This comparison is diagnostic,
not the release result: some statements depend on image configuration or Debian's
`no-dsa` assessment. They must not be treated as proof that a general-purpose agent
runtime contains a fix. No ignore list or VEX suppression was added to the gate.
See [Docker's VEX scanning guidance](https://docs.docker.com/dhi/how-to/scan/).

## Test status

The runtime build, TypeScript typecheck, Python build/harness tests, and real Pi
and Hermes harness installation, startup, failure isolation, and rollback passed
for the patched candidate.
The real test uses disposable volumes and no existing agent homes or credentials.

The earlier complete Bun run reported **499 passed, 6 skipped, 2 failed**. After
fixing those issues, the complete suite reports **504 passed, 0 skipped, 0 failed**:

- Mount validation resolves existing symlinks, including parent links followed
  by `..`, while supporting safe directory creation. Filesystem regression tests
  cover escaped targets, dangling/looping links, aliases, and credential roots.
- The five OPA decision scenarios now run together against a temporary fixture
  and the real base policy. They use an isolated, unmocked WASM engine and no
  application stack. CI installs OPA rather than silently skipping missing tools.
- The llama-proxy expectation now verifies both system and developer guidance
  are hoisted in order, matching the existing Responses API normalization.
- Bun ignored the TCP test's requested source address, preventing the sandbox
  deny scenario from being exercised. The default suite now runs that TCP test
  under Node, matching the production ingress runtime.

Typechecking and all three Rego policy tests also pass. These controller/test
fixes do not change the runtime image CVE assessment above.

Refresh the image and scanner results before publishing; this is dated evidence,
not a permanent vulnerability exemption.
