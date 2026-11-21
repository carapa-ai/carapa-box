import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRunnerConfig, type OpenShellConfig, type RunnerConfig } from "./config.js";
import { OpenShellBackend, sandboxName, sandboxSpec, vmLinks, type CliExec } from "./openshell.js";
import { prepareProject, relayUrl, shellDir, type NativeProject } from "./projects.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const BIN = path.resolve(import.meta.dir, "..", "..", "stacks", "carapa-bot", "bin");

const openshell = (extra: Partial<OpenShellConfig> = {}): OpenShellConfig => ({
    cli: "openshell", driver: "docker", image: "agent:test", bun: "bun", relayHost: "host.openshell.internal", harnesses: ["claude"], mounts: [], readOnlyPaths: [], stacks: {}, ...extra,
});

function setup(extra: Partial<OpenShellConfig> = {}): { config: RunnerConfig; native: NativeProject } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-openshell-"));
    roots.push(root);
    const config: RunnerConfig = {
        root, stateDir: path.join(root, "state"), hubUrl: "wss://hub", boxId: "lab", credential: "x", relayUpstream: "https://hub:8443", relayUpstreamInsecure: false,
        relayPort: 18080, runtimeBinDir: BIN, allowedRoots: [], allowedDomains: [], denyRead: [], allowRead: [],
        llamaPorts: [], llamaToolProfiles: path.join(root, "tool_profiles.jsonc"), openshell: openshell(extra),
    };
    return { config, native: prepareProject(config, "carapa-bot", "alpha", {}) };
}

describe("OpenShell sandbox spec", () => {
    it("mounts only the project's directories writable and the runtime read-only", () => {
        const { config, native } = setup();
        prepareProject(config, "carapa-bot", "other", {});
        const spec = sandboxSpec(native, config, config.openshell!);
        const writable = spec.mounts.filter(m => !m.read_only).map(m => m.target).sort();
        expect(writable).toEqual([native.repoDir, native.groupDir, native.ipcDir, native.agentHome, shellDir(config, native.project)].filter((v, i, a) => a.indexOf(v) === i).sort());
        expect(spec.mounts.find(m => m.target === BIN)?.read_only).toBe(true);
        // Neither the runner's private state nor another project's directories are reachable.
        const targets = spec.mounts.map(m => m.target);
        expect(targets.some(t => t.startsWith(path.join(config.root, "state")))).toBe(false);
        expect(targets.some(t => t.includes("other"))).toBe(false);
        // Every writable mount is writable in the filesystem policy, nothing else beyond the defaults.
        for (const dir of writable) expect(spec.policy).toContain(JSON.stringify(dir));
    });

    it("gives the shell tab its private dir and ptys", () => {
        const { config, native } = setup();
        const spec = sandboxSpec(native, config, config.openshell!);
        const shell = spec.mounts.find(m => m.target === shellDir(config, native.project));
        expect(shell).toMatchObject({ type: "bind", read_only: false });
        for (const dev of ["/dev/ptmx", "/dev/pts"]) expect(spec.policy).toContain(JSON.stringify(dev));
    });

    it("allows the relay forwarder as the only network destination", () => {
        const { config, native } = setup();
        const { policy } = sandboxSpec(native, config, config.openshell!);
        expect(policy.match(/- host: /g)).toHaveLength(1);
        expect(policy).toContain('- host: "host.openshell.internal"');
        expect(policy).toContain("port: 18080");
        expect(relayUrl(native, config)).toStartWith("http://host.openshell.internal:18080/s/carapa-bot-alpha/");
    });

    it("changes its digest when the mounts change, so the sandbox is recreated", () => {
        const { config, native } = setup();
        const base = sandboxSpec(native, config, config.openshell!).hash;
        const withHarness = openshell({ mounts: [{ type: "volume", source: "harness", target: "/opt/carapa-harness/bin", readOnly: true, subpath: "bin" }] });
        const spec = sandboxSpec(native, config, withHarness);
        expect(spec.hash).not.toBe(base);
        expect(spec.mounts.find(m => m.target === "/opt/carapa-harness/bin")).toEqual({ type: "volume", source: "harness", target: "/opt/carapa-harness/bin", read_only: true, subpath: "bin" });
    });

    it("names sandboxes within the gateway's 19 character limit, unique per project", () => {
        const names = ["carapa-bot-alpha", "carapa-bot-alphb", "x", "A.very_long.project-name-123"].map(sandboxName);
        for (const name of names) expect(name).toMatch(/^cb-[a-z0-9-]*[a-z0-9]-[0-9a-f]{8}$/);
        for (const name of names) expect(name.length).toBeLessThanOrEqual(19);
        expect(new Set(names).size).toBe(names.length);
    });
});

