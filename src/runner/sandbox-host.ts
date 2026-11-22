/**
 * One long-lived OS sandbox per native project, the counterpart of a
 * project's container.
 *
 * Seatbelt lets a process signal and inspect only processes in its own
 * sandbox. Agent runs hand work to each other (a turn reuses the warm daemon
 * an earlier turn started; stop-agent.sh signals a running worker), so every
 * command for a project must run in the same sandbox. The runner starts this
 * host once inside the project's profile and sends it commands over stdio,
 * as `docker exec` does for a container.
 *
 * Protocol (JSON lines): runner -> host {id, file, argv, cwd, env, timeoutMs}
 * starts a command, runner -> host {id, kill: true} kills it (a cancelled
 * request); host -> runner {id, out} chunks, then {id, code}.
 * A request with `stdin: true` gets a stdin pipe (all others have stdin
 * ignored): runner -> host {id, in} writes to it, {id, eof: true} ends it.
 * host -> runner {id, ack: bytes} reports that `bytes` of `in` data left the
 * host's queue for the command's stdin, so a command that stops reading shows
 * as unacknowledged bytes (HostStdin.pending) instead of a queue growing in the host.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const serving = import.meta.main && process.argv.includes("--serve");

// Only the runner caps retained output. The host runs inside the sandbox from a copy of this directory alone:
// ../capped-append.js is not mounted there. It is imported directly, not through ../utils.js, whose dependencies
// (config, logger) are not wanted at host startup and which other test files replace with module mocks.
const cappedAppend: typeof import("../capped-append.js").cappedAppend = serving
    ? () => { throw new Error("cappedAppend is runner-side only"); }
    : (await import("../capped-append.js")).cappedAppend;

/** How long a command's output pipes may stay open after it exited before its reply is sent anyway (a descendant may hold them). */
const DRAIN_MS = 1000;

interface HostRequest { id: number; file: string; argv: string[]; cwd: string; env: Record<string, string>; timeoutMs?: number; stdin?: boolean }
type HostInput = HostRequest | { id: number; kill: true } | { id: number; in: string } | { id: number; eof: true };
type HostMessage = { id: number; out: string } | { id: number; ack: number } | { id: number; code: number };

/** Kills the command's whole process group (it is spawned detached, so the group is its own); ESRCH means it is gone already. */
function killGroup(child: ChildProcess): void {
    try {
        if (child.pid === undefined) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
    } catch { /* already gone */ }
}

