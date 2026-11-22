import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEntry } from "../audit.js";
import type { RunnerConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { NativeBrowser } from "./browser.js";
import { prepareProject, projectTmpRoot, type NativeProject } from "./projects.js";
import { ProjectHost, type HostStdin } from "./sandbox-host.js";
import { closeHost, type RunnerContext } from "./tools.js";

/**
 * A stand-in browser-viewer: it records its pid and arguments in the project's tmp root, announces itself,
 * echoes every stdin line back (so a frame proves the line reached the helper's stdin) and records EOF in
 * viewer.eof. A session named stuck* ignores stdin altogether, like a helper that fails to stop on EOF.
 */
const FAKE_VIEWER = `#!/bin/sh
echo $$ > "$CARAPA_TMP_ROOT/viewer.pid"
echo "$@" >> "$CARAPA_TMP_ROOT/viewer.args"
echo "$CARAPA_BROWSER_VIEWER_TRANSPORT" > "$CARAPA_TMP_ROOT/viewer.transport"
echo '{"type":"ready"}'
case "$1" in stuck*) exec sleep 60 ;; esac
while read -r line; do echo "$line"; done
echo eof > "$CARAPA_TMP_ROOT/viewer.eof"
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sandbox(instance: string, killAfterMs = 150) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-browser-"));
    const binDir = path.join(base, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "browser-viewer"), FAKE_VIEWER, { mode: 0o755 });
    const config: RunnerConfig = {
        root: base, stateDir: path.join(base, "state"), hubUrl: "wss://hub", boxId: "mac", credential: "x", relayUpstream: "https://hub:8443", relayUpstreamInsecure: false,
        relayPort: 18080, runtimeBinDir: binDir, allowedRoots: [], allowedDomains: ["localhost"], denyRead: [], allowRead: [],
        llamaPorts: [8881], llamaToolProfiles: path.join(base, "tool_profiles.jsonc"),
    };
    const native = prepareProject(config, "carapa-bot", instance, { GROUP_DIR: `@group/${instance}` });
    const hosts = new Map<string, ProjectHost>();
    const audits: AuditEntry[] = [];
    /** The profile of each sandbox host the runner started. */
    const wrapped: Array<{ shell: boolean }> = [];
    const ctx: RunnerContext = {
        config, projects: new Map<string, NativeProject>([[native.project, native]]),
        credentials: new CredentialStore(path.join(base, "state", "credentials.json")),
        wrap: (_native, file, argv, _env, options) => { wrapped.push({ shell: options?.shell === true }); return [file, ...argv]; },
        hosts, save: () => {},
    };
    const browser = new NativeBrowser(ctx, { audit: (entry) => { audits.push(entry); }, killAfterMs });
    ctx.browser = browser;
    const tmp = projectTmpRoot(native.project);
    cleanups.push(async () => {
        await browser.stopAll();
        for (const project of ctx.projects.keys()) { closeHost(ctx, project, false); closeHost(ctx, project, true); }
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
    });
    const call = (method: string, requestPath: string, body?: unknown) => browser.handle(new Request(`http://native-runner.invalid${requestPath}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const attach = (body: Record<string, unknown>) => call("POST", "/api/browser/attach", { stack: "carapa-bot", service: "agent", instance, sessionId: "abc123", ...body });
    return { native, ctx, audits, wrapped, browser, tmp, call, attach, hosts };
}