/** A fake gateway: sandboxes by name with a phase and the spec hash they were created with. */
function fakeCli(initial: Record<string, { phase: string; hash?: string }> = {}) {
    const sandboxes = new Map(Object.entries(initial));
    const calls: string[][] = [];
    let down = false;
    const exec: CliExec = async (argv) => {
        const args = argv.filter(arg => !arg.startsWith("--gateway"));
        const [, group, action, name] = args;
        calls.push([action, name]);
        if (down) return { code: 1, out: "Error: transport error: connection refused" };
        if (group !== "sandbox") return { code: 1, out: "unexpected" };
        const existing = sandboxes.get(name);
        if (action === "get") {
            return existing ? { code: 0, out: JSON.stringify({ phase: existing.phase, labels: existing.hash ? { "carapa.spec": existing.hash } : {} }) } : { code: 1, out: "Error: code: 'Some requested entity was not found'" };
        }
        if (action === "create") {
            const hash = /carapa\.spec=([0-9a-f]+)/.exec(args.join(" "))?.[1];
            const created = args[args.indexOf("--name") + 1];
            sandboxes.set(created, { phase: "Ready", hash });
            calls[calls.length - 1] = ["create", created];
        } else if (action === "start") existing!.phase = "Ready";
        else if (action === "stop") existing!.phase = "Stopped";
        else if (action === "delete") sandboxes.delete(name);
        return { code: 0, out: "" };
    };
    return { exec, calls, sandboxes, setDown: (value: boolean) => { down = value; } };
}

describe("OpenShell VM sandbox spec", () => {
    const harness = [
        { type: "volume" as const, source: "harness-1", target: "/opt/carapa-harness/bin", readOnly: true, subpath: "bin" },
        { type: "volume" as const, source: "harness-1", target: "/opt/carapa-harness-store", readOnly: true },
    ];
    const vmInput = (id = "abc") => ({ image: { id, rootfs: `/rootfs/${id}.tar.gz`, path: "/opt/bun/bin" }, volumeDir: (name: string) => `/volumes/${name}` });

    it("mounts the checkout, the runner root and the harness copy, and leaves the rest to the policy and rootfs links", () => {
        const { config, native } = setup({ driver: "vm", mounts: harness });
        const spec = sandboxSpec(native, config, config.openshell!, vmInput());
        const checkout = path.resolve(BIN, "..", "..", "..");
        expect(new Map(spec.mounts.map(m => [m.target, m.read_only]))).toEqual(new Map([
            [checkout, true], [path.resolve(config.root), false], ["/opt/carapa-harness-store", true],
        ]));
        expect(spec.mounts.find(m => m.target === "/opt/carapa-harness-store")?.source).toBe("/volumes/harness-1");
        expect(spec.image).toBe("/rootfs/abc.tar.gz");
        // The root is mounted whole; what a project may write is the policy's list.
        const readWrite = spec.policy.split("\n").find(line => line.startsWith("  read_write:"))!;
        expect(readWrite).toContain(JSON.stringify(native.groupDir));
        expect(readWrite).not.toContain(`${JSON.stringify(path.resolve(config.root))},`);
        expect(readWrite).not.toContain(`${JSON.stringify(path.resolve(config.root))}]`);
        expect(vmLinks(config, config.openshell!, native)).toEqual({ "/opt/carapa-harness/bin": "/opt/carapa-harness-store/bin" });
        expect(sandboxSpec(native, config, config.openshell!, vmInput("def")).hash).not.toBe(spec.hash);
    });

    it("refuses what a VM cannot mount", () => {
        const { config, native } = setup({ driver: "vm", mounts: harness });
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-outside-"));
        roots.push(outside);
        expect(() => sandboxSpec({ ...native, extraMounts: [outside] }, config, config.openshell!, vmInput())).toThrow("outside");
        const crowded = { ...config.openshell!, mounts: [...harness, { type: "bind" as const, source: outside, target: "/extra", readOnly: true }] };
        expect(() => sandboxSpec(native, config, crowded, vmInput())).toThrow("at most 3 bind mounts");
        expect(() => vmLinks(config, { ...config.openshell!, mounts: [harness[0]] }, native)).toThrow("mount the volume itself");
    });
});

