import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import fsp from "node:fs/promises";
import { isIP } from "node:net";
import { getStacksDir } from "../config.js";
import { fileExists, execDocker, parseComposePsJson, splitDockerOutput } from "../utils.js";
import { logger } from "../logger.js";
import { registerStackProject, unregisterStackProject, scheduleNetworkPolicyReload } from "../network-policy.js";
import { registerNginxProxyRoute, unregisterNginxProxyRoute } from "../nginx-proxy.js";
import { INSTANCE_PROXIES, connectInstanceProxies, reconnectInstanceProxies, readNetworkReservation, reserveInstanceNetwork } from "./network-reservations.js";
import { ingressEnabled, INGRESS_CONTAINER, isValidIngressIdentifier, setIngressProjectActive } from '../ingress.js';
import { ingressComposePath, prepareIngressCompose } from './ingress.js';
import { boundedStatusReader } from './status-reader.js';
import { containsPath, isInsideAllowlistBase, verifyPinnedMounts, type MountPin } from "../security.js";

/**
 * Map a container-local path to the corresponding host path.
 * When SANDBOX_HOST_DIR is set (containerised mode), paths under the
 * container workspace are rewritten so that docker compose — which executes
 * on the host daemon — resolves volume mounts correctly.
 *
 * Stacks may live outside the project root (e.g. a separate deployment directory),
 * so SANDBOX_STACKS_HOST_DIR is checked first for paths under the stacks dir.
 *
 * Example:
 *   container: /app/stacks/carapa-bot  →  host: /srv/carapa/stacks/carapa-bot
 *   container: /app/egress-proxy       →  host: /home/user/carapa-box/egress-proxy
 */
export function toHostPath(containerPath: string): string {
    const hostDir = process.env.SANDBOX_HOST_DIR;
    if (!hostDir) return containerPath;

    // Stacks may be mounted from a custom host directory.
    // SANDBOX_STACKS_HOST_DIR is set in container mode (docker-compose.yml).
    // When not set (host mode), SANDBOX_STACKS_DIR is already a host path,
    // so using it as fallback makes the replace a no-op.
    const stacksDir = getStacksDir();
    if (containerPath.startsWith(stacksDir)) {
        const stacksHostDir = process.env.SANDBOX_STACKS_HOST_DIR || stacksDir;
        return containerPath.replace(stacksDir, stacksHostDir);
    }

    // Everything else under /app maps to the project root on the host
    const containerRoot = path.resolve(stacksDir, "..");
    if (containerPath.startsWith(containerRoot)) {
        return containerPath.replace(containerRoot, hostDir);
    }
    return containerPath;
}


/**
 * Create a Docker network when absent, tolerating a concurrent creator.
 * Logs a warning instead of throwing if the network cannot be verified.
 */
async function createNetworkIfMissing(name: string, createArgs: string[], warning: string): Promise<void> {
    if ((await execDocker(["network", "inspect", name])).status === 0) {
        return; // exists
    }

    const create = await execDocker(["network", "create", ...createArgs, name]);
    if (create.status !== 0 && (await execDocker(["network", "inspect", name])).status !== 0) {
        // Create failed — could be a race, or a permission issue.
        // Verify it exists; if not, warn but don't crash startup.
        logger.warn({ network: name, err: `exit code ${create.status}` }, warning);
    }
}

export interface ComposeResult {
    stdout: string;
    stderr: string;
    code: number;
}

function toComposeResult(result: Awaited<ReturnType<typeof execDocker>>): ComposeResult {
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.status,
    };
}

/**
 * Execute docker compose command in a stack directory
 */
