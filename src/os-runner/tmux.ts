/**
 * Board's tmux tab on the native runner. It serves the REST contract of
 * src/http/tmux.ts to the hub tunnel in-process (no listening port). Every tmux
 * process (server, pane shell, pane reader) runs through the project's shell
 * host: a second sandbox host with the project's Seatbelt profile plus a pty.
 * Agents run in the project's other host, which has no pty (a pty profile opens
 * every /dev/ttys*, the operator's terminals included).
 *
 * The tmux socket and each reader's FIFO live in the project's shell dir
 * (shellDir), under the runner root: agents can neither read nor connect to it.
 * Nothing the agent can write is read when the shell starts: tmux reads a
 * runner-owned conf, bash a runner-owned rc, readline a runner-owned inputrc.
 * A reader is `cat <fifo>` in the shell host; `tmux pipe-pane` writes the pane
 * into the FIFO. When the last subscriber leaves, the reader is cancelled (the
 * host kills it), the pipe stops and the FIFO is removed.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod";
import type { AuditEntry } from "../audit.js";
import { attachSchema, detachSchema, execSchema, parseBody, resizeSchema, sseFrame, TMUX_SSE_KEEPALIVE_FRAME, TMUX_SSE_KEEPALIVE_INTERVAL_MS } from "../http/tmux-wire.js";
import { logger } from "../logger.js";
import { closeHost, errorText, executable, hostKey, runSandboxed, type RunnerContext } from "./tools.js";
import { closeFd, openDirChain, writeAtomicAt } from "../runs/fd-path.js";
import { shellQuote } from "./os-sandbox.js";
import { projectName, runtimeEnv, shellDir, type NativeProject } from "./projects.js";
import type { HostResult, HostRunOptions } from "./sandbox-host.js";

/** A letter or digit, then letters, digits, '.', '_' or '-' (at most 64 characters). */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TMUX_MISSING = "tmux is not installed on this runner; brew install tmux";
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const DEFAULT_LINES = 2000;
const MAX_INPUT_CHARS = 8192;
const MKFIFO = "/usr/bin/mkfifo";
const READER = "/bin/cat";
const RM = "/bin/rm";
const BASH = "/bin/bash";
const SOCKET_NAME = "tmux.sock";
/** sockaddr_un.sun_path on macOS holds 104 bytes, the terminating NUL included. */
const SOCKET_PATH_LIMIT = 104;
const SHELL_SH = "/bin/sh";
/** History files a pane command would otherwise write into the agent home; null disables the file. */
const PANE_HISTORY_VARS: ReadonlyArray<readonly [string, string | null]> = [
    ["HISTFILE", "bash_history"], ["PYTHON_HISTORY", "python_history"], ["NODE_REPL_HISTORY", "node_repl_history"],
    ["PSQL_HISTORY", "psql_history"], ["MYSQL_HISTFILE", "mysql_history"], ["SQLITE_HISTORY", "sqlite_history"], ["LESSHISTFILE", null],
];
/** bashrc of the shell dir; history stays in the runner-owned dir, never in the agent home (HOME). */
const paneRc = (dir: string): string => `# Runner-owned. The pane shell reads this file instead of the agent home's startup files.\nPS1='\\w \\$ '\n` +
    // Exported so a nested bash and the common REPLs started from the pane also keep their history out of HOME.
    PANE_HISTORY_VARS.map(([name, file]) => `export ${name}=${file === null ? "-" : shellQuote(path.join(dir, file))}\n`).join("");
const INPUTRC = "# Runner-owned. readline reads this file instead of ~/.inputrc of the agent home.\n";

/**
 * The pane shell as an argv, run by tmux directly (no shell in between): it is no login shell and
 * reads only runner-owned files. HOME is the agent's, so its dotfiles are not trusted here.
 */
const paneCommand = (dir: string): string[] => ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV", "TERM=screen-256color", `INPUTRC=${path.join(dir, "inputrc")}`,
    BASH, "--noprofile", "--rcfile", path.join(dir, "bashrc"), "-i"];

