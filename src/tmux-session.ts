import { randomUUID } from "node:crypto";
import { auditLog } from "./audit.js";
import { execDocker, shellQuote } from "./utils.js";
import { logger } from "./logger.js";

/**
 * CarapaBox tmux session manager.
 *
 * Manages long-lived tmux sessions inside running agent containers. Each session
 * is identified by a stable streamId that survives client reconnects, so the
 * board-side wrapper can re-attach to the same logical shell.
 *
 * Lifecycle:
 *   attach  -> create tmux session if needed, start a background pane reader,
 *              return scrollback + streamId.
 *   exec    -> send decoded keystrokes (and optional resize) into the session.
 *   detach  -> stop the reader and kill the tmux session.
 *   session close / box shutdown -> readers stop naturally when their
 *              AbortController is aborted; tmux processes are reaped by the
 *              container stop.
 *
 * Streaming implementation: instead of polling `tmux capture-pane` repeatedly,
 * we use `tmux pipe-pane` to redirect pane output to a container-side FIFO. A
 * long-running `docker exec <container> cat <fifo>` process streams bytes from
 * that FIFO back to carapa-box, and we emit deltas via the onDelta callback. When the client
 * disconnects or detach is called, we kill the docker exec (via AbortController)
 * and run `tmux pipe-pane -t <session>` with no target to stop piping.
 */

export interface TmuxAttachResult {
    scrollback: string;
    streamId: string;
    cols: number;
    rows: number;
}

/** A single subscriber to a tmux session's delta stream. */
interface TmuxSubscriber {
    /** Delta callback — invoked as `(streamId, delta)` for each pane chunk. */
    onDelta: (streamId: string, delta: string) => void;
    /** Invoked when the tmux session itself has ended (for example after
     *  `logout` or Ctrl+D), as opposed to a transport reader disconnect. */
    onExit?: (streamId: string) => void;
    /** Per-subscriber abort signal (from the caller's request). When it
     *  aborts, the subscriber is removed from the entry. When the last
     *  subscriber leaves, the reader is torn down. */
    signal?: AbortSignal;
}

interface TmuxSession {
    streamId: string;
    stackPath: string;
    service: string;
    session: string;
    projectName: string;
    abortController: AbortController;
    cols: number;
    rows: number;
    fifoPath: string;
    /**
     * Subscribers currently receiving deltas from this reader. The reader
     * fans out each chunk to every subscriber. When the set becomes empty
     * (last subscriber disconnects), the reader is torn down.
     *
     * This is what makes browser-refresh reconnects work: a new HTTP attach
     * adds a subscriber to the existing entry instead of being dropped on
     * the floor (the old single-`onDelta` design lost the new callback
     * because the reader was already wired to the first attach's callback).
     */
    subscribers: Set<TmuxSubscriber>;
}

const activeSessions = new Map<string, TmuxSession>();

function sessionKey(projectName: string, service: string, session: string): string {
    return `${projectName}:${service}:${session}`;
}

/**
 * Resolve the docker container name for a compose (project, service) pair.
 *
 * We use `docker exec <container>` instead of `docker compose exec -T <service>`
 * because carapa-bot's `agent` service is short-lived — it runs once and exits,
 * leaving the container alive but the compose service gone. After the agent
 * process exits, `docker compose exec agent …` fails with
 * `service "agent" is not running`, even though the container (and any tmux
 * sessions detached from the agent) is still alive.
 *
 * `docker exec` targets the container directly, so it survives across agent
 * runs within the same container lifetime. The container name follows the
 * compose default `<project>-<service>-1`.
 */
function containerNameFor(projectName: string, service: string): string {
    return `${projectName}-${service}-1`;
}

