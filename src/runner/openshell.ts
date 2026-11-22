/**
 * OpenShell backend of the native runner: every project's agents run in one
 * long-lived OpenShell sandbox (a container whose files, processes and network
 * the OpenShell gateway confines) instead of a macOS Seatbelt profile.
 *
 * The sandbox mounts the project's directories at their host paths, so the
 * runner's path handling is unchanged. Its only network destination is the
 * runner's relay forwarder (host.openshell.internal:<relayPort>), the same
 * single egress the Seatbelt profile allows. Commands run through
 * `openshell sandbox exec`; the long-lived sandbox host (sandbox-host.ts)
 * keeps one such exec per project, as it keeps one sandboxed process on a Mac.
 *
 * The gateway must allow host bind mounts (`enable_bind_mounts`,
 * `allow_driver_config`) and must see the same host paths as the runner:
 * run it as a host process, or mount the runner root into its container at
 * the same path.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger.js";
import type { OpenShellConfig, OpenShellService, OpenShellStack, RunnerConfig } from "./config.js";
import type { CommandWrapper } from "./os-sandbox.js";
import { checkoutRoot, projectTmpRoot, shellDir, type NativeProject } from "./projects.js";
import { VmAssets, spawnExec, type VmImage } from "./vm-assets.js";

interface SandboxMount {
    type: "bind" | "volume";
    source: string;
    target: string;
    read_only: boolean;
    subpath?: string;
}

export interface SandboxSpec {
    name: string;
    /** Image the sandbox is created from (the stack's own, else the OpenShell default). */
    image: string;
    mounts: SandboxMount[];
    /** Sandbox policy (YAML). */
    policy: string;
    /** Digest of everything that is fixed when the sandbox is created. */
    hash: string;
}

interface ExecResult { code: number; out: string }
/** Runs the openshell CLI (injected by tests). */
export type CliExec = (argv: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Directory of the sandbox host script the wrapper starts inside the sandbox. */
const HOST_DIR = import.meta.dir;
const HOST_SCRIPT = path.join(HOST_DIR, "sandbox-host.ts");

/** Paths every sandbox may read besides its mounts (OpenShell's default policy plus /opt for bun and the harnesses). */
const READ_ONLY_DEFAULTS = ["/bin", "/usr", "/lib", "/lib64", "/sbin", "/proc", "/dev/urandom", "/app", "/etc", "/var/log", "/opt"];
/** /dev/ptmx and /dev/pts are the sandbox container's own ptys (Board's shell tab needs them). */
const READ_WRITE_DEFAULTS = ["/sandbox", "/tmp", "/dev/null", "/dev/ptmx", "/dev/pts"];
/** tmux of the sandbox image: the shell tab runs it inside the sandbox, not the runner host's. */
export const SANDBOX_TMUX = "/usr/bin/tmux";
/** Where the container images keep the runtime commands; CarapaBrain calls run-agent.sh there by this fixed path. */
const CONTAINER_BIN_DIR = "/usr/local/ai-cli-bin";
const LABEL_SPEC = "carapa.spec";
const LABEL_BOX = "carapa.runner";

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * OpenShell sandbox name of a project: DNS-safe and unique per project. The gateway
 * accepts at most 19 characters, so only a short readable prefix fits beside the hash.
 */
export function sandboxName(project: string): string {
    const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 7).replace(/^-+|-+$/g, "") || "p";
    return `cb-${slug}-${createHash("sha256").update(project).digest("hex").slice(0, 8)}`;
}

const byDepth = (a: SandboxMount, b: SandboxMount): number => a.target.length - b.target.length || a.target.localeCompare(b.target);
const yamlList = (items: string[]): string => `[${items.map(item => JSON.stringify(item)).join(", ")}]`;

/** The stack-specific settings of a project's sandbox, if any. */
export function stackOf(openshell: OpenShellConfig, native: NativeProject): OpenShellStack | undefined {
    return openshell.stacks[native.stack];
}

/** The VM driver mounts at most this many host directories into a sandbox. */
const VM_MAX_BIND_MOUNTS = 3;

