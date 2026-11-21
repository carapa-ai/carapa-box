/**
 * REST + SSE adapter for the tmux sandbox tools.
 *
 * Why this module exists:
 *   The MCP `sandbox_tmux_*` tools stream pane deltas via
 *   `notifications/message` (sendLoggingMessage), but the board's MCP client
 *   only forwards logging notifications to its `logCallback` during
 *   `sandboxExec` — never during tmux calls — so every live delta is dropped
 *   (see `src/tools/register.ts:1470-1472`, where the `_streamId` is
 *   discarded). The board instead drives a curl `POST /api/tmux/attach` SSE
 *   stream against this module and correlates deltas via `streamId` on each
 *   `event: delta` frame.
 *
 * Endpoints (all require Bearer auth against `CARAPA_BOX_API_TOKEN` /
 * `CARAPA_BOX_ADMIN_TOKEN`, server-to-server — no session cookies):
 *
 *   POST   /api/tmux/attach    → SSE stream: `init` then live `delta`s
 *   POST   /api/tmux/exec      → JSON `{ ok: true }` (no echo)
 *   POST   /api/tmux/resize    → JSON `{ ok: true }` (resizes the pane)
 *   DELETE /api/tmux/detach    → JSON `{ ok: true }` (kills the session)
 *
 * Security: every endpoint validates the wrapper command through the same
 * OPA-backed `validateCommand` gate the MCP tools use, and audits allow/deny
 * via `src/audit.ts` (matching the `sandbox_tmux_*` entries written by
 * `src/tools/register.ts`). Auth failures are logged but not audit-logged
 * (no stack/service yet).
 *
 * Streaming correctness:
 *   - `onDelta` is passed `(streamId, delta)` from `attachTmuxSession`
 *     (src/tmux-session.ts:107). We forward BOTH in each `event: delta`
 *     SSE frame so the board can route bytes to the right tab — this is
 *     the explicit gap that broke the MCP path.
 *   - The SSE writer enqueues every frame directly into the response stream,
 *     including periodic comment heartbeats, so idle proxy timers do not
 *     interrupt a live shell.
 *   - On client disconnect, `req.signal` aborts the reader's AbortController
 *     via `attachTmuxSession({ signal })`, which in turn runs the
 *     `teardownReader` path: kills the docker exec, removes the FIFO, and
 *     runs `tmux pipe-pane -t <session>` with no target to stop piping.
 */

import { bearerToken, safeTokenCompare } from "./auth.js";
import {
    attachSchema, detachSchema, execSchema, jsonCors, parseBody, resizeSchema, sseFrame, TMUX_SSE_KEEPALIVE_FRAME, TMUX_SSE_KEEPALIVE_INTERVAL_MS,
} from "./tmux-wire.js";

import { attachTmuxSession, execTmuxSession, detachTmuxSession } from "../tmux-session.js";
import { resolveStackAndProject } from "../utils.js";
import { validateCommand } from "../security.js";
import { auditLog } from "../audit.js";
import { logger } from "../logger.js";

const TMUX_TOOL = "/usr/local/ai-cli-bin/tmux-tool.sh";

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Tmux is a sandbox API: Board uses the API credential, never the admin credential. */
function expectedToken(): { token: string; source: "api-env" | "none" } {
    if (process.env.CARAPA_BOX_API_TOKEN) return { token: process.env.CARAPA_BOX_API_TOKEN, source: "api-env" };
    return { token: "", source: "none" };
}

