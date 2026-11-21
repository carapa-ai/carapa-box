import { getStateDir } from "./installation-paths.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { logger } from "./logger.js";

/**
 * Per-sandbox carapa-board API tokens, kept in memory and mirrored to a
 * carapa-box-private file so they survive a carapa-box restart while
 * sandboxes are still running.
 *
 * This file is NOT the relay-readable `generated/` directory. The relay
 * never reads it — it pulls tokens over the authenticated admin API. The
 * file is mode 0600 and lives at `generated/relay-tokens.json` in the repo
 * default, `<CARAPA_BOX_STATE_DIR>/relay-tokens.json` otherwise (gitignored,
 * writable bind mount from the same source as the audit log). The previous
 * `process.cwd() + "/state"` location failed under `read_only: true`
 * compose because the controller image's rootfs is read-only — only
 * `/tmp`, `/run`, `/app/.bun`, and `/app/generated` are writable, and
 * `/app/generated` is the only one that survives a restart.
 */

const STATE_DIR = getStateDir();
const STORE_FILE = path.join(STATE_DIR, "relay-tokens.json");

const tokens = new Map<string, string>();
let loaded = false;

/**
 * Compose the storage key. Board tokens (no service) stay bare so the
 * persisted file and the existing relay lookup are unchanged. Service-scoped
 * tokens (e.g. carapa-mail's per-account MCP token) are namespaced so a single
 * sandbox can hold several distinct relay tokens — one per downstream service.
 */
function keyFor(name: string, service?: string): string {
    return service ? `${service}::${name}` : name;
}

function loadFromDisk(): void {
    if (loaded) return;
    loaded = true;
    try {
        const raw = fs.readFileSync(STORE_FILE, "utf8");
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string" && v) tokens.set(k, v);
        }
        logger.info(`[relay-token-store] Loaded ${tokens.size} token(s) from ${STORE_FILE}`);
    } catch (err: any) {
        if (err?.code === "ENOENT") return; // first run — nothing persisted yet
        // EACCES can happen if carapa-box's own runtime mode changed (Docker
        // UID 65532 <-> host-bun UID 1000) and the private file is owned by
        // the other UID. Loud, not fatal: running sandboxes may need a
        // restart, but the relay-pull path stays available for new ones.
        logger.warn(
            `[relay-token-store] Could not load ${STORE_FILE} (${err?.code || err?.message}); starting empty. ` +
            `If carapa-box's runtime mode was switched, chown this file to the current user.`
        );
    }
}

let persistTail: Promise<void> = Promise.resolve();
// True while the last snapshot write failed, so disk may lag the map. The next
// set/delete then persists even when the map is unchanged.
let dirty = false;

async function writeSnapshot(): Promise<void> {
    // Snapshot when the write actually runs so the last write is the latest map.
    const data = JSON.stringify(Object.fromEntries(tokens));
    const tmp = `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
        await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
        // Atomic: write to a temp file then rename, so a crash mid-write
        // can't corrupt the store or leave a half-written token.
        await fsp.writeFile(tmp, data, { mode: 0o600 });
        await fsp.rename(tmp, STORE_FILE);
        renamed = true;
        dirty = false;
    } catch (err: any) {
        dirty = true;
        // Best-effort: a persistence failure must never break sandbox_start.
        // The in-memory map still serves the relay until carapa-box restarts.
        logger.error(`[relay-token-store] Failed to persist ${STORE_FILE}: ${err?.code || err?.message}`);
    } finally {
        if (!renamed) await fsp.unlink(tmp).catch(() => {});
    }
}

function persist(): Promise<void> {
    const result = persistTail.then(writeSnapshot, writeSnapshot);
    persistTail = result.catch(() => {});
    return result;
}

export async function setRelayToken(name: string, token: string, service?: string): Promise<void> {
    loadFromDisk();
    const key = keyFor(name, service);
    if (tokens.get(key) === token && !dirty) return;
    tokens.set(key, token);
    await persist();
}

export function getRelayToken(name: string, service?: string): string | null {
    loadFromDisk();
    return tokens.get(keyFor(name, service)) ?? null;
}

export async function deleteRelayToken(name: string, service?: string): Promise<void> {
    loadFromDisk();
    if (!tokens.delete(keyFor(name, service)) && !dirty) return;
    await persist();
}
