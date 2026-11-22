import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseComposePsJson } from "../utils.js";
// @ts-ignore -- the relay computes the same hash for the code it loaded
import { relayCodeHash } from "../../egress-proxy/api-relay/api-relay.mjs";

/** Label recorded on each egress container; value comes from EGRESS_CODE_HASH_* env vars in compose. */
export const EGRESS_HASH_LABEL = "carapa.egress.code-hash";

/** Bind-mounted code files per egress service (see egress-proxy/docker-compose*.yml). */
const EGRESS_SERVICE_FILES: Record<string, string[]> = {
    "llama-proxy": ["llama-proxy.mjs"],
};

/** api-relay mounts this whole directory and reloads it in place on SIGHUP. */
export const RELAY_CODE_DIR = "api-relay";
const EGRESS_SERVICES = ["api-relay", ...Object.keys(EGRESS_SERVICE_FILES)];

/**
 * Label recorded on each egress container; value comes from EGRESS_DEFINITION_HASH_* env vars in compose.
 * Compose's own config-hash label is not used: `docker compose config --hash` can skip parts of the resolved definition
 * (e.g. env_file on v2.39) that container creation hashes, so every restart would look like a change.
 */
export const EGRESS_DEFINITION_LABEL = "carapa.egress.definition-hash";

/** Services whose compose definition is compared; squid has no code hash, so only a definition change recreates it. */
export const EGRESS_DEFINITION_SERVICES = [...EGRESS_SERVICES, "squid"];

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const envSuffix = (service: string): string => service.toUpperCase().replace(/-/g, "_");

/** Compose env var interpolated into the label of a service. */
function egressHashEnvName(service: string): string {
    return `EGRESS_CODE_HASH_${envSuffix(service)}`;
}

/** Compose env var interpolated into the definition-hash label of a service. */
export function egressDefinitionHashEnvName(service: string): string {
    return `EGRESS_DEFINITION_HASH_${envSuffix(service)}`;
}

/** Sort object keys recursively so equal definitions serialize equally. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/**
 * sha256 of one service in `docker compose config --format json` output, without its own definition-hash
 * label (it carries this hash). null when the output is not a model containing the service.
 */
export function egressDefinitionHash(configJson: string, service: string): string | null {
    let model: unknown;
    try {
        model = JSON.parse(configJson);
    } catch {
        return null;
    }
    const definition: unknown = (model as { services?: Record<string, unknown> } | null)?.services?.[service];
    if (!definition || typeof definition !== "object") return null;
    const { labels, ...rest } = definition as { labels?: unknown };
    const kept = labels && typeof labels === "object" && !Array.isArray(labels)
        ? Object.fromEntries(Object.entries(labels).filter(([key]) => key !== EGRESS_DEFINITION_LABEL))
        : labels;
    return createHash("sha256").update(canonicalJson(kept === undefined ? rest : { ...rest, labels: kept })).digest("hex");
}

export function egressHashEnv(hashes: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(hashes).map(([service, hash]) => [egressHashEnvName(service), hash]));
}

export function egressAutoRecreateEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.EGRESS_AUTO_RECREATE?.trim() !== "0";
}

/** sha256 per service over its bind-mounted code files (name + content, in listed order).
 * api-relay uses the relay's own hash, which a running relay reports as codeHash. */
export async function computeEgressHashes(
    stackDir: string,
    readFile: (file: string) => Promise<Buffer> = file => fsp.readFile(file),
): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    try {
        hashes["api-relay"] = relayCodeHash(path.join(stackDir, RELAY_CODE_DIR));
    } catch {
        hashes["api-relay"] = "<missing>";
    }
    for (const [service, files] of Object.entries(EGRESS_SERVICE_FILES)) {
        const hash = createHash("sha256");
        for (const file of files) {
            hash.update(file).update("\0");
            try {
                hash.update(await readFile(path.join(stackDir, file)));
            } catch {
                hash.update("<missing>");
            }
            hash.update("\0");
        }
        hashes[service] = hash.digest("hex");
    }
    return hashes;
}

const composePsEntrySchema = z.object({
    Service: z.string(),
    State: z.string(),
    Labels: z.string().nullish(),
});

