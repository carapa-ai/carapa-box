# DHI Alpine runtime

`Dockerfile.alpine` provides an optional public CarapaBot runtime using the same
DHI Alpine 3.23 family as CarapaBox. The pinned DHI Node 26 development image
provides real Node.js; Bun 1.4.2 is copied from the controller's exact pinned DHI
Bun image. Using the Bun image directly conflicts with Alpine's Node package
because Bun's package also provides the `node` command.

This image follows the public packaging model: embedded CarapaBot commands and
entrypoint, unprivileged `ubuntu` (1000:1000), and separately installed, read-only
harness volumes. It does not bundle personalized agent homes or agent packages.

## Build and select

From this directory on the Docker operator host:

```sh
./build.sh --alpine
```

The default tag is `carapa-bot:0.1.0-alpine`. The command retains the HIGH/CRITICAL
scan gate. It ignores a Debian image setting in this directory's `.env`; an
explicit `CARAPA_BOT_IMAGE` environment variable can choose another versioned tag.
Building does not update harness selections or recreate running containers.

Use `./update-harnesses.sh --alpine [harness...]` to update an existing Alpine
selection, adding `--stack-dir /path/to/alpine-stack` for a consumer stack.
Omit harness names to update all installed packages. The same script accepts
`--debian`; updating one distribution preserves the other selection.

For a separate Alpine stack, set `CARAPA_BOT_IMAGE=carapa-bot:0.1.0-alpine` in that
stack's `.env`, then install its harnesses using the public operator tool:

```sh
python3 harness.py --stack-dir /path/to/alpine-stack install codex pi opencode playwright
```

Alpine uses musl, a different C runtime from Debian's glibc. Existing Debian
harness volumes cannot be reused. For an intentional conversion of an existing
stack, use `install --replace` after selecting the Alpine image. Retain the old
image and selection for rollback, and recreate only the intended consumers once
the new selection verifies. The installer rejects incompatible ABI metadata.

## Browser and audio

The image includes Alpine's Chromium, PulseAudio, fonts, and FFmpeg. Browser
sessions use private sound servers and null sinks; host audio devices are not
needed. The viewer's existing Enable sound and Mute controls use the same
session-isolated audio transport as the Debian runtime.

The shared Playwright capture helper also allows a live viewer to request a
larger stream while recording is active. The video encoder retains its output
dimensions; attaching or resizing a viewer does not stop the recording.

Playwright uses system Chromium. For video recording, the installer links the
system FFmpeg executable into the browser-cache location expected by the pinned
Playwright version, inside its harness volume. There is no runtime download or
dependency on a prepopulated agent home. OpenCode installs its upstream musl
archive instead of the glibc archive.

## Verification

Run the disposable integration check from this directory:

```sh
python3 test/docker-smoke.py --image carapa-bot:0.1.0-alpine \
  --harness codex --harness pi --harness opencode --harness playwright --browser
```

The check installs real upstream packages into temporary volumes, verifies the
read-only runtime and entrypoint, opens two isolated browsers, exercises viewer
input and sound, finalizes a video, and checks failed-install rollback. It uses
no existing agent homes or credentials and removes its volumes afterward.

On 2026-09-22, the x86_64 candidate verified Codex 0.155.1, Pi 0.87.0, OpenCode
1.18.32, and Playwright CLI 0.1.19. The real browser check passed live frames,
sound, mute, cross-session sound isolation, native-resolution resizing while
recording, navigation, keyboard/mouse and dropdown input, reconnect, and a
finalized WebM video. Typechecking, 81 runtime tests, the build/harness unit
checks, and three shared browser-session tests also passed. The complete Docker
check passed installation failure isolation and rollback, then removed its
temporary volumes.

Alpine is an optional compatibility target. Firefox/WebKit, other harnesses,
authenticated model turns, and ARM64 require their own verification before use.
An attempted twelve-harness consumer migration on 2026-09-22 was rejected by
runtime validation: Oh My Pi 18.2.8's `pi_natives` addon targets glibc and cannot
load in musl Bun, even with gcompat. Its failed installation preserved the active
Debian selection. Do not migrate an OMP-dependent consumer to this image.
The consumer was subsequently configured with a verified six-harness selection:
Codex 0.155.1, Claude 2.1.278, Pi 0.87.0, OpenCode 1.18.32, Playwright CLI 0.1.19,
and Yarn 1.22.22. The prior Debian volume is retained for rollback.
The local Docker check does not substitute for a CarapaBox-managed deployment
check with the target stack's network policy and sandbox runtime.

See [the dated security assessment](SECURITY-SCAN.md) for scan results. Scan
counts are distribution-specific and are not proof that an image has no
vulnerabilities.
