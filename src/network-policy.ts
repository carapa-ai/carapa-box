import { getConfigDir, getStateDir } from "./installation-paths.js";
/**
 * Hot-reloadable network policy engine for CarapaBox.
 *
 * Watches YAML network policy files, collects allowed domains,
 * generates squid.conf ACLs, validates and applies via `squid -k reconfigure`.
 *
 * Flow:
 *   .yaml file changed → fs.watch → debounce(2s) → collect → generate → apply
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileExists, execDocker, splitDockerOutput } from "./utils.js";
import { getStacksDir, getEgressProxyDir } from "./config.js";
import { parse } from "yaml";
import { yamlStringList } from "./yaml-utils.js";

import { execInService } from "./compose/client.js";
import { auditLog } from "./audit.js";
import { logger } from "./logger.js";
import { projectPublishedHostnames } from "./app-publications.js";
import { INGRESS_CONTAINER } from "./ingress.js";
// @ts-ignore -- shared with the standalone relay
import { integrationRoute, readAccountRegistry } from "../egress-proxy/api-relay/provider-account-config.mjs";

// ── Types ─────────────────────────────────────────────────────────────────

interface NetworkPolicy {
    allowed_domains?: string[];
    relay_domains?: string[];
    /** Raw `relay_private_hosts` items (base policy only; validated in collectDomainPolicy). */
    relay_private_hosts?: unknown[];
    /** Raw `host_ports` entries (base policy only; validated in collectDomainPolicy). */
    host_ports?: string[];
    /** Raw `host_deny_ports` entries (base policy only; validated in collectDomainPolicy). */
    host_deny_ports?: string[];
}

export interface DomainPolicy {
    baseDomains: string[];
    /** Domains reachable only from the api-relay container (never from sandboxes). */
    relayDomains: string[];
    /** Exact names the api-relay alone may reach at a private address inside `dst` (HTTPS only). */
    relayPrivateHosts: RelayPrivateHost[];
    /** Hosts of project integrations the api-relay may also reach (HTTPS, public addresses); unlike
     * relayDomains they stay reachable for whoever else already could. */
    integrationHosts?: string[];
    perStack: Map<string, string[]>; // stackName → stack-specific domains (excluding base)
    /** Ports/ranges sandboxes may reach on host.docker.internal (replaces the default range). */
    hostPorts: string[];
    /** Ports/ranges denied on host.docker.internal before hostPorts is allowed (Board, carapa-box). */
    hostDenyPorts: string[];
}

export interface RelayPrivateHost {
    host: string;
    /** A single private IPv4/IPv6 address or CIDR the host must resolve into. */
    dst: string;
}

export interface StackIPMapping {
    stackName: string;
    ips: string[];
}

// ── Module state ──────────────────────────────────────────────────────────

let watchAbortController: AbortController | null = null;

/** Maps projectName → stackName for running agent instances. */
const projectToStack = new Map<string, string>();

const PROXY_CONTAINERS = new Set([
    "egress-proxy-squid-1",
    "egress-proxy-api-relay-1",
    "egress-proxy-llama-proxy-1",
]);

const API_RELAY_CONTAINER = "egress-proxy-api-relay-1";

/** In-container path of the generated config (matches squid-entrypoint.sh and the HEALTHCHECK). */
const SQUID_GENERATED_CONF = "/etc/squid/squid-generated.conf";

type NetworkContainer = { Name: string; IPv4Address: string };

function nonProxyContainerIps(containers: Record<string, NetworkContainer>): Array<{ name: string; ip: string }> {
    return Object.values(containers).flatMap(info => {
        if (PROXY_CONTAINERS.has(info.Name)) return [];
        const ip = info.IPv4Address?.split("/")[0];
        return ip ? [{ name: info.Name, ip }] : [];
    });
}

export function registerStackProject(projectName: string, stackName: string): void {
    projectToStack.set(projectName, stackName);
}

/** Splits a registered compose project name into its stack and instance (`<stack>-<instance>`). */
export function getProjectIdentity(projectName: string): { stack: string; instance: string } | null {
    const stack = projectToStack.get(projectName);
    if (!stack || !projectName.startsWith(`${stack}-`)) return null;
    const instance = projectName.slice(stack.length + 1);
    return instance ? { stack, instance } : null;
}

export function unregisterStackProject(projectName: string): void {
    projectToStack.delete(projectName);
}


/**
 * Discover container IPs per stack from running agent_egress_* networks
 * and the shared agent_egress network.
 */