export async function execCompose(
    stackDir: string,
    args: string[],
    options?: {
        allowFailure?: boolean;
        projectName?: string;
        env?: Record<string, string>;
        onLog?: (message: string) => void;
        signal?: AbortSignal;
    }
): Promise<ComposeResult> {
    // Add project name if specified
    const composeArgs = options?.projectName
        ? ["--project-name", options.projectName, ...args]
        : args;

    // execDocker supplies the process environment shared by all Docker calls;
    // this map only contains values that Compose itself needs.
    const env: Record<string, string> = { ...(options?.env || {}) };

    // Expose stack directory so compose files can mount stack-relative files.
    // When containerised, map to host path so docker daemon resolves mounts.
    env.STACK_DIR = toHostPath(stackDir);

    // Expose project name as an env var so compose files can use ${COMPOSE_PROJECT_NAME}
    if (options?.projectName) {
        env.COMPOSE_PROJECT_NAME = options.projectName;
    }

    const overridePath = options?.projectName
        ? path.join(stackDir, `docker-compose.override.${options.projectName}.yml`)
        : undefined;
    const migratedPath = options?.projectName && args[0] !== 'config' && isValidIngressIdentifier(options.projectName)
        ? ingressComposePath(options.projectName)
        : undefined;
    const [overrideExists, migratedExists, stackDirExists] = await Promise.all([
        overridePath ? fileExists(overridePath) : false,
        migratedPath ? fileExists(migratedPath) : false,
        fileExists(stackDir),
    ]);

    // If a project-specific override file exists, use it via COMPOSE_FILE
    if (options?.projectName && overrideExists) {
        const overrideFile = `docker-compose.override.${options.projectName}.yml`;
        const baseFile = env.COMPOSE_FILE || "docker-compose.yml";
        env.COMPOSE_FILE = `${baseFile}:${overrideFile}`;
    }

    // Always use the original stack for `config` (migration input). Once a
    // sandbox is migrated, all other operations use its resolved private model,
    // including down after ingress has been disabled by the operator.
    let usingIngressModel = false;
    if (migratedPath && migratedExists) {
        env.COMPOSE_FILE = migratedPath;
        usingIngressModel = true;
    }

    // If the stack directory doesn't exist inside the container (e.g. a
    // managed service referencing a host path), pass --project-directory so
    // the Docker daemon resolves compose files on the host, and use /tmp as
    // a valid container-side cwd.
    const cwd = stackDirExists ? stackDir : "/tmp";
    const extraArgs = !stackDirExists
        ? ["--project-directory", toHostPath(stackDir)]
        : usingIngressModel
            ? ["--project-directory", stackDir]
            : [];

    const fullArgs = ["compose", ...extraArgs, ...composeArgs];

    const result = await execDocker(fullArgs, {
        cwd,
        env,
        onLog: options?.onLog,
        signal: options?.signal,
    });

    if (options?.allowFailure) return toComposeResult(result);

    // execDocker reports a process that could not be started via spawnFailed;
    // any other non-zero status means compose itself ran and failed.
    if (result.spawnFailed) {
        throw new Error(`Failed to spawn docker compose: ${result.stderr}`);
    }
    if (result.status !== 0) {
        const stderr = result.stderr.trim();
        throw new Error(
            `docker compose ${args.join(" ")} failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`
        );
    }

    return toComposeResult(result);
}

/**
 * Scan a docker-compose.yml's top-level `networks:` for external networks and
 * create them if missing. If a network has a `name:` property, uses that as the
 * Docker network name. Skips variable-based names (e.g. ${AGENT_NETWORK:-...}) —
 * those are created dynamically by startStack() for per-instance isolation.
 * Other top-level sections (e.g. external `volumes:`) are never touched.
 */
async function ensureExternalNetworks(stackDir: string): Promise<void> {
    const composePath = path.join(stackDir, "docker-compose.yml");
    if (!(await fileExists(composePath))) return;

    let model: unknown;
    try {
        // yaml performs no ${…} interpolation, so names keep their variable text.
        model = parseYaml(await fsp.readFile(composePath, "utf-8"), { merge: true });
    } catch (err) {
        logger.warn({ composePath, err: err instanceof Error ? err.message : String(err) }, "Could not parse compose file for external networks");
        return;
    }
    const networks = (model as { networks?: unknown } | null)?.networks;
    if (!networks || typeof networks !== "object") return;

    const promises: Promise<void>[] = [];
    for (const [yamlKey, def] of Object.entries(networks)) {
        const network = def as { external?: unknown; name?: unknown } | null;
        if (network?.external !== true) continue;
        const networkName = typeof network.name === "string" ? network.name : yamlKey;
        // Skip variable-based names — handled by per-instance network creation
        if (networkName.includes("${")) continue;
        promises.push(createNetworkIfMissing(networkName, [], "Could not ensure network"));
    }
    await Promise.all(promises);
}