/** Value of one label per RUNNING service in `docker compose ps --format json` output (array or NDJSON); "" when absent. */
function parseRecordedLabel(psOutput: string, labelName: string): Record<string, string> {
    if (!psOutput.trim()) return {};
    const parsed = parseComposePsJson(psOutput);
    const recorded: Record<string, string> = {};
    for (const item of Array.isArray(parsed) ? parsed : []) {
        const entry = composePsEntrySchema.safeParse(item);
        if (!entry.success || entry.data.State !== "running") continue;
        const label = (entry.data.Labels ?? "").split(",").find(pair => pair.startsWith(`${labelName}=`));
        recorded[entry.data.Service] = label ? label.slice(labelName.length + 1) : "";
    }
    return recorded;
}

/** Recorded code hash per RUNNING service. A running container without the label maps to "". */
export function parseRecordedHashes(psOutput: string): Record<string, string> {
    return parseRecordedLabel(psOutput, EGRESS_HASH_LABEL);
}

/** Definition hash each RUNNING container was created with. A container without the label maps to "". */
export function parseRecordedDefinitionHashes(psOutput: string): Record<string, string> {
    return parseRecordedLabel(psOutput, EGRESS_DEFINITION_LABEL);
}

/** Egress services (EGRESS_DEFINITION_SERVICES, incl. squid) that have no running container in `compose ps` output. */
export function servicesWithoutRunningContainer(psOutput: string): string[] {
    const recorded = parseRecordedHashes(psOutput);
    return EGRESS_DEFINITION_SERVICES.filter(service => !(service in recorded));
}

export interface StartMissingEgressDeps {
    psOutput: string;
    hashes: Record<string, string>;
    /** `compose up -d --no-deps <service>` with the given env. */
    start: (service: string, env: Record<string, string>) => Promise<void>;
    reconnectNetworks: () => Promise<void>;
    log: (message: string) => void;
}

/** Start egress services with no running container (e.g. box restarted mid-replacement); returns them. */
export async function startMissingEgressServices(deps: StartMissingEgressDeps): Promise<string[]> {
    const missing = servicesWithoutRunningContainer(deps.psOutput);
    if (missing.length === 0) return [];
    const env = egressHashEnv(deps.hashes);
    const started: string[] = [];
    try {
        for (const service of missing) {
            await deps.start(service, env);
            started.push(service);
            deps.log(`[EGRESS] started ${service} (no running container)`);
        }
    } finally {
        // A started service may be recreated and lose agent-network attachments.
        if (started.length > 0) await deps.reconnectNetworks();
    }
    return started;
}

export interface EgressRefreshDeps {
    enabled: boolean;
    /** Current code hashes per service. */
    hashes: Record<string, string>;
    /** Hash recorded on each running container ("" when missing). */
    recorded: Record<string, string>;
    /** Force-recreate one service with the given env. */
    recreate: (service: string, env: Record<string, string>) => Promise<void>;
    reconnectNetworks: () => Promise<void>;
    log: (message: string) => void;
    /** GET /_inflight of a service; null when unknown/unreachable (e.g. container predates /_inflight). */
    status: (service: string) => Promise<EgressStatus | null>;
    /** Ask api-relay to load its code again in place (SIGHUP). */
    reload: (service: string) => Promise<void>;
    /** Definition hash (EGRESS_DEFINITION_LABEL) each running container was created with ("" when missing). */
    recordedDefinitions: Record<string, string>;
    /** Definition hash the compose file yields for a service under the given env; null when it can't be computed. */
    definitionHash: (service: string, env: Record<string, string>) => Promise<string | null>;
    warn: (message: string) => void;
    /** Max idle wait per service in ms (EGRESS_IDLE_WAIT_MS). Default 30 min. */
    idleWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface EgressStatus {
    inflight: number;
    /** Hash of the code the serving process loaded (api-relay only). */
    codeHash?: string;
}

const egressStatusSchema = z.object({ inflight: z.number().int().nonnegative(), codeHash: z.string().optional() });

/** Parse a /_inflight response body; null when it is not one. */
export function parseEgressStatus(body: string): EgressStatus | null {
    try {
        const status = egressStatusSchema.safeParse(JSON.parse(body));
        return status.success ? status.data : null;
    } catch {
        return null;
    }
}

const EGRESS_IDLE_POLL_MS = 5_000;
const EGRESS_IDLE_LOG_MS = 60_000;
const EGRESS_IDLE_WAIT_DEFAULT_MS = 1_800_000;

export function egressIdleWaitMs(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EGRESS_IDLE_WAIT_MS?.trim());
    return env.EGRESS_IDLE_WAIT_MS?.trim() && Number.isFinite(value) && value >= 0 ? value : EGRESS_IDLE_WAIT_DEFAULT_MS;
}

