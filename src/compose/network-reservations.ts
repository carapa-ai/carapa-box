import { getStateDir } from "../installation-paths.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { execDocker, splitDockerOutput } from "../utils.js";

export const INSTANCE_PROXIES = [
    { container: "egress-proxy-squid-1", alias: "squid" },
    { container: "egress-proxy-api-relay-1", alias: "api-relay" },
    { container: "egress-proxy-llama-proxy-1", alias: "llama-proxy" },
];

export interface NetworkReservation {
    network: string;
    service?: string;
    subnet: string;
    gateway: string;
    agentIp: string;
    proxyIps: Record<string, string>;
}

interface ReservationDependencies {
    directory: string;
    execDocker: typeof execDocker;
}

const defaults: ReservationDependencies = {
    directory: path.join(getStateDir(), "network-reservations"),
    // utils and the compose client form an import cycle. Resolve the live
    // executor at call time rather than capturing it during initialization.
    execDocker: (args, options) => execDocker(args, options),
};
const SUBNET_LABEL = "ai.carapa.explicit-instance-subnet";
const reservationsInFlight = new Map<string, Promise<unknown>>();

function reservationPath(network: string, deps: ReservationDependencies): string {
    if (!/^agent_egress_[a-zA-Z0-9_-]+$/.test(network)) {
        throw new Error("Invalid instance network name");
    }
    // /app/generated is a persistent, controller-only writable bind mount.
    return path.join(deps.directory, `${network}.json`);
}

