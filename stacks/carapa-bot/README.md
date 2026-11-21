# CarapaBot Stack

Isolated agent execution container for CarapaBoard. Runs coding harnesses inside a locked-down Docker container with network egress through a proxy and MCP tool access via relay. CarapaBox remains the only Docker control boundary.

## Public image and harness setup

The public image is **`carapa-bot:0.1.0`**. Set `CARAPA_BOT_IMAGE` to a versioned
Docker Hub name such as `<namespace>/carapa-bot:0.1.0`, or an image digest.
`<namespace>` is a placeholder for your own registry namespace; no prebuilt image is published for the
alpha, and the default path is the local build (`./build.sh`, or `stacks/rebuild-agents.sh`).
`carapa-bot-agent:latest` is reserved for the separate personalized stack.

The image contains the system runtime, Node, Bun, Python, Chromium, all `bin/`
control commands/adapters, and the installer. It contains **no harness packages,
credentials, or deployment CA certificate**. `.dockerignore` limits build inputs.
The standard Compose definition pulls no images and mounts no host `bin/`.

Bun is pinned to `1.4.4` (`BUN_VERSION` in the `bun-build` stage of `Dockerfile`). The
build downloads the official release zip for the build architecture, verifies it against
the sha256 ARGs in the Dockerfile, and fails if `/opt/bun/bin/bun --version` differs. To
bump it, change `BUN_VERSION` and both `BUN_SHA256_AMD64` / `BUN_SHA256_ARM64` values
(from the release's `SHASUMS256.txt`: `bun-linux-x64.zip`, `bun-linux-aarch64.zip`).

### License

CarapaBot is licensed under **PolyForm Noncommercial 1.0.0**, including its source
code, scripts, and binaries distributed in this image. See [LICENSE](LICENSE),
which is a distribution copy of the repository's [canonical license](../../LICENSE).

This image includes Docker Hardened Images and third-party components under their
respective licenses. Docker's DHI material is licensed under Apache 2.0; this does
not relicense CarapaBot or the bundled packages. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
The image packages these documents at `/usr/share/licenses/carapa-bot/`, with a
copy of the applicable Apache 2.0 terms available there as `Apache-2.0`.

### Installation

On the Docker operator host, from this directory:

```sh
cp .env.example .env
# Configure workspace/home/group/IPC paths for your CarapaBox installation.
# Set CARAPA_BOT_IMAGE in .env when using a registry namespace.
# Only if the image is in your own registry (<namespace> is a placeholder for your namespace).
# Otherwise skip the pull and build locally with ./build.sh.
docker pull <namespace>/carapa-bot:0.1.0
python3 harness.py install codex
# Start the stack through CarapaBox after installation succeeds.
```

For a local build, first authenticate with `docker login dhi.io`, then replace
the pull with `./build.sh`. DHI credentials are needed by the builder; consumers
pulling the completed public image from Docker Hub do not need DHI access.
The build runs a Trivy/Scout HIGH/CRITICAL gate and fails if no scanner is installed.
`--no-cache` refreshes runtime packages; `--no-scan` explicitly skips the gate for
development. The build never installs or
updates harnesses. `VERSION` supplies the OCI version label; bump it and the
Compose/config defaults together for a runtime release. The runtime CVE scan does
not scan separately installed harness volumes. See [the dated scan assessment](SECURITY-SCAN.md)
for the current candidate's remaining findings and publication status.

### Select and update harnesses

Run `./update-harnesses.sh` with no arguments to open the shared harness TUI. It
shows installed versions, upstream versions and update status for both ABI
variants. Move with the arrow keys or click a row with the mouse; Space or a left
click toggles a checkbox. `i` installs checked missing harnesses, `u` updates
checked installed harnesses, and `d` removes checked harnesses after confirmation.
`c` makes the checked set the complete installed set and confirms any removals.
`r`/`R` refreshes the selection and version checks. `v` switches volumes, `b`
rolls back checked harnesses, `p` previews cleanup, and `P` applies cleanup. The
TUI starts with no harnesses selected; use `a` to select all compatible rows. It
does not rebuild the runtime image or restart containers.
Use `./update-harnesses.sh --tui` when you want to make the mode explicit.

The existing command-line form remains available: `./update-harnesses.sh claude`
updates only Claude, while omitted harness names update every installed harness.

For a consumer stack, pass `--stack-dir /path/to/stack`. If it has selections
for both distributions, `--debian` or `--alpine` updates that distribution's
volume. An inactive distribution is recovered from its latest saved selection
and updated independently; the configured stack keeps its current distribution.
The latest selections are retained under `.harness/variants/`. To intentionally
switch distributions, configure the matching runtime image and use
`harness.py select <volume>` before recreating the intended containers.

```sh
./update-harnesses.sh --configure claude codex # choose the complete installed set
./update-harnesses.sh --install hermes         # add one harness
./update-harnesses.sh --remove hermes          # disable for new runs
./update-harnesses.sh --configure none         # empty installed set
python3 harness.py install codex claude       # install/add selected harnesses
python3 harness.py install codex@<version>    # install a specific package version
python3 harness.py update codex              # update only Codex; retain other packages
python3 harness.py update                    # update every installed harness
python3 harness.py status                    # selected volume and package versions
python3 harness.py check                     # offline runtime/volume validation
python3 harness.py rollback claude          # restore only Claude
python3 harness.py cleanup                  # preview obsolete releases
python3 harness.py cleanup --apply          # remove unleased obsolete releases
python3 harness.py install --replace pi      # replace the whole selected set
python3 harness.py install none              # initialize with no harnesses
```

Supported names: `codex`, `claude`, `opencode`, `pi`, `omp`, `cursor`, `hermes`,
`prime-agent`, `antigravity` (Python SDK), `antigravity-acp`, `muse`, `grok`, `vibe`, and `playwright`.
Yarn is supplied by the Debian/Alpine runtime image as package-manager tooling;
legacy volume entries remain accepted by the installer but are not selectable in
the TUI. Unspecified package versions resolve upstream stable/default releases.
Cursor, Prime and Muse Code use their upstream installers and support `latest` only.
Muse also installs the community `@brokkai/muse-acp` bridge pinned at **0.13.1** (glibc only).
Grok Build is adapter-tested at **1.0.52** (glibc only), Mistral Vibe at **3.1.0** (glibc only).
Playwright is adapter-tested at **0.1.24**; changing these pins requires updating and testing the
shipped installer. Antigravity ACP (the Antigravity CLI) is not pinned: it installs the latest GitHub
release, verified against the SHA-256 GitHub publishes for it.

Each stack/distribution has a stable named store volume. Packages live in
immutable release directories under `/opt/carapa-harness-store/releases/`;
`/opt/carapa-harness/bin` contains stable launchers. Updating a subset installs
only those harnesses. Python harnesses retain independent virtual environments.
`--configure` retains existing versions and installs missing tools; explicit
`name@version` specifications replace those tools. Routine updates honor the saved
set. Removal retains rollback and active-run files until safe cleanup, so it
need not reclaim space immediately.

One atomic selection change publishes the complete update after validation.
Pi's MCP extension is supplied from its pinned release at launch.

Only a temporary installer gets network access (`bridge`). It runs as UID 1000
without capabilities, credentials, host home/workspaces or a Docker socket.
Its candidate release is writable; existing releases and selection are read-only.
Offline validation checks the runtime ABI, executable paths, Python imports and
CLI startup. An installation/validation failure leaves the previous selection
active. Sandboxes never install packages at startup.

After the one-time migration, a fresh agent run snapshots the current selection.
Its children and detached processes inherit that snapshot. Existing processes
and warm conversation daemons keep their original releases; new conversations
or restarted harness daemons pick up updates without restarting the sandbox.
The updater itself never stops agent processes.

Cleanup runs after successful updates, and can be previewed with
`./update-harnesses.sh --cleanup` or applied with `--cleanup --apply`.
It retains the current and previous release **per harness**, plus all releases
leased during each running sandbox's current boot. Boot-long leases deliberately
protect detached descendants: versions used in a long-running sandbox stay on
disk until that sandbox eventually stops. gVisor locks are not shared with the
host, so cleanup does not rely on `flock` to detect readers. Pending launches,
paused/restarting containers or inaccessible consumers cause cleanup to skip
deletions. Legacy named volumes are left untouched by release cleanup.

Migration from the previous one-volume-per-update layout requires a runtime
rebuild/pull with these launcher changes, the updated AppArmor profile (including
read/execute access to `/opt/carapa-harness-store/**`), and one CarapaBox recreation
of each intended sandbox to adopt the two read-only mounts. Run the updater to
prepare its stable store first. Subsequent package-only updates need no rebuild
or recreation. Provider login needs `PROVIDER_LOGIN_HARNESS_VOLUME` set once to
the chosen stable store and an updated controller; subsequent login workers use
the current harness releases automatically. Distribution/runtime ABI changes
still require a matching image and sandbox recreation.

Runtime compatibility records architecture, Node major, Python major/minor and
libc alongside the layout version. An ABI mismatch requires `install --replace`
using the new image. Upstream protocol changes may require a new CarapaBot adapter
release even when the binary ABI matches. Basic CLI checks do not prove every
provider/model interaction works.

### Image commands, development overrides, and trust

`bin/` is copied to `/usr/local/ai-cli-bin` in the image. The base Compose field
`x-carapa-command-source: image` instructs CarapaBox to resolve bare commands there,
even when their build source exists in the checkout. This requires the matching
CarapaBox command-resolution update. Stacks without that field retain the existing
host-override behavior.

For explicit development overrides, add `docker-compose.dev.yml` to `COMPOSE_FILE`
and invoke `/usr/local/stack-cli-bin/<command>`. To make bare commands use that
mount too, set the **base file's** `x-carapa-command-source` to `stack`. Host
executables still undergo CarapaBox validation. Release deployments use the
embedded commands by default.

For a private CA, set `CARAPA_CA_CERTIFICATE` to its absolute host path and use
`COMPOSE_FILE=docker-compose.yml:docker-compose.ca.yml`. The optional mount
populates Chromium's NSS store and extends Node/Python/curl trust at startup.
The override also sets trust variables for commands launched through CarapaBox.
The public image itself contains only the standard system CA roots.

### Validation

All harnesses share the tool-call markup detector, correction prompt, and one-attempt
retry budget in `bin/runtime/tool-call-recovery.ts`. When an otherwise successful
turn ends with an unexecuted call printed as text, the runtime continues in the
same session, preserving the model, reasoning level, and earlier tool results.
It never executes the markup itself or resends the original request. Quoted
examples, tool results, and reasoning do not trigger recovery. A subsequent
real tool action does not prove that an earlier printed call executed, so the
printed call remains pending until the correction. The Board run stays open, shows a correction notice, and fails
clearly if the corrected response still prints calls. Cancellation prevents a
correction, including between provider turns.

Codex also attempts the same bounded correction when a turn with pending
tool-call text fails, including after provider truncation or invalid-history
errors. Failures without pending markup and interrupted turns are not retried.
A provider that still rejects the saved history leaves the run failed; the
runtime does not rewrite history or replay the original request.

Codex, Claude, Pi, and the five ACP adapters use their existing session protocols.
Pi checks for idle state before sending the correction, allowing its own queued
work or retries to finish. OpenCode resumes the native session after its process
exits. The Antigravity SDK uses the existing warm Python shim within the run;
its display session ID cannot restore history across processes. These are runtime
wrapper changes, with no upstream harness or egress-proxy modifications.

```sh
python3 test/build.test.py
python3 test/harness.test.py
# Requires local Docker and upstream network access; removes its temporary volumes.
python3 test/docker-smoke.py --image carapa-bot:0.1.0 --harness codex
python3 test/docker-smoke.py --image carapa-bot:0.1.0 --harness hermes
```

The Docker smoke test checks embedded commands, optional package installation,
controller startup validation, both Compose variants, failed-update isolation,
and rollback. It mounts no credentials or existing agent homes.

### Publishing

Use [DOCKER-HUB.md](DOCKER-HUB.md) as the Docker Hub repository's Overview text.
Image pushes do not update that text automatically. Keep its licensing statement
when editing the listing. If the repository license changes, refresh this stack's
`LICENSE` copy from `../../LICENSE` before building.

Build and validate a versioned image before pushing it:

`<namespace>` below is a placeholder for your own registry namespace.

```sh
CARAPA_BOT_IMAGE=<namespace>/carapa-bot:0.1.0 ./build.sh
# After release review and Docker Hub authentication:
docker push <namespace>/carapa-bot:0.1.0
```

Docker permits redistribution of its DHI Community material under
[Apache 2.0](https://docs.docker.com/dhi/). CarapaBot's own software remains under
PolyForm Noncommercial 1.0.0. Preserve applicable licenses and notices, including
the separate licenses of bundled system/runtime packages.
Authentication to fetch the base is independent of redistribution permission.
For publishing with Docker Scout's inherited DHI VEX support, build with
`--provenance=mode=max --sbom=true` and an attestation-capable image store/exporter;
see [Docker's child-image scanning instructions](https://docs.docker.com/dhi/how-to/scan/).
The ordinary local build uses the unsuppressed scanner gate. Review the applicability
of vendor VEX to the completed agent image before adopting any suppression.

Publish runtime releases when the OS, runtimes, CarapaBot commands/adapters, or
installer support changes. Compatible upstream harness updates only replace a
volume. No personalized shared component images, cache builder or host storage
layout is required. The default public runtime uses the pinned Debian/glibc
Dockerfile. An optional DHI Alpine/musl runtime is built with `./build.sh --alpine`
as `carapa-bot:0.1.0-alpine`; see [Alpine setup and verification](ALPINE.md).
It requires a fresh, compatible harness selection and does not replace the
default Debian image or existing containers.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile`, `.dockerignore`, `VERSION` | Public runtime build and version |
| `LICENSE`, `THIRD-PARTY-NOTICES.md` | CarapaBot license and third-party notice packaged in the image |
| `DOCKER-HUB.md` | Docker Hub Overview text for publication |
| `docker-compose.yml` | Hardened consumer of the versioned image and selected volume |
| `docker-compose.git.yml` | Named-volume workspace variant |
| `build.sh` | Runtime build and optional image CVE scan |
| `harness.py` | Operator-side installation, validation, selection and rollback |
| `harness/` | Image-owned package installation and offline validation |
| `before-start.sh`, `check-harness.mjs` | Read-only controller validation; prepare Git workspace when requested |
| `bin/` | Embedded control commands and Bun runtime adapters |

## How Agent Runs Work

CarapaBoard writes `args.json` and `prompt.txt` to a mounted IPC run directory
and asks CarapaBox to execute the stable `run-agent.sh <run-dir>` entrypoint.

```text
CarapaBoard ──CarapaBox──► run-agent.sh → detached run worker
      ↕ mounted IPC                           │
 logs, V1 events, controls                     ├─ typed harness adapter
                                              └─ detached protocol supervisor
                                                   └─ provider stdin/stdout
```

The worker owns output translation, resource monitoring, metrics and per-turn
controls. The supervisor owns provider pipes, an atomic request spool and an
append-only raw output journal. Neither process is owned by the Board process.
Even `run-agent.sh --exec <run-dir>` is an attached waiter around a detached
worker: losing the caller does not cancel the turn. Re-launching the same run
directory returns its existing worker identity instead of dispatching twice.

Claude only treats a message as a slash command when it starts with `/`, which
the composed `prompt.txt` never does. Board may therefore also write an optional
`user-command.txt` with the user's raw `/<name> …` message (first paragraph
only). The Claude runner sends the normal `prompt.txt` frame first and, once
that turn and any steer or background-task notification turns have their
results, the command as a second `user` frame, so `/goal` registers its Stop hook
on top of the board context. The run completes after the second result, and cost
and metrics count both turns. The command is forwarded
only when its name is in `CARAPA_CLAUDE_FORWARD_COMMANDS` (comma-separated,
default `goal`) and, if the CLI's `system/init` lists `slash_commands`, in that
list. Skill-backed commands such as `/reflect` stay out of the default
allowlist because the model already runs them from `prompt.txt`. An interrupt
before the command frame is sent cancels it. Other harnesses ignore the file.

Board may restart/reconnect and reread the durable IPC files while the container
continues running. This does **not** keep an active turn alive across a container
restart or host reboot. Run directories are single-use; use a new directory to
retry a completed or failed run.

### One runtime per harness

| Harness | Canonical transport | Fresh run | Persistent conversation |
| --- | --- | --- | --- |
| Codex | Typed app-server JSON-RPC | Run-scoped supervised daemon | Reuse daemon and thread |
| Cursor, Grok Build, Hermes, Mistral Vibe, Muse Code, OMP, Prime Agent, Antigravity ACP (opt-in) | Typed shared ACP | Run-scoped supervised daemon | Reuse daemon and native session |
| Pi | Typed Pi RPC | Run-scoped supervised daemon | Reuse daemon and native session |
| Claude | Typed CLI stream-json | Run-scoped supervised process | Reuse process and native session |
| OpenCode, Antigravity SDK | Native CLI adapter and V1 normalizer | One CLI process | Same adapter; CLI resume where supported (SDK IDs are display-only) |

Registered names are `antigravity-acp`, `codex`, `cursor-acp`, `grok-acp`, `hermes-acp`, `muse-acp`, `omp-acp`,
`prime-agent-acp`, `vibe-acp`, `pi`, `claude`, `opencode`, and `agy-sdk`.

`muse-acp` drives Meta Muse Code through the community `@brokkai/muse-acp`
bridge. Sign in through Board Provider accounts (Meta / Muse Code), never with
`muse login` in a sandbox. Each run gets a placeholder Muse login that points at
the relay, which adds the account's key; the real key never enters the sandbox.
Every run starts `muse serve` with contributor mode off and Muse's own sandbox
disabled; the container is the boundary.

`grok-acp` drives xAI Grok Build through its native ACP mode
(`grok agent --always-approve stdio`). Sign in through Board Provider accounts
(xAI / Grok Build); the relay keeps and renews the subscription login. Each run
gets a placeholder login and points Grok's CLI chat proxy at the relay's `xai`
route. Telemetry, trace upload, memory, feedback, auto-update, workspace
snapshots and Claude MCP import are disabled.

`vibe-acp` drives Mistral Vibe (`vibe-acp`). The relay's `mistral-vibe` route
holds a Vibe CLI key (console Code → Vibe CLI), billed to the plan's included
Vibe Code usage; Vibe sees the placeholder key `carapa-relay`. Settings come
from `VIBE_*` variables, which outrank any `.vibe/config.toml`: the relay as the
only provider, the extra models (Small 4, Large 4, GLM 5.3 and 5.3 Flash), and
telemetry, connectors, experiments and update checks off. Each conversation gets
its own `VIBE_HOME` with the workspace trusted and a read-only `carapa-plan`
profile for plan mode (no bash, edit or write_file).

`cursor-acp` drives the Cursor CLI (`agent ... acp`). Sign in through Board
Provider accounts (Cursor); the relay keeps the login (about 60 days, then
reconnect). Each conversation gets its own `XDG_CONFIG_HOME` with a placeholder
login, the shared `~/.cursor/cli-config.json` settings with
`network.useHttp1ForAgent` forced on, and links to the rest of `~/.config`.
`CURSOR_API_ENDPOINT` points at the relay's `cursor` route, which answers the
CLI's telemetry (analytics, metrics, OpenTelemetry) itself; HTTP/1.1 keeps agent traffic on that endpoint.

Typing `grok`, `muse`, `vibe`, `agent` or `cursor-agent` in a sandbox terminal runs the
`bin/` wrapper of the same name: it applies the harness's relay login and
privacy settings in `~/.carapa/` (Muse also gets `--contributor-mode off
--disable-sandbox` for the TUI, `exec` and `resume`), then starts the real CLI.
Board runs set their own `GROK_HOME`/`XDG_CONFIG_HOME`/`VIBE_HOME`/`CURSOR_API_ENDPOINT`
and pass straight through.
Unsupported names fail explicitly. The old shell runtime, JavaScript Codex
runner and unused native OMP runtime have been removed.

Transport does not change between fresh and persistent turns. The explicit
exception is that OpenCode/SDK adapters do not implement a warm stdio
protocol: OpenCode resumes native history with a new CLI process; the current SDK shim only preserves its display session ID, not native history. They do not gain
steering or interactive controls merely by setting `persistent=1`.

Conversation locks serialize turns. Lifecycle locks exclude new turn claims
during shutdown/discard, and ownership checks reject an older run's attempt to
stop a session currently used by another run. Idle daemon retirement preserves
history; failed protocol sessions are retired instead of reused.

### Experimental Antigravity ACP (alongside SDK)

`antigravity-acp` is independently selectable through the existing run-directory
contract. `agy-sdk` and Board's default are unchanged; there is no fallback
between the two. Board exposes ACP when its external `board_agents.jsonc` catalog
includes an `antigravity-acp` harness and model bindings. This step does not add
Board provider setup UI.

Run `python3 harness.py install antigravity-acp` to install Google's pinned
Antigravity CLI (GitHub release, Linux x64/ARM64) into the selected volume; Board
runs its `acp` command. The installer verifies the archive's SHA-256 for the
current architecture. Ordinary sandbox runs download nothing.

Minimal `args.json` alongside `prompt.txt`:

```json
{
  "agentCmd": "antigravity-acp",
  "workDir": "/workspace/project",
  "persistent": "1",
  "conversationKey": "antigravity-acp-new-conversation",
  "env": {
    "ANTIGRAVITY_ACP_AUTH_METHOD": "gemini-api-key"
  }
}
```

The default auth method is `gemini-api-key`. Both ACP and SDK now send a dummy
`GEMINI_API_KEY` to `GOOGLE_GEMINI_BASE_URL=http://api-relay:8080/google`.
The native runtimes honor this base URL without TLS interception. The relay
replaces `x-goog-api-key` with its own Google credential and removes client `key`
query parameters before logging/forwarding. Other inherited Google credentials
are removed from the harness environment. Neither harness reads a sandbox key
file or `.gemini/oauth_creds.json`; never put real keys in run `args.json`.

Deploy/restart the updated egress relay first,
with the same intended Google account/key configured as relay `google_api_key`
or a per-client override. Then recreate the bot sandboxes to remove the old
`gemini_api_key` mount and retire credential-bearing processes. The stack no
longer declares that secret. Restarting only Board is insufficient. Existing
user-owned credentials elsewhere in the shared home are not deleted by this
change; audit them separately before claiming a completely credential-free home.

The first follow-up to an existing scoped API-key ACP conversation performs a
one-time identity migration under its session lock, retires its old daemon, and
resumes the same native history. This requires a completed run with matching
group/conversation/workspace/binary configuration and an existing API-key native
profile; OAuth/custom profiles are excluded. The old fingerprint is retained as
`adapter_identity.pre-relay`. Subsequent endpoint/profile changes still fail
closed and require a new conversation. No legacy key is read for migration.

For `oauth-personal` (an explicit non-relayed exception), set `ANTIGRAVITY_ACP_HOME` to an existing, separately
authenticated profile containing `antigravity-cli/` (the CLI's `--gemini-dir`). Ordinary runs
do not open a browser or implement OAuth callback forwarding. Enterprise/Vertex
setup and interactive account management are not included in this step.

Optional `ANTIGRAVITY_ACP_BIN` selects an already installed `antigravity`
executable. Without an override `/opt/carapa-harness/antigravity-acp/antigravity`
is used. Conversations from the earlier ACP server 1.1.1 cannot be resumed by the
CLI; continue them in a new conversation.

Fresh and persistent runs use the same ACP transport. Follow-ups reuse the daemon;
cold starts call native `session/resume`, and a failed resume fails the run without
creating a replacement. Use a new conversation key when changing auth/profile
or switching from SDK; SDK session IDs are not native ACP resume handles.

Board must register `antigravity-acp` as a persistent ACP harness and enable
`CARAPA_PERSISTENT_CLAUDE=1` (the shared warm-harness switch). Fresh and persistent
runs share `/workspace/ipc/antigravity-home`; per-session native databases and
brain artifacts remain there across runtime cleanup. Auth/profile fingerprints
are stored alongside the native history and checked on cold resume. Explicit
custom/OAuth homes are unchanged. Missing native history fails
the turn; Board must not automatically retry ACP with an empty session.

This initial adapter supports text prompts, prepended `systemPrompt` instructions,
explicit model selection, ordinary tool events/usage, and interrupt controls.
It selects native `yolo` mode, grants only offered `allow_once` permissions, and
fails explicitly on native `interaction_*` questions rather than guessing an
answer. Attachments, question-answer UI, and rich subagent visualization are not
implemented. Board Plan mode is rejected; the native `/plan` command can be sent
as prompt text. File/terminal client capabilities remain off, so native tools
execute inside the agent container, not in Board.

Native `Agent execution error: model unreachable:` messages are treated as
provider failures even when ACP returns `stopReason: end_turn`; the run emits
failed terminal events and exits nonzero instead of reporting success.

Validate real-provider auth, model access, tools, cold resume, egress and Board
restart behavior in the CarapaBox sandbox before default cutover. Mock-provider
tests do not establish those deployment guarantees.

### Stable native session storage

Board supplies the provider session ID from its database. Codex uses
`/workspace/ipc/codex-home`, Pi uses `/workspace/ipc/pi-sessions`, and Antigravity
uses `/workspace/ipc/antigravity-home` for both fresh and persistent runs.
`sessions/<key>` holds only disposable process/transport files and warm-session
caches. Other harnesses keep their existing provider-owned durable storage.

`prune-ipc.sh` previews removal of runtime directories inactive for seven days;
`--apply` removes them after checking process ownership and lifecycle locks.
Native history stays in its permanent provider directory.

The provider session ID from Board is sufficient to select a conversation after
runtime eviction. Antigravity validates its persisted configuration fingerprint;
profiles moved to the shared home retain their former path only to validate that
fingerprint on the next resume. Older fresh Pi tasks can adopt the explicitly
requested native history from the provider's cwd-scoped default directory.
Neither compatibility path changes the runtime cleanup policy.

### Explicit lifecycle controls

Inside the agent container:

```sh
control-agent.sh <run-dir> interrupt
control-agent.sh <run-dir> stop-daemon
control-agent.sh <run-dir> discard-conversation
```

- `interrupt`: cancel the current turn, retaining its managed daemon and history.
  Native CLI adapters stop their run process because they have no in-session
  interrupt protocol. An unconfirmed protocol cancellation returns an error;
  it does not silently escalate to daemon shutdown.
- `stop-daemon`: stop the owned daemon/run worker while keeping resume state.
- `discard-conversation`: stop the owned runtime, remove its managed session
  directory and write a discard marker so stale caller-supplied session IDs
  cannot restore it. This is not secure erasure of a provider's global history
  or previously retained run logs.

The commands return JSON with `ok`, `action`, and an optional `error`.
Existing Board file-based control requests and `stop-agent.sh` remain supported;
the latter is the compatibility hard-stop operation. No Board changes or new
Docker access are required. The new actions are available at the container
entrypoint; Board UI wiring is a separate change.

### Durable output contract

Every supported adapter emits `output.v1.jsonl` and `output.v1.meta.json`.
Their schemas live in `bin/runtime/schema/`. The stream normalizes sessions,
messages, tools, usage, interactions and terminal run status. Exact provider
frames remain available in harness-specific raw sidecars; compatibility
`output.jsonl` remains available for existing Board consumers.

Codex, ACP, Pi and Claude share incremental journal reading and the detached supervisor;
Codex and ACP also share correlated JSON-RPC requests with validation,
deadlines and disconnect rejection. Pi retains its distinct RPC envelope.
Claude uses `--input-format stream-json --output-format stream-json` directly,
without an Agent SDK dependency. Persistent turns retain the same process and end
on a native `result` frame; fresh runs retire their process after the result.
The adapter initializes the protocol once and acknowledges interruption only
when Claude replies to its correlated control request. Steering and interactive
permission/answer controls are not supported. An unsupported incoming permission
request is denied explicitly rather than left waiting.

The supervisor retires idle Claude processes after `CARAPA_PERSIST_IDLE_MIN`
(default 30 minutes), preserving native resume state. A changed model, effort,
system prompt, working directory or provider environment starts a replacement
process with `--resume`. Board may omit the system prompt on follow-ups; the
initial prompt is retained verbatim for warm turns and process recovery. An explicit fork creates a new native session. A turn
left unfinished by a dead worker also forces process replacement before another
prompt is dispatched. Protocol failures and turn timeouts retire the process.

Claude costs prefer its reported USD total, converted to a per-turn amount after
checking session token counters against the previous result. This also detects
accounting resets after a restart. Unknown histories and missing native costs
fall back to `model_pricing.jsonc`; `cacheWrite` configures the standard five-minute
cache rate. The adapter publishes `claude-turn-cost.json` under the session lock
so metrics collection cannot race with the next turn's accounting snapshot.

The worker publishes `exit_code` and `metrics_complete` after output finalization.
A killed worker can leave incomplete metrics; process recovery remains necessary
for crashes of the worker/container, distinct from a Board restart.

### Verification

Run `bun test bin/runtime` from this stack directory in an environment that
permits real subprocesses. Tests use mock local providers, not API credentials.
They cover protocol translation, warm/fresh turns, controller loss, duplicate
launches, native resume, large prompts, and lifecycle ownership. Configuration
and cleanup checks also live under `test/`.

Live-provider compatibility and a real Board/container restart smoke test still
need validation against the packaged public runtime before release.

## Adding a New Agent

1. Add its explicit installer and validation to `harness/`, with stable protected executable paths.
2. Add one adapter under `bin/runtime/harnesses/` and register it in `index.ts`.
3. Reuse the shared supervisor for a stdio protocol; keep session scope separate
   from transport selection.
4. Normalize native events to the V1 schemas and add protocol/lifecycle tests.
5. Verify through the supported CarapaBox sandbox before deployment.

## Skills and Rules

Every harness reads skills from `~/.agent/skills` and rules from
`~/.agent/rules` (`~/.claude`, `~/.codex` and `~/.agents` resolve to them).
The compose files mount both as small container-local tmpfs folders and the
agent home a second time, read-only, at `/opt/carapa/agent-home`.
`carapa-agent-view refresh` fills the folders with links, later layers
replacing earlier entries with the same name:

1. platform: `<agent home>/.agent/{skills,rules}`;
2. stack: `/opt/carapa/stack-agent/{skills,rules}`, when a derived stack mounts
   its own rules or skills there read-only;
3. CarapaBrain group template: `<agent home>/.agent/scopes/group/{skills,rules}`,
   only in images with CarapaBrain installed (`/app/package.json`);
4. project: `/workspace/group/.agent/{skills,rules}`.

Skills listed in `/workspace/group/.carapa/disabled-skills.json`
(`{"disabledSkills": [...]}`, written by CarapaBoard project settings) are left
out. A malformed file is skipped with a warning and disables nothing, so all
skills and rules stay linked. In CarapaBrain images, objective template entries from `<agent home>/.agent/scopes/objective/`
are linked into each `/workspace/group/objectives/*/.agent/`, never over a real
local file. The entrypoint runs the refresh at start, and CarapaBoard runs it
after a settings change or a new objective. The command writes only into
folders on their own mount, so it never changes the shared agent home.

Install the shared content with `scripts/install.sh` from
[carapa-agent-kit](https://github.com/carapa-ai/carapa-agent-kit).
`carapa-promotion` is the command CarapaBoard runs to commit an approved
skill or rule proposal into a kit checkout.

`carapa-delegate` runs an independent one-shot child agent (reviewer, critic,
grader) for harnesses without a subagent tool. It resolves a tier through the
board's runtime-tiers route, writes a run dir for `run-agent.sh --exec` (from
its own directory), prints the child's final assistant message on stdout and a
JSON telemetry line on stderr:

```text
carapa-delegate --tier fast|balanced|frontier --prompt-file FILE|- [--out FILE] [--timeout SEC]
                [--cwd DIR] [--reasoning LEVEL] [--project P] [--objective O | --no-objective]
                [--harness H] [--keep]
```

Exit codes: the child's own code, `2` usage or tier-resolution error (the run
dir is removed), `3` privacy refusal from the board, `124` timeout (the child
is stopped). The child inherits the caller's environment and board token. Its
default cwd is a temp dir outside `/workspace`, so project and objective rules
are not loaded; agent-home rules still are.

## MCP Connections

| Server         | Endpoint                                              | Registered by                                                                                   |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `carapa-board` | `http://api-relay:8080/mcp-relay/mcp/carapa-board`    | Each harness's user-level config under `AGENT_HOME`; the ACP runner adds it to every session     |
| `carapa-mail`  | `http://api-relay:8080/carapa-mail/mcp`               | The runtime, per run, when the project enables Carapa-Mail in Board                              |

The agent never holds the Carapa-Mail token: api-relay injects the project's
token. Before each run, `bin/runtime/carapa-mail.ts` sends an MCP `initialize`
through the relay; HTTP 200 means the project has a working token, and the
Claude, Codex and ACP runners then add `carapa-mail` for that run (Claude
`--mcp-config`, Codex `-c mcp_servers.carapa-mail.url=…`, ACP session
`mcpServers`). A warm session restarts when that result changes, so toggling
the project setting takes effect on the next message. Pi, OpenCode and the
Antigravity SDK harness do not receive it.

## Local LLM Access

The shared `llama-proxy` service in the `egress-proxy` stack forwards traffic to local LLM servers on the host. See the [main README](../../README.md#local-llm-access-llama-proxy-1) for configuration details.

Inside the container, use `http://llama-proxy:<PORT>/v1` (not `host.docker.internal`). Add `llama-proxy` to the `NO_PROXY` list so requests bypass Squid.

## Container Security

- **Hardened image** — multi-stage Debian build, minimal packages, non-root user (UID 1000), SUID/SGID bits stripped
- **Read-only rootfs** — `read_only: true` with tmpfs for `/tmp`, `/var/log`, `/run`, `/etc/profile.d`
- **No Docker socket** — agents cannot manage containers
- **Git guard** — `push`, `fetch`, `pull`, `clone` blocked inside container (use MCP `sandbox_git` tool)
- **Trusted control-plane tools** — the image contains a tested baseline at `/usr/local/ai-cli-bin`; host `bin/` overrides are an explicit development option
- **Network isolation** — each instance gets its own `agent_egress_{project}` bridge (agents cannot see each other); egress through squid proxy only
- **Seccomp** — `seccomp-default.json` profile with `clone`/`unshare` for Playwright compatibility
- **AppArmor** — `carapabox-agent` profile with strict path restrictions
- **No new privileges** — `security_opt: no-new-privileges`, all capabilities dropped
- **Resource limits** — 4 CPUs, 8GB RAM, 2000 PIDs

## Environment Variables

Passed into the container via `docker-compose.yml`:

| Variable                     | Source                      | Purpose                                                                                 |
| ---------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Hardcoded placeholder       | Replaced by api-relay credential injection                                              |
| `ANTHROPIC_BASE_URL`         | Hardcoded                   | Points to `http://api-relay:8080/anthropic`                                             |
| `OPENAI_API_KEY`             | Hardcoded placeholder       | Replaced by api-relay credential injection                                              |
| `CARAPA_BOX_API_TOKEN`       | Host `.env`                 | MCP relay authentication                                                                |
| `HTTP_PROXY` / `HTTPS_PROXY` | Hardcoded                   | Squid egress proxy (`http://squid:3128`)                                                |
| `NO_PROXY`                   | Hardcoded                   | Bypass proxy for internal services                                                      |
| `LOCAL_REPO`                 | Host `.env`                 | Workspace bind mount path                                                               |
| `GROUP_DIR`                  | Host `.env`                 | Per-group memory folder                                                                 |
| `IPC_MOUNT`                  | Host `.env`                 | Shared run directory for args/output/exit_code                                          |
| `EXTRA_MOUNT_1` / `EXTRA_MOUNT_2` | Board project settings | Optional host folders mounted read-only at `/workspace/<EXTRA_MOUNT_N_NAME>`; sources must be in CarapaBox's mount allowlist |
| `EXTRA_MOUNT_1_NAME` / `EXTRA_MOUNT_2_NAME` | Board project settings | Folder name under `/workspace` for each extra mount (source leaf name, suffixed `-1`/`-2` on conflict) |
| `SSH_KEYS_FOLDER`            | Stack `.env` or root `.env` | Path to `.ssh` directory for git. Stack value takes priority; falls back to root `.env` |
| `ENABLE_SSHD`                | `.env`                      | Initial SSH preference for manual launches (default `0`); Board manages subsequent changes |

## Optional SSH access

Project Settings > Sandbox > Enable sandbox SSH starts or stops Dropbear through
CarapaBox. SSH defaults to off. It runs as `ubuntu` under `runsc`, with all
capabilities dropped, `no-new-privileges`, and a read-only root filesystem.
SSH listens on the agent's internal IPv4 address at port 2222. No sidecar,
ingress network, or host port publication is needed. The agent stays on its
internal-only network. The sidebar shows the current address while SSH is
running and copies `ssh -p 2222 ubuntu@<sandbox-ip>` for use on the Docker host.
CarapaBox reserves the instance's subnet and agent address and injects
`AGENT_IPV4_ADDRESS` into Compose. The address survives Board stop/start,
container recreation, image rebuilds, and controller restarts. On the first
managed restart, Box captures an existing agent's address before removing it.
It then migrates the instance network to an explicitly configured subnet while
the agent is stopped, retaining the saved agent and proxy addresses. A direct
start of an already-running legacy instance asks you to stop it first rather
than disconnecting it. New networks also use explicit IPAM before attaching
containers, so Docker accepts their static addresses.
Manual Compose launches without `AGENT_IPV4_ADDRESS` still use dynamic addressing.

Reservations live in CarapaBox's persistent
`generated/network-reservations/agent_egress_<compose-project>.json`, outside
the sandbox. Box retains the internal network and proxy attachments while the
sandbox is stopped, preventing Docker from reallocating its subnet. Proxy
reconnections use reserved addresses too, so they cannot claim the agent IP.
Do not delete these files or prune the reserved networks during routine cleanup.
If a network is removed externally, Box attempts to recreate its saved subnet
and fails rather than silently changing the address if the subnet is unavailable.

There is no automatic reservation expiry. To permanently release a retired
instance, an operator must stop it, disconnect its shared proxies from its
`agent_egress_<compose-project>` network, remove that network, and then delete
only its matching reservation file while no start operation is in progress.
Deploy the updated CarapaBox controller before restarting sandboxes; this change
does not require rebuilding the agent image or CarapaBoard.

SSH uses public-key authentication only. Add your public key to:

```text
$AGENT_HOME/.ssh/authorized_keys
```

Keep `.ssh` mode 700 and `authorized_keys` mode 600, owned by uid 1000. Do not
copy client private keys into the sandbox. Host keys and the live preference
are stored per instance in `/workspace/ipc/ssh`; daemon state is in
`/tmp/carapa-ssh`. Disabling SSH disconnects existing SSH sessions.

For a remote Docker host, use its normal SSH account as a jump host:

```sh
ssh -J <host-user>@<docker-host> -p 2222 ubuntu@<sandbox-ip>
```

The sandbox IP must be reachable from the Docker host; it is not a public
address. Rebuild the agent image and recreate old containers once to install
Dropbear. Containers already running the Dropbear image need no image rebuild
or recreation for direct-IP access.
Stacks opt into the CarapaBox control surface with `ssh.json`.

## Live agent browser

Board's Browser pane attaches to a sandbox Playwright browser through
CarapaBox's approved exec stream. `browser-viewer <contextId>` starts a private
loopback CLI dashboard and bridges its protocol over stdin/stdout. It accepts
no upstream URL. Disconnecting closes only that viewer; agents and stage video
recording continue. `browser-close <runId>` is called after task recording finalizes.

The viewer's speaker button enables sound for that attachment; new and
reconnected viewers start muted. Managed Chromium launches use a private
PulseAudio null sink per browser context. `browser-viewer` captures that sink
only while sound is enabled and the viewer is visible, forwarding 40 ms stereo
PCM packets through the existing authenticated stream. All tabs in that browser
share its sound output; other browser contexts, host audio and microphones are
excluded. Closing the browser stops its sound server. Video recordings remain
silent.

The image installs `pulseaudio` and `pulseaudio-utils`. Rebuild the runtime and
dependent images and recreate existing sandboxes to add those packages; refresh
Board's viewer assets as described below. Existing browsers must be restarted
to select their private sound server. The CLI preload removes Chromium's default
`--mute-audio` only for those launches and must be checked when changing the
Playwright pin. Older images continue to support silent browsing.

Native select popups are not included in Chromium's captured frames. The shared
viewer installs an in-page dropdown renderer in its browser context, including
existing pages, future tabs and frames. This applies to every stack using these
shared CLI tools, not just a particular application. The renderer stays available
until that browser context closes.

The released `bin/browser-select-menu.cjs` is generated from the renderer in
`carapa-playwright` (https://github.com/carapa-ai/playwright, branch
`carapa-browser-viewer-1.66`) and included with this stack. It is Apache-2.0 licensed;
see `THIRD-PARTY-NOTICES.md`. Building the image does not
require checking out the renderer's source repository. Do not edit the generated
file directly. After installing an updated helper, run `./build.sh` to bake it
into the image and rebuild any images derived from it. Reattach existing viewers
to load the updated adapter after container recreation. A harness update is unnecessary.

Conversation contexts persist across turns and cancellation. Board can start,
restart and close them explicitly with `browser-open <contextId> start|restart`
and `browser-close <contextId>`. These helpers resolve only Board-owned
`/workspace/ipc/browser-sessions/` descriptors, containing browser configuration
without agent tokens. Initial navigation uses the descriptor URL, a worktree
`.preview-url`, an optional project startup hook, or `http://nginx/` (port 80).
The default workspace browser can start without an agent run. In a conversation,
select its browser to share cookies and tabs with subsequent agent turns.

For projects without nginx, add `.agent/start-browser.sh` in the checkout. The
helper runs this fixed hook with Bash from that directory, inheriting the shared
Playwright context. Keep the app in the foreground and atomically publish its
ready HTTP/HTTPS URL to `CARAPA_BROWSER_URL_FILE` within 60 seconds. One supervised
hook runs per context; repeated Start reuses it and can recover a stopped app.
Handle SIGTERM for app cleanup. Close/Restart and sandbox shutdown release its
owned processes, while viewer detach and conversation turn completion preserve
them. Logs are bounded and no host port or nginx service is required.

The canonical `playwright-cli` wrapper scopes every managed run's sessions,
registry and sockets, including unrecorded runs. Warm harness daemons resolve
the session's `active_run` pointer on every CLI invocation. Proxy settings
remain inherited. The protocol ownership version retires older warm daemons at
the next turn, preserving their native resume state while installing the new
context forwarding. Legacy runs without `CARAPA_BROWSER_RUN_ID` keep their
original CLI environment during upgrades. `CARAPA_BROWSER_SESSION_ID` pins a
conversation browser and its canonical working directory across turns, including
commands from subdirectories. Repeated `open` navigates the existing browser;
`open` without a URL keeps the current page. Agent `close`/`kill-all` cannot
discard a persistent shared session. Board owns explicit close/restart.
Each context lazily creates one browser; `tab-new` adds a tab in that browser.
Separate conversations and the project default context have separate browsers.
Closing the viewer releases only the viewer, not its browser.
Agent and viewer tab controls share the daemon's current tab. The runtime publishes
the selected page ID in its private session directory; attached viewers follow
it, and viewer tab controls update the daemon before acknowledging the action.
Reconnecting also restores the daemon's current tab instead of choosing tab 0.

The embedded frontend and backend are version-matched: `@playwright/cli@0.1.24`
uses `playwright-core@1.66.0-alpha-1794252756000`. The viewer fails explicitly on a
version mismatch. Update Board's vendored dashboard when changing this pin.
Upstream private registry environment variables are contained in
`bin/browser-session.cjs`.

`browser-viewer-check [internal-url]` runs a disposable integration check with
two isolated concurrent runs, shared navigation/input/tab changes, cancellation,
reconnection and video finalization. It always tests a loopback HTTP app; an
optional URL also checks sandbox network access. It deletes only its own runs
and browsers. `browser-delivery-check` exposes fixed Board/Box verifier commands
inside their development sandboxes (no arbitrary caller-supplied commands).

`browser-persistence-check [main]` verifies on-demand default browsing, preview
URLs, warm-turn reuse, cookies, tabs, input between turns, reconnect and restart.
Use `main` in the demo site to verify its default `http://nginx/` app; omit it for the
disposable localhost-only app. All probe resources are scoped and removed.

`browser-app-check` verifies a disposable project startup hook, loopback URL
discovery, streaming, reuse, recovery, restart, failure diagnostics and cleanup.
Run `browser-app-check board` from Board's prepared sandbox checkout to test its
real `.agent/start-browser.sh`, including login and browser-test session reuse.