/** Inside the sandbox: run each request and report its output and exit code. */
function serve(): void {
    const send = (message: HostMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);
    const children = new Map<number, ChildProcess>();
    createInterface({ input: process.stdin }).on("line", (line) => {
        let message: HostInput;
        try { message = JSON.parse(line); } catch { return; }
        if ("kill" in message) { const target = children.get(message.id); if (target) killGroup(target); return; }
        if ("in" in message) {
            const stdin = children.get(message.id)?.stdin;
            const bytes = Buffer.byteLength(message.in);
            // The write callback runs once the data left the queue (also when the pipe failed: nothing more is pending).
            if (stdin) stdin.write(message.in, () => send({ id: message.id, ack: bytes }));
            else send({ id: message.id, ack: bytes });
            return;
        }
        if ("eof" in message) { children.get(message.id)?.stdin?.end(); return; }
        const request = message;
        // PATH stays the host's: the wrapper dropped directories the profile denies.
        // detached: the command leads its own process group, so a timeout or kill reaches its descendants too.
        const child = spawn(request.file, request.argv, { cwd: request.cwd, env: { ...request.env, PATH: process.env.PATH ?? "" }, stdio: [request.stdin ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
        // A child that exits first leaves writes to its stdin with EPIPE: the exit code reports it.
        child.stdin?.on("error", () => undefined);
        children.set(request.id, child);
        let finished = false;
        let drain: ReturnType<typeof setTimeout> | null = null;
        const timer = request.timeoutMs ? setTimeout(() => killGroup(child), request.timeoutMs) : null;
        // The reply is sent once, by whichever of `close` and the post-exit drain comes first.
        const finish = (code: number | null) => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            if (drain) clearTimeout(drain);
            children.delete(request.id);
            send({ id: request.id, code: code ?? 137 });
        };
        // A multi-byte character may be split across chunks: decode per stream.
        const relay = (stream: Readable) => {
            const decoder = new StringDecoder("utf8");
            const emit = (out: string) => { if (out && !finished) send({ id: request.id, out }); };
            stream.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
            stream.on("end", () => emit(decoder.end()));
        };
        relay(child.stdout!);
        relay(child.stderr!);
        child.on("error", (error) => { if (finished) return; send({ id: request.id, out: String(error) }); finish(127); });
        // A descendant holding the pipes keeps `close` from firing: reply after a bounded drain.
        // Only after `exit`: a long-lived stream whose process is alive is never cut.
        // The command exited by itself, so its timeout no longer applies: it must not kill what it left running.
        child.on("exit", (code) => {
            if (timer) clearTimeout(timer);
            if (!finished) drain = setTimeout(() => finish(code), DRAIN_MS);
        });
        child.on("close", finish);
    });
    // The runner went away: stop accepting work. Agents the runtime detached keep running.
    process.stdin.on("end", () => process.exit(0));
}

export interface HostResult { code: number; output: string }

export interface HostRunOptions {
    env: Record<string, string>;
    timeoutMs?: number;
    onOutput?: (chunk: string) => void;
    /** Aborting kills the command; it resolves with the host's exit code. */
    signal?: AbortSignal;
    /** false for a long-lived stream (a pane reader): its output is not kept in memory. */
    retainOutput?: boolean;
    /** Gives the command a stdin pipe (otherwise ignored); called once, before the command can read. */
    onStdin?: (stdin: HostStdin) => void;
}

/** The stdin pipe of a command started with `onStdin`. */
export interface HostStdin {
    write(data: string): void;
    /** Ends the command's stdin (EOF). */
    end(): void;
    /** Bytes written that the command's stdin has not accepted yet (still queued in the runner, the host or the pipe). */
    pending(): number;
}

/** Runner side: one sandboxed host process and its in-flight commands. */
export class ProjectHost {
    /** Runtime instance id: processes of an earlier host live in another sandbox. */
    readonly instance = randomUUID();
    private child: ChildProcess | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, { output: string; retain: boolean; unacked: number; onOutput?: (chunk: string) => void; resolve: (result: HostResult) => void }>();

    /** `launch` returns the argv that starts this file's host inside the project's sandbox. */
    constructor(private readonly launch: (hostArgv: string[], env: Record<string, string>) => string[], private readonly cwd: string) {}

    private start(env: Record<string, string>): ChildProcess {
        const hostEnv = { ...env, CARAPA_RUNTIME_INSTANCE: this.instance };
        const [command, ...args] = this.launch([process.execPath, import.meta.path, "--serve"], hostEnv);
        const child = spawn(command, args, { cwd: this.cwd, env: hostEnv, stdio: ["pipe", "pipe", "inherit"] });
        createInterface({ input: child.stdout! }).on("line", (line) => {
            let message: HostMessage;
            try { message = JSON.parse(line); } catch { return; }
            const entry = this.pending.get(message.id);
            if (!entry) return;
            if ("ack" in message) {
                entry.unacked -= message.ack;
                return;
            }
            if ("out" in message) {
                if (entry.retain) entry.output = cappedAppend(entry.output, message.out);
                entry.onOutput?.(message.out);
                return;
            }
            this.pending.delete(message.id);
            entry.resolve({ code: message.code, output: entry.output });
        });
        const fail = (message: string) => {
            if (this.child === child) this.child = null;
            for (const [id, entry] of this.pending) {
                this.pending.delete(id);
                entry.resolve({ code: 137, output: `${entry.output}\n${message}` });
            }
        };
        child.on("close", () => fail("sandbox host exited"));
        // A host that died with unflushed stdin leaves our writes with EPIPE: without a listener that crashes the runner.
        // The host is unusable: end it, and `close` then fails what it was running.
        child.stdin!.on("error", () => child.kill());
        // The host could not be started or signalled: fail its requests rather than throw.
        child.on("error", (error) => fail(`sandbox host failed: ${error.message}`));
        this.child = child;
        return child;
    }

    run(file: string, argv: string[], options: HostRunOptions): Promise<HostResult> {
        const child = this.child ?? this.start(options.env);
        const id = this.nextId++;
        return new Promise((resolve) => {
            const cancel = () => child.stdin!.write(`${JSON.stringify({ id, kill: true })}\n`);
            this.pending.set(id, {
                output: "", retain: options.retainOutput !== false, unacked: 0, onOutput: options.onOutput,
                resolve: (result) => { options.signal?.removeEventListener("abort", cancel); resolve(result); },
            });
            const request: HostRequest = {
                id, file, argv, cwd: this.cwd, env: { ...options.env, CARAPA_RUNTIME_INSTANCE: this.instance }, timeoutMs: options.timeoutMs, stdin: options.onStdin ? true : undefined,
            };
            child.stdin!.write(`${JSON.stringify(request)}\n`);
            const send = (message: { in: string } | { eof: true }) => { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ id, ...message })}\n`); };
            options.onStdin?.({
                write: (data) => {
                    const entry = this.pending.get(id);
                    if (!entry || !child.stdin?.writable) return;
                    entry.unacked += Buffer.byteLength(data);
                    send({ in: data });
                },
                end: () => send({ eof: true }),
                pending: () => this.pending.get(id)?.unacked ?? 0,
            });
            if (options.signal?.aborted) cancel();
            else options.signal?.addEventListener("abort", cancel, { once: true });
        });
    }

    /** Close the host; agents it detached are stopped separately (stop-agent.sh). */
    close(): void {
        this.child?.stdin?.end();
        this.child = null;
    }
}

if (serving) serve();
