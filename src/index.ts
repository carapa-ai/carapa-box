import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startProviderAccountReconciler } from './provider-accounts.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";

import { listStacks, getEgressProxyDir, getEgressProxyCodeDir, validateStacksSecurity } from "./config.js";
import { getStackStatus, startStack, execCompose, cleanupOrphanedAgentNetworks, reconnectProxyToAllAgentNetworks } from "./compose/client.js";
import { computeEgressHashes, egressAutoRecreateEnabled, egressIdleWaitMs, egressHashEnv, parseRecordedHashes, parseRecordedDefinitionHashes, egressDefinitionHash, egressDefinitionHashEnvName, EGRESS_DEFINITION_SERVICES, parseEgressStatus, refreshEgressServices, startMissingEgressServices, type EgressStatus } from "./compose/egress-refresh.js";
import { checkEgressDeployDrift } from "./compose/egress-drift.js";
import { runHook } from "./compose/hooks.js";
import { execDocker as execDockerCmd, fileExists, parseEnvFile, splitDockerOutput } from "./utils.js";
import { startNetworkPolicyWatcher, reloadNetworkPolicies, scheduleNetworkPolicyReload, stopNetworkPolicyWatcher, registerStackProject } from "./network-policy.js";
import { logger } from "./logger.js";
import { startIngressReconciler } from './ingress.js';
import { startNginxProxyReconciler } from './proxy-reconciler.js';
import { resumeAllProjectStartups } from './compose/project-startup.js';

import { startDraining, inflightCount, waitForIdle, drainLimitFromEnv } from "./shutdown-drain.js";
import { registerTools } from "./tools/register.js";
import { handleBunRequest, activeSessions, watchProxyContainerRestarts, setBunServer } from "./http/server.js";
import { fdPathAvailable } from "./runs/fd-path.js";
import { bindHostError, resolveBindHost } from "./http/bind.js";
import { hubConfigFromEnv, startHubConnection, type HubConnectionHandle } from "./hub/hub-client.js";

const BOX_VERSION = "0.1.0";

// Start server
/** In-flight count (and api-relay's loaded code hash) from an egress service's loopback /_inflight; null if unknown. */
async function egressStatus(egressDir: string, service: string, env: Record<string, string>): Promise<EgressStatus | null> {
    const port = service === "api-relay" ? "8080" : "(process.env.PORTS||'8880').split(',')[0].trim()";
    const script = `fetch('http://127.0.0.1:'+${port}+'/_inflight').then(r=>r.text()).then(t=>console.log(t.trim())).catch(()=>process.exit(1))`;
    try {
        const result = await execCompose(egressDir, ["exec", "-T", service, "node", "-e", script], {
            projectName: "egress-proxy",
            env,
            allowFailure: true,
            signal: AbortSignal.timeout(5_000),
        });
        if (result.code !== 0) return null;
        return parseEgressStatus(result.stdout);
    } catch {
        return null;
    }
}

/** Normalized definition hash of an egress service under the given env; null when compose can't render it. */
async function egressServiceDefinitionHash(egressDir: string, service: string, env: Record<string, string>): Promise<string | null> {
    try {
        const result = await execCompose(egressDir, ["config", "--format", "json"], {
            projectName: "egress-proxy",
            env,
            allowFailure: true,
            signal: AbortSignal.timeout(15_000),
        });
        return result.code === 0 ? egressDefinitionHash(result.stdout, service) : null;
    } catch {
        return null;
    }
}

/** Env that makes compose stamp each service's definition hash on the containers it creates; omits services whose hash is unknown. */
async function egressDefinitionEnv(egressDir: string, services: string[], env: Record<string, string>): Promise<Record<string, string>> {
    const hashes = await Promise.all(services.map(service => egressServiceDefinitionHash(egressDir, service, env)));
    return Object.fromEntries(services.flatMap((service, i) => (hashes[i] ? [[egressDefinitionHashEnvName(service), hashes[i]]] : [])));
}