/**
 * tmux.conf of the shell dir. tmux runs a command given as one string (and a window's default-command)
 * with `default-shell -c`; the runner's SHELL is typically zsh, which reads ~/.zshenv of the agent home
 * even non-interactively. /bin/sh reads no startup file for `-c`. A window opened inside the pane gets
 * the same guarded bash as the first one.
 */
function tmuxConf(dir: string): string {
    const command = `exec ${paneCommand(dir).map(shellQuote).join(" ")}`;
    // Inside tmux double quotes, backslash, '"' and '$' are special.
    const quoted = command.replace(/[\\"$]/g, "\\$&");
    return `# Runner-owned. tmux reads this file instead of ~/.tmux.conf of the agent home.\nset-option -g default-shell ${SHELL_SH}\nset-option -g default-command "${quoted}"\n`;
}

const sessionName = z.string().regex(SESSION_NAME, "session must be 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit");
const nativeAttachSchema = attachSchema.extend({ session: sessionName });
const nativeExecSchema = execSchema.extend({ session: sessionName });
const nativeResizeSchema = resizeSchema.extend({ session: sessionName });
const nativeDetachSchema = detachSchema.extend({ session: sessionName });

export interface NativeTmuxOptions {
    /** Absolute path of tmux on this runner, or undefined when it is not installed. */
    findTmux: () => string | undefined;
    audit: (entry: AuditEntry) => void;
}

type Body = { stack: string; service: string; instance?: string; session: string };

/** One client of a pane reader: the attach stream it feeds. */
interface Subscriber {
    signal: AbortSignal;
    onDelta(streamId: string, delta: string): void;
    onExit(streamId: string): void;
    onClose(): void;
}

/** The pipe of one tmux session: pane output flows FIFO -> `cat` -> subscribers. */
interface Reader {
    key: string;
    native: NativeProject;
    /** tmux session name (tmux stores '.' in session names as '_'). */
    session: string;
    streamId: string;
    fifo: string;
    cols: number;
    rows: number;
    /** Aborting stops the reader: its `cat` is killed through the host. */
    stop: AbortController;
    subscribers: Set<Subscriber>;
    /** Set once stopping began; settles when the pipe is stopped and the FIFO removed. */
    stopped?: Promise<void>;
}

interface Attached { streamId: string; scrollback: string; cols: number; rows: number }

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });


const tmuxName = (session: string): string => session.replace(/\./g, "_");
const readerKey = (project: string, session: string): string => `${project}:${session}`;

/** Blank rows tmux pads below the prompt; dropped so the cursor lands right after the prompt. */
const trimPadding = (scrollback: string): string => scrollback.replace(/(\r?\n)+$/, "");

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("tmux attach aborted");
}

/** The tmux binary on PATH, as an absolute path. */
export function findTmux(searchPath = process.env.PATH ?? ""): string | undefined {
    for (const dir of searchPath.split(":")) {
        if (!dir) continue;
        const file = path.resolve(dir, "tmux");
        if (executable(file)) return file;
    }
    return undefined;
}