/** Wait until the service reports 0 in-flight requests, it can't report, or the limit expires. */
async function waitForIdle(service: string, deps: EgressRefreshDeps): Promise<void> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const limit = deps.idleWaitMs ?? EGRESS_IDLE_WAIT_DEFAULT_MS;
    const start = now();
    let lastLog = -Infinity;
    for (;;) {
        const count = (await deps.status(service))?.inflight ?? null;
        if (count === null || count === 0) return;
        const elapsed = now() - start;
        if (elapsed >= limit) {
            deps.log(`[EGRESS] ${service} still busy after ${Math.round(elapsed / 60_000)}m; recreating, its SIGTERM drain will finish the open requests`);
            return;
        }
        if (now() - lastLog >= EGRESS_IDLE_LOG_MS) {
            deps.log(`[EGRESS] waiting for ${service} to go idle (inflight=${count})`);
            lastLog = now();
        }
        await sleep(Math.min(EGRESS_IDLE_POLL_MS, limit - elapsed));
    }
}

const RELAY_RELOAD_POLL_MS = 1_000;
const RELAY_RELOAD_WAIT_MS = 60_000;

/** Reload api-relay in place when the code it serves differs from the code on disk; true once it serves the new code. */
async function reloadRelay(deps: EgressRefreshDeps): Promise<boolean> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const hash = deps.hashes["api-relay"];
    const loaded = (await deps.status("api-relay"))?.codeHash;
    if (loaded === hash) return false;
    if (!loaded) {
        deps.log("[EGRESS] api-relay reports no code hash (unreachable, or it predates in-place reload); not reloading");
        return false;
    }
    await deps.reload("api-relay");
    const start = now();
    while (now() - start < RELAY_RELOAD_WAIT_MS) {
        await sleep(RELAY_RELOAD_POLL_MS);
        if ((await deps.status("api-relay"))?.codeHash === hash) {
            deps.log("[EGRESS] reloaded api-relay in place (code hash changed)");
            return true;
        }
    }
    deps.log(`[EGRESS] api-relay did not load the new code within ${RELAY_RELOAD_WAIT_MS / 1000}s; the previous code keeps serving (see its log)`);
    return false;
}

/**
 * Running services whose compose definition differs from the one their container was created with.
 * The label in the definition holds the code hash the container was created with, so the
 * comparison uses the recorded code hashes: a code-only change must not look like a definition change.
 * A hash that can't be determined counts as unchanged.
 */
async function changedDefinitions(deps: EgressRefreshDeps): Promise<Set<string>> {
    const changed = new Set<string>();
    const env = egressHashEnv(deps.recorded);
    for (const service of EGRESS_DEFINITION_SERVICES.filter(name => name in deps.recorded)) {
        const recorded = deps.recordedDefinitions[service];
        let expected: string | null = null;
        if (recorded) {
            try {
                expected = await deps.definitionHash(service, env);
            } catch {
                expected = null;
            }
        }
        if (!expected) {
            deps.warn(`[EGRESS] compose definition hash unavailable for ${service}; ${recorded ? "could not compute the current one" : "its container has no definition-hash label"}, not checking its definition`);
        } else if (expected !== recorded) {
            changed.add(service);
        }
    }
    return changed;
}

/**
 * Force-recreate running services whose compose definition changed, reload api-relay in place when only
 * its code changed, and force-recreate llama-proxy when only its code changed; returns the services touched.
 */
export async function refreshEgressServices(deps: EgressRefreshDeps): Promise<string[]> {
    if (!deps.enabled) return [];
    const redefined = await changedDefinitions(deps);
    const refreshed = "api-relay" in deps.recorded && !redefined.has("api-relay") && await reloadRelay(deps) ? ["api-relay"] : [];
    const changed = EGRESS_DEFINITION_SERVICES.filter(service => service in deps.recorded && (redefined.has(service) ||
        (service in EGRESS_SERVICE_FILES && deps.recorded[service] !== deps.hashes[service])));
    if (changed.length === 0) return refreshed;
    const env = egressHashEnv(deps.hashes);
    const recreated: string[] = [];
    try {
        for (const service of changed) {
            await waitForIdle(service, deps);
            await deps.recreate(service, env);
            recreated.push(service);
            deps.log(`[EGRESS] recreated ${service} (${redefined.has(service) ? "compose definition changed" : "code hash changed"})`);
        }
    } finally {
        // Reattach even when a later recreate failed: earlier ones are already off the agent networks.
        if (recreated.length > 0) await deps.reconnectNetworks();
    }
    return [...refreshed, ...changed];
}