async function getStackNetworkIPs(): Promise<StackIPMapping[]> {
    const resultMap = new Map<string, StackIPMapping>();

    try {
        const ls = await execDocker([
            "network", "ls", "--filter", "name=agent_egress", "--format", "{{.Name}}",
        ]);
        if (ls.status !== 0) return [];

        const networks = splitDockerOutput(ls.stdout);

        // Build a reverse map: projectName → stackName for matching shared-network containers
        const projectNames = [...projectToStack.keys()];

        // Inspect all networks in parallel
        const inspections = await Promise.all(networks
            .filter(n => n !== "agent_egress")
            .map(async (networkName) => {
                const projectName = networkName.replace("agent_egress_", "");
                const stackName = projectToStack.get(projectName);
                if (!stackName) return null;

                const inspect = await execDocker([
                    "network", "inspect", networkName, "--format", "{{json .Containers}}",
                ]);
                if (inspect.status !== 0) return null;

                try {
                    const containers: Record<string, NetworkContainer> =
                        JSON.parse(inspect.stdout.trim());
                    const ips = nonProxyContainerIps(containers).map(({ ip }) => ip);
                    return ips.length > 0 ? { stackName, ips } : null;
                } catch { return null; }
            })
        );

        for (const mapping of inspections) {
            if (!mapping) continue;
            const existing = resultMap.get(mapping.stackName);
            if (existing) {
                existing.ips.push(...mapping.ips);
            } else {
                resultMap.set(mapping.stackName, mapping);
            }
        }

        // Also inspect the shared agent_egress network and match containers
        // back to known stacks by their project name prefix (container names
        // follow the pattern <projectName>-<service>-<n>).
        if (networks.includes("agent_egress") && projectNames.length > 0) {
            const inspect = await execDocker([
                "network", "inspect", "agent_egress", "--format", "{{json .Containers}}",
            ]);
            if (inspect.status === 0) {
                try {
                    const containers: Record<string, NetworkContainer> =
                        JSON.parse(inspect.stdout.trim());
                    for (const { name, ip } of nonProxyContainerIps(containers)) {

                        // Match container name to a known project
                        const matchedProject = projectNames.find(p => name.startsWith(p + "-"));
                        if (!matchedProject) continue;
                        const stackName = projectToStack.get(matchedProject)!;

                        const existing = resultMap.get(stackName);
                        if (existing) {
                            if (!existing.ips.includes(ip)) existing.ips.push(ip);
                        } else {
                            const mapping = { stackName, ips: [ip] };
                            resultMap.set(stackName, mapping);
                        }
                    }
                } catch { /* ignore parse errors */ }
            }
        }
    } catch (err) {
        logger.warn({ err }, "[NETWORK-POLICY] Failed to get stack network IPs");
    }

    return [...resultMap.values()];
}

/**
 * Per running project: its published hostnames and the IPs of its own
 * containers on its project network (shared proxies and ingress excluded).
 * A project whose state cannot be read gets no rule (fail closed).
 */
async function getOwnHostAccess(): Promise<OwnHostAccess[]> {
    const result: OwnHostAccess[] = [];
    for (const project of projectToStack.keys()) {
        try {
            const hostnames = await projectPublishedHostnames(project);
            if (hostnames.length === 0) continue;
            const inspect = await execDocker([
                "network", "inspect", `agent_egress_${project}`, "--format", "{{json .Containers}}",
            ]);
            if (inspect.status !== 0) continue;
            const containers: Record<string, NetworkContainer> = JSON.parse(inspect.stdout.trim()) ?? {};
            const ips = nonProxyContainerIps(containers)
                .filter(({ name }) => name !== INGRESS_CONTAINER)
                .map(({ ip }) => ip);
            if (ips.length > 0) result.push({ project, ips, hostnames });
        } catch (err) {
            logger.warn({ project, err }, "[NETWORK-POLICY] Skipping own-hostname access");
        }
    }
    return result;
}

/**
 * IPs of the api-relay container across all its networks (squid sees whichever
 * one the relay connects through). Empty when the container is unknown, which
 * makes generateSquidConf omit the relay-only rule (fail closed).
 */
async function getRelayIPs(): Promise<string[]> {
    try {
        const r = await execDocker([
            "inspect", API_RELAY_CONTAINER, "--format", "{{json .NetworkSettings.Networks}}",
        ]);
        if (r.status !== 0) return [];
        const nets: Record<string, { IPAddress?: string }> = JSON.parse(r.stdout.trim());
        return [...new Set(Object.values(nets).map(n => n?.IPAddress).filter((ip): ip is string => !!ip))];
    } catch (err) {
        logger.warn({ err }, "[NETWORK-POLICY] Failed to get api-relay IPs");
        return [];
    }
}

