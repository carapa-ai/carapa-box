import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INSTANCE_PROXIES, connectInstanceProxies, reconnectInstanceProxies, readNetworkReservation, reserveInstanceNetwork, networkAddressAllocator } from "./network-reservations.js";
import { assignIngressServiceAddresses } from './ingress.js';

let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "carapa-network-reservations-")); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture(project: string) {
    const name = `agent_egress_${project}`;
    const calls: string[][] = [];
    let sequence = 0;
    const state = { network: undefined as any, agentIp: "", service: "agent", failExplicitCreate: false };
    const ok = (value = "") => ({ status: 0, stdout: value, stderr: "" });
    const fail = (stderr: string) => ({ status: 1, stdout: "", stderr });
    const createLegacy = () => {
        state.network = {
            Id: `network-${++sequence}`, Name: name, Driver: "bridge", Internal: true,
            IPAM: { Driver: "default", Config: [{ Subnet: "172.16.0.96/28", Gateway: "172.16.0.97" }] },
            Labels: {}, Options: {}, Containers: {},
        };
    };
    const deps = {
        directory: path.join(root, project),
        execDocker: async (args: string[]) => {
            calls.push(args);
            if (args[0] === "ps") return ok(state.agentIp ? "agent-id\n" : "");
            if (args[0] === "inspect") return ok(JSON.stringify([{
                Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": state.service } },
                NetworkSettings: { Networks: { [name]: { IPAddress: state.agentIp } } },
            }]));
            if (args[0] !== "network") throw new Error(`Unexpected Docker call: ${args}`);
            if (args[1] === "inspect") return state.network ? ok(JSON.stringify([state.network])) : fail(`network ${name} not found`);
            if (args[1] === "create") {
                if (args.includes("--subnet") && state.failExplicitCreate) return fail("Pool overlaps with other one on this address space");
                if (state.network) return fail("network already exists");
                createLegacy();
                if (args.includes("--subnet")) {
                    state.network.IPAM.Config[0].Subnet = args[args.indexOf("--subnet") + 1];
                    state.network.IPAM.Config[0].Gateway = args[args.indexOf("--gateway") + 1];
                    const [key, value] = args[args.indexOf("--label") + 1].split("=");
                    state.network.Labels[key] = value;
                }
                return ok(state.network.Id);
            }
            if (args[1] === "disconnect") {
                delete state.network.Containers[args.at(-1)!];
                return ok();
            }
            if (args[1] === "rm") {
                if (Object.keys(state.network.Containers).length) return fail("network has active endpoints");
                state.network = undefined;
                return ok();
            }
            if (args[1] === "connect") {
                const container = args.at(-1)!;
                if (state.network.Containers[container]) return fail("endpoint already exists");
                if (!Object.keys(state.network.Labels).length && args.includes("--ip")) {
                    return fail("user specified IP address is supported only when connecting to networks with user configured subnets");
                }
                const ip = args[args.indexOf("--ip") + 1];
                if (Object.values(state.network.Containers).some((endpoint: any) => endpoint.IPv4Address === `${ip}/28`)) return fail("Address already in use");
                state.network.Containers[container] = { Name: container, IPv4Address: `${ip}/28` };
                return ok();
            }
            throw new Error(`Unexpected network operation: ${args}`);
        },
    };
    return { state, calls, deps, createLegacy, name };
}

test('ingress service allocation preserves stopped proxy slots and existing service addresses', async () => {
    const f = fixture('extra-services');
    const saved = (await reserveInstanceNetwork('extra-services', true, f.deps))!;
    // No proxy endpoints are live: Docker would treat every saved slot as free.
    f.state.network.Containers.nginx = { Name: 'extra-services-nginx-1', IPv4Address: '172.16.0.98/28' };
    const model = { services: {
        agent: { networks: { agent_egress: { ipv4_address: saved.agentIp } } },
        nginx: { networks: { agent_egress: null as any } },
        api: { networks: { agent_egress: null as any } },
        fixed: { networks: { agent_egress: { ipv4_address: '172.16.0.105' } } },
    } };
    await assignIngressServiceAddresses(model, 'extra-services', f.deps);
    expect(model.services.agent.networks.agent_egress.ipv4_address).toBe(saved.agentIp);
    expect(model.services.nginx.networks.agent_egress.ipv4_address).toBe('172.16.0.98');
    const apiIp = model.services.api.networks.agent_egress.ipv4_address;
    expect(model.services.fixed.networks.agent_egress.ipv4_address).toBe('172.16.0.105');
    expect([saved.agentIp, saved.gateway, ...Object.values(saved.proxyIps), '172.16.0.98', '172.16.0.105']).not.toContain(apiIp);
    const allocate = (await networkAddressAllocator(f.name, f.deps))!;
    expect(() => allocate('ingress', saved.proxyIps['egress-proxy-llama-proxy-1'])).toThrow('conflicts');
    expect(() => allocate('ingress', '172.16.0.98')).toThrow('conflicts');
    expect(() => allocate('ingress', '172.16.1.98')).toThrow('conflicts');
    for (let i = 98; i < 111; i++) f.state.network.Containers[`peer-${i}`] = { Name: `peer-${i}`, IPv4Address: `172.16.0.${i}/28` };
    const full = (await networkAddressAllocator(f.name, f.deps))!;
    expect(() => full('ingress')).toThrow('No unreserved addresses');
    expect(await readNetworkReservation(f.name, f.deps)).toEqual(saved);
});

