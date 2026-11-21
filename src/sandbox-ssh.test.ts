import { describe, expect, test } from "bun:test";
import { controlSandboxSsh } from "./sandbox-ssh.js";

function fixture() {
    const calls: string[][] = [];
    const container = {
        Config: { Labels: { "com.docker.compose.project": "carapa-bot-demo", "com.docker.compose.service": "agent" } },
        State: { Running: true }, HostConfig: { Runtime: "runsc" },
        NetworkSettings: {
            Ports: { "2222/tcp": null },
            Networks: { "agent_egress_carapa-bot-demo": { IPAddress: "172.16.0.102" } },
        },
    };
    const deps = {
        ingress: {
            enabled: () => false,
            settings: () => { throw new Error('Unexpected ingress settings'); },
            requireMigration: async () => { throw new Error('Unexpected ingress migration'); },
            setSsh: async () => { throw new Error('Unexpected ingress mutation'); },
            readSsh: async () => { throw new Error('Unexpected ingress read'); },
            waitRoute: async () => { throw new Error('Unexpected ingress wait'); },
            checkRoute: async () => { throw new Error('Unexpected ingress check'); },
        },
        readFile: async () => JSON.stringify({ service: "agent", port: 2222 }),
        execDocker: async (args: string[]) => {
            calls.push(args);
            const stdout = args[0] === "ps" ? "abc123\n" : args[0] === "inspect" ? JSON.stringify([container]) : JSON.stringify({ enabled: args.at(-1) !== "stop", running: args.at(-1) !== "stop" });
            return { status: 0, stdout, stderr: "" };
        },
    } as unknown as NonNullable<Parameters<typeof controlSandboxSsh>[3]>;
    return { calls, container, deps };
}