/**
 * Symlinks the VM rootfs needs, because a VM mounts only a few directories: a volume's subpath
 * (the harness commands dir) points into the whole-volume mount, and the runtime commands appear
 * where containers have them (CarapaBrain calls them there).
 */
export function vmLinks(config: RunnerConfig, openshell: OpenShellConfig, native: NativeProject): Record<string, string> {
    const links: Record<string, string> = {};
    const whole = new Map<string, string>();
    for (const mount of openshell.mounts) if (mount.type === "volume" && !mount.subpath) whole.set(mount.source, mount.target);
    for (const mount of openshell.mounts) {
        if (mount.type !== "volume" || !mount.subpath) continue;
        const base = whole.get(mount.source);
        if (!base) throw new Error(`openshell.mounts: ${mount.target} takes a subpath of volume ${mount.source}; a VM mounts whole volumes, so mount the volume itself as well`);
        links[mount.target] = path.join(base, mount.subpath);
    }
    if (stackOf(openshell, native)?.service) links[CONTAINER_BIN_DIR] = config.runtimeBinDir;
    return links;
}

/** What the VM driver is given in place of a Docker image and Docker volumes. */
export interface VmSpecInput {
    image: VmImage;
    /** Host directory holding a Docker volume's content. */
    volumeDir: (volume: string) => string;
}

