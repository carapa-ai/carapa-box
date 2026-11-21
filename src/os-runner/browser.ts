/**
 * Board's browser viewer on the native runner. It serves the REST contract of
 * src/http/browser.ts to the hub tunnel in-process (no listening port, no
 * bearer token: the hub socket authenticates Board), reusing that handler with
 * a native `open`. The trusted `browser-viewer <sessionId>` helper runs only
 * through the project's agent sandbox host, where the agent's browser daemon
 * sockets (under the project's tmp root) are reachable; never in the shell
 * host and never spawned directly. The agent profile allows no local binding
 * and no loopback TCP, so the helper talks to its dashboard over a Unix socket
 * in that tmp root (CARAPA_BROWSER_VIEWER_TRANSPORT=unix). Input lines reach its stdin through the
 * host protocol; closing a viewer ends the helper's stdin, then kills it.
 */
import type { AuditEntry } from "../audit.js";
import { logger } from "../logger.js";
import { BROWSER_MAX_INPUT, BrowserOpenError, createBrowserHandler, frameLines, type BrowserBridge, type BrowserTarget } from "../http/browser.js";
import { projectName, runtimeEnv, type NativeProject } from "./projects.js";
import type { HostStdin } from "./sandbox-host.js";
import { errorText, runSandboxed, trustedExecutable, type RunnerContext } from "./tools.js";

/** The helper gets this long after EOF to stop its own server before it is killed. */
const KILL_AFTER_MS = 2500;
const HELPER = "browser-viewer";

export interface NativeBrowserOptions {
    audit: (entry: AuditEntry) => void;
    /** Grace period between EOF and kill; tests shorten it. */
    killAfterMs?: number;
}

/** A running viewer: `exited` settles (never rejects) once the helper is gone or failed to start. */
interface Viewer {
    close(): void;
    exited: Promise<void>;
}


export class NativeBrowser {
    private readonly viewers = new Map<string, Set<Viewer>>();
    /** Projects whose viewers are being closed: they take no new viewer (a restarted project is a new object). */
    private readonly stopping = new WeakSet<NativeProject>();
    private readonly handler = createBrowserHandler({ open: (target, emit, ended) => this.open(target, emit, ended) }, { trusted: true });

    constructor(private readonly ctx: RunnerContext, private readonly options: NativeBrowserOptions) {}

    /** Serve one /api/browser/* request the hub tunnel forwarded. */
    handle(req: Request): Promise<Response> {
        return this.handler(req);
    }

    /** Close the project's viewers and wait until their helpers are gone (sandbox_stop, before its hosts close). */
    async stopProject(project: string): Promise<void> {
        // Marked before anything is awaited, so no viewer can attach after the snapshot below.
        const native = this.ctx.projects.get(project);
        if (native) this.stopping.add(native);
        const viewers = [...(this.viewers.get(project) ?? [])];
        for (const viewer of viewers) viewer.close();
        await Promise.all(viewers.map(viewer => viewer.exited));
    }

    /** Close every viewer (runner shutdown). */
    async stopAll(): Promise<void> {
        for (const native of this.ctx.projects.values()) this.stopping.add(native);
        await Promise.all([...this.viewers.keys()].map(project => this.stopProject(project)));
    }

    private audit(target: BrowserTarget, project: string, allowed: boolean, reason?: string): void {
        this.options.audit({
            timestamp: new Date().toISOString(), tool: "sandbox_browser_attach", stack: target.stack, service: target.service,
            projectName: project, command: `${HELPER} ${target.sessionId}`, allowed, ...(reason ? { reason } : {}),
        });
    }

    /** Same resolution as the tmux routes: an unknown project is 404, a stopped one 409, never another project. */
    private async open(target: BrowserTarget, emit: (line: string) => void, ended: () => void): Promise<BrowserBridge> {
        const refuse = (status: number, reason: string, project: string): never => {
            this.audit(target, project, false, reason);
            throw new BrowserOpenError(reason, status);
        };
        let name: string;
        try {
            name = projectName(target.stack, target.instance);
        } catch (error) {
            return refuse(400, errorText(error), target.stack);
        }
        const native = this.ctx.projects.get(name);
        if (!native) return refuse(404, `Sandbox not started on this runner: ${name}`, name);
        if (!native.running) return refuse(409, `Sandbox ${name} is stopped`, name);
        if (this.stopping.has(native)) return refuse(409, `Sandbox ${name} is stopping`, name);
        let file: string;
        try {
            file = trustedExecutable(this.ctx.config, HELPER);
        } catch (error) {
            return refuse(502, errorText(error), name);
        }
        this.audit(target, name, true);

        const abort = new AbortController();
        let stdin: HostStdin | undefined;
        let closed = false;
        let exited = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const close = () => {
            if (closed) return;
            closed = true;
            if (!exited) {
                stdin?.end(); // EOF lets the trusted helper stop its own server cleanly.
                killTimer = setTimeout(() => abort.abort(), this.options.killAfterMs ?? KILL_AFTER_MS);
                killTimer.unref?.();
            }
            ended();
        };
        const frame = frameLines(emit, close);
        const run = runSandboxed(this.ctx, native, file, [target.sessionId], {
            // The agent profile allows neither local binding nor loopback TCP: the viewer's dashboard uses a Unix socket under the tmp root.
            env: { ...runtimeEnv(native, this.ctx.config), CARAPA_BROWSER_VIEWER_TRANSPORT: "unix" }, retainOutput: false, signal: abort.signal,
            onStdin: (pipe) => { stdin = pipe; }, onOutput: frame,
        });
        const group = this.viewers.get(name) ?? new Set<Viewer>();
        // A failed start (e.g. the backend cannot ensure the sandbox) is reported to the viewer, never left as an unhandled rejection that kills the runner.
        const exitedRun = run.then(() => undefined, (error: unknown) => {
            logger.warn({ err: errorText(error), project: name }, "[runner] browser viewer failed");
            emit(JSON.stringify({ type: "error", message: errorText(error) }) + "\n");
        }).then(() => {
            exited = true;
            clearTimeout(killTimer);
            group.delete(viewer);
            if (group.size === 0 && this.viewers.get(name) === group) this.viewers.delete(name);
            close();
        });
        const viewer: Viewer = { close, exited: exitedRun };
        group.add(viewer);
        this.viewers.set(name, group);
        return {
            close,
            input(line) {
                if (closed || !stdin || stdin.pending() + Buffer.byteLength(line) > BROWSER_MAX_INPUT) throw new Error("Browser input backpressure");
                stdin.write(line);
            },
        };
    }
}
