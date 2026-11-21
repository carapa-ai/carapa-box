import { describe, expect, test, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type R = { code: number; stdout: string; stderr: string };
const calls: string[] = [];
let handler: (cmd: string) => R = () => ({ code: 0, stdout: "", stderr: "" });

import * as client from "./compose/client.js";
spyOn(client, "execInService").mockImplementation((async (_d: string, _s: string, cmd: string) => {
    calls.push(cmd);
    return handler(cmd);
}) as never);

const { applySquidConfig, collectDomainPolicy, generateSquidConf, reloadNetworkPolicies, startNetworkPolicyWatcher, stopNetworkPolicyWatcher } = await import("./network-policy.js");

const CONF = "/etc/squid/squid-generated.conf";
const ok: R = { code: 0, stdout: "", stderr: "" };
const bad: R = { code: 1, stdout: "", stderr: "boom" };
let dir: string;
let file: string;
let prevEnv: string | undefined;

afterAll(() => mock.restore());

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-"));
    file = path.join(dir, "squid-generated.conf");
    prevEnv = process.env.CARAPA_BOX_STATE_DIR;
    process.env.CARAPA_BOX_STATE_DIR = dir;
    calls.length = 0;
    handler = () => ok;
});
afterEach(() => {
    if (prevEnv === undefined) delete process.env.CARAPA_BOX_STATE_DIR;
    else process.env.CARAPA_BOX_STATE_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("applySquidConfig", () => {
    test("(a) failed reconfigure is retried, not reported unchanged", async () => {
        let n = 0;
        handler = cmd => (cmd.includes("reconfigure") && n++ === 0 ? bad : ok);
        const r1 = await applySquidConfig("new\n");
        expect(r1.ok).toBe(false);
        expect(r1.message).toContain("previous config restored; will retry on next reload");
        calls.length = 0;
        const r2 = await applySquidConfig("new\n");
        expect(r2.ok).toBe(true);
        expect(r2.message).not.toContain("unchanged");
        expect(calls).toHaveLength(2);
        expect(fs.readFileSync(file, "utf-8")).toBe("new\n");
        const r3 = await applySquidConfig("new\n");
        expect(r3.message).toContain("unchanged");
    });

    test("(b) parse failure restores previous content and inode", async () => {
        fs.writeFileSync(file, "old\n");
        const ino = fs.statSync(file).ino;
        handler = () => bad;
        const r = await applySquidConfig("new\n");
        expect(r.ok).toBe(false);
        expect(fs.readFileSync(file, "utf-8")).toBe("old\n");
        expect(fs.statSync(file).ino).toBe(ino);
        expect(calls).toHaveLength(1);
    });

    test("thrown error also restores", async () => {
        fs.writeFileSync(file, "old\n");
        handler = () => {
            throw new Error("exec died");
        };
        const r = await applySquidConfig("new\n");
        expect(r.ok).toBe(false);
        expect(fs.readFileSync(file, "utf-8")).toBe("old\n");
    });

    test("(c) first run with parse failure leaves an empty file", async () => {
        handler = () => bad;
        const r = await applySquidConfig("new\n");
        expect(r.ok).toBe(false);
        expect(fs.readFileSync(file, "utf-8")).toBe("");
    });

    describe("squid not running", () => {
        const stopped = { code: 1, stdout: "", stderr: 'service "squid" is not running' };

        test("no existing file keeps the new config staged", async () => {
            handler = () => stopped;
            const r = await applySquidConfig("new\n");
            expect(r.ok).toBe(false);
            expect(r.message).toContain("staged");
            expect(fs.readFileSync(file, "utf-8")).toBe("new\n");
            expect(calls).toHaveLength(1);
        });

        test("existing empty file keeps the new config staged", async () => {
            fs.writeFileSync(file, "");
            handler = () => stopped;
            await applySquidConfig("new\n");
            expect(fs.readFileSync(file, "utf-8")).toBe("new\n");
        });

        test("existing non-empty file is restored", async () => {
            fs.writeFileSync(file, "old\n");
            handler = () => stopped;
            await applySquidConfig("new\n");
            expect(fs.readFileSync(file, "utf-8")).toBe("old\n");
        });

        test("real parse failure with no existing file leaves it empty", async () => {
            handler = () => ({ code: 1, stdout: "", stderr: "FATAL: Bungled squid.conf line 3" });
            await applySquidConfig("new\n");
            expect(fs.readFileSync(file, "utf-8")).toBe("");
        });

        test("staged config is later reported unchanged", async () => {
            handler = () => stopped;
            await applySquidConfig("new\n");
            handler = () => ok;
            const r = await applySquidConfig("new\n");
            expect(r.message).toContain("unchanged");
        });
    });

    test("(d) commands use -f with the generated config", async () => {
        const r = await applySquidConfig("new\n");
        expect(r.ok).toBe(true);
        expect(calls).toEqual([`squid -k parse -f ${CONF}`, `squid -k reconfigure -f ${CONF}`]);
    });
});

describe("reloadNetworkPolicies serialization", () => {
    const writeBase = (domain: string) => {
        const policies = path.join(dir, "config", "policies");
        fs.mkdirSync(policies, { recursive: true });
        fs.mkdirSync(path.join(dir, "stacks"), { recursive: true });
        fs.writeFileSync(path.join(policies, "network-base.yaml"), `allowed_domains:\n  - ${domain}\n`);
    };

    test("overlapping reloads run one at a time and squid ends on the newest state", async () => {
        const prev = [process.env.CARAPA_BOX_CONFIG_DIR, process.env.SANDBOX_STACKS_DIR];
        process.env.CARAPA_BOX_CONFIG_DIR = path.join(dir, "config");
        process.env.SANDBOX_STACKS_DIR = path.join(dir, "stacks");
        try {
            writeBase("old.example");
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let started!: () => void;
            const firstParse = new Promise<void>(resolve => { started = resolve; });
            let active = 0;
            let maxActive = 0;
            let parses = 0;
            const spy = spyOn(client, "execInService").mockImplementation((async (_d: string, _s: string, cmd: string) => {
                calls.push(cmd);
                if (!cmd.includes("parse")) return ok;
                active++;
                maxActive = Math.max(maxActive, active);
                if (parses++ === 0) {
                    started();
                    await gate;
                }
                await new Promise(resolve => setTimeout(resolve, 5));
                active--;
                return ok;
            }) as never);
            try {
                const a = reloadNetworkPolicies();
                await firstParse; // run A has collected "old.example" and sits in squid -k parse
                writeBase("new.example");
                const b = reloadNetworkPolicies();
                const c = reloadNetworkPolicies(); // coalesces into the same single rerun
                release();
                const [ra, rb, rc] = await Promise.all([a, b, c]);
                expect([ra.ok, rb.ok, rc.ok]).toEqual([true, true, true]);
                expect(maxActive).toBe(1);
                expect(parses).toBe(2);
                const final = fs.readFileSync(file, "utf-8");
                expect(final).toContain("new.example");
                expect(final).not.toContain("old.example");
            } finally {
                spy.mockImplementation((async (_d: string, _s: string, cmd: string) => {
                    calls.push(cmd);
                    return handler(cmd);
                }) as never);
            }
        } finally {
            const [cfg, stacks] = prev;
            if (cfg === undefined) delete process.env.CARAPA_BOX_CONFIG_DIR;
            else process.env.CARAPA_BOX_CONFIG_DIR = cfg;
            if (stacks === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = stacks;
        }
    });
});

describe("relay_domains", () => {
    const writePolicies = (base: string, stackPolicy?: string) => {
        const cfg = path.join(dir, "config");
        fs.mkdirSync(path.join(cfg, "policies"), { recursive: true });
        fs.writeFileSync(path.join(cfg, "policies", "network-base.yaml"), base);
        const stacks = path.join(dir, "stacks");
        fs.mkdirSync(path.join(stacks, "s1"), { recursive: true });
        if (stackPolicy) fs.writeFileSync(path.join(stacks, "s1", "network-policy.yaml"), stackPolicy);
        return { cfg, stacks };
    };
    const BASE = "allowed_domains:\n  - .anthropic.com\n  - mcp.shared.example\nrelay_domains:\n  - mcp.relay.example\n  - mcp.shared.example\n";

    async function policyFor(base: string, stackPolicy?: string) {
        const { cfg, stacks } = writePolicies(base, stackPolicy);
        const prevCfg = process.env.CARAPA_BOX_CONFIG_DIR;
        const prevStacks = process.env.SANDBOX_STACKS_DIR;
        process.env.CARAPA_BOX_CONFIG_DIR = cfg;
        process.env.SANDBOX_STACKS_DIR = stacks;
        try {
            return await collectDomainPolicy();
        } finally {
            if (prevCfg === undefined) delete process.env.CARAPA_BOX_CONFIG_DIR;
            else process.env.CARAPA_BOX_CONFIG_DIR = prevCfg;
            if (prevStacks === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = prevStacks;
        }
    }

    test("relay domains never land in a sandbox-reachable ACL", async () => {
        const policy = await policyFor(BASE, "allowed_domains:\n  - mcp.relay.example\n  - stack.example\n");
        expect(policy.relayDomains).toEqual(["mcp.relay.example", "mcp.shared.example"]);
        expect(policy.baseDomains).toEqual([".anthropic.com"]);
        expect([...policy.perStack.get("s1") ?? []]).toEqual(["stack.example"]);

        const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        const sandboxAcls = conf.split("\n").filter(l => /^acl (base_allowed|stack_)/.test(l)).join("\n");
        expect(sandboxAcls).not.toContain("mcp.relay.example");
        expect(sandboxAcls).not.toContain("mcp.shared.example");
        expect(conf).toContain("acl relay_allowed dstdomain -n mcp.relay.example");
    });

    test("relay rule is emitted only for the relay IP, before deny all", async () => {
        const policy = await policyFor(BASE);
        const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        expect(conf).toContain("acl relay_src src 172.26.0.2\n");
        expect(conf).not.toMatch(/relay_src src .*172\.26\.0\.9/);
        const allow = conf.indexOf("http_access allow CONNECT relay_src relay_allowed");
        expect(allow).toBeGreaterThan(-1);
        expect(allow).toBeLessThan(conf.indexOf("http_access deny all"));
    });

    test("unknown relay IP omits the allow rule but still denies relay domains (fail closed)", async () => {
        const policy = await policyFor(BASE);
        const conf = generateSquidConf(policy, []);
        expect(conf).not.toContain("relay_src");
        expect(conf).not.toContain("http_access allow CONNECT relay_src");
        expect(conf).toContain("acl relay_allowed dstdomain -n mcp.relay.example");
        expect(conf).toContain("http_access deny relay_allowed");
    });

    test("wildcard base/stack entries cannot admit sandboxes to a relay domain", async () => {
        const policy = await policyFor(
            "allowed_domains:\n  - .example.com\nrelay_domains:\n  - mcp.example.com\n",
            "allowed_domains:\n  - .stackwild.example\n",
        );
        for (const ips of [[], ["172.26.0.2"]]) {
            const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ips);
            const deny = conf.indexOf("http_access deny relay_allowed");
            expect(deny).toBeGreaterThan(-1);
            expect(deny).toBeLessThan(conf.indexOf("http_access allow CONNECT base_allowed"));
            expect(deny).toBeLessThan(conf.indexOf("http_access allow base_allowed"));
            const stackAllow = conf.indexOf("http_access allow CONNECT src_s1");
            if (stackAllow >= 0) expect(deny).toBeLessThan(stackAllow);
            const relayAllow = conf.indexOf("http_access allow CONNECT relay_src relay_allowed");
            expect(relayAllow >= 0).toBe(ips.length > 0);
            if (relayAllow >= 0) expect(relayAllow).toBeLessThan(deny);
        }
    });

    test("every domain allow rule ends in !private_dst, after a dstdomain ACL", async () => {
        const policy = await policyFor(BASE, "allowed_domains:\n  - stack.example\n");
        for (const relayIPs of [[], ["172.26.0.2"]]) {
            for (const stacks of [[], [{ stackName: "s1", ips: ["172.26.0.9"] }]]) {
                const conf = generateSquidConf(policy, stacks, relayIPs);
                expect(conf.match(/^acl private_dst dst .*$/gm)).toEqual([
                    "acl private_dst dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1 fc00::/7 fe80::/10",
                ]);
                const allows = conf.split("\n").filter(l => l.startsWith("http_access allow "));
                expect(allows.length).toBeGreaterThan(2);
                for (const line of allows) {
                    if (line === "http_access allow host_services host_ports") continue;
                    expect(line.endsWith(" !private_dst")).toBe(true);
                }
                const aclNames = new Set(["relay_allowed", "base_allowed", ...(stacks.length ? ["stack_s1"] : [])]);
                for (const line of conf.split("\n").filter(l => l.startsWith("http_access") && l.includes("private_dst"))) {
                    const before = line.split(" ").slice(0, -1);
                    expect(before.some(t => aclNames.has(t))).toBe(true);
                }
                expect(conf).not.toMatch(/^http_access deny private_dst/m);
            }
        }
    });

    test("port-restriction denies sit after the relay block and before base/stack allows; host-services rule kept", async () => {
        const policy = await policyFor(BASE, "allowed_domains:\n  - stack.example\n");
        const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        expect(conf).toContain("acl SSL_ports port 443\n");
        expect(conf).toContain("acl Safe_ports port 80 443\n");
        const denyConnect = conf.indexOf("http_access deny CONNECT !SSL_ports !host_services");
        const denyPorts = conf.indexOf("http_access deny !Safe_ports !host_services");
        expect(denyConnect).toBeGreaterThan(-1);
        expect(denyPorts).toBeGreaterThan(denyConnect);
        expect(denyConnect).toBeGreaterThan(conf.indexOf("http_access deny relay_allowed"));
        expect(denyPorts).toBeLessThan(conf.indexOf("http_access allow CONNECT base_allowed"));
        expect(denyPorts).toBeLessThan(conf.indexOf("http_access allow base_allowed"));
        expect(denyPorts).toBeLessThan(conf.indexOf("http_access allow CONNECT src_s1"));
        expect(denyPorts).toBeLessThan(conf.indexOf("http_access allow src_s1"));
        const hostAllow = conf.indexOf("http_access allow host_services host_ports");
        expect(hostAllow).toBeGreaterThan(conf.indexOf("http_access allow src_s1"));
        expect(hostAllow).toBeLessThan(conf.indexOf("http_access deny all"));
    });

    test("fallback squid.conf has the same port-restriction denies before the allows", () => {
        const conf = fs.readFileSync(path.join(import.meta.dir, "..", "egress-proxy", "squid.conf"), "utf-8");
        const denyConnect = conf.indexOf("http_access deny CONNECT !SSL_ports !host_services");
        const denyPorts = conf.indexOf("http_access deny !Safe_ports !host_services");
        expect(conf).toContain("acl SSL_ports port 443\n");
        expect(conf).toContain("acl Safe_ports port 80 443\n");
        expect(denyConnect).toBeGreaterThan(-1);
        expect(denyPorts).toBeGreaterThan(denyConnect);
        expect(denyPorts).toBeLessThan(conf.indexOf("http_access allow CONNECT ai_providers"));
    });
});

describe("dstdomain -n and host port ACLs", () => {
    async function policyFor(base: string) {
        const cfg = path.join(dir, "config");
        fs.mkdirSync(path.join(cfg, "policies"), { recursive: true });
        fs.writeFileSync(path.join(cfg, "policies", "network-base.yaml"), base);
        const prevCfg = process.env.CARAPA_BOX_CONFIG_DIR;
        const prevStacks = process.env.SANDBOX_STACKS_DIR;
        process.env.CARAPA_BOX_CONFIG_DIR = cfg;
        process.env.SANDBOX_STACKS_DIR = path.join(dir, "stacks");
        try {
            return await collectDomainPolicy();
        } finally {
            if (prevCfg === undefined) delete process.env.CARAPA_BOX_CONFIG_DIR;
            else process.env.CARAPA_BOX_CONFIG_DIR = prevCfg;
            if (prevStacks === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = prevStacks;
        }
    }
    const BASE = "allowed_domains:\n  - .anthropic.com\nrelay_domains:\n  - mcp.relay.example\n";

    test("every dstdomain ACL carries -n so IP literals trigger no reverse DNS lookup", async () => {
        const policy = await policyFor(BASE);
        policy.perStack.set("s1", ["stack.example"]);
        const generated = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        const fallback = fs.readFileSync(path.join(import.meta.dir, "..", "egress-proxy", "squid.conf"), "utf-8");
        for (const conf of [generated, fallback]) {
            const acls = conf.split("\n").filter(l => /^acl \S+ dstdomain\b/.test(l));
            expect(acls.length).toBeGreaterThan(3);
            for (const line of acls) expect(line).toMatch(/^acl \S+ dstdomain -n /);
        }
    });

    test("defaults deny 3000 and 3100 before the host_services allow; 3001 stays allowed", async () => {
        const conf = generateSquidConf(await policyFor(BASE), []);
        expect(conf).toContain("acl control_plane_ports port 3000 3100\n");
        expect(conf).toContain("acl host_ports port 3000-9999\n");
        expect(conf).toContain("acl host_ports port 11434\n");
        const deny = conf.indexOf("http_access deny host_services control_plane_ports");
        expect(deny).toBeGreaterThan(-1);
        expect(deny).toBeLessThan(conf.indexOf("http_access allow host_services host_ports"));
        // 3001 is in neither deny entry but inside the allowed range.
        expect(conf).not.toMatch(/control_plane_ports port .*\b3001\b/);
    });

    test("custom host_deny_ports and host_ports replace the defaults; invalid entries are skipped", async () => {
        const policy = await policyFor(
            BASE + "host_deny_ports:\n  - 4000\n  - 4100-4110\n  - 0\n  - 70000\n  - abc\n  - 9-3\n"
            + "host_ports:\n  - 8000-8100\n  - 12345\n",
        );
        const conf = generateSquidConf(policy, []);
        expect(conf).toContain("acl control_plane_ports port 4000 4100-4110\n");
        expect(conf).not.toContain("3100");
        expect(conf).toContain("acl host_ports port 8000-8100\n");
        expect(conf).toContain("acl host_ports port 12345\n");
        expect(conf).not.toContain("3000-9999");
    });

    test("host_deny_ports with no valid entry falls back to the default deny (fail closed)", async () => {
        const conf = generateSquidConf(await policyFor(BASE + "host_deny_ports:\n  - nope\n  - 99999\n"), []);
        expect(conf).toContain("acl control_plane_ports port 3000 3100\n");
    });
});

describe("relay_private_hosts", () => {
    const BASE = "allowed_domains:\n  - .ex.test\nrelay_private_hosts:\n  - host: gitlab.ex.test\n    dst: 10.44.0.1/32\n";

    async function policyFor(base: string, stackPolicy?: string) {
        const cfg = path.join(dir, "config");
        fs.mkdirSync(path.join(cfg, "policies"), { recursive: true });
        fs.writeFileSync(path.join(cfg, "policies", "network-base.yaml"), base);
        const stacks = path.join(dir, "stacks");
        fs.mkdirSync(path.join(stacks, "s1"), { recursive: true });
        if (stackPolicy) fs.writeFileSync(path.join(stacks, "s1", "network-policy.yaml"), stackPolicy);
        const prevCfg = process.env.CARAPA_BOX_CONFIG_DIR;
        const prevStacks = process.env.SANDBOX_STACKS_DIR;
        process.env.CARAPA_BOX_CONFIG_DIR = cfg;
        process.env.SANDBOX_STACKS_DIR = stacks;
        try {
            return await collectDomainPolicy();
        } finally {
            if (prevCfg === undefined) delete process.env.CARAPA_BOX_CONFIG_DIR;
            else process.env.CARAPA_BOX_CONFIG_DIR = prevCfg;
            if (prevStacks === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = prevStacks;
        }
    }
    const rules = (conf: string) => conf.split("\n").filter(l => l.startsWith("http_access "));
    const ALLOW = "http_access allow CONNECT SSL_ports relay_src relay_private_host_0 relay_private_dst_0";

    test("a valid entry yields an HTTPS relay-only allow before the port restriction and base/stack allows, then the deny", async () => {
        const policy = await policyFor(BASE, "allowed_domains:\n  - .ex.test\n  - stack.example\n");
        const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        expect(conf).toContain("acl relay_src src 172.26.0.2\n");
        expect(conf).toContain("acl relay_private_host_0 dstdomain -n gitlab.ex.test\n");
        expect(conf).toContain("acl relay_private_dst_0 dst 10.44.0.1/32\n");
        expect(conf).toContain("acl SSL_ports port 443\n");
        const all = rules(conf);
        const allow = all.indexOf(ALLOW);
        const deny = all.indexOf("http_access deny relay_private_host_0");
        expect(allow).toBeGreaterThan(-1);
        expect(deny).toBe(allow + 1);
        for (const later of ["http_access deny CONNECT !SSL_ports !host_services", "http_access allow CONNECT base_allowed !private_dst", "http_access allow CONNECT src_s1 stack_s1 !private_dst"]) {
            expect(all.indexOf(later)).toBeGreaterThan(deny);
        }
        // The host and the generic !private_dst rules stay untouched elsewhere.
        expect(all.filter(l => l.includes("private_dst") && !l.includes("relay_private")).every(l => l.endsWith(" !private_dst"))).toBe(true);
    });

    test("a wildcard base or stack domain covering the host does not admit sandboxes", async () => {
        const policy = await policyFor(BASE.replace(".ex.test", "gitlab.ex.test"), "allowed_domains:\n  - gitlab.ex.test\n  - .ex.test\n");
        expect(policy.baseDomains).toEqual([]);
        expect(policy.perStack.get("s1")).toEqual([".ex.test"]);
        const conf = generateSquidConf(policy, [{ stackName: "s1", ips: ["172.26.0.9"] }], ["172.26.0.2"]);
        const all = rules(conf);
        expect(all.indexOf("http_access deny relay_private_host_0")).toBeLessThan(all.indexOf("http_access allow CONNECT src_s1 stack_s1 !private_dst"));
        expect(conf).not.toMatch(/^acl (base_allowed|stack_s1) dstdomain -n gitlab\.ex\.test$/m);
    });

    test("without relay IPs only the deny is emitted (fail closed)", async () => {
        const conf = generateSquidConf(await policyFor(BASE), []);
        expect(conf).not.toContain("relay_src");
        expect(rules(conf)).not.toContain(ALLOW);
        expect(rules(conf)).toContain("http_access deny relay_private_host_0");
    });

    test("invalid entries are skipped and never produce an allow", async () => {
        const bad = [
            ["*.ex.test", "10.44.0.1/32"], [".ex.test", "10.44.0.1/32"], ["10.44.0.1", "10.44.0.1/32"], ["nodot", "10.44.0.1/32"],
            ["gitlab.ex.test", "8.8.8.8/32"], ["gitlab.ex.test", "10.44.0.1/33"], ["gitlab.ex.test", "10.44.0.1/x"], ["gitlab.ex.test", "10.0.0.0/7"],
            ["gitlab.ex.test", "0.0.0.0/0"], ["gitlab.ex.test", "10.44.0.1/32/1"], ["gitlab.ex.test", "::ffff:10.44.0.1"], ["gitlab.ex.test", "2001:db8::1"],
            ["gitlab.ex.test", "fc00::/6"], ["gitlab.ex.test", "10.44.0.1 8.8.8.8"], ["gitlab.ex.test", ""],
        ];
        const yaml = "relay_private_hosts:\n" + bad.map(([host, dst]) => `  - host: "${host}"\n    dst: "${dst}"\n`).join("") + "  - not-an-object\n  - host: 5\n    dst: 10.0.0.1\n";
        const policy = await policyFor(yaml);
        expect(policy.relayPrivateHosts).toEqual([]);
        const conf = generateSquidConf(policy, [], ["172.26.0.2"]);
        expect(conf).not.toContain("relay_private");
        expect(conf).not.toContain("relay_src");
    });

    test("valid IPv4 and IPv6 private dst forms are accepted", async () => {
        const policy = await policyFor("relay_private_hosts:\n  - {host: a.example.lan, dst: 192.168.1.5}\n  - {host: B.example.lan, dst: 'fd00::/8'}\n  - {host: c.example.lan, dst: 172.16.0.0/12}\n");
        expect(policy.relayPrivateHosts).toEqual([
            { host: "a.example.lan", dst: "192.168.1.5" }, { host: "b.example.lan", dst: "fd00::/8" }, { host: "c.example.lan", dst: "172.16.0.0/12" },
        ]);
    });

    test("one host with two dst values gets both allows before any deny", async () => {
        const policy = await policyFor("relay_private_hosts:\n  - {host: gitlab.ex.test, dst: 10.44.0.1}\n  - {host: gitlab.ex.test, dst: 10.44.0.2}\n");
        const all = rules(generateSquidConf(policy, [], ["172.26.0.2"]));
        const lastAllow = all.indexOf("http_access allow CONNECT SSL_ports relay_src relay_private_host_1 relay_private_dst_1");
        expect(lastAllow).toBeGreaterThan(-1);
        expect(lastAllow).toBeLessThan(all.indexOf("http_access deny relay_private_host_0"));
    });
});

describe("per-stack ACL names", () => {
    test("stacks whose names sanitize alike keep separate src and dstdomain ACLs", () => {
        const policy = {
            baseDomains: [".anthropic.com"], relayDomains: [], relayPrivateHosts: [],
            perStack: new Map<string, string[]>([["my-stack", ["x.com"]], ["my_stack", ["y.com"]]]),
            hostPorts: [], hostDenyPorts: ["3000"],
        };
        const conf = generateSquidConf(policy, [
            { stackName: "my-stack", ips: ["172.26.0.5"] },
            { stackName: "my_stack", ips: ["172.26.0.6"] },
        ]);
        const aclLine = (re: RegExp) => conf.split("\n").filter(l => re.test(l));
        const srcAcls = aclLine(/^acl src_\S+ src /);
        const domainAcls = aclLine(/^acl stack_\S+ dstdomain /);
        expect(new Set(srcAcls.map(l => l.split(" ")[1])).size).toBe(2);
        expect(new Set(domainAcls.map(l => l.split(" ")[1])).size).toBe(2);
        const [srcA, srcB] = srcAcls.map(l => l.split(" ")[1]);
        const [domA, domB] = domainAcls.map(l => l.split(" ")[1]);
        expect(conf).toContain(`http_access allow CONNECT ${srcA} ${domA} !private_dst`);
        expect(conf).toContain(`http_access allow CONNECT ${srcB} ${domB} !private_dst`);
        expect(domainAcls[0]).toContain("x.com");
        expect(srcAcls[0]).toContain("172.26.0.5");
        expect(domainAcls[1]).toContain("y.com");
        expect(srcAcls[1]).toContain("172.26.0.6");
    });
});

describe("own published hostnames", () => {
    const policy = {
        baseDomains: [".anthropic.com"], relayDomains: ["mcp.relay.example"], relayPrivateHosts: [], perStack: new Map<string, string[]>(),
        hostPorts: ["3000-9999"], hostDenyPorts: ["3000", "3100"],
    };
    const rules = (conf: string) => conf.split("\n").filter(l => l.startsWith("http_access "));

    test("each project reaches only its own exact names, over CONNECT 443, never loopback/link-local", () => {
        const conf = generateSquidConf(policy, [], ["172.26.0.2"], [
            // Sanitized names would collide (a-b / a_b): ACLs must stay separate.
            { project: "a-b", ips: ["172.16.5.238"], hostnames: ["convex-test.ex.test", "convex-admin.ex.test"] },
            { project: "a_b", ips: ["172.16.6.9"], hostnames: ["other.ex.test"] },
        ]);
        expect(conf).toContain("acl own_src_0 src 172.16.5.238\n");
        expect(conf).toContain("acl own_host_0 dstdomain -n convex-test.ex.test convex-admin.ex.test\n");
        expect(conf).toContain("acl own_src_1 src 172.16.6.9\n");
        expect(conf).toContain("acl own_host_1 dstdomain -n other.ex.test\n");
        expect(conf).toContain("acl own_blocked_dst dst 0.0.0.0/8 127.0.0.0/8 169.254.0.0/16 ::1 fe80::/10\n");

        const all = rules(conf);
        const own = all.filter(l => l.includes("own_"));
        expect(own).toEqual([
            "http_access allow CONNECT SSL_ports own_src_0 own_host_0 !own_blocked_dst",
            "http_access allow CONNECT SSL_ports own_src_1 own_host_1 !own_blocked_dst",
        ]);
        // After the relay deny and port restriction, before the final deny.
        for (const line of own) {
            expect(all.indexOf(line)).toBeGreaterThan(all.indexOf("http_access deny relay_allowed"));
            expect(all.indexOf(line)).toBeGreaterThan(all.indexOf("http_access deny CONNECT !SSL_ports !host_services"));
            expect(all.indexOf(line)).toBeLessThan(all.indexOf("http_access deny all"));
        }
    });

    test("wildcards, malformed names and projects without IPs or names get no rule", () => {
        const conf = generateSquidConf(policy, [], [], [
            { project: "p1", ips: ["172.16.5.238"], hostnames: [".ex.test", "ex.test;acl x", "nodot", "*.ex.test"] },
            { project: "p2", ips: [], hostnames: ["p2.ex.test"] },
            { project: "p3", ips: ["172.16.5.9"], hostnames: [] },
        ]);
        expect(conf).not.toContain("own_");
    });
});

describe("project integration hosts", () => {
    const policy = {
        baseDomains: [".anthropic.com"], relayDomains: [], relayPrivateHosts: [], perStack: new Map<string, string[]>(),
        hostPorts: ["3000-9999"], hostDenyPorts: ["3000", "3100"], integrationHosts: ["crm.example.com"],
    };
    const rules = (conf: string) => conf.split("\n").filter(l => l.startsWith("http_access "));

    // The relay may reach an integration's host over HTTPS; no other source gains
    // or loses access to it, and an unknown relay address allows nothing.
    test("only the relay gains HTTPS access, and nobody loses any", () => {
        const conf = generateSquidConf(policy, [], ["172.26.0.2"]);
        expect(conf).toContain("acl relay_integration dstdomain -n crm.example.com\n");
        const integration = rules(conf).filter(l => l.includes("relay_integration"));
        expect(integration).toEqual(["http_access allow CONNECT SSL_ports relay_src relay_integration !private_dst"]);
        expect(rules(generateSquidConf(policy, [], [])).filter(l => l.includes("relay_integration"))).toEqual([]);
    });
});

describe("startNetworkPolicyWatcher", () => {
    test("a stack dir whose fs.watch fails does not stop later stack dirs from being watched", async () => {
        const stacks = path.join(dir, "stacks");
        fs.mkdirSync(stacks);
        // Dangling symlink sorts first: fs.watch throws ENOENT on it.
        fs.symlinkSync(path.join(dir, "missing"), path.join(stacks, "a-broken"));
        fs.mkdirSync(path.join(stacks, "b-good"));
        const prevStacks = process.env.SANDBOX_STACKS_DIR;
        process.env.SANDBOX_STACKS_DIR = stacks;
        const watched: string[] = [];
        const realWatch = fs.watch;
        const watchSpy = spyOn(fs, "watch").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
            watched.push(String(target));
            return (realWatch as (...a: unknown[]) => fs.FSWatcher)(target, ...rest);
        }) as never);
        try {
            await startNetworkPolicyWatcher();
            expect(watched).toContain(path.join(stacks, "b-good"));
        } finally {
            stopNetworkPolicyWatcher();
            watchSpy.mockRestore();
            if (prevStacks === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = prevStacks;
        }
    });
});