/** Everything fixed at sandbox creation for one project. */
export function sandboxSpec(native: NativeProject, config: RunnerConfig, openshell: OpenShellConfig, vm?: VmSpecInput): SandboxSpec {
    const stack = stackOf(openshell, native);
    // The shell tab's tmux socket, FIFOs and startup files live in the runner-owned shell dir.
    const writable = [native.repoDir, native.groupDir, native.ipcDir, native.agentHome, shellDir(config, native.project), ...(native.extraMounts ?? [])];
    const readable = [config.runtimeBinDir, HOST_DIR];
    const playwright = path.join(checkoutRoot(config), "node_modules", "@playwright", "cli");
    if (fs.existsSync(playwright)) readable.push(playwright);
    // The /workspace view is a directory of symlinks onto the mounts above.
    if (!writable.some(dir => within(native.workspaceRoot, dir))) readable.push(native.workspaceRoot);

    const byTarget = new Map<string, SandboxMount>();
    const add = (mount: SandboxMount) => {
        const existing = byTarget.get(mount.target);
        // A path listed twice stays writable if any entry asks for it.
        if (!existing || (existing.read_only && !mount.read_only)) byTarget.set(mount.target, mount);
    };
    let readOnly: string[];
    let readWrite: string[];
    if (vm) {
        // A VM has few mounts: the runner checkout (read-only), the runner root and the harness copy. Which of the
        // root's directories a project may use is the filesystem policy's job, so they must all lie inside it.
        const root = path.resolve(config.root);
        const outside = writable.find(dir => !within(dir, root));
        if (outside) throw new Error(`A VM sandbox mounts only the runner root: ${outside} is outside ${root}`);
        const checkout = checkoutRoot(config);
        if (!within(config.runtimeBinDir, checkout) || !within(HOST_DIR, checkout)) throw new Error("A VM sandbox needs the runtime commands inside the runner checkout");
        add({ type: "bind", source: checkout, target: checkout, read_only: true });
        add({ type: "bind", source: fs.realpathSync(root), target: root, read_only: false });
        for (const mount of openshell.mounts) {
            if (mount.type === "volume" && mount.subpath) continue; // a link in the rootfs (vmLinks)
            add({ type: "bind", source: mount.type === "volume" ? vm.volumeDir(mount.source) : mount.source, target: mount.target, read_only: mount.readOnly });
        }
        if (byTarget.size > VM_MAX_BIND_MOUNTS) throw new Error(`A VM sandbox supports at most ${VM_MAX_BIND_MOUNTS} bind mounts, this one needs ${byTarget.size}: ${[...byTarget.keys()].join(", ")}`);
        const mounts = [...byTarget.values()];
        readOnly = [...new Set([...READ_ONLY_DEFAULTS, ...openshell.readOnlyPaths, ...mounts.filter(m => m.read_only).map(m => m.target), native.workspaceRoot])];
        readWrite = [...new Set([...READ_WRITE_DEFAULTS, projectTmpRoot(native.project), ...mounts.filter(m => !m.read_only && m.target !== root).map(m => m.target), ...writable])];
    } else {
        for (const dir of readable) add({ type: "bind", source: dir, target: dir, read_only: true });
        // A service that starts agents itself (CarapaBrain) finds the runtime commands where containers have them.
        if (stack?.service) add({ type: "bind", source: config.runtimeBinDir, target: CONTAINER_BIN_DIR, read_only: true });
        for (const mount of openshell.mounts) add({ type: mount.type, source: mount.source, target: mount.target, read_only: mount.readOnly, ...(mount.subpath ? { subpath: mount.subpath } : {}) });
        for (const dir of writable) add({ type: "bind", source: dir, target: dir, read_only: false });
        const sorted = [...byTarget.values()].sort(byDepth);
        readOnly = [...new Set([...READ_ONLY_DEFAULTS, ...openshell.readOnlyPaths, ...sorted.filter(m => m.read_only).map(m => m.target)])];
        readWrite = [...new Set([...READ_WRITE_DEFAULTS, projectTmpRoot(native.project), ...sorted.filter(m => !m.read_only).map(m => m.target)])];
    }
    // Parents first: Docker needs the outer mount in place before a nested one.
    const mounts = [...byTarget.values()].sort(byDepth);
    const policy = [
        "version: 1",
        "filesystem_policy:",
        "  include_workdir: true",
        `  read_only: ${yamlList(readOnly)}`,
        `  read_write: ${yamlList(readWrite)}`,
        "landlock:",
        "  compatibility: best_effort",
        "network_policies:",
        "  carapa_relay:",
        "    name: carapa-relay",
        "    endpoints:",
        `      - host: ${JSON.stringify(openshell.relayHost)}`,
        `        port: ${config.relayPort}`,
        "        protocol: rest",
        "        enforcement: enforce",
        "        access: full",
        "        allowed_ips: [\"127.0.0.0/8\"]",
        "    binaries:",
        "      - { path: \"/**\" }",
        "",
    ].join("\n");
    const name = sandboxName(native.project);
    const imageRef = stack?.image ?? openshell.image;
    // The VM boots the exported archive; its digest follows the image id, so a rebuilt image replaces the sandbox.
    const image = vm ? vm.image.rootfs : imageRef;
    const hash = createHash("sha256").update(JSON.stringify({ image: vm ? vm.image.id : imageRef, mounts, policy, cpu: openshell.cpu, memory: openshell.memory })).digest("hex").slice(0, 16);
    return { name, image, mounts, policy, hash };
}

type Phase = "missing" | "stopped" | "running" | "failed" | "other";

export class OpenShellBackend {
    private readonly ready = new Map<string, Promise<void>>();
    /** Microvm sandboxes only: the PATH of each exported image (a rootfs archive carries no image environment). */
    private readonly imagePaths = new Map<string, string>();
    private readonly assets?: VmAssets;

    constructor(private readonly config: RunnerConfig, private readonly openshell: OpenShellConfig, private readonly exec: CliExec = spawnExec, assets?: VmAssets) {
        if (openshell.driver === "vm") this.assets = assets ?? new VmAssets(path.join(config.stateDir, "vm"));
    }

    /** The project's current sandbox spec (a microVM first needs its image archive and volume copies). */
    private async specFor(native: NativeProject): Promise<SandboxSpec> {
        if (!this.assets) return sandboxSpec(native, this.config, this.openshell);
        const ref = stackOf(this.openshell, native)?.image ?? this.openshell.image;
        const image = await this.assets.image(ref, vmLinks(this.config, this.openshell, native));
        this.imagePaths.set(ref, image.path);
        const dirs = new Map<string, string>();
        for (const mount of this.openshell.mounts) {
            if (mount.type === "volume" && !dirs.has(mount.source)) dirs.set(mount.source, await this.assets.volume(mount.source, this.openshell.image));
        }
        return sandboxSpec(native, this.config, this.openshell, { image, volumeDir: volume => dirs.get(volume)! });
    }