/** Returns null on success, or a 401 Response on auth failure. */
function requireBearer(req: Request, urlPath: string): Response | null {
    const { token: expected, source } = expectedToken();
    if (!expected) {
        // Fail closed when the sandbox API credential is absent.
        logger.warn(
            { urlPath, secretsDir: process.env.SECRETS_DIR || "/run/secrets" },
            "[HTTP] [TMUX] request blocked: no CARAPA_BOX_API_TOKEN configured. " +
            "Set the env var directly, or mount the Docker secret into the container (see carapa-box/docker-compose.yml `secrets:` block).",
        );
        return new Response(JSON.stringify({
            error: "Tmux REST surface disabled (no token configured)",
            hint: "Set CARAPA_BOX_API_TOKEN in carapa-box, " +
                "or mount the carapa_box_api_token Docker secret into the container " +
                "(see carapa-box/docker-compose.yml).",
            secretsDir: process.env.SECRETS_DIR || "/run/secrets",
        }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    const providedToken = bearerToken(req.headers);
    if (!providedToken || !safeTokenCompare(providedToken, expected)) {
        logger.warn(
            { urlPath, source, provided: providedToken ? "invalid" : "missing" },
            `[HTTP] [TMUX] Unauthorized request to ${urlPath} (token: ${providedToken ? "invalid" : "missing"}, source: ${source})`,
        );
        return new Response(JSON.stringify({
            error: "Unauthorized",
            hint: "CarapaBoard must use the same CARAPA_BOX_API_TOKEN as CarapaBox, " +
                "mounted at /run/secrets/carapa_box_api_token or supplied by the environment.",
        }), {
            status: 401,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "WWW-Authenticate": "Bearer",
            },
        });
    }
    return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a stack path + project name or 404. */
async function resolveOr404(stack: string, instance: string | undefined, tool: string): Promise<{ stackPath: string; projectName: string } | { errorRes: Response }> {
    const { stackPath, projectName } = await resolveStackAndProject(stack, instance);
    if (!stackPath) {
        auditLog({
            timestamp: new Date().toISOString(),
            tool,
            stack,
            service: "",
            command: `resolve ${stack}`,
            projectName: projectName ?? stack,
            allowed: false,
            reason: `Stack or instance not found: ${stack}`,
        });
        return {
            errorRes: jsonCors({ error: `Stack or instance not found: ${stack}` }, 404)
        };
    }
    return { stackPath, projectName: projectName ?? stack };
}

/** Run policy validation; return null on allow, a 403 Response on deny. */
async function policyOr403(opts: {
    stackPath: string;
    service: string;
    command: string;
    tool: string;
    stack: string;
    projectName: string;
    auditCommand: string;
}): Promise<Response | null> {
    const v = await validateCommand(opts.stackPath, opts.service, opts.command, opts.tool);
    if (!v.allowed) {
        auditLog({
            timestamp: new Date().toISOString(),
            tool: opts.tool,
            stack: opts.stack,
            service: opts.service,
            command: opts.auditCommand,
            projectName: opts.projectName,
            allowed: false,
            reason: v.reason,
            policy_name: v.policy_name,
        });
        return jsonCors({ error: "Forbidden", reason: v.reason, policy_name: v.policy_name }, 403);
    }
    return null;
}

type TmuxAttachCloseReason =
    | "request-aborted"
    | "body-cancelled"
    | "enqueue-failed"
    | "attach-error"
    | "shell-exited";

// ── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/tmux/attach — opens an SSE stream.
 *
 * First frame is `event: init` with `{streamId, cols, rows, scrollback}`.
 * Subsequent frames are `event: delta` with `{streamId, delta}` (streamId
 * included so the board can route each delta to the correct tab — this is
 * the explicit gap the MCP path suffers). When the shell process ends, the
 * final frame is `event: exit` and the response closes.
 *
 * The stream stays open until the client disconnects (`req.signal` aborts
 * the reader's AbortController, which runs `teardownReader` and clears
 * `tmux pipe-pane`), the shell exits, or `attachTmuxSession` rejects (a
 * startup failure is surfaced as one `event: error` frame, then it ends).
 */
export async function handleAttach(req: Request, bunServer: { timeout(req: Request, seconds: number): void } | null): Promise<Response> {
    const auth = requireBearer(req, "/api/tmux/attach");
    if (auth) return auth;

    const parsed = await parseBody(req, attachSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;

    const { stack, service, instance, session, streamId, cols, rows, lines } = body;
    const resolved = await resolveOr404(stack, instance, "sandbox_tmux_attach");
    if ("errorRes" in resolved) return resolved.errorRes;
    const { stackPath, projectName } = resolved;
    const traceId = `${stack}/${service}/${instance}/${session}`;
    const handleStart = Date.now();
    logger.info(
        { traceId, projectName, streamId, cols, rows, lines },
        "[HTTP] [TMUX] attach: handler entered",
    );

    // Policy gate — authorize the stack-owned wrapper rather than bare tmux.
    // Stack policies intentionally allow only immediate children of
    // /usr/local/ai-cli-bin.
    const policy = await policyOr403({
        stackPath,
        service,
        command: `${TMUX_TOOL} create ${session} ${cols ?? 200} ${rows ?? 50}`,
        tool: "sandbox_tmux_attach",
        stack,
        projectName,
        auditCommand: `tmux attach ${session}`,
    });
    if (policy) return policy;
    logger.info(
        { traceId, elapsedMs: Date.now() - handleStart },
        "[HTTP] [TMUX] attach: policy gate passed",
    );

    // Disable Bun's per-request idle timeout so the SSE stream can stay open
    // for the lifetime of the session. Mirrors src/http/server.ts:389-391.
    if (bunServer) {
        try { bunServer.timeout(req, 0); } catch { /* outside Bun, e.g. test env */ }
    }

    // Build the SSE response stream. We bridge `onDelta` directly into the
    // response body so every frame, including keep-alive comments, is flushed
    // promptly instead of being buffered behind a transform.
    let sseStreamId = streamId || "";
    let initSent = false;
    let pendingExitStreamId: string | null = null;
    const encoder = new TextEncoder();
    const externalAbort = new AbortController();
    let closed = false;
    let closeReason: TmuxAttachCloseReason | null = null;
    const reqAbortedAtEntry = req.signal.aborted;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = (): void => {
        if (heartbeat === null) return;
        clearInterval(heartbeat);
        heartbeat = null;
    };

    const safeEnqueue = (frame: Uint8Array): void => {
        if (closed) return;
        try {
            controller.enqueue(frame);
        } catch {
            // Stream already closed by the consumer — no-op.
            releaseStream("enqueue-failed");
        }
    };

    const closeStream = (reason: TmuxAttachCloseReason): void => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        stopHeartbeat();
        if (!initSent && reason !== "attach-error") {
            // Tell the board why the stream ended before init; the reader
            // may already be gone, so a failed enqueue is ignored.
            try {
                controller.enqueue(sseFrame("error", {
                    streamId: sseStreamId,
                    error: `tmux attach closed before init: ${reason}`,
                }));
            } catch { /* reader gone */ }
            logger.warn(
                { traceId, closeReason, reqAbortedAtEntry, elapsedMs: Date.now() - handleStart },
                "[HTTP] [TMUX] attach: stream closed before init",
            );
        }
        try { controller.close(); } catch { /* already closed */ }
    };

    const releaseStream = (reason: TmuxAttachCloseReason): void => {
        if (!externalAbort.signal.aborted) externalAbort.abort();
        closeStream(reason);
    };

    const emitExit = (sid: string): void => {
        safeEnqueue(sseFrame("exit", { streamId: sid, reason: "shell-exited" }));
        releaseStream("shell-exited");
    };

    const readable = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        },
        cancel() {
            // A Response body cancellation is the fetch equivalent of a
            // disconnected client when the request signal is unavailable.
            releaseStream("body-cancelled");
        },
    });

    heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(TMUX_SSE_KEEPALIVE_FRAME));
    }, TMUX_SSE_KEEPALIVE_INTERVAL_MS);
    heartbeat.unref?.();

    // The attach call returns once scrollback is captured; the background
    // reader keeps emitting deltas via `onDelta` until teardown. We start
    // the reader and pipe the init frame when attach resolves.
    // Abort the reader and release the timer as soon as the client disconnects.
    const onReqAbort = () => {
        releaseStream("request-aborted");
    };
    if (req.signal.aborted) onReqAbort();
    else req.signal.addEventListener("abort", onReqAbort, { once: true });

    // Kick off attach in the background; we return the SSE response
    // immediately so the client gets headers + the init frame as soon as
    // the scrollback is captured. Errors are emitted as `event: error`
    // frames and the stream is closed.
    (async () => {
        try {
            const attachStart = Date.now();
            logger.info({ traceId }, "[HTTP] [TMUX] attach: attachTmuxSession start");
            const result = await attachTmuxSession({
                stackPath,
                projectName,
                service,
                session,
                requestedStreamId: streamId,
                cols,
                rows,
                lines,
                signal: externalAbort.signal,
                onDelta: (sid, delta) => {
                    // Each delta is tagged with the streamId so the board
                    // can route it to the correct tab. This is the
                    // correctness fix vs. the MCP path (which discarded
                    // the streamId in `sendLoggingMessage`).
                    safeEnqueue(sseFrame("delta", { streamId: sid, delta }));
                },
                onExit: (sid) => {
                    // Keep the wire contract deterministic: `init` is always
                    // the first event, even if a shell exits immediately.
                    if (!initSent) pendingExitStreamId = sid;
                    else emitExit(sid);
                },
                logChunk: (chunk) => {
                    // Surface reader-side stderr/debug as `log` events so
                    // operators can debug FIFO issues without polluting the
                    // terminal with them.
                    safeEnqueue(sseFrame("log", { streamId: sseStreamId, chunk }));
                },
            });
            logger.info(
                {
                    traceId,
                    streamId: result.streamId,
                    cols: result.cols,
                    rows: result.rows,
                    scrollbackBytes: result.scrollback?.length ?? 0,
                    elapsedMs: Date.now() - attachStart,
                },
                "[HTTP] [TMUX] attach: attachTmuxSession resolved",
            );

            sseStreamId = result.streamId;
            // Include `session` in the init frame: the board's SSE pump
            // rejects an init payload that doesn't carry a session name
            // (it's how the pump validates the wire shape — see
            // carapa-board/src/lib/tmux-box-client.ts init parsing).
            // `attachTmuxSession` returns `TmuxAttachResult` which
            // doesn't carry `session` (it treats session as an input
            // parameter rather than an output), so we use the request's
            // `session` here. It's already validated by `safeTmuxSessionName`
            // upstream so the value is safe to echo.
            safeEnqueue(sseFrame("init", {
                streamId: result.streamId,
                session,
                cols: result.cols,
                rows: result.rows,
                scrollback: result.scrollback,
            }));
            initSent = true;
            logger.info(
                { traceId, streamId: result.streamId, session, elapsedMs: Date.now() - handleStart },
                "[HTTP] [TMUX] attach: init frame enqueued",
            );
            if (pendingExitStreamId) {
                emitExit(pendingExitStreamId);
                pendingExitStreamId = null;
            }

            auditLog({
                timestamp: new Date().toISOString(),
                tool: "sandbox_tmux_attach",
                stack,
                service,
                command: `tmux attach ${session}`,
                projectName,
                allowed: true,
            });
        } catch (err) {
            logger.error(
                {
                    traceId,
                    elapsedMs: Date.now() - handleStart,
                    err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
                },
                "[HTTP] [TMUX] attach: attachTmuxSession rejected",
            );
            safeEnqueue(sseFrame("error", {
                streamId: sseStreamId,
                error: String(err),
            }));
            auditLog({
                timestamp: new Date().toISOString(),
                tool: "sandbox_tmux_attach",
                stack,
                service,
                command: `tmux attach ${session}`,
                projectName,
                allowed: true,
                reason: `tmux attach failed: ${err}`,
                exitCode: -1,
            });
            closeStream("attach-error");
        } finally {
            // If the client disconnected before init, abort the underlying
            // reader too so we don't leak FIFO/dock exec resources.
            if (externalAbort.signal.aborted) {
                closeStream("request-aborted");
                return;
            }
            // Keep the stream open until the client disconnects — the
            // reader is still emitting deltas. We don't close the response
            // here; the controller-side writer is closed by `onReqAbort`.
        }
    })().catch((err) => {
        logger.error({ err }, "[HTTP] [TMUX] attach promise rejected unexpectedly");
    });

    return new Response(readable, {
        status: 200,
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no", // disable nginx response buffering
            "Access-Control-Allow-Origin": "*",
        },
    });
}