describe("OpenShell backend lifecycle", () => {
    it("creates a missing sandbox with the project's mounts and policy, and reuses a current one", async () => {
        const { config, native } = setup();
        const fake = fakeCli();
        const backend = new OpenShellBackend(config, config.openshell!, fake.exec);
        await backend.provision(native);
        const name = sandboxName(native.project);
        expect(fake.sandboxes.get(name)?.hash).toBe(sandboxSpec(native, config, config.openshell!).hash);
        expect(fs.readFileSync(path.join(config.root, "state", "openshell", `${name}.policy.yaml`), "utf8")).toContain("network_policies:");
        fake.calls.length = 0;
        await backend.provision(native);
        expect(fake.calls.map(([action]) => action)).toEqual(["get"]);
    });

    it("recreates a sandbox whose mounts changed and restarts a stopped one", async () => {
        const { config, native } = setup();
        const name = sandboxName(native.project);
        const stale = fakeCli({ [name]: { phase: "Ready", hash: "0000000000000000" } });
        await new OpenShellBackend(config, config.openshell!, stale.exec).provision(native);
        expect(stale.calls.map(([action]) => action)).toEqual(["get", "delete", "create"]);

        const stopped = fakeCli({ [name]: { phase: "Stopped", hash: sandboxSpec(native, config, config.openshell!).hash } });
        await new OpenShellBackend(config, config.openshell!, stopped.exec).provision(native);
        expect(stopped.calls.map(([action]) => action)).toEqual(["get", "start"]);
        expect(stopped.sandboxes.get(name)?.phase).toBe("Ready");
    });

    it("replaces a running sandbox whose spec changed when the runner first uses it", async () => {
        const { config, native } = setup();
        const fake = fakeCli({ [sandboxName(native.project)]: { phase: "Ready", hash: "0000000000000000" } });
        await new OpenShellBackend(config, config.openshell!, fake.exec).ensure(native);
        expect(fake.calls.map(([action]) => action)).toEqual(["get", "delete", "create"]);
    });

    it("does not create a second sandbox when the gateway is unreachable", async () => {
        const { config, native } = setup();
        const fake = fakeCli();
        fake.setDown(true);
        const backend = new OpenShellBackend(config, config.openshell!, fake.exec);
        await expect(backend.provision(native)).rejects.toThrow(/connection refused/);
        await expect(backend.ensure(native)).rejects.toThrow(/connection refused/);
        expect(fake.calls.some(([action]) => action === "create")).toBe(false);
        // A failed attempt is not remembered: the next call tries again.
        fake.setDown(false);
        await backend.ensure(native);
        expect(fake.sandboxes.has(sandboxName(native.project))).toBe(true);
    });

    it("lets concurrent first commands share one start, and stops only a running sandbox", async () => {
        const { config, native } = setup();
        const name = sandboxName(native.project);
        const fake = fakeCli({ [name]: { phase: "Stopped", hash: sandboxSpec(native, config, config.openshell!).hash } });
        const backend = new OpenShellBackend(config, config.openshell!, fake.exec);
        await Promise.all([backend.ensure(native), backend.ensure(native), backend.ensure(native)]);
        expect(fake.calls.filter(([action]) => action === "start")).toHaveLength(1);
        await backend.stop(native);
        expect(fake.sandboxes.get(name)?.phase).toBe("Stopped");
        fake.calls.length = 0;
        await backend.stop(native);
        expect(fake.calls.map(([action]) => action)).toEqual(["get"]);
    });

    it("lets sandbox_start wait for a pending reconcile of the same sandbox instead of racing its create", async () => {
        const { config, native } = setup();
        const fake = fakeCli();
        // Like the gateway: every call takes a moment, and creating an existing name fails.
        const exec: CliExec = async (argv, options) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            const created = argv.includes("create") ? argv[argv.indexOf("--name") + 1] : undefined;
            if (created && fake.sandboxes.has(created)) return { code: 1, out: "Error: already exists" };
            return fake.exec(argv, options);
        };
        const backend = new OpenShellBackend(config, config.openshell!, exec);
        await Promise.all([backend.ensure(native), backend.provision(native), backend.provision(native)]);
        expect(fake.calls.filter(([action]) => action === "create")).toHaveLength(1);
        expect(fake.sandboxes.has(sandboxName(native.project))).toBe(true);
    });

    it("lets stop wait for an in-flight provision, so the next provision does not race its create", async () => {
        const { config, native } = setup();
        const fake = fakeCli();
        let creating = 0;
        let overlap = false;
        // Like the gateway: create takes a while and fails on an existing name.
        const exec: CliExec = async (argv, options) => {
            if (!argv.includes("create")) return fake.exec(argv, options);
            creating++;
            overlap ||= creating > 1;
            await new Promise(resolve => setTimeout(resolve, 50));
            creating--;
            const created = argv[argv.indexOf("--name") + 1];
            if (fake.sandboxes.has(created)) return { code: 1, out: "Error: already exists" };
            return fake.exec(argv, options);
        };
        const backend = new OpenShellBackend(config, config.openshell!, exec);
        const first = backend.provision(native);
        await backend.stop(native);
        // The stop ended after the provision finished, and stopped what it created.
        expect(fake.sandboxes.get(sandboxName(native.project))?.phase).toBe("Stopped");
        await first;
        await backend.provision(native);
        expect(overlap).toBe(false);
        expect(fake.calls.filter(([action]) => action === "create")).toHaveLength(1);
        expect(fake.sandboxes.get(sandboxName(native.project))?.phase).toBe("Ready");
    });
});