    /** Gateway selection flags (the CLI otherwise uses the active gateway). */
    private gatewayFlags(): string[] {
        return [
            ...(this.openshell.gateway ? ["--gateway", this.openshell.gateway] : []),
            ...(this.openshell.gatewayEndpoint ? ["--gateway-endpoint", this.openshell.gatewayEndpoint] : []),
        ];
    }

    /** Global flags go before the subcommand: after `--` they would belong to the sandbox command. */
    private cli(...args: string[]): string[] {
        return [this.openshell.cli, ...this.gatewayFlags(), ...args];
    }

    private async run(argv: string[], what: string, timeoutMs = 120_000): Promise<string> {
        const result = await this.exec(argv, { timeoutMs });
        if (result.code !== 0) throw new Error(`openshell ${what} failed (${result.code}): ${result.out.trim().slice(-600)}`);
        return result.out;
    }

    private async inspect(name: string): Promise<{ phase: Phase; hash?: string }> {
        const result = await this.exec(this.cli("sandbox", "get", name, "-o", "json"), { timeoutMs: 30_000 });
        // Only "not found" means missing: a gateway that is down must not make the runner create a duplicate.
        if (result.code !== 0) {
            if (/not found/i.test(result.out)) return { phase: "missing" };
            throw new Error(`openshell get ${name} failed (${result.code}): ${result.out.trim().slice(-300)}`);
        }
        let parsed: { phase?: string; labels?: Record<string, string> };
        try { parsed = JSON.parse(result.out); } catch { throw new Error(`openshell get ${name} returned unreadable output`); }
        const phase = parsed.phase === "Ready" || parsed.phase === "Running" ? "running" : parsed.phase === "Stopped" ? "stopped" : parsed.phase === "Error" ? "failed" : "other";
        return { phase, hash: parsed.labels?.[LABEL_SPEC] };
    }

    private async create(native: NativeProject, spec: SandboxSpec): Promise<void> {
        const dir = path.join(this.config.stateDir, "openshell");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // A bind source must exist before the sandbox is created; the shell tab fills the directory on use.
        fs.mkdirSync(shellDir(this.config, native.project), { recursive: true, mode: 0o700 });
        const policyFile = path.join(dir, `${spec.name}.policy.yaml`);
        fs.writeFileSync(policyFile, spec.policy, { mode: 0o600 });
        const driverConfig = JSON.stringify({ [this.openshell.driver]: { mounts: spec.mounts } });
        await this.run(this.cli(
            "sandbox", "create", "--name", spec.name, "--from", spec.image, "--policy", policyFile,
            "--driver-config-json", driverConfig, "--label", `${LABEL_SPEC}=${spec.hash}`, "--label", `${LABEL_BOX}=${this.config.boxId}`,
            ...(this.openshell.cpu ? ["--cpu", this.openshell.cpu] : []), ...(this.openshell.memory ? ["--memory", this.openshell.memory] : []),
            "--no-auto-providers", "--no-tty", "--detach", "--restart-policy", "always", "--", "sleep", "infinity",
        ), `create ${spec.name}`, 600_000);
        logger.info({ project: native.project, sandbox: spec.name }, "[runner] created OpenShell sandbox");
    }

    /**
     * Bring the project's sandbox to its current spec and running: one whose mounts or policy
     * changed (a new runner checkout, a new shell dir) is replaced, because a running sandbox keeps
     * the mounts it was created with. Agents in a replaced sandbox end.
     */
    private async reconcile(native: NativeProject): Promise<void> {
        const spec = await this.specFor(native);
        const state = await this.inspect(spec.name);
        // A sandbox that never became ready (Error) cannot be started again: replace it.
        if (state.phase !== "missing" && (state.hash !== spec.hash || state.phase === "failed")) {
            await this.run(this.cli("sandbox", "delete", spec.name), `delete ${spec.name}`);
            state.phase = "missing";
        }
        if (state.phase === "missing") await this.create(native, spec);
        else if (state.phase === "stopped" || state.phase === "other") await this.run(this.cli("sandbox", "start", spec.name), `start ${spec.name}`, 300_000);
    }

