# Agent browser transport

Board attaches to a managed browser context through the existing authenticated Box HTTP
service. No browser, CDP, dashboard or application port is published.

All endpoints require `Authorization: Bearer <CARAPA_BOX_API_TOKEN>`; an unset
token fails closed. Board keeps this credential server-side and applies its
project/conversation/user authorization before requesting an attachment.

- `POST /api/browser/attach`: JSON `{stack, service, instance?, sessionId}`. Returns
  NDJSON: `attached` with an opaque `viewerId`, then `ready`, `message` (the
  upstream JSON protocol as a string), `heartbeat`, `error`, or `ended`.
- `POST /api/browser/:viewerId/input`: JSON array of protocol JSON strings,
  processed in order. Maximum 64 KiB request and 128 messages per batch.
- `DELETE /api/browser/:viewerId`: idempotently detach this viewer.

The attach response owns one Docker exec stream. Box resolves the trusted
`browser-viewer` executable through the stack override/image fallback, checks
its command against the stack policy, audits the decision, then executes its
resolved argv as sandbox UID 1000. No shell, command string or upstream URL is
accepted from Board. The released helper is included under
`stacks/carapa-bot/bin/` and baked into the CarapaBot image.

There are at most 64 pending/active transports, a 4 MiB frame limit, an 8 MiB
response queue, and a 64 KiB exec input queue. Input overflow, slow consumers,
HTTP abort, DELETE and process exit release only the owned viewer. EOF lets the
helper close its dashboard before the exec client is forcibly reaped. Browser
and video ownership stay with Board's lifecycle. Task sessions end after run
recording finalization; conversation and default-workspace browsers survive
turns and are explicitly started, restarted or closed through approved helpers.
`sessionId` identifies either a transient run or a durable browser descriptor;
the helper resolves its registry and never accepts an upstream address.

Verify with `bun run typecheck` and `bun test src/http/browser.test.ts`.
Existing trusted-bin policy applies; no policy broadening is required.

## Headed mode for human verification

Sites behind bot checks (for example Cloudflare Turnstile) reject the default
headless Chromium (`HeadlessChrome` user agent), so a human's click in the
Browser tab never passes. Set `CARAPA_BROWSER_HEADED=1` in the stack `.env` to
opt in; unset keeps today's headless launch unchanged.

With the setting on, `browser-open` launches the local Chromium headed
(`headless: false`) with `--disable-blink-features=AutomationControlled` on a
virtual X display (`:99`). It starts one Xvfb per sandbox on first use and reuses
it for every later start and restart. If Xvfb is missing or does not start,
`browser-open` exits non-zero with a `browser-open:` error; it never falls back
to headless. The Board screencast, input and audio are unchanged. The native
(Mac) runner and `browser-viewer-check` are not affected.

This exists only so a human can pass a bot check. Agents must not automate
challenge clicks, spoof the user agent or use solving services.
