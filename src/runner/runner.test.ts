import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RunnerConfig } from "./config.js";
import { CredentialStore, startCredentialLookup } from "./credentials.js";
import { mapBoardEnv, mapContainerPath, loadProjects, prepareProject, projectTmpRoot, resolveMount, restoreProjects, runtimeEnv, saveProjects, shellDir, type NativeProject } from "./projects.js";
import { logger } from "../logger.js";
import { projectPolicy, seatbeltWrapper } from "./os-sandbox.js";
import type { ProjectHost } from "./sandbox-host.js";
import { liveRunDirs, parseExecCommand, registerRunnerTools, splitCommand, trustedExecutable, type SandboxBackend } from "./tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const BIN = path.resolve(import.meta.dir, "..", "..", "stacks", "carapa-bot", "bin");

function config(): RunnerConfig {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-runner-"));
    roots.push(root);
    return {
        root, stateDir: path.join(root, "state"), hubUrl: "wss://hub", boxId: "mac", credential: "x", relayUpstream: "https://hub:8443", relayUpstreamInsecure: false,
        relayPort: 18080, runtimeBinDir: BIN, allowedRoots: [], allowedDomains: ["localhost"], denyRead: [], allowRead: [],
        llamaPorts: [8881], llamaToolProfiles: path.join(root, "tool_profiles.jsonc"),
    };
}