describe("OpenShell command wrapper", () => {
    it("runs the sandbox host through exec with the operator's HOME and none of the project environment", () => {
        const { config, native } = setup({ gateway: "lab", gatewayEndpoint: "https://gw:17670" });
        const argv = new OpenShellBackend(config, config.openshell!).wrapper()(
            native, process.execPath, ["/srv/runner/sandbox-host.ts", "--serve"], { HOME: native.agentHome, ANTHROPIC_API_KEY: "secret", TMPDIR: "/tmp/cb-1" },
        );
        expect(argv.slice(0, 3)).toEqual(["/usr/bin/env", "-i", `HOME=${os.homedir()}`]);
        expect(argv.join(" ")).not.toContain("secret");
        expect(argv.join(" ")).not.toContain(native.agentHome + " ");
        const cli = argv.indexOf("openshell");
        const separator = argv.indexOf("--");
        // Gateway flags select the gateway for the CLI; after `--` they would be sandbox command arguments.
        expect(argv.slice(cli, cli + 5)).toEqual(["openshell", "--gateway", "lab", "--gateway-endpoint", "https://gw:17670"]);
        expect(argv.indexOf("--gateway")).toBeLessThan(separator);
        expect(argv.slice(argv.indexOf("exec"), argv.indexOf("exec") + 3)).toEqual(["exec", "-n", sandboxName(native.project)]);
        expect(argv.slice(separator + 1).slice(-5)).toEqual(["/tmp/cb-1", BIN, "bun", "/srv/runner/sandbox-host.ts", "--serve"]);
    });

    it("runs the shell tab's host in the project's sandbox", () => {
        const { config, native } = setup();
        const wrap = new OpenShellBackend(config, config.openshell!).wrapper();
        const argv = wrap(native, "bun", ["host.ts", "--serve"], {}, { shell: true });
        expect(argv[argv.indexOf("-n") + 1]).toBe(sandboxName(native.project));
    });
});