// ── YAML parser (uses shared utility) ──────────────────────────────────────

function parseSimpleYaml(content: string): NetworkPolicy {
    const result: NetworkPolicy = {};
    const doc: unknown = parse(content);
    const domains = yamlStringList(doc, "allowed_domains");
    if (domains.length > 0) result.allowed_domains = domains;
    const relay = yamlStringList(doc, "relay_domains");
    if (relay.length > 0) result.relay_domains = relay;
    const privateHosts = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).relay_private_hosts : undefined;
    if (Array.isArray(privateHosts) && privateHosts.length > 0) result.relay_private_hosts = privateHosts;
    const ports = yamlStringList(doc, "host_ports");
    if (ports.length > 0) result.host_ports = ports;
    const denyPorts = yamlStringList(doc, "host_deny_ports");
    if (denyPorts.length > 0) result.host_deny_ports = denyPorts;
    return result;
}

/**
 * Load a network policy YAML file. Returns null if not found.
 */
async function loadNetworkPolicy(yamlPath: string): Promise<NetworkPolicy | null> {
    if (!(await fileExists(yamlPath))) return null;
    try {
        const content = await fsp.readFile(yamlPath, "utf-8");
        return parseSimpleYaml(content);
    } catch (err) {
        logger.error({ yamlPath, err }, "[NETWORK-POLICY] Failed to parse YAML");
        return null;
    }
}

const DEFAULT_HOST_PORTS = ["3000-9999", "11434"];
/** Board (default 3000) and carapa-box (default 3100): reachable only through api-relay. */
const DEFAULT_HOST_DENY_PORTS = ["3000", "3100"];

/**
 * Keep valid squid port entries: an integer 1-65535 or a `low-high` range with
 * low <= high. Invalid entries are skipped with a warning; when none remain the
 * defaults apply (for host_deny_ports this keeps the deny in place — fail closed).
 */
function validPortEntries(key: string, entries: string[] | undefined, defaults: string[]): string[] {
    const valid: string[] = [];
    for (const entry of entries ?? []) {
        const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(entry);
        const low = m ? Number(m[1]) : 0;
        const high = m ? Number(m[2] ?? m[1]) : 0;
        if (!m || low < 1 || high > 65535 || low > high) {
            logger.warn({ key, entry }, "[NETWORK-POLICY] Skipping invalid port entry");
            continue;
        }
        valid.push(entry);
    }
    return valid.length > 0 ? valid : defaults;
}

const PRIVATE_DST_RANGES = "0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1 fc00::/7 fe80::/10";
const EXACT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** One BlockList per private range, with the range's prefix length. */
const PRIVATE_RANGE_LISTS = PRIVATE_DST_RANGES.split(" ").map(range => {
    const [addr, prefix] = range.split("/");
    const family = net.isIPv6(addr) ? "ipv6" : "ipv4";
    const bits = family === "ipv6" ? 128 : 32;
    const list = new net.BlockList();
    list.addSubnet(addr, prefix === undefined ? bits : Number(prefix), family);
    return { list, family, prefix: prefix === undefined ? bits : Number(prefix) } as const;
});

/** True for a single IPv4/IPv6 address or CIDR that lies wholly inside one private range. */
function isPrivateDst(dst: string): boolean {
    const [addr, prefixText, extra] = dst.split("/");
    if (extra !== undefined || addr.includes(".") && net.isIPv6(addr)) return false;
    const family = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
    if (!family) return false;
    const bits = family === "ipv6" ? 128 : 32;
    if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return false;
    const prefix = prefixText === undefined ? bits : Number(prefixText);
    if (prefix > bits) return false;
    return PRIVATE_RANGE_LISTS.some(range => range.family === family && prefix >= range.prefix && range.list.check(addr, family));
}

/**
 * Keep valid `relay_private_hosts` entries: an exact hostname (no wildcard, no
 * leading dot, no IP literal) with a `dst` wholly inside the private ranges.
 * Invalid entries are skipped with a warning; nothing broader replaces them.
 */
function validRelayPrivateHosts(entries: unknown[] | undefined): RelayPrivateHost[] {
    const valid: RelayPrivateHost[] = [];
    for (const entry of entries ?? []) {
        const raw = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const host = typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "";
        const dst = typeof raw.dst === "string" ? raw.dst.trim() : "";
        const lastLabel = host.slice(host.lastIndexOf(".") + 1);
        if (!EXACT_HOSTNAME.test(host) || /^\d+$/.test(lastLabel) || !isPrivateDst(dst)) {
            logger.warn({ key: "relay_private_hosts", entry }, "[NETWORK-POLICY] Skipping invalid relay_private_hosts entry");
            continue;
        }
        valid.push({ host, dst });
    }
    return valid;
}

