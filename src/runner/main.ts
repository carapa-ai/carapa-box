#!/usr/bin/env bun
/**
 * carapa-runner: a Docker-less CarapaBox for machines without containers
 * (e.g. a Mac). It dials the CarapaBoard hub like a Linux box (kind
 * "native"), runs the shared agent runtime natively under Claude Code's
 * sandbox (Seatbelt), and sends model/Board traffic through a local signed
 * relay forwarder to the hub. No provider credential is stored here.
 *
 *   bun run src/runner/main.ts        (config: ~/.carapa-runner/config.json)
 */
import fs from "node:fs";
import path from "node:path";
// @ts-ignore -- plain Node module also used by the standalone relay
import { startApiRelay } from "../../egress-proxy/api-relay/api-relay.mjs";
import { startHubConnection } from "../hub/hub-client.js";
import { auditLog } from "../audit.js";
import { loadRunnerConfig } from "./config.js";
import { CredentialStore, startCredentialLookup } from "./credentials.js";
import { loadProjects, restoreProjects, saveProjects } from "./projects.js";
import { errorText, registerRunnerTools, runSandboxed, type RunnerContext } from "./tools.js";
import { platformWrapper } from "./os-sandbox.js";
import { OpenShellBackend, SANDBOX_TMUX } from "./openshell.js";
import { StackServices } from "./stack-service.js";
import { startLlamaRoute } from "./llama.js";
import type { ProjectHost } from "./sandbox-host.js";
import { NativeBrowser } from "./browser.js";
import { findTmux, NativeTmux } from "./tmux.js";
import { runnerVersion } from "./version.js";

const VERSION = runnerVersion();

async function main(): Promise<void> {
    const config = loadRunnerConfig();
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    // Fail before connecting when agents cannot be confined.
    const openshell = config.openshell ? new OpenShellBackend(config, config.openshell) : undefined;
    const wrap = platformWrapper(config, openshell?.wrapper());
    const hosts = new Map<string, ProjectHost>();
    const stateFile = path.join(config.stateDir, "projects.json");
    const projects = loadProjects(stateFile);
    const save = () => saveProjects(stateFile, projects.values());
    // Projects that were running stay running (sandbox hosts start lazily); the others stay stopped.
    restoreProjects(projects.values(), config);
    save();

    const credentials = new CredentialStore(path.join(config.stateDir, "relay-credentials.json"));
    const lookup = await startCredentialLookup(credentials);

    // Local forwarder: agents address it as http://127.0.0.1:<port>/s/<project>/<capability>/...
    const forwarderEnv: Record<string, string> = {
        HTTP_PROXY: "http://127.0.0.1:9",
        SNI_BRIDGE_PORT: "0",
        RELAY_MODE: "forward",
        RELAY_FORWARD_PATH_IDENTITY: "1",
        CARAPA_RELAY_UPSTREAM: config.relayUpstream,
        CARAPA_RELAY_UPSTREAM_INSECURE: config.relayUpstreamInsecure ? "1" : "",
        CARAPA_BOX_ID: config.boxId,
        CARAPA_BOX_URL: lookup.url,
        CARAPA_BOX_API_TOKEN: lookup.key,
    };
    forwarderEnv.CARAPA_HUB_BOX_SECRET = config.credential;
    const llamaRoute = await startLlamaRoute(config);
    const relay = startApiRelay({
        port: config.relayPort,
        host: "127.0.0.1",
        // Only a running project's current capability identifies it.
        pathCapability: (project: string) => {
            const native = projects.get(project);
            return native?.running ? native.relayCapability : undefined;
        },
        clientsDir: path.resolve(import.meta.dir, "..", "..", "egress-proxy", "relay-clients"),
        env: forwarderEnv,
        localRoute: llamaRoute,
    });

    const ctx: RunnerContext = { config, projects, credentials, wrap, hosts, backend: openshell, save };
    if (openshell && Object.values(config.openshell!.stacks).some(stack => stack.service)) {
        ctx.services = new StackServices({
            config, openshell: config.openshell!,
            run: (native, file, argv, options) => runSandboxed(ctx, native, file, argv, options),
            forwardArgv: (native, service) => openshell.forwardArgv(native, service),
        });
        // Adopt the services that kept running (or restart them); the hub connection does not wait for it.
        void ctx.services.restore(projects.values()).then(save);
    }
    const tmux = new NativeTmux(ctx, { findTmux: () => (openshell ? SANDBOX_TMUX : findTmux()), audit: auditLog });
    ctx.tmux = tmux;
    const browser = new NativeBrowser(ctx, { audit: auditLog });
    ctx.browser = browser;
    const hub = startHubConnection({
        url: hubConnectUrl(config.hubUrl),
        boxId: config.boxId,
        credential: config.credential,
        kind: "native",
        isolation: openshell ? "openshell" : "reduced",
        version: VERSION,
        // http-tunnel: Board's shell tab and browser viewer reach the tmux and browser routes over the hub socket.
        capabilities: ["ipc-sync", "relay-token", "http-tunnel"],
        // Tunnelled /api/tmux/* and /api/browser/* requests run in this process: the runner opens no port.
        // The token is unused (nothing leaves the process); the hub socket authenticates Board.
        tunnel: {
            baseUrl: "http://native-runner.invalid",
            token: "",
            fetchImpl: (input, init) => {
                const req = new Request(input, init);
                const { pathname } = new URL(req.url);
                return pathname === "/api/browser" || pathname.startsWith("/api/browser/") ? browser.handle(req) : tmux.handle(req);
            },
        },
    }, (server) => registerRunnerTools(server, ctx));

    const shutdown = () => {
        ctx.services?.stopAll();
        hub.stop();
        relay.close();
        lookup.close();
        // Pane readers and viewers end first, so no pipe keeps writing into a FIFO nobody reads.
        void Promise.allSettled([tmux.stopAll(), browser.stopAll()]).finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`[carapa-runner] ${config.boxId}: root ${config.root}, relay forwarder 127.0.0.1:${config.relayPort}`);
    if (llamaRoute) console.log(`[carapa-runner] llama-proxy ports ${config.llamaPorts.join(", ")} → ${config.llamaUpstreamHost}`);
}

/** Same URL rules as a Linux box (wss:// for remote hubs). */
function hubConnectUrl(raw: string): string {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol === "ws:" && !local && process.env.CARAPA_HUB_ALLOW_INSECURE !== "1") {
        throw new Error("hubUrl must use wss:// for a remote hub");
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/api/boxes/connect";
    return parsed.toString();
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`[carapa-runner] ${errorText(error)}`);
        process.exit(1);
    });
}