describe("sandbox SSH control boundary", () => {
    test('status shares container discovery while mutations always discover fresh state', async () => {
        const { deps, calls, container } = fixture();
        deps.containers = [{ ...container, Id: 'snapshot-id', Name: '/carapa-bot-demo-agent-1', State: { Running: true, Status: 'running', StartedAt: '2026-01-01T00:00:00Z' } }];
        expect(await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps)).toMatchObject({ running: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('snapshot-id');
        calls.length = 0;
        await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'stop', deps);
        expect(calls.map(call => call[0])).toEqual(['ps', 'inspect', 'exec']);
        expect(calls.at(-1)).toContain('abc123');
        deps.containers = [];
        calls.length = 0;
        expect(await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps)).toMatchObject({ containerRunning: false, running: false });
        expect(calls).toHaveLength(0);
    });
    test('LAN commands require ingress acknowledgement; disabling still kills SSH when ingress is broken', async () => {
        const { deps, calls } = fixture();
        let unavailable = false;
        deps.ingress = {
            enabled: () => true,
            settings: () => ({ host: 'box.lan' } as any),
            requireMigration: async () => {},
            setSsh: async () => { if (unavailable) throw new Error('ingress unavailable'); return 22042; },
            readSsh: async () => ({ port: 22042, enabled: true }),
            waitRoute: async () => { if (unavailable) throw new Error('ingress unavailable'); },
            checkRoute: async () => {},
        };
        expect(await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'start', deps)).toMatchObject({
            running: true, ingress: true, internalHost: '172.16.0.102', host: 'box.lan', port: 22042, command: 'ssh -p 22042 ubuntu@box.lan',
        });
        deps.ingress.checkRoute = async () => { throw new Error('not acknowledged'); };
        const status = await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps);
        expect(status.command).toBeUndefined();
        expect(status.error).toContain('not acknowledged');
        unavailable = true;
        const stopped = await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'stop', deps);
        expect(stopped.running).toBe(false);
        expect(stopped.error).toContain('ingress unavailable');
        expect(calls.at(-1)?.at(-1)).toBe('stop');
    });

    test('status checks the route once and returns quickly when it is not published', async () => {
        const { deps } = fixture();
        let waits = 0;
        deps.ingress = {
            enabled: () => true,
            settings: () => ({ host: 'box.lan' } as any),
            requireMigration: async () => {},
            setSsh: async () => 22042,
            readSsh: async () => ({ port: 22042, enabled: true }),
            waitRoute: async () => { waits++; },
            checkRoute: async () => { throw new Error('Ingress route is not published'); },
        };
        const started = Date.now();
        const status = await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(status.error).toContain('not published');
        expect(status.command).toBeUndefined();
        expect(waits).toBe(0);
    });

    test('status never publishes an SSH route the operator did not enable, even when the sandbox runs its own daemon', async () => {
        for (const intent of [{ enabled: false }, { port: 22042, enabled: false }]) {
            const { deps } = fixture();
            const touched: string[] = [];
            deps.ingress = {
                enabled: () => true,
                // Only `host` is read; the full ingress settings object is not needed here.
                settings: () => ({ host: 'box.lan' } as any),
                requireMigration: async () => {},
                setSsh: async () => { touched.push('setSsh'); return 22042; },
                readSsh: async () => intent,
                waitRoute: async () => { touched.push('waitRoute'); },
                checkRoute: async () => { touched.push('checkRoute'); },
            };
            const status = await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps);
            expect(touched).toEqual([]);
            expect(status).toMatchObject({ running: true, ingress: true });
            expect(status.command).toBeUndefined();
            expect(status.port).toBeUndefined();
            expect(status.error).toContain('not enabled through CarapaBox');
        }
    });

    test('unmigrated sandboxes reject start before daemon changes and status reports migration without waiting', async () => {
        const { deps, calls } = fixture();
        deps.ingress = {
            enabled: () => true,
            settings: () => ({ host: 'box.lan' } as any),
            requireMigration: async () => { throw new Error('Restart the sandbox through CarapaBoard to migrate ingress'); },
            setSsh: async () => 22042,
            readSsh: async () => ({ port: 22042, enabled: true }),
            waitRoute: async () => { throw new Error('unexpected route wait'); },
            checkRoute: async () => { throw new Error('unexpected route check'); },
        };
        await expect(controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'start', deps)).rejects.toThrow('Restart the sandbox');
        expect(calls.some(call => call[0] === 'exec')).toBe(false);
        const status = await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'status', deps);
        expect(status).toMatchObject({ running: true, ingress: true, port: 22042 });
        expect(status.error).toContain('Restart the sandbox');
        expect(status.command).toBeUndefined();
        expect(await controlSandboxSsh('/stacks/carapa-bot', 'carapa-bot-demo', 'stop', deps)).toMatchObject({ running: false });
        expect(calls.at(-1)?.at(-1)).toBe('stop');
    });

    test("starts on the internal address without a published port and tracks address changes", async () => {
        const { calls, container, deps } = fixture();
        const result = await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "start", deps);
        expect(result).toMatchObject({ running: true, host: "172.16.0.102", port: 2222, command: "ssh -p 2222 ubuntu@172.16.0.102" });
        expect(calls.at(-1)).toEqual(["exec", "--user", "1000:1000", "abc123", "/bin/bash", "/usr/local/ai-cli-bin/ssh-control.sh", "start"]);
        container.NetworkSettings.Networks["agent_egress_carapa-bot-demo"].IPAddress = "172.16.0.118";
        expect(await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "status", deps)).toMatchObject({ command: "ssh -p 2222 ubuntu@172.16.0.118" });
        const stopped = await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "stop", deps);
        expect(stopped.running).toBe(false);
        expect(stopped.command).toBeUndefined();
    });

    test("a hung ssh-control exec times out instead of holding the request forever", async () => {
        const { deps } = fixture();
        const answer = deps.execDocker;
        deps.controlTimeoutMs = 100;
        // A sandbox-controlled FIFO lock makes the exec never answer, and it ignores the abort signal.
        deps.execDocker = (async (args: string[], options?: Parameters<typeof answer>[1]) => (
            args[0] === "exec" ? new Promise(() => {}) : answer(args, options)
        )) as typeof answer;
        const status = await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "status", deps);
        expect(status).toMatchObject({ running: false });
        expect(status.error).toContain("timed out");
        await expect(controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "start", deps)).rejects.toThrow("timed out");
    });

    test("supports SSH lifecycle on an approved NVIDIA stack", async () => {
        const { calls, container, deps } = fixture();
        container.HostConfig.Runtime = "nvidia";
        for (const action of ["start", "status", "stop"] as const) {
            const result = await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", action, deps);
            expect(result).toMatchObject({ enabled: action !== "stop", running: action !== "stop" });
            expect(result.error).toBeUndefined();
            expect(calls.at(-1)).toEqual(["exec", "--user", "1000:1000", "abc123", "/bin/bash", "/usr/local/ai-cli-bin/ssh-control.sh", action]);
        }
    });

    test("refuses an invalid address and mismatched ownership before exec", async () => {
        for (const invalid of ["address", "owner"] as const) {
            const { calls, container, deps } = fixture();
            container.HostConfig.Runtime = "nvidia";
            if (invalid === "address") container.NetworkSettings.Networks["agent_egress_carapa-bot-demo"].IPAddress = "";
            if (invalid === "owner") container.Config.Labels["com.docker.compose.project"] = "carapa-bot-other";
            await expect(controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "start", deps)).rejects.toThrow();
            expect(calls.some((call) => call[0] === "exec")).toBe(false);
        }
    });

    test("selects the instance network and permits stopping after its address disappears", async () => {
        const { container, deps } = fixture();
        const networks = container.NetworkSettings.Networks as Record<string, { IPAddress: string }>;
        networks.other_network = { IPAddress: "172.18.0.5" };
        expect(await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "start", deps)).toMatchObject({ host: "172.16.0.102" });
        networks["agent_egress_carapa-bot-demo"].IPAddress = "";
        expect(await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "stop", deps)).toMatchObject({ running: false });
    });

    test("keeps a stopped sandbox stopped and reports that the preference is pending", async () => {
        const { calls, container, deps } = fixture();
        container.State.Running = false;
        expect(await controlSandboxSsh("/stacks/carapa-bot", "carapa-bot-demo", "start", deps)).toMatchObject({ running: false, pending: true });
        expect(calls.some((call) => call[0] === "exec")).toBe(false);
    });
});