// ── Core functions ────────────────────────────────────────────────────────

/**
 * Collect base and per-stack domains separately for src-ACL isolation.
 */
export async function collectDomainPolicy(): Promise<DomainPolicy> {
    const policiesDir = path.join(getConfigDir(), "policies");
    const stacksDir = getStacksDir();
    const baseDomains = new Set<string>();
    const perStack = new Map<string, string[]>();
    const relayDomains = new Set<string>();

    // Base network policy
    const basePolicy = await loadNetworkPolicy(path.join(policiesDir, "network-base.yaml"));
    if (basePolicy?.allowed_domains) {
        for (const d of basePolicy.allowed_domains) baseDomains.add(d);
    }
    // Relay-only domains come from the base policy only. They are removed from
    // every sandbox-reachable list below, so a domain listed in both is relay-only.
    for (const d of basePolicy?.relay_domains ?? []) relayDomains.add(d);
    for (const d of relayDomains) baseDomains.delete(d);
    const relayPrivateHosts = validRelayPrivateHosts(basePolicy?.relay_private_hosts);
    const privateHostNames = new Set(relayPrivateHosts.map(e => e.host));
    for (const d of privateHostNames) baseDomains.delete(d);

    // Per-stack network policies
    if (await fileExists(stacksDir)) {
        const entries = await fsp.readdir(stacksDir, { withFileTypes: true });
        const policies = await Promise.all(entries.map(async entry => {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
            return { name: entry.name, policy: await loadNetworkPolicy(path.join(stacksDir, entry.name, "network-policy.yaml")) };
        }));
        for (const entry of policies) {
            if (!entry) continue;
            const { name, policy } = entry;
            if (policy?.allowed_domains) {
                const stackOnly = policy.allowed_domains.filter(d => !baseDomains.has(d) && !relayDomains.has(d) && !privateHostNames.has(d));
                if (stackOnly.length > 0) {
                    perStack.set(name, stackOnly.sort());
                }
            }
        }
    }

    // Project integrations the relay cannot reach yet: not a base (everyone) or
    // relay domain, and not a private host, which needs its dst written by hand.
    const coveredBy = (host: string, domain: string) => domain.startsWith(".")
        ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
    const integrationHosts = integrationAccountHosts().filter(host =>
        ![...baseDomains, ...relayDomains, ...privateHostNames].some(domain => coveredBy(host, domain)));

    return {
        baseDomains: [...baseDomains].sort(),
        relayDomains: [...relayDomains].sort(),
        relayPrivateHosts,
        integrationHosts,
        perStack,
        hostPorts: validPortEntries("host_ports", basePolicy?.host_ports, DEFAULT_HOST_PORTS),
        hostDenyPorts: validPortEntries("host_deny_ports", basePolicy?.host_deny_ports, DEFAULT_HOST_DENY_PORTS),
    };
}

/** The upstream hosts of the project integrations saved in Provider accounts (none when unavailable). */
function integrationAccountHosts(): string[] {
    const directory = process.env.PROVIDER_ACCOUNTS_DIR;
    if (!directory) return [];
    try {
        const accounts = readAccountRegistry(directory) as Array<Record<string, any>>;
        const hosts = accounts.filter(a => a.scope === "project").map(a => integrationRoute(a).host as string)
            // squid matches names; a GitLab server with a port is reached on 443 only anyway.
            .map(host => host.split(":")[0]);
        return [...new Set(hosts)].sort();
    } catch (err) {
        logger.warn({ err }, "[NETWORK-POLICY] Provider accounts unreadable; no integration hosts");
        return [];
    }
}

/** Still blocked for own published hostnames, which resolve to the (private) host nginx. */
const OWN_HOST_BLOCKED_DST = "0.0.0.0/8 127.0.0.0/8 169.254.0.0/16 ::1 fe80::/10";

/** A project's sandbox IPs and the exact hostnames the host nginx serves for that project. */
export interface OwnHostAccess {
    project: string;
    ips: string[];
    hostnames: string[];
}

/**
 * Generate squid.conf with per-stack src ACLs for domain isolation.
 */