describe("Pi models in the agent home", () => {
    it("lists the managed providers at the relay forwarder and keeps the agent's own", () => {
        const { config, native } = setup();
        const file = path.join(native.agentHome, ".pi", "agent", "models.json");
        const relay = relayUrl(native, config);
        const first = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(first.providers.freellmapi.baseUrl).toBe(`${relay}/llama-proxy/3001/v1`);
        expect(JSON.stringify(first)).not.toMatch(/api-relay:8080|llama-proxy:\d/);

        fs.writeFileSync(file, JSON.stringify({ providers: { mine: { baseUrl: "http://example.test" }, freellmapi: { stale: true } } }));
        const again = prepareProject(config, "carapa-bot", "alpha", {});
        const merged = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(merged.providers.mine.baseUrl).toBe("http://example.test");
        expect(merged.providers.freellmapi.baseUrl).toBe(`${relayUrl(again, config)}/llama-proxy/3001/v1`);
    });
});

describe("Codex config in the agent home", () => {
    it("routes Codex through the relay provider and keeps an operator-edited file", () => {
        const { config, native } = setup();
        const file = path.join(native.agentHome, ".codex", "config.toml");
        expect(fs.readFileSync(file, "utf8")).toContain('base_url = "http://api-relay:8080/codex"');
        expect(fs.readFileSync(file, "utf8")).toContain("supports_websockets = false");
        fs.writeFileSync(file, 'model = "mine"\n');
        prepareProject(config, "carapa-bot", "alpha", {});
        expect(fs.readFileSync(file, "utf8")).toBe('model = "mine"\n');
    });
});

describe("Codex seed directory", () => {
    it("copies the operator's profiles and model catalogs, pointing /home/ubuntu/.codex at the project", () => {
        const { config } = setup();
        const seed = path.join(config.root, "seed");
        fs.mkdirSync(path.join(seed, "models"), { recursive: true });
        fs.writeFileSync(path.join(seed, "config.toml"), 'model_provider = "relay"\n[model_providers.relay]\nsupports_websockets = true\n');
        fs.writeFileSync(path.join(seed, "llama.config.toml"), 'model_catalog_json = "/home/ubuntu/.codex/models/llama.json"\n');
        fs.writeFileSync(path.join(seed, "models", "llama.json"), "{}");
        fs.writeFileSync(path.join(seed, "auth.json"), "secret");
        const native = prepareProject({ ...config, codexSeed: seed }, "carapa-bot", "alpha", {});
        const dir = path.join(native.agentHome, ".codex");
        expect(fs.readFileSync(path.join(dir, "llama.config.toml"), "utf8")).toBe(`model_catalog_json = "${dir}/models/llama.json"\n`);
        expect(fs.readFileSync(path.join(dir, "models", "llama.json"), "utf8")).toBe("{}");
        expect(fs.readFileSync(path.join(dir, "config.toml"), "utf8")).toContain("supports_websockets = false");
        expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
    });
});

describe("OpenShell runner config", () => {
    const load = (openshell: unknown) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-openshell-cfg-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ hubUrl: "wss://hub", boxId: "lab", credential: "x", relayUpstream: "https://hub:8443", openshell }));
        return loadRunnerConfig({ OS_RUNNER_ROOT: root });
    };

    it("applies defaults and validates mounts", () => {
        const config = load({ image: "agent:1", mounts: [{ type: "volume", source: "harness", target: "/opt/h", subpath: "bin" }] });
        expect(config.openshell).toMatchObject({ cli: "openshell", relayHost: "host.openshell.internal", bun: "bun", harnesses: ["claude"] });
        expect(config.openshell?.mounts).toEqual([{ type: "volume", source: "harness", target: "/opt/h", readOnly: true, subpath: "bin" }]);
        expect(() => load({})).toThrow("openshell.image");
        expect(() => load({ image: "a", mounts: [{ type: "bind", source: "rel", target: "/x" }] })).toThrow("absolute");
        expect(() => load({ image: "a", mounts: [{ type: "volume", source: "v", target: "/x", subpath: "../up" }] })).toThrow("subpath");
    });

    it("still reads the former CARAPA_RUNNER_ROOT name", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-openshell-legacy-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ hubUrl: "wss://hub", boxId: "legacy", credential: "x", relayUpstream: "https://hub:8443" }));
        expect(loadRunnerConfig({ CARAPA_RUNNER_ROOT: root }).boxId).toBe("legacy");
    });
});