export class NativeTmux {
    private readonly readers = new Map<string, Reader>();
    /** Readers whose teardown (pipe stop, FIFO removal) is still running; the shell host must outlive it. */
    private readonly stopping = new Set<Reader>();
    /** Per key: attaches and teardowns run one at a time, in order. */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly ctx: RunnerContext, private readonly options: NativeTmuxOptions) {}

    /** Serve one request the hub tunnel forwarded (the tunnel enforces the /api/(browser|tmux) allow-list; /api/browser goes to NativeBrowser). */
    async handle(req: Request): Promise<Response> {
        const { pathname } = new URL(req.url);
        if (req.method === "POST" && pathname === "/api/tmux/attach") return this.attach(req);
        if (req.method === "POST" && pathname === "/api/tmux/exec") return this.exec(req);
        if (req.method === "POST" && pathname === "/api/tmux/resize") return this.resize(req);
        if (req.method === "DELETE" && pathname === "/api/tmux/detach") return this.detach(req);
        return json({ error: `Not found: ${req.method} ${pathname}` }, 404);
    }

    /**
     * End one project's pane readers and its tmux server (sandbox_stop, which runs
     * before the shell host closes). The server keeps the profile of the host that
     * started it, so the next shell must start under the next profile.
     */
    async stopProject(project: string): Promise<void> {
        await Promise.all([...this.readers.values(), ...this.stopping].filter(reader => reader.native.project === project).map(reader => this.stopReader(reader)));
        const native = this.ctx.projects.get(project);
        // A server that outlived a runner restart has a socket but no shell host yet; one is only started to kill it.
        const serving = this.ctx.hosts.has(hostKey(project, true)) || fs.existsSync(path.join(shellDir(this.ctx.config, project), SOCKET_NAME));
        if (native && serving) await this.tmux(native, ["kill-server"]).catch(() => undefined);
    }

    /** End every pane reader, kill each tmux server and close the shell hosts (runner shutdown). */
    async stopAll(): Promise<void> {
        await Promise.all([...this.readers.values(), ...this.stopping].map(reader => this.stopReader(reader)));
        await Promise.all([...this.ctx.projects.values()].filter(native => this.ctx.hosts.has(hostKey(native.project, true))).map(async (native) => {
            await this.tmux(native, ["kill-server"]).catch(() => undefined);
            closeHost(this.ctx, native.project, true);
        }));
    }

    /** The project a request addresses. A miss is refused; it is never sent to another project. */
    private resolve(tool: string, body: Body, command: string): { native: NativeProject; session: string; key: string } | Response {
        const refuse = (status: number, reason: string, project: string) => {
            this.audit(body, tool, command, { projectName: project, allowed: false, reason });
            return json({ error: reason }, status);
        };
        let name: string;
        try {
            name = projectName(body.stack, body.instance);
        } catch (error) {
            return refuse(400, errorText(error), body.stack);
        }
        const native = this.ctx.projects.get(name);
        if (!native) return refuse(404, `Sandbox not started on this runner: ${name}`, name);
        if (!native.running) return refuse(409, `Sandbox ${name} is stopped`, name);
        const session = tmuxName(body.session);
        return { native, session, key: readerKey(name, session) };
    }

    private audit(body: Body, tool: string, command: string, outcome: { projectName: string; allowed: boolean; reason?: string; exitCode?: number }): void {
        this.options.audit({ timestamp: new Date().toISOString(), tool, stack: body.stack, service: body.service, command, ...outcome });
    }

    /** Logs, audits and answers a tmux exec, resize or detach that threw. */
    private failed(body: Body, verb: "exec" | "resize" | "detach", command: string, native: NativeProject, session: string, error: unknown): Response {
        logger.warn({ err: errorText(error), project: native.project, session }, `[runner] tmux ${verb} failed`);
        this.audit(body, `sandbox_tmux_${verb}`, command, { projectName: native.project, allowed: true, reason: `tmux ${verb} failed: ${String(error)}`, exitCode: -1 });
        return json({ error: String(error) }, 500);
    }

    private async attach(req: Request): Promise<Response> {
        const parsed = await parseBody(req, nativeAttachSchema);
        if (!parsed.ok) return parsed.res;
        const body = parsed.data;
        const command = `tmux attach ${body.session}`;
        const target = this.resolve("sandbox_tmux_attach", body, command);
        if (target instanceof Response) return target;
        const { native, session } = target;
        if (!this.options.findTmux()) {
            this.audit(body, "sandbox_tmux_attach", command, { projectName: native.project, allowed: true, reason: TMUX_MISSING, exitCode: -1 });
            return json({ error: TMUX_MISSING }, 500);
        }

        // The stream outlives this handler: its subscriber aborts when the client leaves.
        const abort = new AbortController();
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;
        let initSent = false;
        // Pane output that arrives before init is held back: init is always the first event.
        let held: Uint8Array[] = [];
        let exitedStream: string | undefined;
        const finish = (last?: Uint8Array) => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            // This client leaves: its reader stops when it was the last subscriber.
            abort.abort();
            try {
                if (last) controller.enqueue(last);
                controller.close();
            } catch { /* the client already left */ }
        };
        const emit = (frame: Uint8Array) => {
            if (closed) return;
            try {
                controller.enqueue(frame);
            } catch {
                finish();
            }
        };
        const write = (frame: Uint8Array) => {
            if (initSent) emit(frame);
            else held.push(frame);
        };
        const closeBeforeInit = (reason: string) => finish(initSent ? undefined : sseFrame("error", { streamId: "", error: `tmux attach closed before init: ${reason}` }));
        const exitFrame = (streamId: string) => sseFrame("exit", { streamId, reason: "shell-exited" });
        const subscriber: Subscriber = {
            signal: abort.signal,
            onDelta: (streamId, delta) => write(sseFrame("delta", { streamId, delta })),
            onExit: (streamId) => {
                if (initSent) finish(exitFrame(streamId));
                else exitedStream = streamId;
            },
            onClose: () => closeBeforeInit("tmux reader stopped"),
        };
        const readable = new ReadableStream<Uint8Array>({
            start(streamController) { controller = streamController; },
            cancel() { closeBeforeInit("body-cancelled"); },
        });
        const heartbeat = setInterval(() => emit(encoder.encode(TMUX_SSE_KEEPALIVE_FRAME)), TMUX_SSE_KEEPALIVE_INTERVAL_MS);
        heartbeat.unref?.();
        if (req.signal.aborted) closeBeforeInit("request-aborted");
        else req.signal.addEventListener("abort", () => closeBeforeInit("request-aborted"), { once: true });

        this.attachSession(native, session, { cols: body.cols, rows: body.rows, lines: body.lines, signal: abort.signal, subscriber })
            .then((attached) => {
                if (closed) return;
                initSent = true;
                emit(sseFrame("init", { streamId: attached.streamId, session: body.session, cols: attached.cols, rows: attached.rows, scrollback: attached.scrollback }));
                for (const frame of held) emit(frame);
                held = [];
                this.audit(body, "sandbox_tmux_attach", command, { projectName: native.project, allowed: true });
                if (exitedStream !== undefined) finish(exitFrame(exitedStream));
            })
            .catch((error: unknown) => {
                logger.warn({ err: errorText(error), project: native.project, session }, "[runner] tmux attach failed");
                this.audit(body, "sandbox_tmux_attach", command, { projectName: native.project, allowed: true, reason: `tmux attach failed: ${String(error)}`, exitCode: -1 });
                finish(sseFrame("error", { streamId: "", error: String(error) }));
            });

        return new Response(readable, {
            status: 200,
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-store, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    }

    /** Join the session's pane reader, or start one; resolves once the scrollback is captured. */
    private attachSession(native: NativeProject, session: string, opts: { cols?: number; rows?: number; lines?: number; signal: AbortSignal; subscriber: Subscriber }): Promise<Attached> {
        const key = readerKey(native.project, session);
        return this.enqueue(key, async (): Promise<Attached> => {
            throwIfAborted(opts.signal);
            const lines = opts.lines ?? DEFAULT_LINES;
            const existing = this.readers.get(key);
            if (existing) {
                const scrollback = await this.capture(native, session, lines, opts.signal);
                // The reader may have stopped while capturing: then a new one starts below.
                if (this.readers.get(key) === existing) {
                    this.subscribe(existing, opts.subscriber);
                    return { streamId: existing.streamId, scrollback, cols: existing.cols, rows: existing.rows };
                }
            }
            const dir = this.prepareShellDir(native);
            // Brings up a server whose socket went stale, as the Linux path does.
            await this.tmux(native, ["start-server"], opts.signal);
            throwIfAborted(opts.signal);
            let cols = opts.cols ?? DEFAULT_COLS;
            let rows = opts.rows ?? DEFAULT_ROWS;
            const has = await this.tmux(native, ["has-session", "-t", `=${session}`], opts.signal);
            if (has.code === 0) {
                // A session that survived its last reader keeps its window size.
                const size = await this.tmux(native, ["display-message", "-p", "-t", `=${session}:`, "#{window_width} #{window_height}"], opts.signal);
                const match = /^([1-9]\d*) ([1-9]\d*)$/.exec(size.output.trim());
                if (match) {
                    cols = Number(match[1]);
                    rows = Number(match[2]);
                }
            } else {
                // The shell has the 256-colour TERM the prompt needs (as on Linux). The command is passed as an argv,
                // so tmux runs it directly and no intermediate shell reads the agent home's startup files.
                const created = await this.tmux(native, ["new-session", "-d", "-s", session, "-n", "carapa", "-x", String(cols), "-y", String(rows), "-c", native.repoDir, ...paneCommand(dir)], opts.signal);
                if (created.code !== 0) throw new Error(`tmux new-session failed: ${created.output || "unknown error"}`);
            }
            const scrollback = await this.capture(native, session, lines, opts.signal);

            const streamId = randomUUID();
            const reader: Reader = {
                key, native, session, streamId, cols, rows,
                fifo: path.join(dir, `${streamId}.fifo`),
                stop: new AbortController(), subscribers: new Set(),
            };
            this.readers.set(key, reader);
            this.subscribe(reader, opts.subscriber);
            try {
                throwIfAborted(reader.stop.signal);
                const made = await this.host(native, MKFIFO, ["-m", "600", reader.fifo], { signal: reader.stop.signal, timeoutMs: COMMAND_TIMEOUT_MS });
                if (made.code !== 0) throw new Error(`mkfifo failed: ${made.output || "unknown error"}`);
                const piped = await this.tmux(native, ["pipe-pane", "-t", `=${session}:`, `cat > ${shellQuote(reader.fifo)}`], reader.stop.signal);
                if (piped.code !== 0) throw new Error(`tmux pipe-pane failed: ${piped.output || "unknown error"}`);
                throwIfAborted(reader.stop.signal);
            } catch (error) {
                void this.stopReader(reader);
                throw error;
            }
            this.startReader(reader);
            return { streamId, scrollback, cols, rows };
        });
    }

    private subscribe(reader: Reader, subscriber: Subscriber): void {
        if (subscriber.signal.aborted) {
            if (reader.subscribers.size === 0) void this.stopReader(reader);
            return;
        }
        reader.subscribers.add(subscriber);
        subscriber.signal.addEventListener("abort", () => {
            reader.subscribers.delete(subscriber);
            if (reader.subscribers.size === 0) void this.stopReader(reader);
        }, { once: true });
    }

    /** Stop a pane reader: its `cat` is cancelled, the pipe stopped and the FIFO removed. Remaining subscribers end. */
    private stopReader(reader: Reader, end: "closed" | "exited" = "closed"): Promise<void> {
        if (reader.stopped) return reader.stopped;
        if (this.readers.get(reader.key) === reader) this.readers.delete(reader.key);
        const subscribers = [...reader.subscribers];
        reader.subscribers.clear();
        reader.stop.abort();
        reader.stopped = this.enqueue(reader.key, async () => {
            // Best-effort steps. A newer reader of this session may own the pipe by now, so it is only stopped when none does.
            if (!this.readers.has(reader.key)) await this.tmux(reader.native, ["pipe-pane", "-t", `=${reader.session}:`]).catch(() => undefined);
            // A pipe writer still waiting to open the FIFO would wait forever once the reader is gone; this read-write
            // open never waits, so the writer opens, reads EOF from the stopped pipe and exits.
            await this.host(reader.native, "/bin/sh", ["-c", 'exec 3<> "$0"', reader.fifo], { timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => undefined);
            await this.host(reader.native, RM, ["-f", reader.fifo], {}).catch(() => undefined);
        });
        this.stopping.add(reader);
        void reader.stopped.finally(() => this.stopping.delete(reader));
        for (const subscriber of subscribers) {
            if (end === "exited") subscriber.onExit(reader.streamId);
            else subscriber.onClose();
        }
        return reader.stopped;
    }

    private startReader(reader: Reader): void {
        runSandboxed(this.ctx, reader.native, READER, [reader.fifo], {
            env: runtimeEnv(reader.native, this.ctx.config),
            signal: reader.stop.signal,
            // A pane stream is unbounded: its output is delivered, not kept.
            retainOutput: false,
            onOutput: (chunk) => {
                for (const subscriber of [...reader.subscribers]) subscriber.onDelta(reader.streamId, chunk);
            },
        }, true).then(async () => {
            // The pipe closed on its own: the shell exited or the tmux server went away.
            if (!reader.stop.signal.aborted) await this.readerEnded(reader);
        }).catch((error: unknown) => {
            logger.warn({ err: errorText(error), project: reader.native.project }, "[runner] tmux reader failed");
            void this.stopReader(reader);
        });
    }

    private async readerEnded(reader: Reader): Promise<void> {
        const alive = await this.tmux(reader.native, ["has-session", "-t", `=${reader.session}`]).then(result => result.code === 0, () => false);
        void this.stopReader(reader, alive ? "closed" : "exited");
    }

    private async capture(native: NativeProject, session: string, lines: number, signal: AbortSignal): Promise<string> {
        // -e keeps the cursor-positioning escapes, so xterm places the cursor where tmux has it.
        const result = await this.tmux(native, ["capture-pane", "-p", "-e", "-t", `=${session}:`, "-S", `-${lines}`], signal);
        if (result.code !== 0) throw new Error(`tmux capture-pane failed: ${result.output || "unknown error"}`);
        return trimPadding(result.output);
    }

    private async exec(req: Request): Promise<Response> {
        const parsed = await parseBody(req, nativeExecSchema);
        if (!parsed.ok) return parsed.res;
        const body = parsed.data;
        const decoded = body.inputBase64 ? Buffer.from(body.input, "base64").toString("utf8") : body.input;
        if (decoded.length > MAX_INPUT_CHARS) return json({ error: `Input exceeds maximum length (${MAX_INPUT_CHARS} bytes).` }, 400);
        const command = `tmux send-keys ${body.session} (${decoded.length} bytes)`;
        const target = this.resolve("sandbox_tmux_exec", body, command);
        if (target instanceof Response) return target;
        const { native, session, key } = target;
        try {
            const tracked = this.readers.get(key);
            const cols = body.cols ?? tracked?.cols ?? DEFAULT_COLS;
            const rows = body.rows ?? tracked?.rows ?? DEFAULT_ROWS;
            let result: HostResult = { code: 0, output: "" };
            if ((body.cols !== undefined || body.rows !== undefined) && (cols !== tracked?.cols || rows !== tracked?.rows)) {
                result = await this.resizeWindow(native, session, cols, rows);
            }
            if (result.code === 0 && decoded) {
                // `--` keeps keystrokes that begin with '-' from being read as options.
                result = await this.tmux(native, ["send-keys", "-l", "-t", `=${session}:`, "--", decoded]);
            }
            this.audit(body, "sandbox_tmux_exec", command, { projectName: native.project, allowed: true, exitCode: result.code });
            if (result.code !== 0) return json({ error: "tmux exec returned non-zero", stderr: result.output, exitCode: result.code }, 500);
            return json({ ok: true });
        } catch (error) {
            return this.failed(body, "exec", command, native, session, error);
        }
    }

    private async resize(req: Request): Promise<Response> {
        const parsed = await parseBody(req, nativeResizeSchema);
        if (!parsed.ok) return parsed.res;
        const body = parsed.data;
        const command = `tmux resize-window ${body.session} -x ${body.cols} -y ${body.rows}`;
        const target = this.resolve("sandbox_tmux_resize", body, command);
        if (target instanceof Response) return target;
        const { native, session } = target;
        try {
            const result = await this.resizeWindow(native, session, body.cols, body.rows);
            this.audit(body, "sandbox_tmux_resize", command, { projectName: native.project, allowed: true, exitCode: result.code });
            if (result.code !== 0) return json({ error: "tmux resize returned non-zero", stderr: result.output, exitCode: result.code }, 500);
            return json({ ok: true });
        } catch (error) {
            return this.failed(body, "resize", command, native, session, error);
        }
    }

    private async resizeWindow(native: NativeProject, session: string, cols: number, rows: number): Promise<HostResult> {
        const result = await this.tmux(native, ["resize-window", "-t", `=${session}:`, "-x", String(cols), "-y", String(rows)]);
        const reader = this.readers.get(readerKey(native.project, session));
        if (reader && result.code === 0) {
            reader.cols = cols;
            reader.rows = rows;
        }
        return result;
    }

    private async detach(req: Request): Promise<Response> {
        const parsed = await parseBody(req, nativeDetachSchema);
        if (!parsed.ok) return parsed.res;
        const body = parsed.data;
        const command = `tmux kill-session -t ${body.session}`;
        const target = this.resolve("sandbox_tmux_detach", body, command);
        if (target instanceof Response) return target;
        const { native, session, key } = target;
        try {
            // The client's own reader stops first, then its session is killed.
            const reader = this.readers.get(key);
            if (reader?.streamId === body.streamId) await this.stopReader(reader);
            const result = await this.enqueue(key, () => this.killSession(native, session));
            this.audit(body, "sandbox_tmux_detach", command, {
                projectName: native.project, allowed: result.code === 0, exitCode: result.code,
                reason: result.code === 0 ? undefined : result.output || "tmux kill-session returned non-zero",
            });
            return json({ ok: true, exitCode: result.code }, result.code === 0 ? 200 : 500);
        } catch (error) {
            return this.failed(body, "detach", command, native, session, error);
        }
    }

    /** A session that is already gone counts as detached (as on Linux). */
    private async killSession(native: NativeProject, session: string): Promise<HostResult> {
        const has = await this.tmux(native, ["has-session", "-t", `=${session}`]);
        if (has.code !== 0) return { code: 0, output: `tmux session ${session} already gone (no-op detach)` };
        return this.tmux(native, ["kill-session", "-t", `=${session}`]);
    }

    /**
     * The project's shell dir, created 0700 with the runner-owned startup files. The files are replaced
     * on every use, through a directory handle, so one a shell planted is never followed or kept.
     */
    private prepareShellDir(native: NativeProject): string {
        const dir = shellDir(this.ctx.config, native.project);
        this.socketPath(native);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        const dirFd = openDirChain(dir, []);
        try {
            writeAtomicAt(dirFd, "tmux.conf", Buffer.from(tmuxConf(dir)));
            writeAtomicAt(dirFd, "bashrc", Buffer.from(paneRc(dir)));
            writeAtomicAt(dirFd, "inputrc", Buffer.from(INPUTRC));
        } finally {
            closeFd(dirFd);
        }
        return dir;
    }

    /** The project's tmux socket in its shell dir; a path macOS cannot bind is refused (there is no fallback to /tmp). */
    private socketPath(native: NativeProject): string {
        const socket = path.join(shellDir(this.ctx.config, native.project), SOCKET_NAME);
        const bytes = Buffer.byteLength(socket);
        if (bytes >= SOCKET_PATH_LIMIT) {
            throw new Error(`tmux socket path is ${bytes} bytes, over the macOS limit of ${SOCKET_PATH_LIMIT - 1}: ${socket}; use a shorter runner root`);
        }
        return socket;
    }

    /** Run one tmux command on the project's socket, through its shell host. */
    private async tmux(native: NativeProject, args: string[], signal?: AbortSignal): Promise<HostResult> {
        const binary = this.options.findTmux();
        if (!binary) throw new Error(TMUX_MISSING);
        // -f: tmux reads the runner-owned conf, never ~/.tmux.conf of the agent home.
        const conf = path.join(shellDir(this.ctx.config, native.project), "tmux.conf");
        return this.host(native, binary, ["-f", conf, "-S", this.socketPath(native), ...args], { signal, timeoutMs: COMMAND_TIMEOUT_MS });
    }

    /** Any process of the shell tab, started inside the project's shell host (the runner never spawns it directly). */
    private async host(native: NativeProject, file: string, argv: string[], options: Omit<HostRunOptions, "env">): Promise<HostResult> {
        return runSandboxed(this.ctx, native, file, argv, { ...options, env: runtimeEnv(native, this.ctx.config) }, true);
    }

    private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
        const run = (this.queues.get(key) ?? Promise.resolve()).then(work);
        const settled = run.then(() => undefined, () => undefined);
        this.queues.set(key, settled);
        void settled.then(() => {
            if (this.queues.get(key) === settled) this.queues.delete(key);
        });
        return run;
    }
}