// ── Per-instance agent network isolation ────────────────────────────

async function stackNetworkFeatures(stackDir: string): Promise<{
    usesAgentNetwork: boolean;
    usesApiRelayIp: boolean;
    usesStableAgentIp: boolean;
}> {
    const composePath = path.join(stackDir, "docker-compose.yml");
    if (!(await fileExists(composePath))) {
        return { usesAgentNetwork: false, usesApiRelayIp: false, usesStableAgentIp: false };
    }
    const content = await fsp.readFile(composePath, "utf-8");
    return {
        usesAgentNetwork: content.includes("AGENT_NETWORK"),
        usesApiRelayIp: content.includes("API_RELAY_IP"),
        usesStableAgentIp: content.includes("AGENT_IPV4_ADDRESS"),
    };
}

/** The approved stack chooses its SSH service; project settings cannot redirect it. */
async function stackAgentService(stackDir: string): Promise<string> {
    try {
        const manifest = JSON.parse(await fsp.readFile(path.join(stackDir, "ssh.json"), "utf-8"));
        if (typeof manifest.service !== "string" || !isValidIngressIdentifier(manifest.service) || manifest.port !== 2222) {
            throw new Error("Invalid stack SSH configuration");
        }
        return manifest.service;
    } catch (error: any) {
        if (error.code === "ENOENT") return "agent";
        throw error;
    }
}

/**
 * Create a per-instance internal bridge network for agent isolation.
 * Each agent stack gets its own network so agents cannot see each other.
 */
async function createInstanceNetwork(projectName: string): Promise<string> {
    const networkName = `agent_egress_${projectName}`;
    await createNetworkIfMissing(networkName, ["--internal"], "Could not create instance network");
    return networkName;
}

/** A failed `docker network connect`; an already-connected container is not a failure. */
function isConnectFailure(result: { status: number; stderr: string }): boolean {
    return result.status !== 0 && !result.stderr.includes("already exists");
}

/**
 * Connect egress-proxy containers (squid, api-relay, llama-proxy) to a
 * per-instance network so the agent can reach them by service name.
 * The --alias flag registers the compose service name as a DNS entry on
 * the new network (docker network connect only registers the container
 * name by default, not the compose service name).
 */
async function connectProxyContainers(networkName: string): Promise<void> {
    // Connect all proxies in parallel — already-connected or missing containers are non-fatal
    const results = await connectInstanceProxies(networkName);
    for (const { container, result } of results) {
        if (isConnectFailure(result)) {
            logger.warn(
                { container, networkName, err: result.stderr.trim() },
                "Could not connect proxy container to instance network",
            );
        }
    }
}

/** Compose service name (DNS alias) of the credential relay. */
const API_RELAY_ALIAS = "api-relay";

async function listAgentNetworks(): Promise<string[]> {
    const result = await execDocker(["network", "ls", "--filter", "name=agent_egress_", "--format", "{{.Name}}"]);
    return result.status === 0 ? splitDockerOutput(result.stdout) : [];
}

/**
 * Read a container's IPv4 on a specific network. Used to tell agent stacks the
 * api-relay IP on their per-instance network (agy hard-dials some Google hosts
 * on :443 ignoring https_proxy; those are mapped to this IP via compose
 * extra_hosts → the api-relay SNI bridge → squid). Returns undefined if the
 * container isn't on the network or inspect fails.
 */