export function generateSquidConf(policy: DomainPolicy, stackIPs: StackIPMapping[], relayIPs: string[] = [], ownHosts: OwnHostAccess[] = []): string {
    const lines: string[] = [];

    lines.push("# Auto-generated by CarapaBox network policy engine");
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push(`# Base domains: ${policy.baseDomains.length}, isolated stacks: ${stackIPs.filter(s => policy.perStack.has(s.stackName)).length}`);
    lines.push("");
    lines.push("http_port 3128");
    lines.push("");

    // Base domains — allowed for all sources
    lines.push("# ── Base domains (all stacks) ────────────────────────────────────────");
    for (const domain of policy.baseDomains) {
        lines.push(`acl base_allowed dstdomain -n ${domain}`);
    }
    lines.push("");

    // Relay-only domains. relay_allowed is always defined so the deny rule below
    // blocks every other source, even where a wildcard base/stack entry overlaps.
    // The allow rule needs relay_src, so it is emitted only when the relay IP is
    // known (fail closed).
    const hasRelayDomains = policy.relayDomains.length > 0;
    const hasRelayPrivate = policy.relayPrivateHosts.length > 0;
    const integrationHosts = policy.integrationHosts ?? [];
    const relayAllowed = (hasRelayDomains || hasRelayPrivate || integrationHosts.length > 0) && relayIPs.length > 0;
    if (hasRelayDomains || hasRelayPrivate || integrationHosts.length > 0) {
        lines.push("# ── Relay-only domains (api-relay container, not sandboxes) ───────────");
        if (relayAllowed) lines.push(`acl relay_src src ${relayIPs.join(" ")}`);
        policy.relayPrivateHosts.forEach(({ host, dst }, index) => {
            lines.push(`acl relay_private_host_${index} dstdomain -n ${host}`);
            lines.push(`acl relay_private_dst_${index} dst ${dst}`);
        });
        for (const domain of policy.relayDomains) {
            lines.push(`acl relay_allowed dstdomain -n ${domain}`);
        }
        for (const host of integrationHosts) {
            lines.push(`acl relay_integration dstdomain -n ${host}`);
        }
        lines.push("");
    }

    // Per-stack src + dstdomain ACLs
    const activeStacks: string[] = [];
    const usedAclNames = new Set<string>();
    for (const { stackName, ips } of stackIPs) {
        const stackDomains = policy.perStack.get(stackName);
        if (!stackDomains || stackDomains.length === 0) continue;

        // Sanitizing can collide (my-stack vs my_stack); squid merges same-name ACLs,
        // so a repeated name gets a numeric suffix to keep each stack's ACLs separate.
        const baseName = stackName.replace(/[^a-zA-Z0-9_]/g, "_");
        let safeName = baseName;
        for (let n = 2; usedAclNames.has(safeName); n++) safeName = `${baseName}_${n}`;
        usedAclNames.add(safeName);
        lines.push(`# ── Stack: ${stackName} ──────────────────────────────────────────────`);
        lines.push(`acl src_${safeName} src ${ips.join(" ")}`);
        for (const domain of stackDomains) {
            lines.push(`acl stack_${safeName} dstdomain -n ${domain}`);
        }
        lines.push("");
        activeStacks.push(safeName);
    }

    // Host services
    lines.push("# ── Host services ─────────────────────────────────────────────────────");
    lines.push("acl host_services dstdomain -n host.docker.internal");
    for (const port of policy.hostPorts) lines.push(`acl host_ports port ${port}`);
    lines.push(`acl control_plane_ports port ${policy.hostDenyPorts.join(" ")}`);
    lines.push("");

    // Private/loopback/link-local/metadata destinations. Appended last to each
    // allow rule (never a standalone deny) so DNS is resolved only for names that
    // already matched an allowed domain and source — no DNS exfiltration channel.
    lines.push("# ── Private destinations (blocked after DNS resolution) ───────────────");
    lines.push(`acl private_dst dst ${PRIVATE_DST_RANGES}`);
    lines.push("");

    // Access rules
    lines.push("# ── Access rules ──────────────────────────────────────────────────────");
    lines.push("acl CONNECT method CONNECT");
    lines.push("acl SSL_ports port 443");
    lines.push("acl Safe_ports port 80 443");
    lines.push("");
    // Relay-only — must precede the base/stack allows so wildcard overlaps
    // (e.g. base .example.com vs relay mcp.example.com) cannot admit sandboxes.
    // Named private hosts come first: a relay_domains wildcard that covers one
    // would otherwise deny it for the relay too.
    if (hasRelayPrivate) {
        lines.push("# Relay-only private hosts — api-relay source, HTTPS, exact resolved dst; denied for everyone else");
        // All allows before all denies: one host may be listed with several dst values.
        if (relayAllowed) {
            policy.relayPrivateHosts.forEach((_, index) => lines.push(`http_access allow CONNECT SSL_ports relay_src relay_private_host_${index} relay_private_dst_${index}`));
        }
        policy.relayPrivateHosts.forEach((_, index) => lines.push(`http_access deny relay_private_host_${index}`));
        lines.push("");
    }
    if (hasRelayDomains) {
        lines.push("# Relay-only — api-relay source, denied for everyone else");
        if (relayAllowed) lines.push("http_access allow CONNECT relay_src relay_allowed !private_dst");
        lines.push("http_access deny relay_allowed");
        lines.push("");
    }
    if (integrationHosts.length > 0 && relayAllowed) {
        lines.push("# Project integrations — api-relay source, HTTPS, public addresses; other sources unchanged");
        lines.push("http_access allow CONNECT SSL_ports relay_src relay_integration !private_dst");
        lines.push("");
    }

    // Port restriction — after relay rules, before any base/stack allow, so an
    // allowed domain cannot be tunnelled to arbitrary ports (e.g. CONNECT github.com:22).
    lines.push("# Port restriction — only 80/443 (host services exempt, limited by host_ports below)");
    lines.push("http_access deny CONNECT !SSL_ports !host_services");
    lines.push("http_access deny !Safe_ports !host_services");
    lines.push("");

    lines.push("# Base — everyone");
    lines.push("http_access allow CONNECT base_allowed !private_dst");
    lines.push("http_access allow base_allowed !private_dst");
    lines.push("");

    // Per-stack — source-restricted
    if (activeStacks.length > 0) {
        lines.push("# Per-stack — source-restricted");
        for (const safeName of activeStacks) {
            lines.push(`http_access allow CONNECT src_${safeName} stack_${safeName} !private_dst`);
            lines.push(`http_access allow src_${safeName} stack_${safeName} !private_dst`);
        }
        lines.push("");
    }

    // Own published hostnames — a project's sandboxes may open the exact names
    // the host nginx serves for that project, although they resolve to a private
    // address. HTTPS only. Numbered ACLs: sanitized project names can collide.
    const ownRules = ownHosts.flatMap(({ project, ips, hostnames }) => {
        const names = hostnames.filter(name => EXACT_HOSTNAME.test(name));
        return ips.length > 0 && names.length > 0 ? [{ project, ips, names }] : [];
    });
    if (ownRules.length > 0) {
        lines.push("# Own published hostnames — project sandboxes to their own nginx routes (HTTPS)");
        lines.push(`acl own_blocked_dst dst ${OWN_HOST_BLOCKED_DST}`);
        ownRules.forEach(({ project, ips, names }, index) => {
            lines.push(`# ${project.replace(/[^a-zA-Z0-9_.-]/g, "_")}`);
            lines.push(`acl own_src_${index} src ${ips.join(" ")}`);
            lines.push(`acl own_host_${index} dstdomain -n ${names.join(" ")}`);
            lines.push(`http_access allow CONNECT SSL_ports own_src_${index} own_host_${index} !own_blocked_dst`);
        });
        lines.push("");
    }

    // Board and carapa-box are reached via api-relay only, never through squid.
    lines.push("http_access deny host_services control_plane_ports");
    lines.push("http_access allow host_services host_ports");
    lines.push("http_access deny all");
    lines.push("");

    // Logging
    lines.push("# Log to stdout");
    lines.push("access_log stdio:/var/log/squid/access.log");
    lines.push("");
    lines.push("# No caching");
    lines.push("cache deny all");
    lines.push("");
    lines.push("cache_log /var/log/squid/cache.log");

    return lines.join("\n") + "\n";
}

