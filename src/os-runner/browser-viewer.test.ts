import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * The real browser-viewer against the real pinned Playwright dashboard (`playwright-cli show`), in a process
 * that is denied TCP the way the Mac agent sandbox denies it (no local binding, no connect except Unix sockets).
 * No browser is started: the dashboard only has to come up and accept the viewer's websocket.
 */
const root = path.resolve(import.meta.dir, "..", "..");
const bin = path.join(root, "stacks", "carapa-bot", "bin");
const viewer = path.join(bin, "browser-viewer");
const cli = path.join(root, "node_modules", "@playwright", "cli", "playwright-cli.js");
const node = Bun.which("node");
const available = Boolean(node && fs.existsSync(cli));
const socketModule = createRequire(import.meta.url)(path.join(bin, "browser-viewer-socket.cjs")) as {
    patchDashboardSocket(source: string, env?: Record<string, string>): string;
};

/** Preloaded into every node process of the scenario: only Unix sockets may listen or connect. */
const DENY_TCP = `'use strict';
const net = require('node:net');
const unixOnly = (arg) => typeof arg === 'string' ? !/^\\d+$/.test(arg) : Boolean(arg && typeof arg === 'object' && arg.path);
const deny = () => Object.assign(new Error('TCP is denied in this sandbox (EPERM)'), { code: 'EPERM' });
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) { if (!unixOnly(args[0])) throw deny(); return listen.apply(this, args); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { if (!unixOnly(Array.isArray(args[0]) ? args[0][0] : args[0])) throw deny(); return connect.apply(this, args); };
`;

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Starts the viewer for a browser descriptor under native roots; resolves with its events up to ready/error/ended. */
async function attach(options: { denyTcp: boolean; transport?: "unix" }): Promise<string[]> {
    // Short paths: a Unix socket path holds about 100 bytes.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bv-"));
    dirs.push(base);
    const id = `browser-${"a".repeat(40)}`;
    const ipc = path.join(base, "ipc");
    fs.mkdirSync(path.join(ipc, "browser-sessions"), { recursive: true });
    fs.mkdirSync(path.join(base, "ws", "app"), { recursive: true });
    fs.mkdirSync(path.join(base, "tmp"));
    fs.writeFileSync(path.join(ipc, "browser-sessions", `${id}.json`), JSON.stringify({
        id, workDir: "/workspace/app",
        env: { CARAPA_BROWSER_SESSION_ID: id, PLAYWRIGHT_CLI_SESSION: id, PLAYWRIGHT_DAEMON_SESSION_DIR: `/tmp/pwcli-${id}` },
    }));
    const deny = path.join(base, "deny-tcp.cjs");
    fs.writeFileSync(deny, DENY_TCP);
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "", HOME: base,
        CARAPA_IPC_ROOT: ipc, CARAPA_WORKSPACE_ROOT: path.join(base, "ws"), CARAPA_TMP_ROOT: path.join(base, "tmp"),
        CARAPA_HARNESS_SNAPSHOT: "test", CARAPA_PLAYWRIGHT_REAL: cli,
        ...(options.denyTcp ? { NODE_OPTIONS: `--require=${deny}` } : {}),
        ...(options.transport ? { CARAPA_BROWSER_VIEWER_TRANSPORT: options.transport } : {}),
    };
    const child = spawn(node!, [viewer, id], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    child.stderr.resume();
    const events: string[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    const finished = new Promise<void>((resolve) => {
        const check = () => { if (events.some(line => /"type":"(ready|error|ended)"/.test(line))) resolve(); };
        child.stdout.on("data", (chunk: string) => {
            buffer += chunk;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) !== -1) { events.push(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
            check();
        });
        child.on("exit", resolve);
    });
    await Promise.race([finished, Bun.sleep(30_000)]);
    child.stdin.end();
    return events;
}

describe.skipIf(!available)("browser-viewer dashboard transport", () => {
    it("starts and connects over a Unix socket when TCP is denied, as in the Mac agent sandbox", async () => {
        const events = await attach({ denyTcp: true, transport: "unix" });
        expect(events.some(line => line.includes('"type":"ready"'))).toBe(true);
        expect(events.some(line => line.includes('"type":"error"'))).toBe(false);
    }, 40_000);

    it("cannot start its loopback TCP dashboard when TCP is denied (the failure the Unix socket avoids)", async () => {
        const events = await attach({ denyTcp: true });
        expect(events.some(line => line.includes('"type":"ready"'))).toBe(false);
    }, 40_000);

    it("keeps the loopback TCP dashboard by default where TCP is allowed (Linux)", async () => {
        const events = await attach({ denyTcp: false });
        expect(events.some(line => line.includes('"type":"ready"'))).toBe(true);
    }, 40_000);
});

describe("dashboard socket patch", () => {
    const listenCall = "await httpServer.start({ port: options.port, host: options.host });";
    it("leaves the bundle alone without a socket, rewrites its single listen call with one, and refuses a bundle it does not know", () => {
        const source = `before\n  ${listenCall}\nafter`;
        expect(socketModule.patchDashboardSocket(source, {})).toBe(source);
        const patched = socketModule.patchDashboardSocket(source, { CARAPA_BROWSER_VIEWER_SOCKET: "/tmp/x.sock" });
        expect(patched).toContain("port: process.env.CARAPA_BROWSER_VIEWER_SOCKET");
        expect(patched).not.toContain("options.port");
        expect(() => socketModule.patchDashboardSocket("nothing here", { CARAPA_BROWSER_VIEWER_SOCKET: "/tmp/x.sock" })).toThrow("Unsupported Playwright dashboard server");
        expect(() => socketModule.patchDashboardSocket(source + source, { CARAPA_BROWSER_VIEWER_SOCKET: "/tmp/x.sock" })).toThrow("Unsupported Playwright dashboard server");
    });
});