async function getContainerIpOnNetwork(container: string, networkName: string): Promise<string | undefined> {
    const res = await execDocker([
        "inspect", "-f",
        `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`,
        container,
    ]);
    if (res.status !== 0) return undefined;
    const ip = res.stdout.trim();
    // Docker can print the literal "invalid IP" when a stopped container
    // retains an endpoint for a network that was removed.
    return isIP(ip) === 4 ? ip : undefined;
}

/**
 * Disconnect proxy containers from a per-instance network and remove it.
 * Called after stack stop to clean up.
 */
async function cleanupInstanceNetwork(networkName: string): Promise<void> {
    // Retain both the subnet and attached proxies. Otherwise Docker could reuse
    // the subnet, or a dynamically reattached proxy could take the agent's IP.
    if (await readNetworkReservation(networkName)) return;
    await Promise.all(INSTANCE_PROXIES.map(({ container }) =>
        // --force also clears endpoints belonging to stopped containers.
        execDocker(["network", "disconnect", "--force", networkName, container])
    ));
    await execDocker(["network", "rm", networkName]);
}

/**
 * Remove orphaned per-instance agent networks (agent_egress_*) that have
 * no connected containers. Safe to call at startup.
 */
export async function cleanupOrphanedAgentNetworks(): Promise<void> {
    const networks = await listAgentNetworks();
    await Promise.all(networks.map(async (name) => {
        if (await readNetworkReservation(name)) return;
        const inspect = await execDocker(["network", "inspect", name, "--format", "{{len .Containers}}"]);
        if (inspect.status === 0 && inspect.stdout.trim() === "0") {
            await execDocker(["network", "rm", name]);
        }
    }));
}

/**
 * Reconnect proxy containers to ALL existing per-instance agent networks.
 * Called when egress-proxy containers restart to restore sandbox connectivity.
 */
export async function reconnectProxyToAllAgentNetworks(): Promise<void> {
    const networks = (await listAgentNetworks()).filter(network => network !== "agent_egress");
    if (networks.length === 0) return;

    logger.info({ networks: networks.length }, "Reconnecting proxy containers to agent networks");
    for (const { network, container, result } of await reconnectInstanceProxies(networks)) {
        if (isConnectFailure(result)) {
            logger.warn({ container, networkName: network, err: result.stderr.trim() }, 'Could not reconnect proxy container to instance network');
        }
    }
}

// Only the fields the mount guard reads; everything else passes through.
const RenderedComposeModel = z.object({
    services: z.record(z.string(), z.object({
        volumes: z.array(z.object({ type: z.string().optional(), source: z.string().optional() }).passthrough()).default([]),
    }).passthrough()).default({}),
    volumes: z.record(z.string(), z.object({
        driver_opts: z.object({ device: z.string().optional() }).passthrough().optional(),
    }).passthrough().nullable()).default({}),
}).passthrough();

/**
 * Refuse a rendered compose model that bind-mounts a path inside an allowlist
 * base (or a validated mount source) by path: Docker would re-follow symlinks
 * on every start. Box-owned binds under the stacks directory stay allowed.
 */
export async function assertNoUserBindMounts(config: unknown, stackDir: string, pins: MountPin[] = []): Promise<void> {
    // Sibling stacks (e.g. a shared ../carapa-bot/bin) are box-owned too.
    const stacksDir = getStacksDir();
    const owned = [stackDir, toHostPath(stackDir), stacksDir, toHostPath(stacksDir)].map((dir) => path.resolve(dir));
    const refuse = (what: string, source: string) => {
        throw new Error(
            `[SECURITY] Refusing to start: ${what} ${JSON.stringify(source)} is a host path inside the mount allowlist. ` +
            "Use a volume with a subpath on the carapa-mount-* volumes instead.");
    };
    const inspect = async (what: string, source: unknown, exempt: boolean) => {
        if (typeof source !== "string" || !source) return;
        if (exempt && owned.some((dir) => containsPath(dir, path.resolve(source)))) return;
        if (pins.some((pin) => path.resolve(pin.value) === path.resolve(source)) || await isInsideAllowlistBase(source)) {
            refuse(what, source);
        }
    };
    const parsed = RenderedComposeModel.safeParse(config);
    if (!parsed.success) {
        throw new Error("[SECURITY] Refusing to start: the rendered compose model has an unexpected shape, so its mounts cannot be checked");
    }
    for (const service of Object.values(parsed.data.services)) {
        for (const volume of service.volumes) {
            if (volume.type === "bind") await inspect("bind mount", volume.source, true);
        }
    }
    for (const volume of Object.values(parsed.data.volumes)) {
        await inspect("volume device", volume?.driver_opts?.device, true);
    }
}