test("new instances use explicit IPAM and preserve reservations through controller and network recreation", async () => {
    const f = fixture("new-instance");
    const [reservation, concurrent] = await Promise.all([
        reserveInstanceNetwork("new-instance", true, f.deps),
        reserveInstanceNetwork("new-instance", true, f.deps),
    ]);
    expect(reservation).toEqual(concurrent);
    expect(f.calls.filter(args => args[1] === "rm")).toHaveLength(1);
    expect(f.calls.filter(args => args[1] === "create").at(-1)).toContain("--subnet");
    expect((await connectInstanceProxies(f.name, f.deps)).every(result => result.result.status === 0)).toBe(true);
    const before = structuredClone(f.state.network.Containers);
    f.state.network.Containers = {};
    expect((await connectInstanceProxies(f.name, f.deps)).every(result => result.result.status === 0)).toBe(true);
    expect(f.state.network.Containers).toEqual(before);
    expect(Object.values(before).some((endpoint: any) => endpoint.IPv4Address.startsWith(`${reservation!.agentIp}/`))).toBe(false);
    const recoveredDeps = { ...f.deps };
    expect(await readNetworkReservation(f.name, recoveredDeps)).toEqual(reservation);
    f.state.network = undefined; // External prune: recover the same subnet, not a fresh allocation.
    expect(await reserveInstanceNetwork("new-instance", true, recoveredDeps)).toEqual(reservation);
    expect(f.state.network.IPAM.Config[0].Subnet).toBe(reservation!.subnet);
    expect(f.calls.at(-2)).toContain("--subnet");
});

test("legacy migration captures the live address but only replaces the network after agent teardown", async () => {
    const f = fixture("legacy");
    f.createLegacy();
    f.state.agentIp = "172.16.0.102";
    f.state.network.Containers["agent-id"] = { Name: "legacy-agent-1", IPv4Address: "172.16.0.102/28" };
    INSTANCE_PROXIES.forEach((proxy, index) => {
        f.state.network.Containers[proxy.container] = { Name: proxy.container, IPv4Address: `172.16.0.${98 + index}/28` };
    });
    const reservation = await reserveInstanceNetwork("legacy", false, f.deps);
    expect(reservation!.agentIp).toBe("172.16.0.102");
    expect(f.calls.some(args => ["rm", "disconnect", "create"].includes(args[1]))).toBe(false);
    await expect(reserveInstanceNetwork("legacy", true, f.deps)).rejects.toThrow("Stop legacy");
    expect(f.calls.some(args => args[1] === "disconnect")).toBe(false);
    delete f.state.network.Containers["agent-id"];
    f.state.agentIp = "";
    expect(await reserveInstanceNetwork("legacy", true, f.deps)).toEqual(reservation);
    expect((await connectInstanceProxies(f.name, f.deps)).every(result => result.result.status === 0)).toBe(true);
    INSTANCE_PROXIES.forEach((proxy, index) => {
        expect(f.state.network.Containers[proxy.container].IPv4Address).toBe(`172.16.0.${98 + index}/28`);
    });
    const removes = f.calls.filter(args => args[1] === "rm").length;
    await reserveInstanceNetwork("legacy", true, f.deps);
    expect(f.calls.filter(args => args[1] === "rm")).toHaveLength(removes);
});

test("failed subnet recovery preserves the durable address and refuses conflicting or foreign networks", async () => {
    const f = fixture("recovery");
    f.state.failExplicitCreate = true;
    await expect(reserveInstanceNetwork("recovery", true, f.deps)).rejects.toThrow("Cannot restore reserved subnet");
    const saved = await readNetworkReservation(f.name, f.deps);
    expect(saved).toBeDefined();
    f.state.failExplicitCreate = false;
    expect(await reserveInstanceNetwork("recovery", true, f.deps)).toEqual(saved);
    f.state.network.IPAM.Config[0] = { Subnet: "172.16.0.112/28", Gateway: "172.16.0.113" };
    await expect(reserveInstanceNetwork("recovery", true, f.deps)).rejects.toThrow("no longer matches");
    f.state.network.IPAM.Config[0] = { Subnet: saved!.subnet, Gateway: saved!.gateway };
    f.state.network.Labels = {};
    f.state.network.Containers.foreign = { Name: "unrelated-container", IPv4Address: "172.16.0.103/28" };
    const before = f.calls.filter(args => args[1] === "disconnect").length;
    await expect(reserveInstanceNetwork("recovery", true, f.deps)).rejects.toThrow("non-proxy containers");
    expect(f.calls.filter(args => args[1] === "disconnect")).toHaveLength(before);
});


