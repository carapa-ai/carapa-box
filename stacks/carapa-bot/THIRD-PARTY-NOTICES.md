# CarapaBot image licensing and third-party notices

CarapaBot is licensed under PolyForm Noncommercial 1.0.0. Its source code, scripts,
and binaries remain under that license when distributed in this image. The terms
are in the adjacent `LICENSE` file and at:
https://polyformproject.org/licenses/noncommercial/1.0.0

This image includes Docker Hardened Images and third-party components under their
respective licenses. This notice does not replace those licenses, change their
permissions, or apply CarapaBot's noncommercial restriction to third-party software.

## Docker Hardened Images

Docker's DHI Community material is licensed under Apache License 2.0. A copy of
those terms is available at `/usr/share/licenses/carapa-bot/Apache-2.0`: the Debian
image links its system license; the Alpine image ships the official license text.

- DHI documentation: https://docs.docker.com/dhi/
- DHI definitions and license: https://github.com/docker-hardened-images/catalog
- Apache 2.0 terms: https://www.apache.org/licenses/LICENSE-2.0

The base image reference is pinned in CarapaBot's Dockerfile. CarapaBot adds its
own runtime tools, configuration, package updates, and harness installer. These
additions do not make the entire image Apache-licensed or imply Docker endorsement.

## Playwright select-menu renderer

`bin/browser-select-menu.cjs` is generated from the select-menu renderer in
CarapaAI's Playwright fork and is licensed under Apache License 2.0. A copy of
those terms is available at `/usr/share/licenses/carapa-bot/Apache-2.0`.

- Source: https://github.com/carapa-ai/playwright (branch `carapa-browser-viewer-1.66`,
  commit `58ef715f610229f18c3e332be2e8f01926094122`),
  a fork of https://github.com/microsoft/playwright
- Apache 2.0 terms: https://www.apache.org/licenses/LICENSE-2.0

Playwright NOTICE:

```text
Playwright
Copyright (c) Microsoft Corporation

This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer), available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).
```

This component stays under Apache-2.0 and is not covered by PolyForm Noncommercial.

## Bundled system packages and runtimes

System packages and their dependencies retain their individual licenses. Debian
package notices are available under `/usr/share/doc/<package>/copyright` where
provided by the package; common license texts are in `/usr/share/common-licenses/`.
For Alpine, package license declarations remain in `/lib/apk/db/installed`.
The Alpine image copies Bun 1.4.2 from CarapaBox's pinned DHI Bun image; its upstream
license and bundled-component notices are retained in
`/usr/share/licenses/carapa-bot/Bun-LICENSE` (from that release's `LICENSE.md`).

Node.js, Bun, npm, Yarn, Python, Chromium, and other bundled tools retain their upstream
licenses and third-party notices. Relevant upstream sources include:

- Node.js: https://github.com/nodejs/node and its `LICENSE` file.
- Bun: https://github.com/oven-sh/bun and https://bun.com/docs/project/license.
- npm: `/opt/npm/lib/node_modules/npm/LICENSE`; bundled dependency licenses remain
  in their package directories. The base image's npm is under `/usr/lib/nodejs/npm/`.
- Yarn: `/opt/yarn/lib/node_modules/yarn/LICENSE`.
- Python and Chromium: their Debian package copyright files under `/usr/share/doc/`.

CarapaBot updates npm's bundled brace-expansion, ip-address, and tar dependencies
and adjusts npm's development-workspace metadata, as recorded in the Dockerfile
and npm's `package.json`. Their upstream license files are retained.

This document is an index to licensing information, not a replacement for the
component notices or any applicable source-distribution obligations.

## Optional harnesses

Harness packages are installed separately into user-selected volumes and are not
included in the runtime image. Each installed harness remains subject to its own
license and any applicable provider terms. CarapaBot's license grants no additional
rights to those packages.