/**
 * Start a stack.
 * Agent stacks (those using AGENT_NETWORK variable) get a per-instance
 * isolated network so agents cannot see each other on the shared bridge.
 */
export async function startStack(stackDir: string, projectName?: string, env?: Record<string, string>, onLog?: (msg: string) => void, pins?: MountPin[]): Promise<ComposeResult> {
    const networkFeatures = projectName ? await stackNetworkFeatures(stackDir) : undefined;
    const needsIsolation = projectName && networkFeatures?.usesAgentNetwork;
    const needsRelayIp = needsIsolation && networkFeatures.usesApiRelayIp;
    let instanceNetwork: string | undefined;

    if (needsIsolation) {
        if (networkFeatures.usesStableAgentIp) {
            const reservation = (await reserveInstanceNetwork(projectName, true, undefined, await stackAgentService(stackDir)))!;
            instanceNetwork = reservation.network;
            env = { ...env, AGENT_IPV4_ADDRESS: reservation.agentIp };
        } else {
            instanceNetwork = await createInstanceNetwork(projectName);
        }
        // Connect the proxies (squid/api-relay/llama/playwright) to the per-instance
        // network BEFORE `up` — so the agent can resolve them at boot, AND so we can
        // read api-relay's IP on this network and pass it as API_RELAY_IP. agy stacks
        // map their proxy-ignoring Google direct-dials to that IP via extra_hosts,
        // which compose evaluates at `up` time (hence: must be known before `up`).
        await connectProxyContainers(instanceNetwork);
        const relayIp = await getContainerIpOnNetwork(
            INSTANCE_PROXIES.find(p => p.alias === API_RELAY_ALIAS)!.container,
            instanceNetwork,
        );
        if (relayIp) {
            env = { ...env, AGENT_NETWORK: instanceNetwork, API_RELAY_IP: relayIp };
        } else {
            if (needsRelayIp) {
                throw new Error(
                    `api-relay has no valid IPv4 address on ${instanceNetwork}; ` +
                    "ensure egress-proxy-api-relay-1 is running and can attach to the instance network",
                );
            }
            logger.warn({ instanceNetwork }, "startStack: could not read api-relay IP on instance network");
            env = { ...env, AGENT_NETWORK: instanceNetwork };
        }
    }

    await ensureExternalNetworks(stackDir);

    // sandbox_start passes its pinned mounts; only then is the rendered model
    // checked (infrastructure stacks keep their own binds).
    const guardMounts = pins !== undefined;
    let config: unknown;
    if (guardMounts || (needsIsolation && ingressEnabled())) {
        const resolved = await execCompose(stackDir, ['config', '--format', 'json'], { projectName, env });
        try {
            config = JSON.parse(resolved.stdout);
        } catch {
            if (guardMounts) throw new Error("[SECURITY] Refusing to start: cannot read the rendered compose model to check its mounts");
            throw new Error("Cannot read the rendered compose model");
        }
    }
    if (guardMounts) await assertNoUserBindMounts(config, stackDir, pins);

    if (needsIsolation && ingressEnabled()) {
        await prepareIngressCompose(config, projectName!);
    }

    // Defence in depth: the pinned sources must still resolve to what was validated.
    if (pins) await verifyPinnedMounts(pins);

    // Try up -d. On container name conflict (ghost from a previous run or
    // different project), extract the conflicting name, force-remove it, and retry.
    let result = await execCompose(stackDir, ["up", "-d"], { projectName, env, onLog, allowFailure: true });

    const ghostName = result.code !== 0 && result.stderr.includes("is already in use by container")
        ? result.stderr.match(/container name "\/([^"]+)" is already in use/)?.[1]
        : undefined;
    if (ghostName) {
        logger.info({ ghostName, projectName }, "startStack: removing conflicting container and retrying");
        onLog?.(`Removing conflicting container ${ghostName}\n`);
        const rmResult = await execDocker(["rm", "-f", ghostName]);
        if (rmResult.status !== 0) {
            logger.warn({ ghostName, err: rmResult.stderr }, "startStack: failed to remove conflicting container");
        }
        result = await execCompose(stackDir, ["up", "-d"], { projectName, env, onLog });
    } else if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `docker compose up -d failed`);
    }

    // (proxies were connected to the instance network before `up`, above)

    // Register project→stack mapping and reload Squid ACLs with new container IPs
    if (projectName) {
        if (needsIsolation && ingressEnabled()) await setIngressProjectActive(projectName, true);
        const stackName = path.basename(stackDir);
        registerStackProject(projectName, stackName);
        // Debounced + no-op-skipped: coalesces bursts of stack events into a
        // single squid reconfigure, avoiding tunnel-severing churn for peers.
        scheduleNetworkPolicyReload();
        try {
            const url = await registerNginxProxyRoute(
                stackDir,
                projectName,
                execCompose,
                env?.NGINX_PROXY_ALIASES,
            );
            if (url) onLog?.(`Published sandbox at ${url}\n`);
        } catch (err) {
            if (needsIsolation && ingressEnabled()) throw err;
            logger.warn({ projectName, err }, "Could not register nginx proxy route");
            onLog?.(`Warning: could not publish nginx proxy route: ${String(err)}\n`);
        }
        // Again after the route exists: the own-hostname rule reads it.
        scheduleNetworkPolicyReload();
    }

    return result;
}

