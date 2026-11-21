import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { execDocker, execDockerWithTimeout, splitDockerOutput } from "./utils.js";
import { ingressEnabled, ingressSettings, isValidIngressIdentifier, readIngressSsh, requireIngressMigration, setIngressSsh, waitIngressRoute, checkIngressRoute } from './ingress.js';
import type { ContainerStatus } from './compose/inventory.js';

export interface SandboxSshStatus {
    supported: boolean;
    containerRunning: boolean;
    running: boolean;
    enabled?: boolean;
    pending?: boolean;
    service?: string;
    host?: string;
    port?: number;
    user?: string;
    command?: string;
    internalHost?: string;
    ingress?: boolean;
    error?: string;
}

// ssh-control.sh waits up to 10 s for its lock, and start polls up to 2 s more.
const SSH_CONTROL_TIMEOUT_MS = 20000;
const SSH_NOT_ENABLED_ERROR = "SSH is running inside the sandbox but was not enabled through CarapaBox; no route is published";
const tails = new Map<string, Promise<void>>();
const ingressControl = { enabled: ingressEnabled, settings: ingressSettings, requireMigration: requireIngressMigration, setSsh: setIngressSsh, readSsh: readIngressSsh, waitRoute: waitIngressRoute, checkRoute: checkIngressRoute };