/**
 * POST /api/tmux/exec — send keystrokes (and optionally resize) into the
 * session. Returns plain JSON `{ ok: true }` — the live pane echo arrives
 * over the attach SSE stream, not in this response.
 */
export async function handleExec(req: Request): Promise<Response> {
    const auth = requireBearer(req, "/api/tmux/exec");
    if (auth) return auth;

    const parsed = await parseBody(req, execSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const { stack, service, instance, session, input, inputBase64, cols, rows } = body;

    // Decode base64 input to enforce the same length cap as the MCP tool
    // (src/tools/register.ts:1571). Sending 8KB+ bytes of keystrokes is
    // almost always an accident; the MCP layer refuses it explicitly and
    // we keep the behaviour uniform.
    const decoded = inputBase64 ? Buffer.from(input, "base64").toString("utf8") : input;
    if (decoded.length > 8192) {
        return jsonCors({ error: "Input exceeds maximum length (8192 bytes)." }, 400);
    }

    const resolved = await resolveOr404(stack, instance, "sandbox_tmux_exec");
    if ("errorRes" in resolved) return resolved.errorRes;
    const { stackPath, projectName } = resolved;

    // Policy gate — mirror src/tools/register.ts. The wrapper
    // command is what `tmux-tool.sh send` translates to internally; we
    // validate the wrapper surface rather than the decoded keystrokes
    // (which would falsely reject ordinary terminal input like spaces).
    const policy = await policyOr403({
        stackPath,
        service,
        command: `${TMUX_TOOL} send ${session}`,
        tool: "sandbox_tmux_exec",
        stack,
        projectName,
        auditCommand: `tmux-tool.sh send ${session}`,
    });
    if (policy) return policy;

    try {
        const result = await execTmuxSession({
            stackPath,
            projectName,
            service,
            session,
            input,
            inputBase64: inputBase64 ?? false,
            cols,
            rows,
        });

        auditLog({
            timestamp: new Date().toISOString(),
            tool: "sandbox_tmux_exec",
            stack,
            service,
            command: `tmux send-keys ${session} (${decoded.length} bytes)`,
            projectName,
            allowed: true,
            exitCode: result.code,
        });

        if (result.code !== 0) {
            return jsonCors({
                error: "tmux exec returned non-zero",
                stderr: result.stderr,
                exitCode: result.code,
            }, 500);
        }
        return jsonCors({ ok: true });
    } catch (err) {
        logger.warn({ err, stack, service, session }, "[HTTP] [TMUX] exec failed");
        auditLog({
            timestamp: new Date().toISOString(),
            tool: "sandbox_tmux_exec",
            stack,
            service,
            command: `tmux send-keys ${session} (${decoded.length} bytes)`,
            projectName,
            allowed: true,
            reason: `tmux exec failed: ${err}`,
            exitCode: -1,
        });
        return jsonCors({ error: String(err) }, 500);
    }
}

/**
 * POST /api/tmux/resize — resize the tmux pane and forward SIGWINCH.
 * Body requires `cols` and `rows` (unlike exec, where they're optional).
 */
export async function handleResize(req: Request): Promise<Response> {
    const auth = requireBearer(req, "/api/tmux/resize");
    if (auth) return auth;

    const parsed = await parseBody(req, resizeSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const { stack, service, instance, session, cols, rows } = body;

    const resolved = await resolveOr404(stack, instance, "sandbox_tmux_resize");
    if ("errorRes" in resolved) return resolved.errorRes;
    const { stackPath, projectName } = resolved;

    // Resize uses the same wrapper as exec — `tmux-tool.sh send` is the
    // tool that internally calls `tmux resize-window` before forwarding
    // keystrokes, so the policy rule that allows exec also allows resize.
    const policy = await policyOr403({
        stackPath,
        service,
        command: `${TMUX_TOOL} send ${session}`,
        tool: "sandbox_tmux_resize",
        stack,
        projectName,
        auditCommand: `tmux resize-window ${session} -x ${cols} -y ${rows}`,
    });
    if (policy) return policy;

    try {
        const result = await execTmuxSession({
            stackPath,
            projectName,
            service,
            session,
            input: "",
            cols,
            rows,
        });

        auditLog({
            timestamp: new Date().toISOString(),
            tool: "sandbox_tmux_resize",
            stack,
            service,
            command: `tmux resize-window ${session} -x ${cols} -y ${rows}`,
            projectName,
            allowed: true,
            exitCode: result.code,
        });

        if (result.code !== 0) {
            return jsonCors({
                error: "tmux resize returned non-zero",
                stderr: result.stderr,
                exitCode: result.code,
            }, 500);
        }
        return jsonCors({ ok: true });
    } catch (err) {
        logger.warn({ err, stack, service, session }, "[HTTP] [TMUX] resize failed");
        auditLog({
            timestamp: new Date().toISOString(),
            tool: "sandbox_tmux_resize",
            stack,
            service,
            command: `tmux resize-window ${session} -x ${cols} -y ${rows}`,
            projectName,
            allowed: true,
            reason: `tmux resize failed: ${err}`,
            exitCode: -1,
        });
        return jsonCors({ error: String(err) }, 500);
    }
}

/**
 * DELETE /api/tmux/detach — kill the tmux session and stop the background
 * reader. The body is required (it's a DELETE; the spec calls for it).
 */
export async function handleDetach(req: Request): Promise<Response> {
    const auth = requireBearer(req, "/api/tmux/detach");
    if (auth) return auth;

    const parsed = await parseBody(req, detachSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const { stack, service, instance, session, streamId } = body;

    const resolved = await resolveOr404(stack, instance, "sandbox_tmux_detach");
    if ("errorRes" in resolved) return resolved.errorRes;
    const { stackPath, projectName } = resolved;

    // Detach policy gate — use the same trusted wrapper as the MCP tool.
    const policy = await policyOr403({
        stackPath,
        service,
        command: `${TMUX_TOOL} kill ${session}`,
        tool: "sandbox_tmux_detach",
        stack,
        projectName,
        auditCommand: `tmux-tool.sh kill ${session}`,
    });
    if (policy) return policy;

    try {
        const result = await detachTmuxSession({
            stackPath,
            projectName,
            service,
            session,
            streamId,
        });

        return jsonCors({ ok: true, exitCode: result.code }, result.code === 0 ? 200 : 500);
    } catch (err) {
        logger.warn({ err, stack, service, session }, "[HTTP] [TMUX] detach failed");
        return jsonCors({ error: String(err) }, 500);
    }
}