/**
 * Shell loop stopping every agent whose pid file names a live process.
 * Runs live in <ipcRoot>/runs/<runId>/; <ipcRoot>/*\/ covers old layouts.
 * Dead pids are skipped so completed runs are never relabelled as stopped.
 */
export function buildStopAgentsCommand(ipcRoot = '/workspace/ipc'): string {
    const root = `'${ipcRoot.replace(/'/g, `'\\''`)}'`;
    return `for d in ${root}/runs/*/ ${root}/*/; do `
        + 'p=$(cat "$d/pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null && stop-agent.sh "$d" 2>/dev/null || true; done';
}

/** Drain managed processes in the stack-selected service, if it is running. */
export async function stopSandboxProcesses(
    stackDir: string, projectName: string, onLog?: (msg: string) => void,
    deps = { getStackStatus, execInService },
): Promise<void> {
    const service = await stackAgentService(stackDir);
    const status = await deps.getStackStatus(stackDir, projectName);
    if (status.code !== 0 || !status.stdout.trim()) return;
    const containers = parseComposePsJson(status.stdout) as { Service?: string; State?: string }[];
    if (!containers.some((c: any) => c.Service === service && c.State === 'running')) return;
    const result = await deps.execInService(stackDir, service,
        buildStopAgentsCommand(), projectName, onLog);
    if (result.stdout?.trim()) onLog?.(` Agent stop: ${result.stdout.trim()}\n`);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Stop a stack.
 * Cleans up per-instance agent network if one was created by startStack().
 */
export async function stopStack(stackDir: string, projectName?: string, onLog?: (msg: string) => void): Promise<ComposeResult> {
    if (projectName && ingressEnabled()) {
        await setIngressProjectActive(projectName, false);
        // Detach first: an expired route cannot survive a stop, and a retained
        // ingress endpoint must not prevent legacy subnet migration below.
        const inspect = await execDocker(['inspect', INGRESS_CONTAINER]);
        if (inspect.status === 0 && JSON.parse(inspect.stdout)[0]?.NetworkSettings?.Networks?.[`agent_egress_${projectName}`]) {
            const disconnected = await execDocker(['network', 'disconnect', '--force', `agent_egress_${projectName}`, INGRESS_CONTAINER]);
            if (disconnected.status !== 0) throw new Error(disconnected.stderr || 'Could not revoke sandbox ingress');
        }
    }
    // Capture the current legacy address BEFORE down destroys the endpoint.
    const networkFeatures = projectName ? await stackNetworkFeatures(stackDir) : undefined;
    if (projectName && networkFeatures?.usesAgentNetwork && networkFeatures.usesStableAgentIp) {
        await reserveInstanceNetwork(projectName, false, undefined, await stackAgentService(stackDir));
    }
    // Let each service's stop_grace_period (in docker-compose.yml) control its own shutdown timeout.
    // Default is 10s if not specified; stacks that need longer (e.g. carapa-brain) should set it in their compose file.
    const result = await execCompose(stackDir, ["down", "-v", "--remove-orphans"], { projectName, onLog, allowFailure: true });

    // Safety: force-remove any leftover containers that `down` didn't clean up.
    // This can happen when a container exited on its own (graceful shutdown) or
    // when the stop grace period is exceeded and Docker leaves a ghost entry in
    // "dead"/"exited" state, which blocks the name on the next `up`.
    // Use `docker ps` with label filter instead of `compose ps` — more reliable
    // for finding containers in weird states where compose metadata is gone.
    if (projectName) {
        try {
            // Find leftover containers by both compose project label AND name pattern.
            const [byLabel, byName] = await Promise.all([
                execDocker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${projectName}`]),
                execDocker(["ps", "-a", "--filter", `name=${projectName}-`, "--format", "{{.ID}} {{.Names}}"]),
            ]);
            // `name=` is a substring match: keep only the exact compose naming
            // `<project>-<service>-<n>` so sibling projects sharing the prefix survive.
            const nameRows = byName.stdout.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(r => r.length >= 2);
            let serviceNames: string[] | undefined;
            if (nameRows.length > 0) {
                const services = await getStackServices(stackDir, projectName).catch(() => undefined);
                const list = services?.code === 0 ? splitDockerOutput(services.stdout) : [];
                serviceNames = list.length > 0 ? list : undefined;
            }
            const servicePattern = serviceNames
                ? `(?:${serviceNames.map(escapeRegExp).join("|")})`
                : "[^-]+";
            const exactName = new RegExp(`^/?${escapeRegExp(projectName)}-${servicePattern}-\\d+$`);
            const allIds = new Set([
                ...splitDockerOutput(byLabel.stdout),
                ...nameRows.filter(([, name]) => exactName.test(name)).map(([id]) => id),
            ]);
            const containerIds = [...allIds];
            logger.debug({ projectName, containerIds }, "stopStack: ghost container check");
            if (containerIds.length > 0) {
                onLog?.(`Removing ${containerIds.length} leftover container(s)\n`);
                const rmResult = await execDocker(["rm", "-f", ...containerIds]);
                logger.debug({ containerIds, rmStderr: rmResult.stderr?.trim() }, "stopStack: force-removed containers");
            }
        } catch (err) {
            logger.warn({ projectName, err }, "stopStack: ghost cleanup failed");
        }
    }

    // Clean up per-instance network (no-op if it doesn't exist)
    if (projectName) {
        try {
            await unregisterNginxProxyRoute(projectName, undefined, stackDir);
        } catch (err) {
            logger.warn({ projectName, err }, "Could not remove nginx proxy route");
            onLog?.(`Warning: could not remove nginx proxy route: ${String(err)}\n`);
        }
        const instanceNetwork = `agent_egress_${projectName}`;
        await cleanupInstanceNetwork(instanceNetwork);
        unregisterStackProject(projectName);
        // Debounced + no-op-skipped (see startStack).
        scheduleNetworkPolicyReload();
    }

    // Cleanup above ran regardless; still surface the down failure to callers.
    if (result.code !== 0) throw new Error(result.stderr.trim() || "docker compose down failed");
    return result;
}