async function main() {
    // .env is already loaded into process.env by config.ts at import time.
    const args = process.argv.slice(2);
    const httpMode = args.includes("--http");

    // Security check: refuse to register stacks missing policy.wasm
    const { registered, excluded } = await validateStacksSecurity();
    if (excluded.length > 0) {
        logger.warn(`[SECURITY] ${excluded.length} stack(s) excluded due to missing policy.wasm: ${excluded.join(", ")}`);
        logger.warn(`[SECURITY] Run 'bash scripts/compile-policies.sh' to compile .rego policies.`);
    }
    if (registered.length > 0) {
        logger.info(`[SECURITY] ${registered.length} stack(s) registered with policy.wasm: ${registered.join(", ")}`);
    }

    fdPathAvailable(); // logs once whether fd-relative IPC writes are active

    if (httpMode) {
        // Global network recovery and monitoring belong to the persistent controller.
        // Stdio clients (including `bun call`) only perform requested tool operations.
        await cleanupOrphanedAgentNetworks();
        watchProxyContainerRestarts();

        // Populate project→stack registry for running agent networks (survives controller restart)
        try {
            const ls = await execDockerCmd([
                "network", "ls", "--filter", "name=agent_egress_", "--format", "{{.Name}}",
            ]);
            if (ls.status === 0) {
                // Keep listStacks() here: its call populates the discovery cache
                // used by subsequent tool and HTTP requests during startup.
                const knownStacks = (await listStacks()).map(stack => stack.name);
                const stackSet = new Set(knownStacks);
                for (const net of splitDockerOutput(ls.stdout)) {
                    if (net === "agent_egress") continue;
                    const projectName = net.replace("agent_egress_", "");
                    // Try exact match first (O(1)), then prefix match
                    const matched = stackSet.has(projectName)
                        ? projectName
                        : knownStacks.find(s => projectName.startsWith(s + "-"));
                    if (matched) registerStackProject(projectName, matched);
                }
            }
        } catch { /* docker not available */ }

        // Reconnect proxy containers to surviving agent networks (handles box controller restart)
        await reconnectProxyToAllAgentNetworks();
        startProviderAccountReconciler();
        // Auto-start the egress proxy stack (squid + mcp-relay) if not already running
        const egressDir = getEgressProxyDir();
        if (await fileExists(egressDir)) {
            // Generate initial network policy config (also ensures the file exists before Docker binds it)
            const result = await reloadNetworkPolicies();
            if (result.ok) {
                logger.info(`[NETWORK-POLICY] Initial generation: ${result.message}`);
            } else {
                logger.warn(`[NETWORK-POLICY] Initial generation notice: ${result.message}`);
            }

            await checkEgressDeployDrift();

            try {
                const [status, egressEnv, hashes] = await Promise.all([
                    getStackStatus(egressDir, "egress-proxy"),
                    parseEnvFile(path.join(egressDir, ".env")),
                    computeEgressHashes(getEgressProxyCodeDir()),
                ]);
                const running = status.stdout.includes('"running"');
                if (!running) {
                    logger.info("Starting egress-proxy stack (squid + mcp-relay + api-relay)...");
                    await runHook(egressDir, "before-start", egressEnv);
                    const hashEnv = { ...egressEnv, ...egressHashEnv(hashes) };
                    await startStack(egressDir, "egress-proxy", { ...hashEnv, ...await egressDefinitionEnv(egressDir, EGRESS_DEFINITION_SERVICES, hashEnv) });
                    logger.info("Egress-proxy stack started.");
                    scheduleNetworkPolicyReload(); // api-relay now has an IP: refresh squid relay_src
                } else {
                    // Start services left without a running container (e.g. box restarted mid-replacement).
                    let recorded = parseRecordedHashes(status.stdout);
                    // Started/recreated services may get new IPs (api-relay): refresh squid relay_src.
                    const reconnectAndReloadPolicy = async (): Promise<void> => {
                        await reconnectProxyToAllAgentNetworks();
                        scheduleNetworkPolicyReload();
                    };
                    try {
                        const started = await startMissingEgressServices({
                            psOutput: status.stdout,
                            hashes,
                            start: async (service, hashEnv) => {
                                const env = { ...egressEnv, ...hashEnv };
                                await execCompose(egressDir, ["up", "-d", "--no-deps", service], {
                                    projectName: "egress-proxy",
                                    env: { ...env, ...await egressDefinitionEnv(egressDir, [service], env) },
                                });
                            },
                            reconnectNetworks: reconnectAndReloadPolicy,
                            log: message => logger.info(message),
                        });
                        // Started services already carry the current hash.
                        recorded = Object.fromEntries(Object.entries(recorded).filter(([service]) => !started.includes(service)));
                    } catch (e) {
                        logger.warn({ err: e }, "Warning: failed to start missing egress services");
                    }
                    // Recreate services whose compose definition changed; bind-mounted code is loaded
                    // once per process: reload api-relay in place and recreate other services whose code changed.
                    // Background: waiting for idle services can take up to EGRESS_IDLE_WAIT_MS.
                    void refreshEgressServices({
                        enabled: egressAutoRecreateEnabled(),
                        hashes,
                        recorded,
                        recordedDefinitions: parseRecordedDefinitionHashes(status.stdout),
                        definitionHash: (service, hashEnv) => egressServiceDefinitionHash(egressDir, service, { ...egressEnv, ...hashEnv }),
                        warn: message => logger.warn(message),
                        recreate: async (service, hashEnv) => {
                            const env = { ...egressEnv, ...hashEnv };
                            await execCompose(egressDir, ["up", "-d", "--force-recreate", "--no-deps", service], {
                                projectName: "egress-proxy",
                                env: { ...env, ...await egressDefinitionEnv(egressDir, [service], env) },
                            });
                        },
                        reload: async service => {
                            await execCompose(egressDir, ["kill", "-s", "SIGHUP", service], {
                                projectName: "egress-proxy",
                                env: egressEnv,
                            });
                        },
                        reconnectNetworks: reconnectAndReloadPolicy,
                        log: message => logger.info(message),
                        idleWaitMs: egressIdleWaitMs(),
                        status: service => egressStatus(egressDir, service, egressEnv),
                    }).catch(e => logger.warn({ err: e }, "Warning: failed to refresh egress services"));
                }
            } catch (e) {
                logger.warn({ err: e }, "Warning: failed to auto-start egress-proxy");
            }
        }

        // Start watching network policy files for hot-reload
        await startNetworkPolicyWatcher();
        startIngressReconciler();
        startNginxProxyReconciler();
        // Sandboxes Docker restarted at boot, before the start-event watcher existed.
        void resumeAllProjectStartups();
    }

    // Port priority: --port=X > MCP_SANDBOX_PORT env > default 3100
    const portArg = args.find(a => a.startsWith("--port="))?.split("=")[1];
    const port = parseInt(portArg || process.env.MCP_SANDBOX_PORT || "3100");

    if (httpMode) {
        // Pre-populate toolRegistry so REST /api/tools/* works before the first MCP session connects.
        // McpServer with no transport: sendLoggingMessage() calls inside handlers will fail silently
        // (all callers already use .catch(() => {})), so this is safe.
        const _registryServer = new McpServer({ name: "carapa-box", version: "0.1.0", description: "registry-only" });
        registerTools(_registryServer);

        const hostname = resolveBindHost(args);
        const bindError = bindHostError(hostname, process.env.CARAPA_BOX_API_TOKEN);
        if (bindError) {
            logger.error(`[SECURITY] ${bindError}`);
            process.exit(1);
        }
        logger.info(`CarapaBox (HTTP) on ${hostname}:${port}`);
        // @ts-ignore Bun-specific API — suppress depends on tsconfig target
        const server = Bun.serve({
            hostname,
            port,
            fetch: handleBunRequest,
            idleTimeout: 255 // Max allowed by Bun; per-request timeout(req, 0) handles SSE streams
        });
        setBunServer(server);
        startHub({ host: hostname, port });
    } else {
        // Stdio transport (default)
        const s = new McpServer({
            name: "carapa-box",
            version: "0.1.0",
            description: "CarapaBox - Manages isolated Docker-based coding environments.",
        }, { capabilities: { logging: {} } });
        registerTools(s);
        const transport = new StdioServerTransport();
        await s.connect(transport);
        logger.info("CarapaBox running on stdio");
    }
}