async function tmuxCommand(
    stackPath: string,
    service: string,
    projectName: string,
    command: string,
    signal?: AbortSignal,
    onLog?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string; code: number }> {
    // Run inside the container as uid 1000 — carapa-bot runs `user: 1000:1000`
    // and tmux stores its socket under `/tmp/tmux-<uid>/`. Running as root
    // would either fail to find the existing tmux server (different socket
    // directory) or create a parallel tmux server under `/tmp/tmux-0/`,
    // which would not be visible to the user's shell. We omit `-t` so the
    // container-side `tmux` is not given a fresh PTY (we just want stdout).
    const container = containerNameFor(projectName, service);
    const res = await execDocker(
        ["exec", "-u", "1000", container, "sh", "-c", command],
        {
            cwd: stackPath,
            onLog,
            signal,
        },
    );
    return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

function safeTmuxSessionName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Register a delta subscriber on an existing tmux session entry. The
 * subscriber's `onDelta` is invoked for every pane chunk the reader emits.
 * When the subscriber's `signal` aborts (caller disconnect), the subscriber
 * is removed from the entry. When the last subscriber leaves, the reader's
 * `abortController` is aborted so `startReader`'s teardown path runs
 * (kills the docker exec, clears `pipe-pane`, removes the FIFO).
 *
 * This is the reconnect fix: a browser refresh closes the old SSE response
 * (old subscriber's signal aborts → removed), and the new attach adds a
 * fresh subscriber to the same entry — so the reader's delta fan-out
 * reaches the new SSE response instead of being dropped on the floor.
 */
function addSubscriber(
    entry: TmuxSession,
    onDelta: (streamId: string, delta: string) => void,
    onExit?: (streamId: string) => void,
    signal?: AbortSignal,
): TmuxSubscriber {
    const subscriber: TmuxSubscriber = { onDelta, onExit, signal };
    if (signal?.aborted) {
        // Caller already gone: never register, and don't leave a reader
        // running that nobody can receive from.
        if (entry.subscribers.size === 0 && !entry.abortController.signal.aborted) {
            entry.abortController.abort();
        }
        return subscriber;
    }
    if (signal) {
        const abortListener = () => {
            entry.subscribers.delete(subscriber);
            if (entry.subscribers.size === 0 && !entry.abortController.signal.aborted) {
                logger.info(
                    { streamId: entry.streamId, session: entry.session },
                    "[tmux] subscriber: last subscriber gone, tearing down reader",
                );
                entry.abortController.abort();
            }
        };
        signal.addEventListener("abort", abortListener, { once: true });
    }
    entry.subscribers.add(subscriber);
    return subscriber;
}

/**
 * Attach to (or create) a tmux session in a running service.
 *
 * If the caller supplies an existing streamId that is still active, the same
 * session key is reused and the latest scrollback is returned; otherwise a new
 * streamId is allocated. The background reader emits pane deltas via onDelta
 * until the session is detached, the container stops, or the abort signal fires.
 */
type AttachOptions = Parameters<typeof attachTmuxSessionNow>[0];

/** Attaches in flight per session key, so concurrent attaches run in order. */
const attachQueue = new Map<string, Promise<unknown>>();

export function attachTmuxSession(opts: AttachOptions): Promise<TmuxAttachResult> {
    // Attaches of one session must not overlap: each would find no active
    // reader, start its own `tmux pipe-pane`, and only the last pipe keeps
    // receiving output, so the other streams look frozen. In order, later
    // attaches join the first one's reader as subscribers.
    const key = sessionKey(opts.projectName, opts.service, opts.session);
    const previous = attachQueue.get(key);
    // Uncontended attaches run immediately, without extra scheduling hops.
    const run = previous ? previous.then(() => attachTmuxSessionNow(opts)) : attachTmuxSessionNow(opts);
    // Registered before the caller's own continuation, so the queue is
    // already clear when the caller resumes.
    const clear = () => {
        if (attachQueue.get(key) === settled) attachQueue.delete(key);
    };
    const settled: Promise<void> = run.then(clear, clear);
    attachQueue.set(key, settled);
    return run;
}

async function attachTmuxSessionNow(opts: {
    stackPath: string;
    projectName: string;
    service: string;
    session: string;
    requestedStreamId?: string;
    cols?: number;
    rows?: number;
    lines?: number;
    onDelta: (streamId: string, delta: string) => void;
    onExit?: (streamId: string) => void;
    logChunk?: (chunk: string) => void;
    signal?: AbortSignal;
}): Promise<TmuxAttachResult> {
    const { stackPath, projectName, service, session, requestedStreamId, onDelta, onExit, logChunk, signal, lines = 2000 } = opts;

    if (!safeTmuxSessionName(session)) {
        throw new Error(`Invalid tmux session name: ${session}`);
    }

    const traceId = `${projectName}:${service}:${session}`;
    const attachStart = Date.now();
    logger.info(
        { traceId, requestedStreamId, cols: opts.cols, rows: opts.rows, lines },
        "[tmux] attach: enter",
    );

    // Bring the tmux server up before doing anything else. The agent
    // container's tmux server can die when the last session exits (e.g. the
    // user closes the last bash tab, or the user `exit`s from a TUI that
    // was the only process holding the session open). The leftover
    // `/tmp/tmux-1000/default` socket file stays on disk, so a fresh
    // `tmux` invocation will fail with "no server running on
    // /tmp/tmux-1000/default" and `tmux has-session` reports a
    // non-existent session — which would cause us to fall through to the
    // "create new session" branch and silently lose the user's running
    // TUI on the next call.
    //
    // `tmux start-server` is the right rescue: it's a no-op if a live
    // server is already there (exits 0 immediately), and it removes the
    // stale socket and spawns a fresh server if not. We run it BEFORE
    // the `hasSession` check so a dead server never trips the wrong
    // branch.
    {
        const t0 = Date.now();
        const result = await tmuxCommand(
            stackPath, service, projectName,
            `tmux start-server 2>/dev/null; true`,
            signal, logChunk,
        );
        logger.info(
            { traceId, elapsedMs: Date.now() - t0, code: result.code, stderr: result.stderr?.slice(0, 200) },
            "[tmux] attach: start-server resolved",
        );
    }

    const key = sessionKey(projectName, service, session);
    const existing = activeSessions.get(key);
    if (existing) {
        logger.info(
            { traceId, existingStreamId: existing.streamId, requestedStreamId, subscriberCount: existing.subscribers.size },
            "[tmux] attach: reusing existing reader",
        );
    }

    // Reconnect / reuse path: an existing reader is already running under
    // this key (same tmux session, same container). We add the new caller
    // as a SUBSCRIBER to the existing entry so the reader's delta fan-out
    // reaches it. Tearing down the reader stops `pipe-pane` and kills the
    // docker exec process, which disrupts the shell in the tmux pane and
    // can kill the agent process before xterm renders — that was the root
    // cause of "agent killed mid-run" when the board auto-attached on
    // mount.
    //
    // We return the existing reader's streamId so the client can use it
    // for subsequent reconnects. The existing reader continues to emit
    // deltas; the new caller just gets fresh scrollback.
    //
    // The previous design returned early here WITHOUT wiring the new
    // `onDelta` to anything — the reader kept calling the first attach's
    // callback (whose SSE response was already closed), so a
    // browser-refresh reconnect saw scrollback but no live updates. The
    // subscriber set fixes that: every attach's `onDelta` is registered
    // and removed on its own signal abort; the reader is torn down only
    // when the last subscriber leaves.
    if (existing) {
        const scrollback = await captureSession(stackPath, service, projectName, session, lines, signal, logChunk);
        // The reader may have been torn down while capture-pane ran (the last
        // subscriber left). Joining it would hand out a dead streamId and no
        // live output, so fall through to the create path instead. That path
        // starts exactly one pipe-pane, as activeSessions no longer holds it.
        if (activeSessions.get(key) === existing && !existing.abortController.signal.aborted) {
            addSubscriber(existing, onDelta, onExit, signal);
            return {
                scrollback,
                streamId: existing.streamId,
                cols: existing.cols,
                rows: existing.rows,
            };
        }
    }

    const qSession = shellQuote(session);
    let trackedCols = opts.cols ?? 200;
    let trackedRows = opts.rows ?? 50;
    let sessionAlreadyExisted = false;
    {
        const t0 = Date.now();
        const hasSession = await tmuxCommand(
            stackPath, service, projectName,
            `tmux has-session -t =${qSession} 2>/dev/null && echo __HAS__ || echo __MISSING__`,
            signal, logChunk,
        );
        logger.info(
            { traceId, elapsedMs: Date.now() - t0, code: hasSession.code, hasSession: hasSession.stdout.includes("__HAS__") },
            "[tmux] attach: has-session resolved",
        );

        sessionAlreadyExisted = hasSession.stdout.includes("__HAS__");
        if (!sessionAlreadyExisted) {
            const cols = trackedCols;
            const rows = trackedRows;
            const t1 = Date.now();
            // tmux's default pane TERM is `screen`, which makes the mounted
            // Debian-style .bashrc choose its monochrome prompt even though
            // xterm supports ANSI color. Keep bash as a login shell (so the
            // existing `logout` command remains valid) and advertise tmux's
            // actual 256-color capability to the shell it launches.
            const create = await tmuxCommand(
                stackPath, service, projectName,
                `tmux new-session -d -s ${qSession} -n carapa -x ${cols} -y ${rows} 'env TERM=screen-256color /bin/bash -l'`,
                signal, logChunk,
            );
            logger.info(
                { traceId, elapsedMs: Date.now() - t1, code: create.code, stderr: create.stderr?.slice(0, 200) },
                "[tmux] attach: new-session resolved",
            );
            if (create.code !== 0 && !(signal?.aborted)) {
                throw new Error(`tmux new-session failed: ${create.stderr || create.stdout || "unknown error"}`);
            }
        }
    }

    // A browser disconnect tears down only the pipe-pane reader, not the tmux
    // session. On the next attach there is no activeSessions entry from which
    // to recover geometry, so ask tmux for the authoritative window size.
    // This lets the subsequent ResizeObserver request be skipped when nothing
    // changed, while still performing a real resize if the browser dimensions
    // changed while detached.
    if (sessionAlreadyExisted) {
        const size = await tmuxCommand(
            stackPath, service, projectName,
            `tmux display-message -p -t =${qSession}: '#{window_width} #{window_height}'`,
            signal, logChunk,
        );
        const match = size.stdout.trim().match(/^([1-9][0-9]*) ([1-9][0-9]*)$/);
        if (match) {
            trackedCols = Number(match[1]);
            trackedRows = Number(match[2]);
        }
    }

    {
        const t0 = Date.now();
        const scrollback = await captureSession(stackPath, service, projectName, session, lines, signal, logChunk);
        logger.info(
            { traceId, elapsedMs: Date.now() - t0, scrollbackBytes: scrollback.length },
            "[tmux] attach: capture-pane resolved",
        );

        const streamId = randomUUID();
        const abortController = new AbortController();
        const fifoPath = `/tmp/carapa-tmux-${streamId}.fifo`;
        const entry: TmuxSession = {
            streamId,
            stackPath,
            service,
            session,
            projectName,
            abortController,
            cols: trackedCols,
            rows: trackedRows,
            fifoPath,
            subscribers: new Set(),
        };
        activeSessions.set(key, entry);

        // Register the first subscriber (the caller's onDelta). The
        // external abort signal removes this subscriber when the caller
        // disconnects; the reader is torn down only when the last
        // subscriber leaves.
        addSubscriber(entry, onDelta, onExit, signal);

        // Caller aborted during setup: addSubscriber tore the entry down
        // before any reader existed, so don't start one.
        if (entry.abortController.signal.aborted) {
            forgetEntry(entry);
            return { scrollback, streamId, cols: entry.cols, rows: entry.rows };
        }

        // Start background reader.
        logger.info(
            { traceId, streamId, fifoPath, elapsedMs: Date.now() - attachStart },
            "[tmux] attach: starting background reader",
        );
        startReader(entry, logChunk);
        logger.info(
            { traceId, streamId, elapsedMs: Date.now() - attachStart },
            "[tmux] attach: returning to caller",
        );

        return { scrollback, streamId, cols: entry.cols, rows: entry.rows };
    }
}

async function captureSession(
    stackPath: string,
    service: string,
    projectName: string,
    session: string,
    lines: number,
    signal?: AbortSignal,
    logChunk?: (chunk: string) => void,
): Promise<string> {
    const qSession = shellQuote(session);
    // `-e` includes the escape sequences that reposition the cursor so that
    // xterm drops its cursor at tmux's real cursor position when it replays
    // the scrollback. Without `-e`, `-p` is plain text and the cursor lands
    // at the end of the bytes — which doesn't match the live prompt when
    // tmux's pane width differs from xterm's width (lines wrap differently
    // and the tail of the captured bytes is no longer the live cursor).
    const result = await tmuxCommand(
        stackPath, service, projectName,
        `tmux capture-pane -p -e -t =${qSession}: -S -${lines}`,
        signal, logChunk,
    );
    // tmux capture-pane always emits a row per visible line in the pane,
    // even for blank rows below the cursor. For a fresh session this means
    // 50+ trailing newlines ("row padding") that scroll xterm.js's cursor
    // off the visible area on initial render. Strip the trailing blank-line
    // padding entirely so the cursor lands exactly where the shell placed
    // it (right after the prompt, with no extra blank line below). The
    // final `\n` we'd otherwise keep is just tmux's row terminator for
    // the prompt line itself — the shell prints PS1 without a trailing
    // newline, so it shouldn't be rendered either. Preserve CRLF if the
    // input used CRLF so we don't accidentally shorten CRLF to LF.
    const trailing = result.stdout.match(/(\r?\n)+$/);
    if (!trailing) return result.stdout;
    return result.stdout.slice(0, result.stdout.length - trailing[0].length);
}

/** Tell every subscriber of an entry that its tmux session has ended. */
function notifySubscribersExit(entry: TmuxSession): void {
    for (const sub of [...entry.subscribers]) {
        try {
            sub.onExit?.(entry.streamId);
        } catch (err) {
            logger.warn(
                { err, streamId: entry.streamId },
                "[tmux] subscriber exit handler failed",
            );
        }
    }
}

async function teardownReader(entry: TmuxSession, logChunk?: (chunk: string) => void): Promise<void> {
    entry.abortController.abort();

    try {
        // Stop tmux from writing to the FIFO.
        await tmuxCommand(
            entry.stackPath, entry.service, entry.projectName,
            `tmux pipe-pane -t =${shellQuote(entry.session)}:`,
            undefined, logChunk,
        );
    } catch (err) {
        logger.warn({ err, streamId: entry.streamId }, "[tmux] failed to stop pipe-pane during teardown");
    }

    try {
        // Remove the FIFO so subsequent readers don't read stale data.
        await tmuxCommand(
            entry.stackPath, entry.service, entry.projectName,
            `rm -f ${shellQuote(entry.fifoPath)}`,
            undefined, logChunk,
        );
    } catch { /* best-effort cleanup */ }
}

/** Drop a reader entry from the session registries (only if still current). */
function forgetEntry(entry: TmuxSession): void {
    const key = sessionKey(entry.projectName, entry.service, entry.session);
    if (activeSessions.get(key)?.streamId === entry.streamId) {
        activeSessions.delete(key);
    }
}

function startReader(entry: TmuxSession, logChunk?: (chunk: string) => void): void {
    const cleanup = () => forgetEntry(entry);

    entry.abortController.signal.addEventListener("abort", cleanup, { once: true });

    // Push-based reader via `tmux pipe-pane` + a container-side FIFO.
    // The whole setup runs inside ONE `docker exec sh -c` so the ordering
    // is guaranteed by the shell: `rm -f <fifo>` → `mkfifo <fifo>` (now
    // the FIFO node exists) → `tmux pipe-pane -t <session> 'cat > <fifo>'`
    // (tmux opens the writer side) → `cat <fifo>` (the reader, blocks
    // on `open(2)` until tmux connects). cat's stdout is the docker
    // exec's stdout, which is `proc.stdout` in the box — bytes flow as
    // soon as tmux writes them.
    //
    // Why the single exec matters: the previous architecture spawned cat
    // locally (via `node:child_process.spawn`) in parallel with a
    // separate mkfifo exec, which produced a race where cat could open
    // the FIFO before mkfifo had created it (ENOENT → cat exit → reader
    // dead). One shell command eliminates that race.
    //
    // Why we poll proc.exitCode in a watchdog: the old `node:spawn`
    // reader's `proc.on("exit")` didn't always fire when the docker
    // exec was reparented (e.g. after the box process restarted).
    // `Bun.spawn` returns a `Subprocess` with a polled `exitCode`
    // property — checking it every WATCHDOG_INTERVAL_MS is the
    // authoritative source of truth, so a dead reader is always
    // detected and torn down within one watchdog tick.
    const qSession = shellQuote(entry.session);
    const qFifo = shellQuote(entry.fifoPath);
    const container = containerNameFor(entry.projectName, entry.service);
    const setupCmd =
        `rm -f ${qFifo} && ` +
        `mkfifo ${qFifo} && ` +
        `tmux pipe-pane -t =${qSession}: 'cat > ${qFifo}' && ` +
        `cat ${qFifo}`;

    let proc: Bun.Subprocess | null = null;
    let readerBytesTotal = 0;
    let sessionExitNotified = false;
    const notifySessionExitIfGone = async () => {
        if (sessionExitNotified || entry.abortController.signal.aborted) return;
        const status = await tmuxCommand(
            entry.stackPath,
            entry.service,
            entry.projectName,
            `tmux has-session -t =${qSession}`,
            undefined,
            logChunk,
        );
        if (status.code === 0 || entry.abortController.signal.aborted) return;
        sessionExitNotified = true;
        notifySubscribersExit(entry);
    };
    let teardownPromise: Promise<void> | null = null;
    const teardown = async () => {
        if (teardownPromise) return teardownPromise;
        teardownPromise = (async () => {
            // Stop the local docker exec first — that unblocks the inner
            // `cat <fifo>` with EOF, the inner `sh -c` returns, and the
            // tmux pipe-pane cat dies too.
            if (proc && proc.exitCode === null) {
                try { proc.kill(); } catch { /* ignore */ }
            }
            // Clear pipe-pane globally for the session and remove the
            // FIFO so the next attach starts from a clean state. Both
            // are best-effort — a stale pipe-pane or FIFO is harmless.
            try {
                await tmuxCommand(
                    entry.stackPath, entry.service, entry.projectName,
                    `tmux pipe-pane -t =${qSession}:`,
                    undefined, logChunk,
                );
            } catch { /* best-effort */ }
            try {
                await tmuxCommand(
                    entry.stackPath, entry.service, entry.projectName,
                    `rm -f ${qFifo}`,
                    undefined, logChunk,
                );
            } catch { /* best-effort */ }
            // Fire the abort signal last so the entry's activeSessions
            // cleanup runs once teardown is done.
            if (!entry.abortController.signal.aborted) {
                entry.abortController.abort();
            }
        })();
        return teardownPromise;
    };
    // Wire external aborts (request disconnect, mcp session close,
    // teardownReader) to the local teardown so the proc is killed, the
    // pipe-pane is turned off and the FIFO removed. teardown() is
    // memoised, so the abort it fires itself cannot re-enter.
    entry.abortController.signal.addEventListener("abort", () => {
        void teardown();
    }, { once: true });

    try {
        proc = Bun.spawn(
            ["docker", "exec", "-u", "1000", "-i", container, "sh", "-c", setupCmd],
            {
                cwd: entry.stackPath,
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    DOCKER_HOST: process.env.DOCKER_HOST,
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    TERM: process.env.TERM,
                },
            },
        ) as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
    } catch (err) {
        logger.warn(
            { err: err instanceof Error ? { message: err.message } : String(err), streamId: entry.streamId },
            "[tmux] fifo reader: docker exec spawn failed",
        );
        void teardown();
        return;
    }

    logger.info(
        { streamId: entry.streamId, fifoPath: entry.fifoPath, container, pid: proc.pid },
        "[tmux] fifo reader: spawned",
    );

    // Stream stdout → onDelta. The reader accumulates into a per-stream
    // buffer so we can pass any unhandled tail bytes to the next reader
    // (we don't use one here, but it keeps the protocol clean for the
    // `replay` path).
    // Cast the stdout/stderr to ReadableStream<Uint8Array> — when both
    // are configured with "pipe", Bun.spawn returns ReadableStreams; the
    // overload types in bun-types make this hard to express directly.
    const stdoutStream = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    // Separate streaming decoders: a multibyte char split across stdout
    // chunks must not have its pending bytes absorbed by a stderr chunk.
    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    (async () => {
        const reader = stdoutStream.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.byteLength === 0) continue;
                readerBytesTotal += value.byteLength;
                // `tmux pipe-pane` bytes are a stream of escape sequences
                // and characters; we just forward everything to onDelta.
                // The decoder's `stream: true` option keeps partial
                // multi-byte sequences across reads so we don't split
                // an emoji or wide char in half.
                const text = stdoutDecoder.decode(value, { stream: true });
                if (text.length > 0 && !entry.abortController.signal.aborted) {
                    // Fan out to every subscriber. We iterate over a
                    // snapshot so a subscriber removing itself (via its
                    // abort listener) during the loop doesn't skip
                    // subsequent subscribers.
                    for (const sub of entry.subscribers) {
                        try {
                            sub.onDelta(entry.streamId, text);
                        } catch (err) {
                            logger.warn(
                                { err, streamId: entry.streamId },
                                "[tmux] fifo reader: subscriber delta handler failed",
                            );
                        }
                    }
                }
            }
        } catch (err) {
            if (!entry.abortController.signal.aborted) {
                logger.warn(
                    { err: err instanceof Error ? { message: err.message } : String(err), streamId: entry.streamId },
                    "[tmux] fifo reader: stdout read failed",
                );
            }
        } finally {
            // A shell exit closes tmux's pipe-pane writer, which lets the FIFO
            // reader reach EOF. Confirm the session is actually gone before
            // notifying clients so an infrastructure reader failure never
            // masquerades as a user logout.
            await notifySessionExitIfGone();
        }
    })().catch(() => { /* errors logged above */ });

    // Stream stderr → warn. mkfifo / pipe-pane failures end up here;
    // promoting to warn so a broken setup is visible in the box logs
    // at the default log level.
    (async () => {
        const reader = stderrStream.getReader();
        let acc = "";
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.byteLength === 0) continue;
                acc += stderrDecoder.decode(value, { stream: true });
            }
        } catch { /* ignore */ }
        if (acc.trim().length > 0 && !entry.abortController.signal.aborted) {
            logger.warn(
                { streamId: entry.streamId, msg: acc.trim() },
                "[tmux] fifo reader: docker exec stderr",
            );
        }
    })().catch(() => { /* errors logged above */ });

    // Watchdog: poll proc.exitCode every WATCHDOG_INTERVAL_MS. The
    // `proc.exited` promise is the canonical Bun lifecycle, but if the
    // docker exec is reparented (e.g. after a box process restart)
    // the Subprocess handle can miss the exit event. exitCode is the
    // source of truth: if it goes non-null, the proc is dead and we
    // tear down. A live proc has `exitCode === null` (Bun Subprocess
    // contract).
    const watchdog = setInterval(() => {
        if (entry.abortController.signal.aborted) {
            clearInterval(watchdog);
            return;
        }
        if (proc && proc.exitCode !== null) {
            const code = proc.exitCode;
            logger.info(
                { streamId: entry.streamId, code, bytesTotal: readerBytesTotal },
                "[tmux] fifo reader: docker exec exited",
            );
            clearInterval(watchdog);
            void teardown();
        }
    }, WATCHDOG_INTERVAL_MS);
    // Don't keep the event loop alive just for the watchdog — a torn-
    // down reader should let the process exit cleanly if nothing else
    // holds it open.
    watchdog.unref?.();
}