/**
 * Build a stack
 */
export async function buildStack(stackDir: string, projectName?: string, onLog?: (msg: string) => void): Promise<ComposeResult> {
    return execCompose(stackDir, ["build"], { projectName, onLog });
}

/**
 * Get stack status (ps). Includes all containers (running and exited).
 */
export const getStackStatus = boundedStatusReader((stackDir: string, projectName?: string): Promise<ComposeResult> =>
    execCompose(stackDir, ["ps", "-a", "--format", "json"], { allowFailure: true, projectName }));

async function execServiceCommand(
    stackDir: string,
    service: string,
    command: string[],
    projectName?: string,
    onLog?: (msg: string) => void,
    signal?: AbortSignal,
    env?: Record<string, string>
): Promise<ComposeResult> {
    // Forward env vars to the container process via `exec -e KEY`, with the
    // value supplied in the docker compose process environment. This keeps
    // secrets (e.g. provisioning DB creds) out of both the in-container
    // `sh -c` command line and the host-side docker CLI argv.
    const execArgs = ["exec", "-T"];
    const composeEnv: Record<string, string> = {};
    if (env) {
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined || v === null) continue;
            composeEnv[k] = v;
            execArgs.push("-e", k);
        }
    }
    execArgs.push(service, ...command);
    return execCompose(stackDir, execArgs, { projectName, onLog, allowFailure: true, signal, env: composeEnv });
}

