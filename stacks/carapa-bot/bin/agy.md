# Antigravity from the terminal: `agy-sdk` and `agy-acp`

Two commands run Google's Antigravity agent from a sandbox shell. Both go through the
relay (`api-relay`), which holds the real Google login and adds it to each request, so
no Google credential is ever stored in the sandbox.

| Command | What it runs | Model names you type | Reports token usage |
| --- | --- | --- | --- |
| `agy-sdk` | the Antigravity Python SDK (installed as "antigravity", currently 0.1.22) through the small script `agy-sdk.py` | the real Google names, with the effort on the end | yes (`usage` on the last line) |
| `agy-acp` | the ACP harness (`antigravity acp` from the Antigravity CLI) that Board's "Antigravity ACP" runtime uses | the real Google names, with the effort on the end | no |
| `agy` | Google's Antigravity CLI itself, the same program `agy-acp` runs; interactive, and you log in to it yourself (it does not use the relay) | its own | no |

Board's "Antigravity ACP" runtime uses the same harness as `agy-acp`; Board's "Antigravity
SDK" runtime uses the same SDK script as `agy-sdk`.

## Using them

```
agy-sdk --model gemini-4-argon-medium "your prompt"
agy-sdk --help

agy-acp --list-models
agy-acp --model gemini-4-hydrogen-xhigh "your prompt"
agy-acp --mcp --model gemini-3.8-flash-medium "use the carapa-board recall tool to ..."
```

- `agy-sdk` prints one JSON event per line. The last line holds the answer and the token counts
  (`"usage": {"input_tokens": ..., "output_tokens": ...}`). Add `--work-dir DIR` to choose the folder it
  works in, `--system TEXT` for standing instructions.
- `agy-acp` prints the answer as plain text; tool activity such as `[tool] Running view_file` goes
  to stderr. `--cwd DIR` chooses the folder; `--mcp` adds the Board's MCP tools. Ctrl-C stops the run cleanly.
- Both can read and change files and run shell commands without asking first, like Board's runs.
- Each call is one prompt in a new session; there is no memory between calls.

Both commands find the installed harness by themselves, so they keep working after the harness
is updated (`update-harnesses.sh`). They only run in a sandbox that has the harness installed.

## Which Google route is used

The relay offers two routes to Google, and they use different logins:

- **`/antigravity`** (default for both commands): your Google AI Pro subscription. This is the
  route that serves Gemini 3.8 Flash, Gemini 4 Argon and Gemini 4 Hydrogen.
- **`/google`**: a plain Gemini API key held by the relay. It is on the free tier, which has no
  Gemini 4 Argon (Google answers "quota exceeded, limit: 0"). Use it only for models the free
  tier serves, with `AGY_ROUTE=google agy-sdk --model gemini-3.8-flash "..."`.

## Model names

Both commands use Google's current names with the effort on the end, for example
`gemini-4-hydrogen-xhigh`, `gemini-4-argon-medium` or `gemini-3.8-flash-low`. Gemini 4 Hydrogen
has Low, Medium, High and XHigh; Argon and 3.8 Flash have Low, Medium and High.

- `agy-acp --list-models` prints what the harness offers. It also lists retired names (3.7 and
  3.6 Flash, 3.1 Pro) and Gemini 4 Carbon; your subscription does not serve those, so they answer
  "Requested entity was not found". Board hides them by keeping only names your account serves.
- The harness sends a base name plus a thinking level (`gemini-4-hydrogen` + `xhigh`); the relay
  joins them into the name the subscription expects (`antigravityRequest` in `api-relay.mjs`).
- On the subscription route the bare `gemini-4-argon` or `gemini-3.8-flash` fails with "not found"
  in `agy-sdk` (they only work on the free-tier `/google` route, and Argon not even there).

## Where this is configured

- **Harness version:** `install-antigravity-acp.sh` and `antigravity_release` in `harness/install.py` (CarapaBox; latest release unless you name one),
  installed with `python3 harness.py install antigravity-acp`. Releases:
  https://github.com/google-antigravity/antigravity-cli/releases
- **How Board starts it:** `bin/runtime/harnesses/antigravity-acp.ts` runs
  `antigravity acp --gemini-dir <profile> --disable-telemetry --dangerously-skip-permissions` and
  writes `{"modelProvider": "gemini"}` to `<profile>/antigravity-cli/settings.json`. Without that
  setting the CLI ignores the relay URL and calls Google directly (and fails).
- **Names Board shows:** the harness's list, filtered to what your Google account offers. Board
  merges the levels into one model with a reasoning picker (`effortVariants` on the
  `antigravity-acp` harness in `board_agents.jsonc`; see `docs/AGENTS-CONFIG.md`).
- **Which models exist:** to see what your account can use, open Admin -> Provider accounts in Board,
  or `agy-acp --list-models` for what the harness can ask for.

## Limits and things to know

- `agy-acp` reports no token usage; Board shows an estimate for ACP replies. `agy-sdk` reports real counts.
- MCP tools (the Board tools and the like): Board's own Antigravity ACP runs have them, because Board hands its MCP
  servers to the harness when it starts a session. `agy-acp` does the same only when you add `--mcp`, which gives the
  harness the `carapa-board` server (through the relay, which adds the login). Those tools can change things (create
  tasks, send messages), so it is off by default. Without `--mcp` the model only has the built-in file and shell tools
  and may improvise, for example by calling the relay's MCP address by hand with Python. `agy-sdk` configures no MCP
  servers; whether the SDK can use them at all is untested.
- Argon needs the AI Pro subscription to be connected under Admin -> Provider accounts.