describe("native runner helpers", () => {
    it("parses trusted commands without a shell", () => {
        expect(splitCommand("stop-agent.sh /workspace/ipc/runs/r1 42")).toEqual(["stop-agent.sh", "/workspace/ipc/runs/r1", "42"]);
        expect(splitCommand("record-end.sh '/tmp/pw a' b")).toEqual(["record-end.sh", "/tmp/pw a", "b"]);
        for (const bad of ["a; rm -rf /", "a | b", "a $(x)", "a `x`", "a > f"]) expect(() => splitCommand(bad)).toThrow();
        expect(parseExecCommand("run-agent.sh /workspace/ipc/runs/r && : > /workspace/ipc/runs/r/.restart-recovery-dispatched"))
            .toEqual({ argv: ["run-agent.sh", "/workspace/ipc/runs/r"], receipt: "/workspace/ipc/runs/r/.restart-recovery-dispatched" });
    });

    it("only runs executables from the runtime bin dir", () => {
        const c = config();
        expect(trustedExecutable(c, "run-agent.sh")).toBe(path.join(BIN, "run-agent.sh"));
        expect(trustedExecutable(c, "/usr/local/bin/stop-agent.sh")).toBe(path.join(BIN, "stop-agent.sh"));
        expect(() => trustedExecutable(c, "/etc/passwd")).toThrow();
        expect(() => trustedExecutable(c, "no-such-tool.sh")).toThrow();
    });

    it("resolves mounts under the runner root or allowed roots only", () => {
        const c = config();
        expect(resolveMount("@group/proj", c)).toBe(path.join(c.root, "groups", "proj"));
        expect(resolveMount("@repo/app", c)).toBe(path.join(c.root, "repos", "app"));
        expect(() => resolveMount("/etc", c)).toThrow("outside");
        expect(() => resolveMount("@group/../x", c)).toThrow();
        expect(resolveMount("/srv/code/app", { ...c, allowedRoots: ["/srv/code"] })).toBe("/srv/code/app");
    });

    it("refuses absolute mounts on the runner root's private dirs, including through symlinks", () => {
        const c = config();
        const root = fs.realpathSync(c.root);
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-allowed-"));
        roots.push(outside);
        fs.mkdirSync(path.join(root, "state"), { recursive: true });
        fs.symlinkSync(path.join(root, "state"), path.join(outside, "link"));
        const allowed = { ...c, allowedRoots: [outside] };
        for (const bad of [root, "state", "home/x", "ipc/x", "workspaces/x", "groups", "repos"]) {
            expect(() => resolveMount(bad === root ? root : path.join(root, bad), allowed)).toThrow(/runner root|groups\/<name>/);
        }
        expect(() => resolveMount(path.join(outside, "link"), allowed)).toThrow("runner root");
        expect(() => resolveMount(path.join(outside, "link", "sub"), allowed)).toThrow("runner root");
        expect(resolveMount(path.join(root, "groups", "a"), allowed)).toBe(path.join(root, "groups", "a"));
        expect(resolveMount(path.join(root, "repos", "r", "sub"), allowed)).toBe(path.join(root, "repos", "r", "sub"));
        expect(resolveMount(path.join(outside, "app"), allowed)).toBe(path.join(fs.realpathSync(outside), "app"));
    });

    it("maps the container layout and prepares the agent home", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app", WORKSPACE_PATH: "/workspace/app" });
        expect(mapContainerPath("/workspace/ipc/runs/r1", native)).toBe(path.join(native.ipcDir, "runs", "r1"));
        expect(mapContainerPath("/workspace/group/AGENTS.md", native)).toBe(path.join(native.groupDir, "AGENTS.md"));
        expect(fs.realpathSync(mapContainerPath("/workspace/app", native))).toBe(fs.realpathSync(native.repoDir));
        // Claude Code's own sandbox cannot nest inside the project's Seatbelt profile.
        const settings = JSON.parse(fs.readFileSync(path.join(native.agentHome, ".claude", "settings.json"), "utf8"));
        expect(settings.sandbox.enabled).toBe(false);
        // The project's relay address carries a per-start secret only its sandbox receives.
        expect(native.relayCapability).toMatch(/^[a-f0-9]{64}$/);
        const relay = `http://127.0.0.1:18080/s/carapa-bot-proj/${native.relayCapability}`;
        expect(prepareProject(c, "carapa-bot", "proj", {}).relayCapability).not.toBe(native.relayCapability);
        const user = JSON.parse(fs.readFileSync(path.join(native.agentHome, ".claude.json"), "utf8"));
        expect(user.mcpServers["carapa-board"].url.startsWith("http://127.0.0.1:18080/s/carapa-bot-proj/")).toBe(true);
        // Board's per-command environment (web_view's browser session) is written for a container.
        const tmp = projectTmpRoot("carapa-bot-proj");
        expect(mapBoardEnv({
            PLAYWRIGHT_MCP_CDP_ENDPOINT: "ws://api-relay:8080/board-api/api/web-browser/sessions/s/cdp",
            PLAYWRIGHT_DAEMON_SOCKETS_DIR: "/tmp/pwcli-s/sockets",
            CARAPA_RECORD_DIR: "/workspace/ipc/recordings/r",
        }, native, c)).toEqual({
            PLAYWRIGHT_MCP_CDP_ENDPOINT: `${relay.replace(/^http/, "ws")}/board-api/api/web-browser/sessions/s/cdp`,
            PLAYWRIGHT_DAEMON_SOCKETS_DIR: `${tmp}/pwcli-s/sockets`,
            CARAPA_RECORD_DIR: path.join(native.ipcDir, "recordings", "r"),
        });
        expect(fs.statSync(tmp).isDirectory()).toBe(true);
    });

    it("confines project processes to a deny-by-default Seatbelt profile", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app" });
        const deniedBin = path.join(os.homedir(), ".not-a-toolchain", "bin");
        const [shell, flag, wrapped] = seatbeltWrapper(c)(native, "/bin/echo", ["it's"], { PATH: `${deniedBin}:/usr/bin` });
        expect([shell, flag]).toEqual(["/bin/sh", "-c"]);
        expect(wrapped).toContain("/usr/bin/sandbox-exec");
        expect(wrapped).toContain("(deny default");
        // Network: only the runner's relay forwarder.
        expect(wrapped).toContain('(remote ip "localhost:18080")');
        expect(wrapped).not.toContain('localhost:*');
        // Reads: home denied, this project's directories (not the runner state) re-allowed.
        const home = fs.realpathSync(os.homedir());
        expect(wrapped).toContain(`(subpath "${home}")`);
        expect(wrapped).toContain(fs.realpathSync(native.repoDir));
        expect(wrapped).not.toContain(path.join(fs.realpathSync(c.root), "state"));
        // Unix sockets only in the project's own temporary root, never all of /tmp.
        expect(wrapped).toContain(`(remote unix-socket (subpath "${fs.realpathSync(projectTmpRoot(native.project))}"))`);
        expect(wrapped).not.toMatch(/unix-socket \(subpath "(\/private)?\/tmp"\)/);
        // Writes: repository hooks and config stay protected.
        expect(wrapped).toContain(path.join(fs.realpathSync(native.repoDir), ".git", "hooks"));
        // Nested .git and Claude Code settings anywhere below the repo become regex rules.
        const repo = fs.realpathSync(native.repoDir);
        expect(wrapped).toContain(`(regex "^${repo}/[^/]*/(.*/)?\\\\.git(/.*)?$")`);
        expect(wrapped).toContain(`(regex "^${repo}/(.*/)?\\\\.claude/settings\\\\.json(/.*)?$")`);
        // Program lookup must not stop at a directory the profile denies.
        expect(wrapped).toContain("PATH=/usr/bin");
        expect(wrapped).not.toContain(deniedBin);
    });

    it("gives only the shell profile a pty and the private shell dir", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", { GROUP_DIR: "@group/proj" });
        const env = { PATH: "/usr/bin" };
        const dir = shellDir(c, native.project);
        expect(dir).toMatch(new RegExp(`^${fs.realpathSync(c.root)}/shell/[0-9a-f]{8}$`));

        // The generated profiles: a pty (and every /dev/ttys*) only in the shell variant, the shell dir only there too.
        const agent = seatbeltWrapper(c)(native, "/bin/echo", [], env)[2];
        const shell = seatbeltWrapper(c)(native, "/bin/echo", [], env, { shell: true })[2];
        expect(agent).not.toContain("pseudo-tty");
        expect(agent).not.toContain("/dev/ptmx");
        expect(agent).not.toContain("/dev/ttys");
        expect(agent).not.toContain(dir);
        expect(shell).toContain("(allow pseudo-tty)");
        expect(shell).toContain('(literal "/dev/ptmx")');
        expect(shell).toContain(`(remote unix-socket (subpath "${dir}"))`);

        // Paths: the agent keeps its policy; the shell policy adds the dir to reads, writes and sockets.
        const agentPolicy = projectPolicy(native, c, env);
        const shellPolicy = projectPolicy(native, c, env, { shell: true });
        for (const list of [agentPolicy.allowRead, agentPolicy.allowWrite, agentPolicy.unixSockets]) expect(list).not.toContain(dir);
        for (const list of [shellPolicy.allowRead, shellPolicy.allowWrite, shellPolicy.unixSockets]) expect(list).toContain(dir);
        expect(agentPolicy.allowPty).toBe(false);
        expect(shellPolicy.allowPty).toBe(true);
        // Every other rule is the same.
        const { allowRead, allowWrite, unixSockets, allowPty, ...agentRest } = agentPolicy;
        const { allowRead: shellRead, allowWrite: shellWrite, unixSockets: shellSockets, allowPty: shellPty, ...shellRest } = shellPolicy;
        expect(shellRest).toEqual(agentRest);
        expect(shellRead.filter(p => p !== dir)).toEqual(allowRead);
        expect(shellWrite.filter(p => p !== dir)).toEqual(allowWrite);
        expect(shellSockets.filter(p => p !== dir)).toEqual(unixSockets);
        // The runner root, which holds the dir, stays unreadable for the agent.
        expect(agentPolicy.denyRead).toContain(fs.realpathSync(c.root));
    });

    it("denies writes to implicitly executed repo files, nested and in extra mounts, but not agentHome", () => {
        const c = config();
        const extra = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-extra-"));
        roots.push(extra);
        const native = { ...prepareProject(c, "carapa-bot", "proj", { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app" }), extraMounts: [extra] };
        const { denyWrite } = projectPolicy(native, c, { PATH: "/usr/bin" });
        const rels = [".git/hooks", ".git/config", ".git/config.worktree", ".git/modules", ".gitmodules", ".mcp.json",
            ".claude/settings.json", ".claude/settings.local.json", ".claude/commands", ".claude/agents", ".vscode", ".idea",
            "*/**/.git", ".git/worktrees/*/config.worktree", "**/.gitmodules", "**/.mcp.json", "**/.claude/settings.json",
            "**/.claude/settings.local.json", "**/.claude/commands/**", "**/.claude/agents/**", "**/.vscode/**", "**/.idea/**"];
        for (const dir of [native.repoDir, extra].map(d => fs.realpathSync(d))) {
            for (const rel of rels) expect(denyWrite).toContain(path.join(dir, rel));
        }
        expect(denyWrite.some(d => d.startsWith(fs.realpathSync(native.agentHome)))).toBe(false);
    });

    it("refuses to start when a protected repo path contains glob characters", () => {
        const c = config();
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-glob-"));
        roots.push(base);
        const repo = path.join(base, "re[po]");
        fs.mkdirSync(repo);
        const native = prepareProject(c, "carapa-bot", "proj", { GROUP_DIR: "@group/proj" });
        expect(() => projectPolicy({ ...native, repoDir: repo }, c, { PATH: "/usr/bin" })).toThrow("protected repo path contains glob characters");
    });

    it("denies reads of the runner root and allowed roots except this project's own directories", () => {
        const c = config();
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-allowed-"));
        roots.push(allowedRoot);
        const cfg = { ...c, allowedRoots: [allowedRoot] };
        const native = prepareProject(cfg, "carapa-bot", "proj", { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app" });
        const other = prepareProject(cfg, "carapa-bot", "other", {});
        const policy = projectPolicy(native, cfg, { PATH: "/usr/bin" });
        expect(policy.denyRead).toContain(fs.realpathSync(c.root));
        expect(policy.denyRead).toContain(fs.realpathSync(allowedRoot));
        for (const dir of [native.repoDir, native.groupDir, native.ipcDir, native.agentHome, native.workspaceRoot]) {
            expect(policy.allowRead).toContain(fs.realpathSync(dir));
        }
        expect(policy.allowRead).not.toContain(fs.realpathSync(other.agentHome));
        expect(policy.allowRead).not.toContain(path.join(fs.realpathSync(c.root), "state"));
        expect(policy.allowWrite).toContain(fs.realpathSync(projectTmpRoot(native.project)));
    });

    it("gives each project its own TMPDIR instead of the runner's", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", {});
        const env = runtimeEnv(native, c, { PATH: "/usr/bin", TMPDIR: "/var/shared-runner-tmp" });
        expect(env.TMPDIR).toBe(projectTmpRoot(native.project));
    });

    it("serves stored relay credentials only to the bearer of its lookup key", async () => {
        const c = config();
        const store = new CredentialStore(path.join(c.root, "state", "relay.json"));
        store.set("carapa-bot-proj-agent-1", "board-cred");
        const lookup = await startCredentialLookup(store);
        try {
            const ok = await fetch(`${lookup.url}/api/admin/relay-token/carapa-bot-proj-agent-1`, { headers: { authorization: `Bearer ${lookup.key}` } });
            expect(await ok.json()).toEqual({ token: "board-cred" });
            expect((await fetch(`${lookup.url}/api/admin/relay-token/carapa-bot-proj-agent-1`)).status).toBe(401);
            expect((fs.statSync(path.join(c.root, "state", "relay.json")).mode & 0o777)).toBe(0o600);
        } finally { lookup.close(); }
    });
});

describe("native runner symlink safety", () => {
    it("never follows a planted .claude or .claude.json symlink in the agent home", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", {});
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-outside-"));
        roots.push(outside);
        fs.writeFileSync(path.join(outside, "settings.json"), "SENTINEL");
        fs.writeFileSync(path.join(outside, "user.json"), "SENTINEL");
        fs.rmSync(path.join(native.agentHome, ".claude"), { recursive: true });
        fs.symlinkSync(outside, path.join(native.agentHome, ".claude"));
        fs.rmSync(path.join(native.agentHome, ".claude.json"));
        fs.symlinkSync(path.join(outside, "user.json"), path.join(native.agentHome, ".claude.json"));
        prepareProject(c, "carapa-bot", "proj", {});
        expect(fs.readFileSync(path.join(outside, "settings.json"), "utf8")).toBe("SENTINEL");
        expect(fs.readFileSync(path.join(outside, "user.json"), "utf8")).toBe("SENTINEL");
        const settings = path.join(native.agentHome, ".claude", "settings.json");
        expect(fs.lstatSync(path.join(native.agentHome, ".claude")).isDirectory()).toBe(true);
        expect(fs.lstatSync(settings).isFile()).toBe(true);
        expect(JSON.parse(fs.readFileSync(settings, "utf8")).sandbox.enabled).toBe(false);
        const user = path.join(native.agentHome, ".claude.json");
        expect(fs.lstatSync(user).isFile()).toBe(true);
        expect(JSON.parse(fs.readFileSync(user, "utf8")).mcpServers["carapa-board"]).toBeDefined();
    });

    it("does not block or list runs whose worker.pid is a FIFO or a /dev/zero symlink", () => {
        const c = config();
        const native = prepareProject(c, "carapa-bot", "proj", {});
        const fifoRun = path.join(native.ipcDir, "runs", "fifo");
        const zeroRun = path.join(native.ipcDir, "runs", "zero");
        const okRun = path.join(native.ipcDir, "runs", "ok");
        for (const dir of [fifoRun, zeroRun, okRun]) fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync("/dev/zero", path.join(zeroRun, "worker.pid"));
        fs.writeFileSync(path.join(okRun, "worker.pid"), String(process.pid));
        const mk = Bun.spawnSync(["mkfifo", path.join(fifoRun, "worker.pid")]);
        const live = liveRunDirs(native);
        expect(live).toEqual([okRun]);
        expect(mk.exitCode === 0 || !fs.existsSync(path.join(fifoRun, "worker.pid"))).toBe(true);
    }, 2000);

    it("returns no live runs when runs is missing or replaced by a file", () => {
        const native = prepareProject(config(), "carapa-bot", "proj", {});
        const runs = path.join(native.ipcDir, "runs");
        fs.rmSync(runs, { recursive: true, force: true });
        expect(liveRunDirs(native)).toEqual([]);
        fs.writeFileSync(runs, "not a dir");
        expect(liveRunDirs(native)).toEqual([]);
    });
});

describe("native runner tools", () => {
    it("runs the shared agent runtime natively from Board-style container paths", async () => {
        const c = config();
        const projects = new Map<string, NativeProject>();
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        // Seatbelt exists only on macOS; the runtime contract is exercised unwrapped here.
        const wrap = (_native: NativeProject, file: string, argv: string[]) => [file, ...argv];
        const hosts = new Map<string, ProjectHost>();
        const credentials = new CredentialStore(path.join(c.root, "state", "c.json"));
        registerRunnerTools(server, { config: c, projects, credentials, wrap, hosts, save: () => {} });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
            return { text: result.content[0]?.text ?? "", isError: result.isError === true };
        };
        expect((await call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj", WORKSPACE_PATH: "/workspace", CARAPA_BOARD_API_TOKEN: "board-cred" } })).isError).toBe(false);
        // The relay forwarder needs the sandbox's Board credential for Board MCP calls.
        expect(credentials.get("carapa-bot-proj-agent-1")).toBe("board-cred");
        expect(JSON.parse((await call("sandbox_status", { name: "carapa-bot", instance: "proj" })).text)[0].State).toBe("running");

        // Board pushes inputs through sandbox_ipc_sync with container paths.
        const fakeBin = path.join(c.root, "fake-bin");
        fs.mkdirSync(fakeBin);
        fs.writeFileSync(path.join(fakeBin, "opencode"), `#!${process.execPath}
if (process.argv[2] === 'export') { console.log(JSON.stringify({ messages: [] })); }
else {
  const fs = require('node:fs');
  fs.writeFileSync(process.cwd() + '/cwd-probe', process.cwd());
  console.log(JSON.stringify({ sessionID: 'ses-native', type: 'step_start' }));
  console.log(JSON.stringify({ sessionID: 'ses-native', type: 'text', part: { text: 'native ok' } }));
  console.log(JSON.stringify({ sessionID: 'ses-native', type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 } } }));
}
`);
        fs.chmodSync(path.join(fakeBin, "opencode"), 0o755);
        const args = { agentCmd: "opencode", workDir: "/workspace", groupDir: "/workspace/group", metricsContract: 1,
            env: { PATH: `${fakeBin}:${process.env.PATH}`, CARAPA_RUN_MEMORY_LIMIT_MIB: "0" } };
        const push = [
            { op: "write", path: "args.json", data: Buffer.from(JSON.stringify(args)).toString("base64") },
            { op: "write", path: "prompt.txt", data: Buffer.from("hello from board").toString("base64") },
        ];
        const synced = await call("sandbox_ipc_sync", { project: "carapa-bot-proj", root: "runs/r1", push });
        expect(synced.isError).toBe(false);

        const launched = await call("sandbox_exec", { name: "carapa-bot", instance: "proj", service: "agent", command: "run-agent.sh /workspace/ipc/runs/r1", timeout: 30 });
        expect(launched.isError).toBe(false);
        const runDir = path.join(c.root, "ipc", "carapa-bot-proj", "runs", "r1");
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(path.join(runDir, "metrics_complete")) && Date.now() < deadline) await Bun.sleep(50);
        expect(fs.readFileSync(path.join(runDir, "exit_code"), "utf8")).toBe("0");
        const events = fs.readFileSync(path.join(runDir, "output.v1.jsonl"), "utf8");
        expect(events).toContain("ses-native");
        const repo = path.join(c.root, "groups", "proj");
        expect(fs.readFileSync(path.join(repo, "cwd-probe"), "utf8")).toBe(fs.realpathSync(repo));

        // Every command of a project runs in one sandbox host, like one container.
        const host = hosts.get("carapa-bot-proj");
        expect(host).toBeDefined();
        expect((await call("sandbox_exec", { name: "carapa-bot", instance: "proj", service: "agent", command: "agent-status.sh /workspace/ipc/runs/r1", timeout: 30 })).text).not.toContain("sandbox host exited");
        expect(hosts.get("carapa-bot-proj")).toBe(host);
        expect((await call("sandbox_worktree", {})).isError).toBe(true);
        expect((await call("sandbox_exec", { name: "carapa-bot", instance: "proj", service: "agent", command: "sh -c id" })).isError).toBe(true);
        await call("sandbox_stop", { name: "carapa-bot", instance: "proj" });
        expect(JSON.parse((await call("sandbox_status", { name: "carapa-bot", instance: "proj" })).text)[0].State).toBe("exited");
        expect(hosts.has("carapa-bot-proj")).toBe(false);
        await client.close();
    }, 40_000);

    it("sandbox_logs reads the newest log tail and refuses planted symlinks and FIFOs", async () => {
        const c = config();
        const projects = new Map<string, NativeProject>();
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        registerRunnerTools(server, { config: c, projects, credentials: new CredentialStore(path.join(c.root, "state", "c.json")), wrap: (_n, file, argv) => [file, ...argv], hosts: new Map<string, ProjectHost>(), save: () => {} });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const logs = async () => {
            const result = await client.callTool({ name: "sandbox_logs", arguments: { name: "carapa-bot", instance: "proj", tail: 2 } }) as { content: Array<{ text: string }>; isError?: boolean };
            return { text: result.content[0]?.text ?? "", isError: result.isError === true };
        };
        await client.callTool({ name: "sandbox_start", arguments: { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj" } } });
        const runs = path.join(c.root, "ipc", "carapa-bot-proj", "runs");
        fs.mkdirSync(path.join(runs, "old"), { recursive: true });
        fs.mkdirSync(path.join(runs, "new"), { recursive: true });
        fs.writeFileSync(path.join(runs, "old", "agent-stderr.log"), "stale\n");
        fs.utimesSync(path.join(runs, "old", "agent-stderr.log"), 1, 1);
        fs.writeFileSync(path.join(runs, "new", "agent-stderr.log"), "one\ntwo\nthree\n");
        expect(await logs()).toEqual({ text: "three\n", isError: false });

        // A symlinked log is refused instead of returning the file it points at.
        const secret = path.join(c.root, "secret");
        fs.writeFileSync(secret, "SENTINEL");
        fs.mkdirSync(path.join(runs, "evil"));
        fs.symlinkSync(secret, path.join(runs, "evil", "agent-stderr.log"));
        const linked = await logs();
        expect(linked.isError).toBe(true);
        expect(linked.text).not.toContain("SENTINEL");
        fs.rmSync(path.join(runs, "evil", "agent-stderr.log"));

        // A FIFO fails fast instead of blocking the runner's event loop.
        expect(Bun.spawnSync(["mkfifo", path.join(runs, "evil", "agent-stderr.log")]).exitCode).toBe(0);
        expect((await logs()).isError).toBe(true);
        fs.rmSync(path.join(runs, "evil"), { recursive: true });

        // A symlinked run directory is not followed either.
        const elsewhere = path.join(c.root, "elsewhere");
        fs.mkdirSync(elsewhere);
        fs.writeFileSync(path.join(elsewhere, "agent-stderr.log"), "SENTINEL");
        fs.symlinkSync(elsewhere, path.join(runs, "evil"));
        const dirLinked = await logs();
        expect(dirLinked.isError).toBe(true);
        expect(dirLinked.text).not.toContain("SENTINEL");
        await client.close();
    });

    it("refuses exec receipts that are symlinks or escape the IPC directory", async () => {
        const c = config();
        const projects = new Map<string, NativeProject>();
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        const wrap = (_native: NativeProject, file: string, argv: string[]) => [file, ...argv];
        registerRunnerTools(server, { config: c, projects, credentials: new CredentialStore(path.join(c.root, "state", "c.json")), wrap, hosts: new Map<string, ProjectHost>(), save: () => {} });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
            return { text: result.content[0]?.text ?? "", isError: result.isError === true };
        };
        await call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj" } });
        const runDir = path.join(c.root, "ipc", "carapa-bot-proj", "runs", "r1");
        fs.mkdirSync(runDir, { recursive: true });
        const victim = path.join(c.root, "victim");
        fs.writeFileSync(victim, "SENTINEL");
        fs.symlinkSync(victim, path.join(runDir, ".restart-recovery-dispatched"));
        const exec = (receipt: string) => call("sandbox_exec", { name: "carapa-bot", instance: "proj", service: "agent", command: `agent-status.sh ${process.pid} && : > ${receipt}` });
        const linked = await exec("/workspace/ipc/runs/r1/.restart-recovery-dispatched");
        expect(linked.isError).toBe(true);
        expect(fs.readFileSync(victim, "utf8")).toBe("SENTINEL");
        const escaped = await exec("/workspace/ipc/runs/../../../victim");
        expect(escaped.isError).toBe(true);
        expect(fs.readFileSync(victim, "utf8")).toBe("SENTINEL");
        expect((await exec("/workspace/ipc/runs/r1/ok-receipt")).isError).toBe(false);
        expect(fs.existsSync(path.join(runDir, "ok-receipt"))).toBe(true);
        await client.close();
    }, 20_000);

    async function stopHarness(binDir?: string) {
        const c = config();
        if (binDir) c.runtimeBinDir = binDir;
        const projects = new Map<string, NativeProject>();
        const hosts = new Map<string, ProjectHost>();
        const saved: boolean[][] = [];
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        const wrap = (_native: NativeProject, file: string, argv: string[]) => [file, ...argv];
        registerRunnerTools(server, { config: c, projects, credentials: new CredentialStore(path.join(c.root, "state", "c.json")), wrap, hosts,
            save: () => { saved.push([...projects.values()].map(p => p.running)); } });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
            return { text: result.content[0]?.text ?? "", isError: result.isError === true };
        };
        await call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj" } });
        const native = projects.get("carapa-bot-proj")!;
        const state = async () => JSON.parse((await call("sandbox_status", { name: "carapa-bot", instance: "proj" })).text)[0].State;
        return { c, native, hosts, saved, call, state, client };
    }

    it("a failed sandbox_start refresh keeps the agent home on the running relay capability", async () => {
        const c = config();
        const projects = new Map<string, NativeProject>();
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        const wrap = (_native: NativeProject, file: string, argv: string[]) => [file, ...argv];
        let failProvision = false;
        const backend: SandboxBackend = {
            provision: async () => { if (failProvision) throw new Error("provision boom"); },
            ensure: async () => {},
            stop: async () => {},
        };
        registerRunnerTools(server, { config: c, projects, credentials: new CredentialStore(path.join(c.root, "state", "c.json")), wrap, hosts: new Map<string, ProjectHost>(), save: () => {}, backend });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const start = async () => await client.callTool({ name: "sandbox_start", arguments: { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj" } } }) as { isError?: boolean };
        expect((await start()).isError).toBeFalsy();
        const native = projects.get("carapa-bot-proj")!;
        failProvision = true;
        expect((await start()).isError).toBe(true);
        // The relay accepts only the registered capability; new sessions read the agent home.
        const user = JSON.parse(fs.readFileSync(path.join(native.agentHome, ".claude.json"), "utf8"));
        expect(user.mcpServers["carapa-board"].url.startsWith(`http://127.0.0.1:18080/s/carapa-bot-proj/${native.relayCapability}/`)).toBe(true);
        expect(projects.get("carapa-bot-proj")).toBe(native);
        await client.close();
    });

    it("sandbox_start closes the sandbox hosts when the repo changes, and keeps them otherwise", async () => {
        const h = await stopHarness();
        const closed: string[] = [];
        const fakeHosts = () => {
            for (const key of ["carapa-bot-proj", "carapa-bot-proj#shell"]) h.hosts.set(key, { close: () => { closed.push(key); } } as unknown as ProjectHost);
        };
        fakeHosts();
        // Same repo and mounts: the hosts keep serving.
        expect((await h.call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj" } })).isError).toBe(false);
        expect(closed).toEqual([]);
        expect(h.hosts.size).toBe(2);
        // A different repo: both hosts close, so the next command starts one in the new repo.
        expect((await h.call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app" } })).isError).toBe(false);
        expect(closed.sort()).toEqual(["carapa-bot-proj", "carapa-bot-proj#shell"]);
        expect(h.hosts.size).toBe(0);
        // Different extra mounts close them too.
        fakeHosts();
        closed.length = 0;
        const extra = path.join(h.c.root, "groups", "extra");
        await h.call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app", EXTRA_MOUNT_1: extra, EXTRA_MOUNT_1_NAME: "extra" } });
        expect(closed.sort()).toEqual(["carapa-bot-proj", "carapa-bot-proj#shell"]);
        // A new /workspace view alone (same repo and mounts) closes them: the Seatbelt policy was fixed at spawn.
        fakeHosts();
        closed.length = 0;
        const mounted = { GROUP_DIR: "@group/proj", LOCAL_REPO: "@repo/app", EXTRA_MOUNT_1: extra, EXTRA_MOUNT_1_NAME: "extra" };
        await h.call("sandbox_start", { name: "carapa-bot", instance: "proj", env: { ...mounted, WORKSPACE_PATH: "/workspace/app" } });
        expect(closed.sort()).toEqual(["carapa-bot-proj", "carapa-bot-proj#shell"]);
        await h.client.close();
    });

    for (const kind of ["missing", "file"] as const) {
        it(`sandbox_stop still cleans up when runs is ${kind}`, async () => {
            const h = await stopHarness();
            const runs = path.join(h.native.ipcDir, "runs");
            fs.rmSync(runs, { recursive: true, force: true });
            if (kind === "file") fs.writeFileSync(runs, "x");
            const closed: string[] = [];
            // only close() is read by sandbox_stop with no live runs; the shell tab's host is the second one
            for (const key of ["carapa-bot-proj", "carapa-bot-proj#shell"]) h.hosts.set(key, { close: () => { closed.push(key); } } as unknown as ProjectHost);
            const stopped = await h.call("sandbox_stop", { name: "carapa-bot", instance: "proj" });
            expect(stopped.isError).toBe(false);
            expect(stopped.text).toContain("Stopped carapa-bot-proj");
            expect(await h.state()).toBe("exited");
            expect(closed.sort()).toEqual(["carapa-bot-proj", "carapa-bot-proj#shell"]);
            expect(h.hosts.size).toBe(0);
            expect(h.native.running).toBe(false);
            expect(h.saved.at(-1)).toEqual([false]);
            await h.client.close();
        });
    }

    it("sandbox_stop reports a failing stop-agent but still stops other runs and cleans up", async () => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-bin-"));
        roots.push(bin);
        fs.cpSync(BIN, bin, { recursive: true });
        const log = path.join(bin, "stop.log");
        fs.writeFileSync(path.join(bin, "stop-agent.sh"), `#!/bin/sh\necho "$1" >> ${log}\nexit 1\n`);
        fs.chmodSync(path.join(bin, "stop-agent.sh"), 0o755);
        const h = await stopHarness(bin);
        const runDirs = ["r1", "r2"].map(n => path.join(h.native.ipcDir, "runs", n));
        for (const dir of runDirs) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "worker.pid"), String(process.pid));
        }
        const stopped = await h.call("sandbox_stop", { name: "carapa-bot", instance: "proj" });
        expect(stopped.isError).toBe(true);
        expect(stopped.text).toContain("Stopped carapa-bot-proj with errors");
        expect(fs.readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(runDirs);
        expect(await h.state()).toBe("exited");
        expect(h.hosts.has("carapa-bot-proj")).toBe(false);
        expect(h.native.running).toBe(false);
        expect(h.saved.at(-1)).toEqual([false]);
        await h.client.close();
    }, 20_000);
});

describe("native runner restart", () => {
    it("keeps an unreadable projects.json as a backup and leaves no partial file when a save fails", () => {
        const c = config();
        const stateFile = path.join(c.root, "state", "projects.json");
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        const truncated = '[{"project":"carapa-bot-kept","stack":"carapa-b';
        fs.writeFileSync(stateFile, truncated);
        const error = spyOn(logger, "error").mockImplementation(() => {});
        try {
            expect(loadProjects(stateFile).size).toBe(0);
        } finally {
            error.mockRestore();
        }
        const backups = fs.readdirSync(path.dirname(stateFile)).filter(name => name.startsWith("projects.json.corrupt-"));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(path.dirname(stateFile), backups[0]), "utf8")).toBe(truncated);

        // A save that fails midway leaves the previous file whole.
        const project = prepareProject(c, "carapa-bot", "kept", { GROUP_DIR: "@group/kept", LOCAL_REPO: "@repo/kept" });
        saveProjects(stateFile, [project]);
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => saveProjects(stateFile, [circular as unknown as NativeProject])).toThrow();
        expect([...loadProjects(stateFile).keys()]).toEqual(["carapa-bot-kept"]);
        expect(fs.readdirSync(path.dirname(stateFile)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    });

    it("keeps running projects running, refreshes their home and stops those whose directories are gone", async () => {
        const c = config();
        const stateFile = path.join(c.root, "state", "projects.json");
        const start = (instance: string) => prepareProject(c, "carapa-bot", instance, { GROUP_DIR: `@group/${instance}`, LOCAL_REPO: `@repo/${instance}` });
        const kept = start("kept");
        const stopped = start("stopped");
        const gone = start("gone");
        const noHome = start("nohome");
        stopped.running = false;
        // What an older runner left: no current settings or MCP server, /tmp cleared by a reboot, one repository removed.
        fs.rmSync(path.join(kept.agentHome, ".claude"), { recursive: true });
        fs.rmSync(path.join(kept.agentHome, ".claude.json"));
        fs.rmSync(projectTmpRoot(kept.project), { recursive: true, force: true });
        fs.rmSync(gone.repoDir, { recursive: true });
        fs.rmSync(noHome.agentHome, { recursive: true });
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify([kept, stopped, gone, noHome]));
        const capability = kept.relayCapability;

        const projects = new Map((JSON.parse(fs.readFileSync(stateFile, "utf8")) as NativeProject[]).map(p => [p.project, p]));
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
            restoreProjects(projects.values(), c);
            const warned = warn.mock.calls.map(call => JSON.stringify(call));
            expect(warned.filter(line => line.includes("carapa-bot-gone"))).toHaveLength(1);
            expect(warned.filter(line => line.includes("carapa-bot-nohome") && line.includes("agent home"))).toHaveLength(1);
            expect(warned.join()).toContain("no longer exists");
        } finally {
            warn.mockRestore();
        }
        const save = () => fs.writeFileSync(stateFile, JSON.stringify([...projects.values()]));
        save();

        const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as NativeProject[];
        expect(saved.map(p => [p.project, p.running])).toEqual([["carapa-bot-kept", true], ["carapa-bot-stopped", false], ["carapa-bot-gone", false], ["carapa-bot-nohome", false]]);
        // The saved capability is kept (the relay accepts it only for a running project), and the home is current.
        const restored = projects.get("carapa-bot-kept")!;
        expect(restored.running && restored.relayCapability).toBe(capability);
        expect(JSON.parse(fs.readFileSync(path.join(kept.agentHome, ".claude", "settings.json"), "utf8")).sandbox.enabled).toBe(false);
        const user = JSON.parse(fs.readFileSync(path.join(kept.agentHome, ".claude.json"), "utf8"));
        expect(user.mcpServers["carapa-board"].url).toBe(`http://127.0.0.1:18080/s/carapa-bot-kept/${capability}/mcp-relay/mcp/carapa-board`);
        expect(fs.statSync(projectTmpRoot(kept.project)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(shellDir(c, kept.project)).mode & 0o777).toBe(0o700);

        // Board reads the state through sandbox_ps / sandbox_status.
        const server = new McpServer({ name: "runner", version: "0" }, { capabilities: { logging: {} } });
        registerRunnerTools(server, { config: c, projects, credentials: new CredentialStore(path.join(c.root, "state", "c.json")), wrap: (_n, file, argv) => [file, ...argv], hosts: new Map(), save });
        const client = new Client({ name: "board", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const call = async (name: string, args: Record<string, unknown>) =>
            ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0].text;
        expect((JSON.parse(await call("sandbox_ps", {})) as Array<{ name: string }>).map(row => row.name)).toEqual(["carapa-bot-kept"]);
        const state = async (instance: string) => JSON.parse(await call("sandbox_status", { name: "carapa-bot", instance }))[0].State;
        expect(await state("kept")).toBe("running");
        expect(await state("stopped")).toBe("exited");
        expect(await state("gone")).toBe("exited");
        expect(await state("nohome")).toBe("exited");
        expect(fs.existsSync(noHome.agentHome)).toBe(false);
        await client.close();
    });

    it("stops a running project whose directory is outside the allowed roots", () => {
        const c = config();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-outside-"));
        roots.push(outside);
        const native = prepareProject(c, "carapa-bot", "proj", {});
        native.repoDir = outside;
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
            restoreProjects([native], c);
            expect(JSON.stringify(warn.mock.calls)).toContain("outside the runner root and allowedRoots");
        } finally {
            warn.mockRestore();
        }
        expect(native.running).toBe(false);
    });
});
