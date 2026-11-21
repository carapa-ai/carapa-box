import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEntry } from "../audit.js";
import { decodeFrame, encodeFrame, FRAME, serveHttpTunnel } from "../hub/http-tunnel.js";
import type { RunnerConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { prepareProject, projectTmpRoot, shellDir, type NativeProject } from "./projects.js";
import type { CommandWrapper } from "./os-sandbox.js";
import { ProjectHost, type HostResult } from "./sandbox-host.js";
import { findTmux, NativeTmux } from "./tmux.js";
import { hostKey, type RunnerContext } from "./tools.js";

/**
 * A stand-in tmux: it logs each call with its parent pid and the full argv, and
 * keeps the pane's input in the FIFO that `pipe-pane` names. A holder keeps that
 * FIFO open the way tmux's pipe writer does, so the reader outlives one keystroke.
 */
const FAKE_TMUX = `#!/bin/sh
DIR=$(dirname "$0")
echo "$PPID $*" >> "$DIR/calls"
for last; do :; done
[ "$1" = "-f" ] && shift 2
[ "$1" = "-S" ] && shift 2
case "$1" in
  has-session) [ -e "$DIR/session" ] ;;
  new-session) : > "$DIR/session" ;;
  display-message) echo "80 24" ;;
  capture-pane) printf 'prompt$ ' ;;
  send-keys) printf '%s' "$last" > "$(cat "$DIR/pane-fifo")" ;;
  pipe-pane)
    case "$last" in
      "cat > "*) printf '%s' "$last" | cut -c7- | tr -d "'" > "$DIR/pane-fifo"; sleep 60 >/dev/null 2>&1 3> "$(cat "$DIR/pane-fifo")" & echo $! > "$DIR/holder" ;;
      *) kill "$(cat "$DIR/holder")" 2>/dev/null; rm -f "$DIR/pane-fifo" ;;
    esac ;;
  kill-session) rm -f "$DIR/session" ;;
esac
`;

/**
 * Starts each host through a shell that records its pid in host.<variant>.pid, so a test can tell
 * which variant's host ran a tmux call. `variants` lists the profile each host was wrapped with.
 */
function pidWrap(variants: string[] = []): CommandWrapper {
    return (native, file, argv, _env, options) => {
        const variant = options?.shell ? "shell" : "agent";
        variants.push(variant);
        return ["/bin/sh", "-c", 'echo $$ > "$0"; exec "$@"', path.join(native.ipcDir, `host.${variant}.pid`), file, ...argv];
    };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Sandbox {
    root: string;
    /** The project's private shell dir (socket, FIFOs, startup files). */
    dir: string;
    native: NativeProject;
    hosts: Map<string, ProjectHost>;
    audits: AuditEntry[];
    tmux: NativeTmux;
    calls(): string[];
}

function sandbox(instance: string, options: { wrap?: CommandWrapper; findTmux?: () => string | undefined; rootPadding?: number } = {}): Sandbox {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-tmux-"));
    // A long runner root pushes the socket path past the macOS limit.
    const root = options.rootPadding ? path.join(base, "x".repeat(options.rootPadding)) : base;
    const binDir = path.join(base, "bin");
    fs.mkdirSync(binDir);
    const tmuxBin = path.join(binDir, "tmux");
    fs.writeFileSync(tmuxBin, FAKE_TMUX, { mode: 0o755 });
    const config: RunnerConfig = {
        root, stateDir: path.join(root, "state"), hubUrl: "wss://hub", boxId: "mac", credential: "x", relayUpstream: "https://hub:8443", relayUpstreamInsecure: false,
        relayPort: 18080, runtimeBinDir: binDir, allowedRoots: [], allowedDomains: ["localhost"], denyRead: [], allowRead: [],
        llamaPorts: [8881], llamaToolProfiles: path.join(root, "tool_profiles.jsonc"),
    };
    fs.mkdirSync(root, { recursive: true });
    const native = prepareProject(config, "carapa-bot", instance, { GROUP_DIR: `@group/${instance}` });
    const hosts = new Map<string, ProjectHost>();
    const audits: AuditEntry[] = [];
    const ctx: RunnerContext = {
        config, projects: new Map([[native.project, native]]),
        credentials: new CredentialStore(path.join(root, "state", "credentials.json")),
        wrap: options.wrap ?? ((_native, file, argv) => [file, ...argv]),
        hosts, save: () => {},
    };
    const tmux = new NativeTmux(ctx, { findTmux: options.findTmux ?? (() => tmuxBin), audit: (entry) => { audits.push(entry); } });
    ctx.tmux = tmux;
    const calls = () => fs.existsSync(path.join(binDir, "calls"))
        ? fs.readFileSync(path.join(binDir, "calls"), "utf8").split("\n").filter(Boolean)
        : [];
    cleanups.push(async () => {
        await tmux.stopAll();
        for (const host of hosts.values()) host.close();
        fs.rmSync(projectTmpRoot(native.project), { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
    });
    return { root, dir: shellDir(config, native.project), native, hosts, audits, tmux, calls };
}

/**
 * Board's side of the hub socket: requests go in as tunnel frames and replies
 * come back as decoded frames, through the same serveHttpTunnel the runner uses.
 */
function tunnel(tmux: NativeTmux) {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const frames: Array<{ type: number; id: number; payload: Uint8Array }> = [];
    const socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send(data: Uint8Array) {
            const frame = decodeFrame(data);
            if (frame) frames.push(frame);
        },
        addEventListener(type: string, listener: (event: { data?: unknown }) => void) { listeners.set(type, listener); },
    };
    // Only the members the tunnel reads of an open socket; the rest of WebSocket is unused.
    serveHttpTunnel(socket as unknown as WebSocket, { baseUrl: "http://native-runner.invalid", token: "", fetchImpl: (input, init) => tmux.handle(new Request(input, init)) });
    const decoder = new TextDecoder();
    const deliver = (frame: Uint8Array) => listeners.get("message")?.({ data: frame });
    const send = (id: number, method: string, requestPath: string, body?: unknown) => {
        const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString("base64");
        deliver(encodeFrame(FRAME.request, id, JSON.stringify({ method, path: requestPath, body: encoded })));
    };
    const head = (id: number): { status: number } | undefined => {
        const frame = frames.find(f => f.id === id && f.type === FRAME.head);
        return frame ? JSON.parse(decoder.decode(frame.payload)) as { status: number } : undefined;
    };
    const text = (id: number) => frames.filter(f => f.id === id && f.type === FRAME.data).map(f => decoder.decode(f.payload)).join("");
    const ended = (id: number) => frames.some(f => f.id === id && f.type === FRAME.end);
    return {
        send,
        cancel: (id: number) => deliver(encodeFrame(FRAME.cancel, id)),
        head,
        text,
        ended,
        /** A finite response: status and body once the tunnel reports its end. */
        async call(id: number, method: string, requestPath: string, body?: unknown) {
            send(id, method, requestPath, body);
            const response = await waitFor(() => head(id), `head ${id}`);
            await waitFor(() => (ended(id) ? true : undefined), `end ${id}`);
            return { status: response.status, body: text(id) };
        },
        close: () => listeners.get("close")?.({}),
    };
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}

const shell = (instance: string) => ({ stack: "carapa-bot", service: "agent", instance, session: "shell" });

describe("native runner tmux tab", () => {
    it("serves attach and exec through the tunnel, streams the pane for the same streamId, and runs every shell command in the shell host only", async () => {
        const variants: string[] = [];
        const sb = sandbox("routing", { wrap: pidWrap(variants) });
        const client = tunnel(sb.tmux);
        // The shell host starts on first shell use.
        expect(sb.hosts.size).toBe(0);
        client.send(1, "POST", "/api/tmux/attach", { ...shell("routing"), cols: 80, rows: 24 });
        expect((await waitFor(() => client.head(1), "attach head")).status).toBe(200);
        const init = JSON.parse(await waitFor(() => /event: init\ndata: (.*)\n/.exec(client.text(1))?.[1], "init frame")) as { streamId: string; scrollback: string };
        expect(init.scrollback).toBe("prompt$ ");

        expect(await client.call(2, "POST", "/api/tmux/exec", { ...shell("routing"), input: "echo hi\n" })).toEqual({ status: 200, body: '{"ok":true}' });
        const deltas = await waitFor(() => {
            const found = [...client.text(1).matchAll(/event: delta\ndata: (.*)\n/g)].map(m => JSON.parse(m[1]) as { streamId: string; delta: string });
            return found.some(d => d.delta.includes("echo hi")) ? found : undefined;
        }, "pane delta");
        expect(deltas.every(d => d.streamId === init.streamId)).toBe(true);

        // The tmux server, its commands and the pane pipe all run under the shell host (never the agent host),
        // with a runner-owned conf, on a socket and FIFO in the shell dir (never under the agent-writable tmp root).
        const dir = sb.dir;
        expect(variants).toEqual(["shell"]);
        expect([...sb.hosts.keys()]).toEqual([hostKey(sb.native.project, true)]);
        expect(fs.existsSync(path.join(sb.native.ipcDir, "host.agent.pid"))).toBe(false);
        const host = fs.readFileSync(path.join(sb.native.ipcDir, "host.shell.pid"), "utf8").trim();
        const calls = sb.calls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call.startsWith(`${host} -f ${dir}/tmux.conf -S ${dir}/tmux.sock `))).toBe(true);
        const pipe = calls.find(call => call.includes(" pipe-pane -t =shell: cat > "));
        expect(pipe?.split("cat > ")[1]).toStartWith(`'${dir}/`);
        expect(pipe).not.toContain(projectTmpRoot(sb.native.project));
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        // The pane shell is no login shell and reads only runner-owned startup files.
        const created = calls.find(call => call.includes(" new-session "));
        expect(created).toEndWith(` /usr/bin/env -u BASH_ENV -u ENV TERM=screen-256color INPUTRC=${dir}/inputrc /bin/bash --noprofile --rcfile ${dir}/bashrc -i`);
        expect(created).not.toContain(" -l");
        expect(created).toContain(`-c ${sb.native.repoDir}`);
        for (const file of ["tmux.conf", "bashrc", "inputrc"]) expect(fs.statSync(path.join(dir, file)).isFile()).toBe(true);
        // HISTFILE would default to $HOME/.bash_history (the agent home): history is kept in the shell dir instead.
        const rcLines = fs.readFileSync(path.join(dir, "bashrc"), "utf8").split("\n");
        expect(rcLines.filter(line => /^(export )?HISTFILE=/.test(line))).toEqual([`export HISTFILE='${dir}/bash_history'`]);
        // Exported, so nested shells and REPLs started from the pane do not write history into the agent home either.
        expect(rcLines).toContain(`export PYTHON_HISTORY='${dir}/python_history'`);
        expect(rcLines).toContain(`export PSQL_HISTORY='${dir}/psql_history'`);
        expect(rcLines).toContain("export LESSHISTFILE=-");
        for (const line of rcLines.filter(l => l.startsWith("export "))) expect(line).not.toContain(sb.native.agentHome);
        expect(sb.audits.filter(e => e.tool === "sandbox_tmux_attach" && e.allowed).map(e => e.projectName)).toEqual([sb.native.project]);

        expect(await client.call(3, "DELETE", "/api/tmux/detach", { ...shell("routing"), streamId: init.streamId })).toMatchObject({ status: 200 });
        expect(sb.calls().some(call => call.endsWith("kill-session -t =shell"))).toBe(true);
        client.close();
    }, 60_000);

    it("cancels the pane reader when the client leaves: the reader is killed through the host, the pipe stops and the FIFO is removed", async () => {
        const sb = sandbox("cancel");
        // The reader's host is observed directly: its `cat` must end by the host's kill (exit 137), not by EOF.
        const host = new ProjectHost((argv) => argv, sb.native.repoDir);
        sb.hosts.set(hostKey(sb.native.project, true), host);
        const run = host.run.bind(host);
        let reader: HostResult | undefined;
        host.run = (file, argv, options) => {
            const result = run(file, argv, options);
            if (file === "/bin/cat") void result.then((settled) => { reader = settled; });
            return result;
        };
        const fifos = () => fs.readdirSync(sb.dir).filter(name => name.endsWith(".fifo"));
        const client = tunnel(sb.tmux);
        client.send(1, "POST", "/api/tmux/attach", shell("cancel"));
        await waitFor(() => (/event: init/.test(client.text(1)) ? true : undefined), "init");
        expect(fifos()).toHaveLength(1);

        client.cancel(1);
        expect((await waitFor(() => reader, "reader settled")).code).toBe(137);
        await waitFor(() => (fifos().length === 0 ? true : undefined), "FIFO removed");
        expect(sb.calls().some(call => call.endsWith("pipe-pane -t =shell:"))).toBe(true);
        client.close();
    }, 60_000);

    it("ends the shell's pane reader, its FIFO and its tmux server when the project stops", async () => {
        const sb = sandbox("stopping");
        const client = tunnel(sb.tmux);
        client.send(1, "POST", "/api/tmux/attach", shell("stopping"));
        await waitFor(() => (/event: init/.test(client.text(1)) ? true : undefined), "init");

        await sb.tmux.stopProject(sb.native.project);
        await waitFor(() => (client.ended(1) ? true : undefined), "attach stream end");
        expect(fs.readdirSync(sb.dir).some(name => name.endsWith(".fifo"))).toBe(false);
        expect(sb.calls().some(call => call.endsWith("kill-server"))).toBe(true);
        client.close();
    }, 60_000);

    it("starts the pane shell without an intermediate shell that reads the agent home's startup files", async () => {
        // Real tmux. A SHELL that sources $HOME/.zshenv before running, as zsh -c does: the agent plants that file.
        const realTmux = findTmux();
        expect(realTmux).toBeDefined();
        const sb = sandbox("zshenv", { findTmux: () => realTmux });
        const fakeZsh = path.join(sb.root, "bin", "fake-zsh");
        fs.writeFileSync(fakeZsh, '#!/bin/sh\n[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\nexec /bin/sh "$@"\n', { mode: 0o755 });
        const marker = path.join(sb.root, "zshenv-ran");
        fs.writeFileSync(path.join(sb.native.agentHome, ".zshenv"), `touch ${marker}\n`);
        const savedShell = process.env.SHELL;
        process.env.SHELL = fakeZsh;
        const client = tunnel(sb.tmux);
        try {
            client.send(1, "POST", "/api/tmux/attach", { ...shell("zshenv"), cols: 80, rows: 24 });
            await waitFor(() => (/event: init/.test(client.text(1)) ? true : undefined), "init", 30_000);
            expect(await client.call(2, "POST", "/api/tmux/exec", { ...shell("zshenv"), input: "echo pane-$((6*7))\n" })).toEqual({ status: 200, body: '{"ok":true}' });
            // The pane runs and its output reaches the reader.
            await waitFor(() => (client.text(1).includes("pane-42") ? true : undefined), "pane output", 30_000);
            expect(fs.existsSync(marker)).toBe(false);
        } finally {
            if (savedShell === undefined) delete process.env.SHELL;
            else process.env.SHELL = savedShell;
            client.close();
        }
    }, 60_000);

    it("closes the shell host on runner shutdown, after its tmux server is killed", async () => {
        const sb = sandbox("shutdown");
        const client = tunnel(sb.tmux);
        client.send(1, "POST", "/api/tmux/attach", shell("shutdown"));
        await waitFor(() => (/event: init/.test(client.text(1)) ? true : undefined), "init");
        expect(sb.hosts.has(hostKey(sb.native.project, true))).toBe(true);

        await sb.tmux.stopAll();
        expect(sb.calls().some(call => call.endsWith("kill-server"))).toBe(true);
        expect(sb.hosts.size).toBe(0);
        client.close();
    }, 60_000);

    it("refuses to attach, with a clear error and no fallback to /tmp, when the socket path exceeds the macOS limit", async () => {
        const sb = sandbox("longpath", { rootPadding: 90 });
        const client = tunnel(sb.tmux);
        client.send(1, "POST", "/api/tmux/attach", shell("longpath"));
        await waitFor(() => (client.ended(1) ? true : undefined), "attach end");
        expect(client.text(1)).toMatch(/event: error\ndata: .*tmux socket path is \d+ bytes, over the macOS limit of 103/);
        expect(client.text(1)).not.toContain("event: init");
        expect(sb.calls()).toEqual([]);
        expect(sb.hosts.size).toBe(0);
        expect(sb.audits.some(e => e.reason?.includes("over the macOS limit"))).toBe(true);
        client.close();
    });

    it("refuses unknown, stopped and invalid targets", async () => {
        const sb = sandbox("refuse");
        const client = tunnel(sb.tmux);
        expect(await client.call(1, "POST", "/api/tmux/attach", { ...shell("nope") })).toMatchObject({ status: 404 });
        expect(await client.call(2, "POST", "/api/tmux/attach", { ...shell("refuse"), session: "../etc" })).toMatchObject({ status: 400 });
        sb.native.running = false;
        expect(await client.call(3, "POST", "/api/tmux/attach", shell("refuse"))).toMatchObject({ status: 409 });
        expect(sb.calls()).toEqual([]);
        client.close();
    });

    it("answers attach with a clear error, before any stream, when tmux is not installed", async () => {
        const sb = sandbox("notmux", { findTmux: () => undefined });
        const client = tunnel(sb.tmux);
        const response = await client.call(1, "POST", "/api/tmux/attach", shell("notmux"));
        expect(response.status).toBe(500);
        expect(response.body).toContain("brew install tmux");
        expect(sb.calls()).toEqual([]);
        client.close();
    });
});