/**
 * Execute command in a service
 */
export async function execInService(
    stackDir: string,
    service: string,
    command: string,
    projectName?: string,
    onLog?: (msg: string) => void,
    signal?: AbortSignal,
    env?: Record<string, string>
): Promise<ComposeResult> {
    return execServiceCommand(stackDir, service, ["sh", "-c", command], projectName, onLog, signal, env);
}

/** Execute an already parsed command directly, without an in-container shell. */
export async function execArgvInService(
    stackDir: string,
    service: string,
    argv: string[],
    projectName?: string,
    onLog?: (msg: string) => void,
    signal?: AbortSignal,
    env?: Record<string, string>
): Promise<ComposeResult> {
    return execServiceCommand(stackDir, service, argv, projectName, onLog, signal, env);
}

/**
 * List service names defined in the stack's compose file.
 * Uses projectName so project-specific overrides are applied.
 */
export async function getStackServices(
    stackDir: string,
    projectName?: string
): Promise<ComposeResult> {
    return execCompose(stackDir, ["config", "--services"], { projectName, allowFailure: true });
}

const DEFAULT_LOG_TAIL = 1000;

/**
 * Get logs from a service
 */
export async function getServiceLogs(
    stackDir: string,
    service: string,
    tail?: number,
    projectName?: string
): Promise<ComposeResult> {
    const args = ["logs", service];
    args.push("--tail", String(tail ?? DEFAULT_LOG_TAIL));
    return execCompose(stackDir, args, { allowFailure: true, projectName });
}

/**
 * Execute a standalone `docker run --rm` command (not tied to compose).
 * Useful for host-side operations like git push via alpine/git.
 */
export async function execDockerRun(
    args: string[],
    options?: { onLog?: (message: string) => void }
): Promise<ComposeResult> {
    const result = await execDocker(["run", "--rm", ...args], {
        onLog: options?.onLog
    });

    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `docker run failed with exit code ${result.status}`);
    }

    return toComposeResult(result);
}

/**
 * List compose projects. By default only active projects (at least one
 * running container) are returned; pass all=true to also include projects
 * whose containers have all stopped.
 */
export async function listProjects(all = false): Promise<ComposeResult> {
    const args = ["compose", "ls"];
    if (all) args.push("--all");
    args.push("--format", "json");
    const result = await execDocker(args);

    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "docker compose ls failed");
    }

    return toComposeResult(result);
}