/** Watchdog cadence for the docker-exec exit detection. 5 s is a
 *  reasonable trade-off — fast enough to notice a dead reader, slow
 *  enough that the polling is essentially free. */
const WATCHDOG_INTERVAL_MS = 5_000;

/**
 * Send literal keystrokes into the tmux session.
 *
 * The wire format accepts base64 so clients can send raw bytes / escapes without
 * JSON fighting them. The server decodes the value and passes it to
 * `tmux send-keys -l`. If cols/rows are supplied, the tmux window is resized,
 * SIGWINCH is forwarded to the pane, and the active tracked size is updated.
 */
export async function execTmuxSession(opts: {
    stackPath: string;
    projectName: string;
    service: string;
    session: string;
    input: string;
    inputBase64?: boolean;
    cols?: number;
    rows?: number;
    signal?: AbortSignal;
    logChunk?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string; code: number }> {
    const { stackPath, projectName, service, session, signal, logChunk } = opts;

    if (!safeTmuxSessionName(session)) {
        throw new Error(`Invalid tmux session name: ${session}`);
    }

    const decoded = opts.inputBase64
        ? Buffer.from(opts.input, "base64").toString("utf8")
        : opts.input;
    const key = sessionKey(projectName, service, session);
    const active = activeSessions.get(key);
    const resizeRequested = opts.cols !== undefined || opts.rows !== undefined;
    const resizeChanged = resizeRequested && (
        !active ||
        (opts.cols !== undefined && opts.cols !== active.cols) ||
        (opts.rows !== undefined && opts.rows !== active.rows)
    );

    // Keep the startup guard in the SAME container exec as the operation.
    // A separate exec makes every key launch two processes and wait twice
    // in the shared process queue. The final operation still determines
    // the exit status, including a missing session after a server restart.
    const startCmd = "tmux start-server 2>/dev/null; ";

    // Update tracked size if we have an active session under this key.
    if (active) {
        if (opts.cols !== undefined) active.cols = opts.cols;
        if (opts.rows !== undefined) active.rows = opts.rows;
    }

    const qSession = shellQuote(session);
    let resizeCmd = "";
    if (resizeChanged) {
        const cols = opts.cols ?? (active?.cols ?? 200);
        const rows = opts.rows ?? (active?.rows ?? 50);
        // resize-window forwards SIGWINCH to the pane process; an additional
        // `send-keys -R` is unnecessary and resets tmux's terminal state,
        // which makes an idle readline prompt redraw into pane history.
        //
        // We deliberately do NOT send `C-l` (clear screen) here. The board's
        // bash-tab fires an immediate resize on attach; sending `C-l` would
        // wipe the visible scrollback and move tmux's cursor to the top while
        // xterm still shows the pre-clear content with its cursor at the
        // bottom, so subsequent keystrokes would render at the wrong place.
        resizeCmd = `tmux resize-window -t =${qSession}: -x ${cols} -y ${rows} 2>/dev/null; `;
    }

    if (!decoded) {
        // BashTab's ResizeObserver can repeat an unchanged resize request.
        // Avoid starting a container exec when there is no resize to apply.
        if (!resizeCmd) return { stdout: "", stderr: "", code: 0 };
        return tmuxCommand(
            stackPath, service, projectName,
            `${startCmd}${resizeCmd}`,
            signal, logChunk,
        );
    }

    // Pass the decoded input to send-keys -l as a single literal string.
    return tmuxCommand(
        stackPath, service, projectName,
        `${startCmd}${resizeCmd}tmux send-keys -l -t =${qSession}: ${shellQuote(decoded)}`,
        signal, logChunk,
    );
}

/**
 * Detach (kill) a tmux session and stop its background reader.
 */
export async function detachTmuxSession(opts: {
    stackPath: string;
    projectName: string;
    service: string;
    session: string;
    streamId: string;
    signal?: AbortSignal;
    logChunk?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string; code: number }> {
    const { stackPath, projectName, service, session, streamId, signal, logChunk } = opts;

    if (!safeTmuxSessionName(session)) {
        throw new Error(`Invalid tmux session name: ${session}`);
    }

    const key = sessionKey(projectName, service, session);
    const active = activeSessions.get(key);
    if (active && active.streamId === streamId) {
        await teardownReader(active, logChunk);
        activeSessions.delete(key);
        // Aborting the reader suppresses its own exit notification, so tell
        // the other tabs sharing this entry that the session is gone;
        // otherwise their streams stay open on a dead terminal.
        notifySubscribersExit(active);
    }

    // Check whether the tmux session still exists in the server. The user
    // intent of a detach is "ensure that tmux session is gone". When the
    // session is already gone (e.g. the user Ctrl+D'd out of the shell and
    // tmux exited on its own, or a sibling tab already killed it), calling
    // `tmux kill-session` would emit a non-zero exit and the HTTP layer
    // would surface that as `HTTP 500 {"ok":true,"exitCode":1}` — which is
    // misleading: the desired state ("session is gone") is already true.
    //
    // Treat "session not found" as a successful no-op: tear down any
    // matching reader above (the only side effect that might still need
    // running) and return a synthetic `{ code: 0, stderr: <notice> }` so
    // the audit trail records the no-op and the HTTP layer returns 200.
    // Real `kill-session` failures (e.g. tmux server unreachable) still
    // surface as non-zero below.
    const hasSession = await tmuxCommand(
        stackPath, service, projectName,
        `tmux has-session -t =${shellQuote(session)}`,
        signal, logChunk,
    );
    if (hasSession.code !== 0) {
        auditLog({
            timestamp: new Date().toISOString(),
            tool: "sandbox_tmux_detach",
            stack: projectName,
            service,
            command: `tmux kill-session -t ${session}`,
            projectName,
            allowed: true,
            reason: `tmux session ${session} already gone (no-op detach)`,
        });
        return {
            stdout: "",
            stderr: `tmux session ${session} already gone (no-op detach)`,
            code: 0,
        };
    }

    const result = await tmuxCommand(
        stackPath, service, projectName,
        `tmux kill-session -t =${shellQuote(session)}`,
        signal, logChunk,
    );

    auditLog({
        timestamp: new Date().toISOString(),
        tool: "sandbox_tmux_detach",
        stack: projectName,
        service,
        command: `tmux kill-session -t ${session}`,
        projectName,
        allowed: result.code === 0,
        exitCode: result.code,
        reason: result.code === 0 ? undefined : (result.stderr || "tmux kill-session returned non-zero"),
    });

    return result;
}

/**
 * Stop all readers for a project without killing tmux sessions. Used by box
 * shutdown so sessions tied to active_run lifetime are not left dangling in
 * this process.
 */
export function stopAllTmuxReaders(projectName?: string): void {
    for (const [key, entry] of activeSessions) {
        if (!projectName || key.startsWith(`${projectName}:`)) {
            entry.abortController.abort();
        }
    }
}

/**
 * List currently active tmux session readers. Diagnostic only.
 */
export function listActiveTmuxSessions(): { streamId: string; projectName: string; service: string; session: string }[] {
    return [...activeSessions.values()].map((e) => ({
        streamId: e.streamId,
        projectName: e.projectName,
        service: e.service,
        session: e.session,
    }));
}