test('startup recovery skips existing proxy attachments and bounds work across many networks', async () => {
    const networks = Array.from({ length: 43 }, (_, i) => `agent_egress_recovery${i}`);
    const calls: string[][] = [];
    let connected = true;
    let active = 0;
    let peak = 0;
    const deps = {
        directory: path.join(root, 'bounded-recovery'),
        execDocker: async (args: string[]) => {
            calls.push(args);
            active++;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 0));
            active--;
            if (args[0] === 'inspect') return { status: 0, stderr: '', stdout: JSON.stringify([{
                NetworkSettings: { Networks: connected ? Object.fromEntries(networks.map(n => [n, { IPAddress: '172.30.0.2' }])) : {} },
            }]) };
            expect(args.slice(0, 2)).toEqual(['network', 'connect']);
            return { status: 0, stderr: '', stdout: '' };
        },
    };
    expect(await reconnectInstanceProxies(networks, deps)).toEqual([]);
    expect(calls).toHaveLength(INSTANCE_PROXIES.length);
    connected = false;
    calls.length = 0;
    const results = await reconnectInstanceProxies(networks, deps);
    expect(results).toHaveLength(networks.length * INSTANCE_PROXIES.length);
    expect(peak).toBeLessThanOrEqual(INSTANCE_PROXIES.length);
    expect(new Set(results.map(r => `${r.network}/${r.container}`)).size).toBe(results.length);
});


test("legacy service identity is adopted only from the existing owner without renumbering", async () => {
    const f = fixture("php-legacy");
    f.createLegacy();
    f.state.agentIp = "172.16.0.102";
    f.state.service = "php84";
    const original = await reserveInstanceNetwork("php-legacy", false, f.deps, "php84");
    const legacy = { ...original! };
    delete legacy.service;
    const file = path.join(f.deps.directory, `${f.name}.json`);
    await fs.writeFile(file, JSON.stringify(legacy));
    f.state.agentIp = "172.16.0.103";
    await expect(reserveInstanceNetwork("php-legacy", false, f.deps, "php84")).rejects.toThrow("Cannot verify legacy reservation owner");
    expect(await readNetworkReservation(f.name, f.deps)).toEqual(legacy);
    f.state.agentIp = legacy.agentIp;
    f.state.service = "foreign";
    await expect(reserveInstanceNetwork("php-legacy", false, f.deps, "php84")).rejects.toThrow("Cannot verify legacy reservation owner");
    f.state.service = "php84";
    expect(await reserveInstanceNetwork("php-legacy", false, f.deps, "php84")).toEqual(original);
    f.state.agentIp = ""; // Later restart can recover even after the old container is gone.
    expect(await reserveInstanceNetwork("php-legacy", false, f.deps, "php84")).toEqual(original);
    await expect(reserveInstanceNetwork("php-legacy", false, f.deps, "agent")).rejects.toThrow("different service");
});

test('retired playwright-mcp proxy is never connected and its stale reservation key is tolerated', async () => {
    const f = fixture('retired-proxy');
    const reservation = (await reserveInstanceNetwork('retired-proxy', true, f.deps))!;
    expect(Object.keys(reservation.proxyIps)).not.toContain('playwright-mcp');
    expect((await connectInstanceProxies(f.name, f.deps)).every(result => result.result.status === 0)).toBe(true);
    f.state.network.Containers = {};
    await reconnectInstanceProxies([f.name], f.deps);
    expect(f.calls.filter(args => args[1] === 'connect' && args.includes('playwright-mcp'))).toEqual([]);

    // A reservation stored before the proxy was retired still carries its key.
    const staleIp = '172.16.0.106';
    const file = path.join(f.deps.directory, `${f.name}.json`);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.proxyIps['playwright-mcp'] = staleIp;
    await fs.writeFile(file, JSON.stringify(stored));
    expect(await readNetworkReservation(f.name, f.deps)).toEqual(stored);
    // The stale address stays reserved so it is not reused while an old container may hold it.
    const allocate = (await networkAddressAllocator(f.name, f.deps))!;
    expect(() => allocate('ingress', staleIp)).toThrow('conflicts');
});
