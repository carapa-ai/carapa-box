# CarapaBot

Isolated coding-agent runtime for CarapaBoard, managed through CarapaBox.

The image includes Node, Bun, Python, Chromium, and CarapaBot's runtime commands.
Install only the coding harnesses you need into a separate persistent volume.
Compatible harness updates do not require rebuilding the runtime image.

See the [CarapaBot setup guide](https://github.com/carapa-ai/carapa-box/tree/main/stacks/carapa-bot)
for versioned image configuration, harness installation, and deployment through
CarapaBox. Use a published version tag or digest for deployments.

## License

**CarapaBot is licensed under PolyForm Noncommercial 1.0.0**, including its source
code, scripts, and binaries distributed in this image.

This image includes Docker Hardened Images and third-party components under their
respective licenses. Docker's DHI material is licensed under Apache 2.0. That
license does not replace CarapaBot's license or the licenses of bundled packages.
Public availability on Docker Hub does not remove CarapaBot's noncommercial terms.

The image contains CarapaBot's license and third-party notice at:

- `/usr/share/licenses/carapa-bot/LICENSE`
- `/usr/share/licenses/carapa-bot/THIRD-PARTY-NOTICES.md`
- `/usr/share/licenses/carapa-bot/Apache-2.0`

Read the [PolyForm Noncommercial 1.0.0 terms](https://polyformproject.org/licenses/noncommercial/1.0.0)
and the [third-party notice](https://github.com/carapa-ai/carapa-box/blob/main/stacks/carapa-bot/THIRD-PARTY-NOTICES.md).
Optional harnesses installed into volumes retain their own licenses and provider terms.