export async function controlSandboxSsh(
    stackPath: string,
    projectName: string,
    action: "status" | "start" | "stop" = "status",
    deps: { readFile: typeof fs.readFile; execDocker: typeof execDocker; ingress?: typeof ingressControl; containers?: readonly ContainerStatus[]; controlTimeoutMs?: number } = { readFile: fs.readFile, execDocker },
): Promise<SandboxSshStatus> {
    const ingress = deps.ingress ?? ingressControl;
    if (!isValidIngressIdentifier(projectName)) throw new Error("Invalid sandbox project name");
    const previous = tails.get(projectName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(projectName, current);
    await previous;
    try {
        let manifest: { service: string; port: number };
        try {
            manifest = JSON.parse(await deps.readFile(path.join(stackPath, "ssh.json"), "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (action !== "status") throw new Error("This stack does not support managed SSH. Update the stack and rebuild its image first.");
            return { supported: false, containerRunning: false, running: false };
        }
        if (!isValidIngressIdentifier(manifest.service) || manifest.port !== 2222) {
            throw new Error("Invalid stack SSH configuration");
        }
        const state: SandboxSshStatus = {
            supported: true, containerRunning: false, running: false,
            service: manifest.service, port: manifest.port, user: "ubuntu",
        };
        // Revoke ingress before stopping the daemon, even if the container has
        // already disappeared. Stale sessions must not survive an SSH disable.
        let ingressStopError: unknown;
        if (ingress.enabled() && action === 'stop') {
            try { await ingress.setSsh(projectName, manifest.service, false); }
            catch (error) { ingressStopError = error; }
        }
        // A list refresh already has a fresh Docker snapshot. Mutations always
        // discover again after acquiring the project lock.
        const snapshot = action === 'status' ? deps.containers?.filter(container =>
            container.Config.Labels?.['com.docker.compose.project'] === projectName &&
            container.Config.Labels?.['com.docker.compose.service'] === manifest.service) : undefined;
        let ids: string[];
        if (snapshot) {
            ids = snapshot.map(container => container.Id);
        } else {
            const listed = await deps.execDocker([
                "ps", "-a", "--filter", `label=com.docker.compose.project=${projectName}`,
                "--filter", `label=com.docker.compose.service=${manifest.service}`,
                "--format", "{{.ID}}",
            ]);
            if (listed.status !== 0) throw new Error(listed.stderr || "Could not find sandbox container");
            ids = splitDockerOutput(listed.stdout);
        }
        if (ids.length > 1) throw new Error("SSH requires exactly one agent container per sandbox");
        if (!ids.length) return { ...state, pending: action !== "status" };
        let container = snapshot?.[0];
        if (!snapshot) {
            const inspected = await deps.execDocker(["inspect", ids[0]]);
            if (inspected.status !== 0) throw new Error(inspected.stderr || "Could not inspect sandbox container");
            [container] = JSON.parse(inspected.stdout);
        }
        if (container?.Config?.Labels?.["com.docker.compose.project"] !== projectName ||
            container?.Config?.Labels?.["com.docker.compose.service"] !== manifest.service) {
            throw new Error("Container does not belong to the requested sandbox");
        }
        if (!container.State?.Running) return { ...state, pending: action !== "status" };
        state.containerRunning = true;
        // Connect from the Docker host directly to the internal bridge address.
        // Prefer the instance's isolated network; never guess between multiple
        // unrelated addresses, or substitute a published host port.
        const networks = container.NetworkSettings?.Networks ?? {};
        const preferred = networks[`agent_egress_${projectName}`] ?? networks.agent_egress;
        let host = typeof preferred?.IPAddress === "string" && isIP(preferred.IPAddress) === 4
            ? preferred.IPAddress
            : undefined;
        if (!host && !preferred) {
            const addresses = [...new Set(Object.values(networks)
                .map((endpoint: any) => endpoint?.IPAddress)
                .filter((address): address is string => typeof address === "string" && isIP(address) === 4))];
            host = addresses.length === 1 ? addresses[0] : undefined;
        }
        if (host) state.host = host;
        // The approved stack selects its runtime; SSH does not change it.
        // Disabling remains possible even when networking is unavailable.
        if (action !== "stop" && !host) {
            const error = "The sandbox has no unambiguous internal IPv4 address for SSH";
            if (action === "start") throw new Error(error);
            return { ...state, error };
        }
        // Reject an unmigrated project before starting SSH or waiting on a
        // route that the reconciler cannot publish. Stopping always remains possible.
        if (ingress.enabled() && action === 'start') await ingress.requireMigration(projectName);
        const result = await execDockerWithTimeout(deps.execDocker, [
            "exec", "--user", "1000:1000", ids[0],
            "/bin/bash", "/usr/local/ai-cli-bin/ssh-control.sh", action,
        ], deps.controlTimeoutMs ?? SSH_CONTROL_TIMEOUT_MS);
        if (result.status !== 0) {
            const error = result.stderr.trim() || "SSH control unavailable; rebuild and recreate the sandbox";
            if (action !== "status") throw new Error(error);
            return { ...state, error };
        }
        const daemon = JSON.parse(result.stdout.trim());
        if (typeof daemon.enabled !== "boolean" || typeof daemon.running !== "boolean") {
            throw new Error("Invalid SSH daemon status");
        }
        if (action === "start" && !daemon.running) throw new Error("SSH listener did not start");
        if (action === "stop" && daemon.running) throw new Error("SSH listener did not stop");
        if (ingressStopError) return { ...state, enabled: daemon.enabled, running: false, ingress: true, error: String(ingressStopError) };
        let connectionHost = host;
        let connectionPort: number | undefined = manifest.port;
        if (ingress.enabled()) {
            state.ingress = true;
            state.internalHost = host;
            connectionHost = ingress.settings().host;
            // Only start/stop change the operator's intent. A status refresh reads it and
            // never trusts the sandbox-reported daemon state to reserve a port or publish a route.
            let published = false;
            if (action === 'status') {
                const intent = await ingress.readSsh(projectName, manifest.service);
                published = intent.enabled && intent.port !== undefined;
                connectionPort = published ? intent.port : undefined;
            } else {
                connectionPort = await ingress.setSsh(projectName, manifest.service, daemon.running);
            }
            state.host = connectionHost;
            state.port = connectionPort;
            // No reservation: SSH was never enabled, so there is no route to check or wait for.
            if (action === 'status') {
                try { await ingress.requireMigration(projectName); }
                catch (error) { return { ...state, enabled: daemon.enabled, running: daemon.running, error: String(error) }; }
                if (!published && daemon.running) {
                    return { ...state, enabled: daemon.enabled, running: true, error: SSH_NOT_ENABLED_ERROR };
                }
            }
            if (daemon.running && connectionPort !== undefined) {
                try { await (action === 'status' ? ingress.checkRoute(connectionPort) : ingress.waitRoute(connectionPort)); }
                catch (error) {
                    if (action === 'start') throw error;
                    return { ...state, enabled: daemon.enabled, running: daemon.running, error: String(error) };
                }
            } else if (action === 'stop' && connectionPort !== undefined) {
                // Daemon shutdown must succeed even if the proxy/controller is
                // unavailable. Report propagation failure after killing sessions.
                try { await ingress.waitRoute(connectionPort, false); }
                catch (error) { return { ...state, enabled: daemon.enabled, running: false, error: String(error) }; }
            }
        }
        return {
            ...state, enabled: daemon.enabled, running: daemon.running,
            ...(daemon.running && connectionHost ? { command: `ssh -p ${connectionPort} ubuntu@${connectionHost}` } : {}),
        };
    } finally {
        release();
        if (tails.get(projectName) === current) tails.delete(projectName);
    }
}