/**
 * Strip volatile lines so two configs that differ only by their generation
 * timestamp compare equal. `generateSquidConf` stamps every file with a
 * `# Generated: <ISO>` line (and a comment header), so a byte comparison would
 * never match — we must ignore those before deciding whether to reconfigure.
 */
function normalizeConf(conf: string): string {
    return conf
        .split("\n")
        .filter(line => !line.startsWith("# Generated:"))
        .join("\n");
}

/** True when an exec failed because the compose service is not running. */
function isServiceNotRunning(r: { code: number; stderr: string }): boolean {
    return r.code !== 0 && /is not running|no container found|no such service/i.test(r.stderr);
}

/**
 * Apply a new squid config: write to host filesystem (bind-mounted into squid
 * container as /etc/squid/squid-generated.conf:ro), then trigger reconfigure.
 *
 * Skips the write + `squid -k reconfigure` entirely when the meaningful config
 * is unchanged. A reconfigure briefly closes port 3128 and can sever in-flight
 * egress tunnels (e.g. a concurrent agent's streaming model request), so we must
 * not churn squid on no-op reloads (identical regenerations, redundant lifecycle
 * events, or watcher touches that don't change any ACL).
 */
export async function applySquidConfig(conf: string): Promise<{ ok: boolean; message: string }> {
    const generatedDir = getStateDir();
    const generatedPath = path.join(generatedDir, "squid-generated.conf");
    const egressDir = getEgressProxyDir();

    // Previous on-disk content (null when the file is missing). The skip below
    // is only safe because a failed apply restores this content, so the file
    // always reflects a config squid actually accepted.
    let existing: string | null = null;
    try {
        existing = await fsp.readFile(generatedPath, "utf-8");
        if (normalizeConf(existing) === normalizeConf(conf)) {
            return { ok: true, message: "Network policy unchanged — squid reconfigure skipped." };
        }
    } catch {
        // File missing or unreadable (first run) — proceed with a normal apply.
    }

    // Write in-place to preserve the inode — squid's bind mount tracks the
    // original inode, so replacing the file would leave squid reading stale data.
    const writeInPlace = async (content: string): Promise<void> => {
        let fh;
        try {
            fh = await fsp.open(generatedPath, "r+");
        } catch {
            // File doesn't exist yet (first run) — create it
            fh = await fsp.open(generatedPath, "w");
        }
        try {
            await fh.truncate(0);
            if (content.length > 0) await fh.write(content, 0, "utf-8");
        } finally {
            await fh.close();
        }
    };

    // Put the previous content back (empty when there was none: the entrypoint
    // ignores an empty file). Returns a message suffix. Not used when squid is
    // not running and there is no previous config: the new config stays staged
    // so the entrypoint picks it up on first start (squid validates it then and
    // refuses to start if invalid, i.e. fail closed).
    const restore = async (): Promise<string> => {
        try {
            await writeInPlace(existing ?? "");
            return "previous config restored; will retry on next reload";
        } catch (e) {
            return `restoring previous config also failed (${e}); will retry on next reload`;
        }
    };

    try {
        await writeInPlace(conf);

        // Validate the file squid actually runs with (same -f as the entrypoint)
        const checkResult = await execInService(
            egressDir,
            "squid",
            `squid -k parse -f ${SQUID_GENERATED_CONF}`,
            "egress-proxy"
        ).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));

        if (checkResult.code !== 0) {
            if (!existing && isServiceNotRunning(checkResult)) {
                return { ok: false, message: "squid is not running; config staged for next start (not validated)" };
            }
            return {
                ok: false,
                message: `Squid config validation failed (${await restore()}): ${checkResult.stderr}`
            };
        }

        // Trigger graceful reload
        const reconfigResult = await execInService(
            egressDir,
            "squid",
            `squid -k reconfigure -f ${SQUID_GENERATED_CONF}`,
            "egress-proxy"
        ).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));

        if (reconfigResult.code !== 0) {
            return {
                ok: false,
                message: `Config written but squid -k reconfigure failed: ${reconfigResult.stderr}. ${await restore()}`
            };
        }

        const baseCount = (conf.match(/^acl base_allowed /gm) || []).length;
        const stackCount = (conf.match(/^acl stack_/gm) || []).length;
        return {
            ok: true,
            message: `Applied ${baseCount} base + ${stackCount} per-stack domain ACLs. Config saved and squid reconfigured.`
        };
    } catch (err) {
        return { ok: false, message: `Network policy apply failed: ${err} (${await restore()})` };
    }
}