function ipNumber(ip: string): number {
    if (typeof ip !== "string" || isIP(ip) !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
    return ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function ipString(ip: number): string {
    return [24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join(".");
}

function subnetRange(subnet: string): { first: number; last: number } {
    const match = typeof subnet === "string" && /^([^/]+)\/(\d+)$/.exec(subnet);
    if (!match) throw new Error(`Invalid IPv4 subnet: ${subnet}`);
    const prefix = Number(match[2]);
    if (prefix < 1 || prefix > 29) throw new Error(`Instance subnet is too small or unsupported: ${subnet}`);
    const first = ipNumber(match[1]);
    const size = 2 ** (32 - prefix);
    if (first % size !== 0) throw new Error(`Non-canonical subnet: ${subnet}`);
    return { first, last: first + size - 1 };
}

function validateReservation(value: NetworkReservation, network: string): NetworkReservation {
    if (!value || value.network !== network) throw new Error(`Invalid reservation for ${network}`);
    if (value.service !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(value.service)) {
        throw new Error(`Invalid reserved service for ${network}`);
    }
    const { first, last } = subnetRange(value.subnet);
    // Only current INSTANCE_PROXIES are validated. Keys of retired proxies in a
    // stored reservation are ignored on purpose: the file is not rewritten, and
    // networkAddressAllocator keeps their IPs reserved while an old container may
    // still hold them.
    const ips = [value.gateway, value.agentIp, ...INSTANCE_PROXIES.map(p => value.proxyIps?.[p.container])];
    const numbers = ips.map(ipNumber);
    if (numbers.some(ip => ip <= first || ip >= last) || new Set(numbers).size !== numbers.length) {
        throw new Error(`Conflicting or out-of-subnet addresses in reservation for ${network}`);
    }
    return value;
}

export async function readNetworkReservation(network: string, deps = defaults): Promise<NetworkReservation | undefined> {
    try {
        return validateReservation(JSON.parse(await fs.readFile(reservationPath(network, deps), "utf8")), network);
    } catch (error: any) {
        if (error.code === "ENOENT") return undefined;
        throw error; // Never silently renumber a damaged reservation.
    }
}

/** Docker's dynamic IPAM does not know our durable reservations, and releases
 * stopped containers' addresses. Allocate extra endpoints outside those slots. */
export async function networkAddressAllocator(network: string, deps = defaults) {
    const reservation = await readNetworkReservation(network, deps);
    if (!reservation) return undefined;
    const inspected = await inspectNetwork(network, deps);
    if (!inspected) throw new Error(`Cannot allocate an address on missing network ${network}`);
    const config = networkConfig(inspected);
    if (config.Subnet !== reservation.subnet || config.Gateway !== reservation.gateway) {
        throw new Error(`${network} no longer matches its saved subnet`);
    }
    const reserved = new Set([reservation.gateway, reservation.agentIp, ...Object.values(reservation.proxyIps)]);
    const endpoints = Object.values(inspected.Containers ?? {}) as Array<{ Name: string; IPv4Address: string }>;
    const occupied = new Map<string, string>();
    const endpointIpByOwner = new Map<string, string>();
    for (const endpoint of endpoints) {
        const ip = endpoint.IPv4Address.split('/')[0];
        occupied.set(ip, endpoint.Name);
        if (!endpointIpByOwner.has(endpoint.Name)) {
            endpointIpByOwner.set(endpoint.Name, ip);
        }
    }
    const { first, last } = subnetRange(reservation.subnet);
    return (owner: string, requestedIp?: string): string => {
        const available = (ip: string) => !reserved.has(ip) && (!occupied.has(ip) || occupied.get(ip) === owner);
        if (requestedIp) {
            const number = ipNumber(requestedIp);
            if (number <= first || number >= last || !available(requestedIp)) {
                throw new Error(`${owner} address ${requestedIp} conflicts with a reserved or occupied address on ${network}`);
            }
            occupied.set(requestedIp, owner);
            return requestedIp;
        }
        const current = endpointIpByOwner.get(owner);
        if (current && available(current)) return current;
        for (let candidate = last - 1; candidate > first; candidate--) {
            const ip = ipString(candidate);
            if (available(ip)) {
                occupied.set(ip, owner);
                return ip;
            }
        }
        throw new Error(`No unreserved addresses available on ${network}`);
    };
}

async function persistReservation(value: NetworkReservation, deps: ReservationDependencies): Promise<NetworkReservation> {
    const destination = reservationPath(value.network, deps);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        // Publish an entire immutable file atomically, without replacing a
        // reservation concurrently created by another controller/CLI process.
        try {
            await fs.link(temporary, destination);
        } catch (error: any) {
            if (error.code !== "EEXIST") throw error;
        }
        return (await readNetworkReservation(value.network, deps))!;
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

async function inspectNetwork(network: string, deps: ReservationDependencies): Promise<any | undefined> {
    const result = await deps.execDocker(["network", "inspect", network]);
    if (result.status !== 0) {
        if (/no such network|network .* not found/i.test(result.stderr)) return undefined;
        throw new Error(result.stderr.trim() || `Cannot inspect ${network}`);
    }
    const inspected = JSON.parse(result.stdout)[0];
    if (!inspected || inspected.Name !== network || inspected.Internal !== true || inspected.Driver !== "bridge") {
        throw new Error(`${network} must be an internal bridge network`);
    }
    return inspected;
}

function networkConfig(inspected: any): { Subnet: string; Gateway: string } {
    const configs = inspected.IPAM?.Config;
    if (inspected.IPAM?.Driver !== "default" || !Array.isArray(configs) || configs.length !== 1 ||
        configs[0].IPRange || Object.keys(configs[0].AuxiliaryAddresses ?? {}).length) {
        throw new Error(`Unsupported custom IPAM configuration on ${inspected.Name}`);
    }
    subnetRange(configs[0].Subnet);
    ipNumber(configs[0].Gateway);
    return configs[0];
}

function explicitNetworkArgs(reservation: NetworkReservation): string[] {
    return ["network", "create", "--driver", "bridge", "--internal",
        "--subnet", reservation.subnet, "--gateway", reservation.gateway,
        "--label", `${SUBNET_LABEL}=1`, reservation.network];
}

/** Shared by normal starts and infrastructure proxy reconnects. */
export async function connectInstanceProxies(network: string, deps = defaults, proxies = INSTANCE_PROXIES) {
    const reservation = await readNetworkReservation(network, deps);
    return Promise.all(proxies.map(async ({ container, alias }) => ({
        container,
        result: await deps.execDocker([
            "network", "connect", "--alias", alias,
            ...(reservation ? ["--ip", reservation.proxyIps[container]] : []),
            network, container,
        ]),
    })));
}

/** Startup recovery should not enqueue four Docker commands per retained network.
 * Inspect each proxy once and connect only missing attachments, one network at a
 * time (at most four concurrent Docker commands, leaving process slots available). */
export async function reconnectInstanceProxies(networks: string[], deps = defaults) {
    const inspected = await Promise.all(INSTANCE_PROXIES.map(async proxy => {
        const result = await deps.execDocker(['inspect', proxy.container]);
        if (result.status !== 0) return null; // Optional or currently absent proxy.
        const [container] = JSON.parse(result.stdout);
        return container ? { proxy, networks: container.NetworkSettings?.Networks ?? {} } : null;
    }));
    const results = [];
    for (const network of networks) {
        const missing = inspected.flatMap(item => item && !item.networks[network] ? [item.proxy] : []);
        if (!missing.length) continue;
        for (const result of await connectInstanceProxies(network, deps, missing)) results.push({ network, ...result });
    }
    return results;
}

/** Keep the network itself as the Docker-side subnet reservation. The file
 * preserves endpoint assignments and permits exact recovery if it is removed.
 */
export async function reserveInstanceNetwork(project: string, deps = defaults, service = "agent"): Promise<NetworkReservation> {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(service)) throw new Error("Invalid reserved service name");
    const key = reservationPath(`agent_egress_${project}`, deps);
    const previous = reservationsInFlight.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => reserveNetwork(project, deps, service));
    reservationsInFlight.set(key, current);
    try {
        return await current;
    } finally {
        if (reservationsInFlight.get(key) === current) reservationsInFlight.delete(key);
    }
}

async function reserveNetwork(project: string, deps: ReservationDependencies, service: string): Promise<NetworkReservation> {
    const network = `agent_egress_${project}`;
    let reservation = await readNetworkReservation(network, deps);
    if (reservation && (reservation.service ?? "agent") !== service) {
        throw new Error(`${network} is reserved for a different service; refusing to transfer its IP`);
    }
    let inspected = await inspectNetwork(network, deps);
    // Set when this call created the empty network that only asks Docker's
    // configured address pools for a free subnet. Nothing is attached to it yet.
    let placeholder = false;
    if (!inspected) {
        // Recoveries already have a subnet and create it with explicit IPAM.
        placeholder = !reservation;
        const args = reservation ? explicitNetworkArgs(reservation) : ["network", "create", "--internal", network];
        const result = await deps.execDocker(args);
        inspected = await inspectNetwork(network, deps);
        if (!inspected) throw new Error(result.stderr.trim() || `Cannot create reserved network ${network}`);
    }
    const config = networkConfig(inspected);

    if (!reservation) {
        const endpoints = Object.values(inspected.Containers ?? {}) as Array<{ Name: string; IPv4Address: string }>;
        const occupied = new Set(endpoints.map(endpoint => endpoint.IPv4Address?.split("/")[0]).filter(Boolean));
        occupied.add(config.Gateway);
        const { first, last } = subnetRange(config.Subnet);
        const allocate = (): string => {
            // Start at the high end, away from Docker's usual dynamic allocations.
            for (let candidate = last - 1; candidate > first; candidate--) {
                const ip = ipString(candidate);
                if (!occupied.has(ip)) {
                    occupied.add(ip);
                    return ip;
                }
            }
            throw new Error(`No free addresses on ${network}`);
        };

        const agents = await deps.execDocker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`,
            "--filter", `label=com.docker.compose.service=${service}`]);
        if (agents.status !== 0) throw new Error(agents.stderr.trim() || "Cannot discover existing agent address");
        const ids = splitDockerOutput(agents.stdout);
        if (ids.length > 1) throw new Error(`Stable addressing requires one agent per instance: ${project}`);
        let agentIp: string | undefined;
        if (ids.length === 1) {
            const result = await deps.execDocker(["inspect", ids[0]]);
            if (result.status !== 0) throw new Error(result.stderr.trim() || "Cannot inspect existing agent");
            const container = JSON.parse(result.stdout)[0];
            const labels = container?.Config?.Labels;
            if (labels?.["com.docker.compose.project"] !== project || labels?.["com.docker.compose.service"] !== service) {
                throw new Error(`Agent ownership mismatch for ${project}`);
            }
            const current = container.NetworkSettings?.Networks?.[network]?.IPAddress;
            if (typeof current === "string" && isIP(current) === 4) agentIp = current;
        }
        agentIp ??= allocate();
        occupied.add(agentIp);
        const proxyIps: Record<string, string> = {};
        for (const proxy of INSTANCE_PROXIES) {
            const current = endpoints.find(endpoint => endpoint.Name === proxy.container)?.IPv4Address?.split("/")[0];
            proxyIps[proxy.container] = current || allocate();
        }
        reservation = await persistReservation(validateReservation({
            network, service, subnet: config.Subnet, gateway: config.Gateway, agentIp, proxyIps,
        }, network), deps);
    }

    if (config.Subnet !== reservation.subnet || config.Gateway !== reservation.gateway) {
        throw new Error(`${network} no longer matches its saved subnet; refusing to change the sandbox IP`);
    }
    if (placeholder) {
        // Replace it with explicit IPAM before any endpoint is attached. If
        // creation fails, the durable reservation lets the next start retry the
        // exact subnet, never an automatically chosen one.
        const removed = await deps.execDocker(["network", "rm", inspected.Id]);
        if (removed.status !== 0) throw new Error(removed.stderr.trim() || `Cannot replace placeholder network ${network}`);
        const created = await deps.execDocker(explicitNetworkArgs(reservation));
        if (created.status !== 0) {
            throw new Error(`Cannot restore reserved subnet for ${network}: ${created.stderr.trim()}`);
        }
    } else if (inspected.Labels?.[SUBNET_LABEL] !== "1") {
        throw new Error(`${network} has no explicit subnet label; recreate this sandbox`);
    }
    return reservation;
}