// --- HUB CONNECTION ---
let hubHandle: HubConnectionHandle | null = null;

/** Dial the CarapaBoard hub when configured (CARAPA_HUB_URL / CARAPA_BOX_ID / CARAPA_HUB_BOX_SECRET). */
function startHub(listen: { host: string; port: number }): void {
    let config;
    try {
        config = hubConfigFromEnv(process.env, BOX_VERSION, listen);
    } catch (err) {
        logger.error({ err }, "[hub] Invalid hub configuration; hub connection disabled");
        return;
    }
    if (!config) return;
    hubHandle = startHubConnection(config, (server) => registerTools(server, false));
}

// --- GRACEFUL SHUTDOWN ---
let _shutdownInitiated = false;

async function shutdown(signal: string): Promise<void> {
    if (_shutdownInitiated) return;
    _shutdownInitiated = true;

    logger.info(`[CarapaBox] Received ${signal}, shutting down gracefully...`);

    // Drain: refuse new tool calls, let running ones finish. HTTP server and hub stay open
    // so in-flight calls can still deliver their responses.
    startDraining();
    const pending = inflightCount();
    if (pending > 0) {
        const limit = drainLimitFromEnv();
        logger.info(`[CarapaBox] Waiting up to ${limit}ms for ${pending} in-flight tool call(s)...`);
        const idle = await waitForIdle(limit, 100, remaining =>
            logger.info(`[CarapaBox] Still waiting for ${remaining} in-flight tool call(s)...`)
        );
        if (!idle) {
            logger.warn(`[CarapaBox] Drain limit reached with ${inflightCount()} tool call(s) still running; shutting down anyway.`);
        }
    }

    hubHandle?.stop();

    // Stop network policy file watcher
    stopNetworkPolicyWatcher();

    // Stop any tmux pane readers so they don't outlive the box process.
    // stopAllTmuxReaders() aborts every AbortController, which triggers the
    // teardown path (kills the docker exec, removes the FIFO, runs
    // `tmux pipe-pane` with no target to stop piping).
    try {
        const { stopAllTmuxReaders } = await import("./tmux-session.js");
        stopAllTmuxReaders();
    } catch (err) {
        logger.warn({ err }, "[CarapaBox] Failed to stop tmux readers during shutdown");
    }

    // Close all active MCP sessions
    if (activeSessions.size > 0) {
        logger.info(`[CarapaBox] Closing ${activeSessions.size} active session(s)...`);
        const SESSION_CLOSE_TIMEOUT_MS = 5_000;
        const closeAll = Promise.allSettled(
            [...activeSessions.values()].map(async entry => {
                await entry.server.close();
                await entry.transport.close();
            })
        );
        const timeout = new Promise<void>(resolve =>
            setTimeout(() => {
                logger.warn("[CarapaBox] Session close timed out; proceeding with shutdown.");
                resolve();
            }, SESSION_CLOSE_TIMEOUT_MS).unref()
        );
        await Promise.race([closeAll, timeout]);
        activeSessions.clear();
    }

    // Stop the HTTP server (force-closes active connections immediately)
    const { _bunServer } = await import("./http/server.js");
    if (_bunServer !== null) {
        _bunServer.stop(true);
        setBunServer(null);
        logger.info("[CarapaBox] HTTP server stopped.");
    }

    logger.info("[CarapaBox] Shutdown complete.");
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM").catch(e => {
    logger.error({ err: e }, "[CarapaBox] SIGTERM shutdown error");
    process.exit(1);
}));
process.on("SIGINT", () => shutdown("SIGINT").catch(e => {
    logger.error({ err: e }, "[CarapaBox] SIGINT shutdown error");
    process.exit(1);
}));

/** Log a fatal startup error (with the Error object under `err`) and exit non-zero so the container restarts. */
export function handleFatalStartupError(
    err: unknown,
    deps: { logger: { error: (obj: { err: unknown }, msg: string) => void }; exit: (code: number) => unknown } = { logger, exit: process.exit },
): void {
    deps.logger.error({ err }, "[CarapaBox] Fatal startup error");
    deps.exit(1);
}

if (import.meta.main) {
    main().catch(e => handleFatalStartupError(e));
}