    /** Remember a project's reconcile as its ready attempt until it fails (a failed attempt is not reused). */
    private track(project: string, attempt: Promise<void>): Promise<void> {
        this.ready.set(project, attempt);
        attempt.catch(() => { if (this.ready.get(project) === attempt) this.ready.delete(project); });
        return attempt;
    }

    /**
     * Make the project's sandbox exist and run (call it where the project is (re)started). It always
     * reconciles afresh, but only after any pending reconcile of the same sandbox ended: two
     * reconciles that overlap both delete or create it and the second fails.
     */
    provision(native: NativeProject): Promise<void> {
        const previous = this.ready.get(native.project);
        return this.track(native.project, (async () => {
            await previous?.catch(() => undefined);
            await this.reconcile(native);
        })());
    }

    /** Lazily make sure the sandbox runs (also after a runner restart); concurrent callers share one attempt. */
    ensure(native: NativeProject): Promise<void> {
        return this.ready.get(native.project) ?? this.track(native.project, this.reconcile(native));
    }

    /**
     * Stop the sandbox, keeping it (and its writable layer) for the next start. A pending ready attempt
     * is waited for first (its error does not matter): dropping it would let it finish after the stop
     * and leave a running sandbox, and the next provision would reconcile alongside it.
     */
    async stop(native: NativeProject): Promise<void> {
        for (let pending = this.ready.get(native.project); pending; pending = this.ready.get(native.project)) {
            await pending.catch(() => undefined);
            if (this.ready.get(native.project) === pending) this.ready.delete(native.project);
        }
        const name = sandboxName(native.project);
        if ((await this.inspect(name)).phase === "running") await this.run(this.cli("sandbox", "stop", name), `stop ${name}`, 120_000);
    }

    /** argv of the long-running command that publishes a service of the project's sandbox on the host. */
    forwardArgv(native: NativeProject, service: OpenShellService): string[] {
        return this.cli("forward", "service", "--target-port", String(service.port), "--local", `${service.bind}:${service.hostPort}`, sandboxName(native.project));
    }

    /** Spawn argv that runs a project command (the sandbox host) inside the project's sandbox. */
    wrapper(): CommandWrapper {
        const realHome = os.homedir();
        // The shell tab's host (options.shell) runs in the same sandbox: one sandbox has one policy, so unlike Seatbelt it has no profile of its own.
        return (native, _file, argv, env) => {
            const [script, ...rest] = argv;
            // The CLI needs the operator's HOME (gateway metadata, mTLS material), not the project's, and none of the project environment.
            const cliEnv = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "PATH", "LANG", ...Object.keys(process.env).filter(key => key.startsWith("OPENSHELL_"))]
                .filter(key => process.env[key] !== undefined).map(key => `${key}=${process.env[key]}`);
            // Host processes see the sandbox's PATH, with the runtime commands first; the project's temp dir must exist.
            const launcher = 'mkdir -p -m 700 "$1" && export PATH="$2:$PATH" && shift 2 && exec "$@"';
            // A microVM's PATH is the base system's: add the image's own (bun, the harness commands).
            const imagePath = this.imagePaths.get(stackOf(this.openshell, native)?.image ?? this.openshell.image);
            const commandPath = imagePath ? `${this.config.runtimeBinDir}:${imagePath}` : this.config.runtimeBinDir;
            return ["/usr/bin/env", "-i", `HOME=${realHome}`, ...cliEnv, ...this.cli(
                "sandbox", "exec", "-n", sandboxName(native.project), "--no-tty", "--no-login-shell", "--workdir", native.repoDir,
                "--", "sh", "-c", launcher, "sh", env.TMPDIR ?? projectTmpRoot(native.project), commandPath, this.openshell.bun, script ?? HOST_SCRIPT, ...rest,
            )];
        };
    }
}