type ReloadResult = { ok: boolean; message: string };

/** Tail of the reload chain and the one queued (not yet started) rerun, if any. */
let reloadTail: Promise<unknown> = Promise.resolve();
let queuedReload: Promise<ReloadResult> | null = null;

/**
 * Full reload cycle: collect domains → generate config → apply.
 *
 * Runs one at a time for every caller (debounced and direct). A call made
 * while a run is in flight shares a single queued rerun that collects state
 * only once it starts, so squid always ends on the newest state and an
 * overlapping run can never read or restore another run's unvalidated file.
 */
export function reloadNetworkPolicies(): Promise<ReloadResult> {
    if (queuedReload) return queuedReload;
    const run = reloadTail.then(() => {
        queuedReload = null;
        return runNetworkPolicyReload();
    });
    queuedReload = run;
    reloadTail = run;
    return run;
}

async function runNetworkPolicyReload(): Promise<ReloadResult> {
    try {
        const policy = await collectDomainPolicy();
        if (policy.baseDomains.length === 0) {
            return { ok: false, message: "No network policy domains found. Keeping existing config." };
        }

        const [stackIPs, relayIPs, ownHosts] = await Promise.all([
            getStackNetworkIPs(),
            getRelayIPs(),
            getOwnHostAccess(),
        ]);
        const conf = generateSquidConf(policy, stackIPs, relayIPs, ownHosts);
        const result = await applySquidConfig(conf);

        auditLog({
            timestamp: new Date().toISOString(),
            tool: "network_policy_reload",
            stack: "egress-proxy",
            service: "squid",
            command: "squid -k reconfigure",
            projectName: "egress-proxy",
            allowed: true,
            reason: result.message,
            policy_name: "network_policy",
        });

        return result;
    } catch (err) {
        return { ok: false, message: `Network policy reload failed: ${err}` };
    }
}

