import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getEgressProxyCodeDir, getEgressProxyDir } from "../config.js";
import { logger } from "../logger.js";

/** Egress services whose deploy-copy definition is compared with the checkout's. */
const EGRESS_DRIFT_SERVICES = ["api-relay", "llama-proxy", "squid"];

/** What the deploy copy of one service lacks compared with the checkout. */
export interface ServiceDrift {
    /** The whole service is absent from the deploy copy. */
    missing_service: boolean;
    /** Volume targets (container paths) present in the checkout only. */
    volumes: string[];
    /** `environment` keys present in the checkout only. */
    env: string[];
}

export type EgressDrift = Record<string, ServiceDrift>;

/** Container path of a short (`src:target[:mode]`) or long (`target:`) volume entry. */
function volumeTarget(entry: unknown): string | null {
    if (typeof entry === "string") {
        // Split on colons outside `${…}` so interpolation defaults (`${A:-.}`) do not count as separators.
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        for (let i = 0; i < entry.length; i++) {
            const char = entry[i];
            if (char === "$" && entry[i + 1] === "{") depth++;
            else if (char === "}" && depth > 0) depth--;
            if (char === ":" && depth === 0) {
                parts.push(current);
                current = "";
            } else {
                current += char;
            }
        }
        parts.push(current);
        return (parts.length === 1 ? parts[0] : parts[1]) || null;
    }
    if (entry && typeof entry === "object") {
        const target = (entry as { target?: unknown }).target;
        return typeof target === "string" && target ? target : null;
    }
    return null;
}

function volumeTargets(service: unknown): Set<string> {
    const volumes = (service as { volumes?: unknown } | null)?.volumes;
    if (!Array.isArray(volumes)) return new Set();
    return new Set(volumes.map(volumeTarget).filter((target): target is string => target !== null));
}

/** `environment` keys in list (`KEY=value`, `KEY`) or map form. */
function envKeys(service: unknown): Set<string> {
    const environment = (service as { environment?: unknown } | null)?.environment;
    if (Array.isArray(environment)) {
        return new Set(environment.filter((item): item is string => typeof item === "string").map(item => item.split("=")[0]));
    }
    if (environment && typeof environment === "object") return new Set(Object.keys(environment));
    return new Set();
}

function servicesOf(model: unknown): Record<string, unknown> {
    const services = (model as { services?: unknown } | null)?.services;
    return services && typeof services === "object" ? services as Record<string, unknown> : {};
}

/**
 * Volume targets, environment keys and services the checkout's compose model defines for the egress
 * services but the deploy copy lacks. Host source paths are ignored; extras in the deploy copy are not reported.
 */
function egressComposeDrift(checkout: unknown, deploy: unknown): EgressDrift {
    const checkoutServices = servicesOf(checkout);
    const deployServices = servicesOf(deploy);
    const drift: EgressDrift = {};
    for (const name of EGRESS_DRIFT_SERVICES) {
        if (!(name in checkoutServices)) continue;
        if (!(name in deployServices)) {
            drift[name] = { missing_service: true, volumes: [], env: [] };
            continue;
        }
        const deployVolumes = volumeTargets(deployServices[name]);
        const deployEnv = envKeys(deployServices[name]);
        const volumes = [...volumeTargets(checkoutServices[name])].filter(target => !deployVolumes.has(target));
        const env = [...envKeys(checkoutServices[name])].filter(key => !deployEnv.has(key));
        if (volumes.length > 0 || env.length > 0) drift[name] = { missing_service: false, volumes, env };
    }
    return drift;
}

function describeDrift(service: string, drift: ServiceDrift): string {
    if (drift.missing_service) return `${service} missing from deploy compose`;
    const parts = drift.volumes.map(target => `missing volume ${target}`);
    if (drift.env.length > 0) parts.push(`missing env ${drift.env.join(", ")}`);
    return `${service} ${parts.join("; ")}`;
}

let lastDrift: EgressDrift = {};

/** Result of the last startup check; empty when there was no drift, no deploy dir, or no check yet. */
export function getEgressDeployDrift(): EgressDrift {
    return lastDrift;
}

export interface EgressDriftOptions {
    egressDir?: string;
    codeDir?: string;
    warn?: (message: string) => void;
}

async function readComposeModel(dir: string): Promise<unknown> {
    // yaml performs no ${…} interpolation, so neither .env nor secrets are needed.
    return parseYaml(await fsp.readFile(path.join(dir, "docker-compose.yml"), "utf8"), { merge: true });
}

/**
 * Compare the checkout's egress compose file with the operator's deploy copy, log one warning per drifting
 * service and cache the result. Never throws; an unreadable or unparsable file logs one warning.
 */
export async function checkEgressDeployDrift(options: EgressDriftOptions = {}): Promise<EgressDrift> {
    const warn = options.warn ?? ((message: string) => logger.warn(message));
    const egressDir = path.resolve(options.egressDir ?? getEgressProxyDir());
    const codeDir = path.resolve(options.codeDir ?? getEgressProxyCodeDir());
    lastDrift = {};
    if (egressDir === codeDir) return lastDrift;
    try {
        const [checkout, deploy] = await Promise.all([readComposeModel(codeDir), readComposeModel(egressDir)]);
        lastDrift = egressComposeDrift(checkout, deploy);
    } catch (e) {
        warn(`[EGRESS] deploy compose drift check skipped: ${e instanceof Error ? e.message : String(e)}`);
        return lastDrift;
    }
    for (const [service, drift] of Object.entries(lastDrift)) {
        warn(`[EGRESS] deploy compose drift: ${describeDrift(service, drift)}`);
    }
    return lastDrift;
}