/** Collects the NDJSON lines of a streaming response; `ended` settles when the stream closes. */
function readLines(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const lines: string[] = [];
    let buffer = "";
    const ended = (async () => {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) !== -1) { lines.push(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        }
    })();
    const until = async (predicate: () => boolean, what: string) => {
        const deadline = Date.now() + 15_000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${lines.join(" | ")}`);
            await Bun.sleep(10);
        }
    };
    return { lines, ended, until };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("native runner browser viewer", () => {
    it("serves attach, input and DELETE without a token: the helper runs in the agent host only, input reaches its stdin, DELETE sends EOF", async () => {
        const sb = sandbox("viewer");
        const response = await sb.attach({});
        expect(response.status).toBe(200);
        const stream = readLines(response);
        await stream.until(() => stream.lines.length >= 2, "attached and ready");
        const attached = JSON.parse(stream.lines[0]);
        expect(attached.type).toBe("attached");
        expect(stream.lines[1]).toBe('{"type":"ready"}');
        // The helper ran through the agent host (the only host started, never the shell one) with the session id as its only argument.
        expect(sb.wrapped.map(w => w.shell)).toEqual([false]);
        expect(fs.readFileSync(path.join(sb.tmp, "viewer.args"), "utf8")).toBe("abc123\n");
        // The agent sandbox denies loopback TCP: the helper must be told to keep its dashboard on a Unix socket.
        expect(fs.readFileSync(path.join(sb.tmp, "viewer.transport"), "utf8")).toBe("unix\n");
        expect(sb.audits).toMatchObject([{ tool: "sandbox_browser_attach", projectName: sb.native.project, allowed: true, command: "browser-viewer abc123" }]);

        const input = await sb.call("POST", `/api/browser/${attached.viewerId}/input`, ['{"type":"mousedown","x":1}', '{"type":"keydown","key":"a"}']);
        expect(input.status).toBe(200);
        await stream.until(() => stream.lines.length >= 4, "echoed input");
        expect(stream.lines.slice(2, 4)).toEqual(['{"type":"mousedown","x":1}', '{"type":"keydown","key":"a"}']);

        expect((await sb.call("DELETE", `/api/browser/${attached.viewerId}`)).status).toBe(200);
        await stream.ended;
        await stream.until(() => fs.existsSync(path.join(sb.tmp, "viewer.eof")), "helper saw EOF");
    });

    it("kills a helper that ignores EOF once the grace period passed", async () => {
        const sb = sandbox("stuck");
        const stream = readLines(await sb.attach({ sessionId: "stuck1" }));
        await stream.until(() => stream.lines.length >= 2, "ready");
        const pid = Number(fs.readFileSync(path.join(sb.tmp, "viewer.pid"), "utf8"));
        expect(alive(pid)).toBe(true);
        await sb.call("DELETE", `/api/browser/${JSON.parse(stream.lines[0]).viewerId}`);
        await stream.ended;
        await stream.until(() => !alive(pid), "helper killed");
    });

    it("closes a project's viewers when the project stops", async () => {
        const sb = sandbox("stopping");
        const stream = readLines(await sb.attach({ sessionId: "stuck2" }));
        await stream.until(() => stream.lines.length >= 2, "ready");
        const pid = Number(fs.readFileSync(path.join(sb.tmp, "viewer.pid"), "utf8"));
        await sb.browser.stopProject(sb.native.project);
        await stream.ended;
        expect(alive(pid)).toBe(false);
    });

    it("takes no new viewer while the project's viewers are closing, so none outlives the stop", async () => {
        const sb = sandbox("racing", 400);
        const first = readLines(await sb.attach({ sessionId: "stuck3" }));
        await first.until(() => first.lines.length >= 2, "ready");
        const pid = Number(fs.readFileSync(path.join(sb.tmp, "viewer.pid"), "utf8"));
        // The first helper ignores EOF, so teardown spends the kill grace period; an attach lands inside it.
        const stopping = sb.browser.stopProject(sb.native.project);
        const second = await sb.attach({ sessionId: "stuck4" });
        expect(second.status).toBe(409);
        expect(await second.json()).toEqual({ error: `Sandbox ${sb.native.project} is stopping` });
        await stopping;
        expect(alive(pid)).toBe(false);
        expect(fs.readFileSync(path.join(sb.tmp, "viewer.args"), "utf8")).toBe("stuck3\n");
    });

    it("closes the viewer when input piles up faster than the helper reads it", async () => {
        const sb = sandbox("stalled");
        // A helper that never reads its stdin: the pipe fills, then unacknowledged input counts against the 64 KiB cap.
        const stream = readLines(await sb.attach({ sessionId: "stuck5" }));
        await stream.until(() => stream.lines.length >= 2, "ready");
        const viewerId = JSON.parse(stream.lines[0]).viewerId;
        const line = JSON.stringify({ type: "keydown", pad: "x".repeat(20_000) });
        let refused = 0;
        for (let batch = 0; batch < 100 && !refused; batch++) {
            const response = await sb.call("POST", `/api/browser/${viewerId}/input`, [line, line]);
            if (response.status !== 200) refused = response.status;
            await Bun.sleep(5);
        }
        expect(refused).toBe(400);
        await stream.ended;
    });

    it("reports a failed sandbox start to the viewer and cleans it up instead of crashing the runner", async () => {
        const sb = sandbox("ensurefail");
        sb.ctx.backend = { provision: async () => {}, ensure: async () => { throw new Error("openshell get failed"); }, stop: async () => {} };
        const stream = readLines(await sb.attach({}));
        await stream.ended;
        expect(stream.lines.map(line => JSON.parse(line).type)).toEqual(["attached", "error"]);
        expect(JSON.parse(stream.lines[1]).message).toContain("openshell get failed");
        // The failed viewer is forgotten, and waiting for it never rejects.
        await sb.browser.stopProject(sb.native.project);
        expect(sb.hosts.size).toBe(0);
    });

    it("refuses unknown (404), stopped (409) and invalid (400) targets without starting a host, and audits the denials", async () => {
        const sb = sandbox("refuse");
        expect((await sb.attach({ instance: "nope" })).status).toBe(404);
        expect((await sb.attach({ sessionId: "../etc" })).status).toBe(400);
        expect((await sb.attach({ stack: "bad stack" })).status).toBe(400);
        sb.native.running = false;
        const stopped = await sb.attach({});
        expect(stopped.status).toBe(409);
        expect(await stopped.json()).toEqual({ error: `Sandbox ${sb.native.project} is stopped` });
        expect(sb.hosts.size).toBe(0);
        expect(sb.wrapped).toEqual([]);
        expect(sb.audits.map(a => [a.allowed, a.tool])).toEqual([[false, "sandbox_browser_attach"], [false, "sandbox_browser_attach"]]);
    });
});

describe("sandbox host stdin", () => {
    it("gives stdin only to requests that ask for it; the others have it ignored", async () => {
        const host = new ProjectHost(argv => argv, os.tmpdir());
        cleanups.push(async () => host.close());
        const env = { PATH: process.env.PATH ?? "" };
        // cat ends at once on an ignored stdin; a piped one would keep it waiting.
        expect(await host.run("cat", [], { env, timeoutMs: 5000 })).toEqual({ code: 0, output: "" });
        const result = await host.run("cat", [], {
            env, timeoutMs: 5000,
            onStdin: (stdin) => { stdin.write("one\n"); stdin.write("two\n"); stdin.end(); },
        });
        expect(result).toEqual({ code: 0, output: "one\ntwo\n" });
    });

    it("counts input the command has not read as pending, however much the host has already taken over", async () => {
        const host = new ProjectHost(argv => argv, os.tmpdir());
        cleanups.push(async () => host.close());
        const abort = new AbortController();
        let stdin: HostStdin | undefined;
        // sleep never reads its stdin: once the pipe is full, the host can only queue the data.
        const run = host.run("sleep", ["30"], { env: { PATH: process.env.PATH ?? "" }, signal: abort.signal, onStdin: (pipe) => { stdin = pipe; } });
        const chunk = "x".repeat(1024);
        for (let i = 0; i < 1024; i++) stdin!.write(chunk);
        const total = 1024 * 1024;
        // Let the host drain its input pipe; whatever it could not give to sleep stays pending.
        await Bun.sleep(300);
        expect(stdin!.pending()).toBeGreaterThan(total - 1024 * 1024 / 2);
        abort.abort();
        await run;
    });
});