// ── File watcher ──────────────────────────────────────────────────────────

/** Log watcher errors, ignoring the benign EACCES/ENOENT/ABORT_ERR cases. */
function logWatcherErrors(watcher: fs.FSWatcher, dir: string, message: string): void {
    watcher.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "ENOENT" || code === "ABORT_ERR") return;
        logger.warn({ dir, err: (err as Error).message }, message);
    });
}

function debounce(fn: () => void, ms: number): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

/**
 * Debounced reload shared by every trigger (file watcher + stack lifecycle).
 * Coalescing matters: a burst of stack start/stop events (concurrent agents)
 * would otherwise fire one `squid -k reconfigure` each, and every reconfigure
 * can sever other agents' in-flight egress tunnels. One debounced reload
 * applies the final state once, and the no-op skip in applySquidConfig drops it
 * to zero reconfigures when nothing actually changed.
 */
export const scheduleNetworkPolicyReload = debounce(async () => {
    const result = await reloadNetworkPolicies();
    if (result.ok) {
        logger.info({ message: result.message }, "[NETWORK-POLICY] Reload succeeded");
    } else {
        logger.error({ message: result.message }, "[NETWORK-POLICY] Reload failed");
    }
}, 2000);

/**
 * Start watching for network policy YAML file changes.
 * Triggers a reload cycle on any .yaml change in relevant directories.
 */
export async function startNetworkPolicyWatcher(): Promise<void> {
    if (watchAbortController) {
        watchAbortController.abort();
    }
    watchAbortController = new AbortController();
    const signal = watchAbortController.signal;

    const onPolicyChange = () => {
        logger.info("[NETWORK-POLICY] Change detected, reloading...");
        scheduleNetworkPolicyReload();
    };

    const policiesDir = path.join(getConfigDir(), "policies");
    const stacksDir = getStacksDir();

    const watchers: fs.FSWatcher[] = [];
    signal.addEventListener("abort", () => {
        for (const w of watchers) w.close();
    });

    // Watch config/policies/ for base network policy changes
    if (await fileExists(policiesDir)) {
        try {
            const w = fs.watch(policiesDir, (_event, filename) => {
                if (filename && filename.includes("network") && filename.endsWith(".yaml")) {
                    onPolicyChange();
                }
            });
            watchers.push(w);
            logWatcherErrors(w, policiesDir, "[NETWORK-POLICY] Watcher error (policies dir)");
        } catch (err) {
            logger.error({ dir: policiesDir, err }, "[NETWORK-POLICY] Failed to watch policies dir");
        }
    }

    // Watch each stack subdirectory for network-policy.yaml changes (create/modify)
    if (await fileExists(stacksDir)) {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fsp.readdir(stacksDir, { withFileTypes: true });
        } catch (err) {
            logger.error({ dir: stacksDir, err }, "[NETWORK-POLICY] Failed to watch stack policies");
        }
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const stackDir = path.join(stacksDir, entry.name);
            try {
                const w = fs.watch(stackDir, (_event, filename) => {
                    if (filename === "network-policy.yaml") onPolicyChange();
                });
                watchers.push(w);
                logWatcherErrors(w, stackDir, "[NETWORK-POLICY] Watcher error");
            } catch (err) {
                logger.error({ dir: stackDir, err }, "[NETWORK-POLICY] Failed to watch stack dir");
            }
        }
    }

    logger.info("[NETWORK-POLICY] File watcher started");
}

/**
 * Stop the network policy file watcher.
 */
export function stopNetworkPolicyWatcher(): void {
    if (watchAbortController) {
        watchAbortController.abort();
        watchAbortController = null;
        logger.info("[NETWORK-POLICY] File watcher stopped");
    }
}
