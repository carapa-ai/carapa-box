import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env file into process.env ────────────────────────────────────
const envFile = path.join(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const [key, ...values] = trimmed.split('=');
        if (key && values.length > 0) {
            const k = key.trim();
            if (process.env[k] === undefined) {
                process.env[k] = values.join('=').trim();
            }
        }
    });
}

// ── Docker Compose file-based secrets ──────────────────────────────────
// Reads from /run/secrets/<name> first, falls back to process.env.
const SECRETS_DIR = process.env.SECRETS_DIR || '/run/secrets';
function readSecret(envName: string): string {
    const fileName = envName.toLowerCase();
    try {
        const val = fs.readFileSync(path.join(SECRETS_DIR, fileName), 'utf8').trim();
        if (val) return val;
    } catch { /* intentionally swallowed: secret file absent (non-container env), falls back to process.env below */ }
    return process.env[envName] || '';
}

// Inject secrets into process.env for code that reads them directly.
for (const key of ['CARAPA_BOX_ADMIN_TOKEN', 'CARAPA_BOX_API_TOKEN', 'CARAPA_HUB_BOX_SECRET']) {
    if (!process.env[key]) {
        const val = readSecret(key);
        if (val) process.env[key] = val;
    }
}

export interface StackInfo {
    name: string;
    path: string;
    hasEnv: boolean;
    hasOpaPolicy: boolean;
    hooks: {
        beforeStart: boolean;
        afterStart: boolean;
        beforeStop: boolean;
        afterStop: boolean;
    };
    /** Harnesses selected with harness.py; absent when the stack has no harness selection. */
    harnesses?: string[];
}

/**
 * Get the stacks directory path
 */
export function getStacksDir(): string {
    // Default to stacks/ in project root (one level up from src/)
    return process.env.SANDBOX_STACKS_DIR || path.resolve(__dirname, "../stacks");
}

/**
 * Get the egress-proxy infrastructure directory path.
 * This is separate from the stacks directory because egress-proxy is
 * infrastructure, not a user-managed stack.
 */
export function getEgressProxyDir(): string {
    return process.env.SANDBOX_EGRESS_PROXY_DIR || path.resolve(__dirname, "../egress-proxy");
}

/**
 * Get the egress-proxy service code directory: the bind-mounted *.mjs files
 * whose hashes drive auto-recreation, and the provider-login helper.
 * Defaults to the egress-proxy directory; set SANDBOX_EGRESS_PROXY_CODE_DIR
 * when the Compose project (compose files, .env, hooks) lives in an
 * operator-only directory instead.
 */
export function getEgressProxyCodeDir(): string {
    return process.env.SANDBOX_EGRESS_PROXY_CODE_DIR || getEgressProxyDir();
}

let cachedStacks: StackInfo[] | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 30_000;

async function isStackDirectory(entry: fs.Dirent, stackPath: string): Promise<boolean> {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
        return (await fsp.stat(stackPath)).isDirectory();
    } catch {
        return false; // broken symlink
    }
}

async function listStackDirectories(stacksDir: string): Promise<Array<{ name: string; path: string }>> {
    const entries = await fsp.readdir(stacksDir, { withFileTypes: true });
    const directories = await Promise.all(entries.map(async (entry) => {
        const stackPath = path.join(stacksDir, entry.name);
        // Follow symlinks: isDirectory() returns false for symlinks.
        if (await isStackDirectory(entry, stackPath)) {
            return { name: entry.name, path: stackPath };
        }
        return null;
    }));

    return directories.filter((directory): directory is { name: string; path: string } => directory !== null);
}

async function stackRequiredFiles(stackPath: string): Promise<{ hasCompose: boolean; hasOpaPolicy: boolean }> {
    const [hasCompose, hasOpaPolicy] = await Promise.all([
        fileExists(path.join(stackPath, "docker-compose.yml")),
        fileExists(path.join(stackPath, "policy.wasm")),
    ]);
    return { hasCompose, hasOpaPolicy };
}

async function readSelectedHarnesses(stackPath: string): Promise<string[] | undefined> {
    try {
        const selection = JSON.parse(await fsp.readFile(path.join(stackPath, ".harness/active/selection.json"), "utf8"));
        const harnesses = selection?.manifest?.harnesses;
        return harnesses && typeof harnesses === "object" ? Object.keys(harnesses).sort() : undefined;
    } catch {
        return undefined;
    }
}

async function readStackInfo(name: string, stackPath: string): Promise<StackInfo | null> {
    const { hasCompose, hasOpaPolicy } = await stackRequiredFiles(stackPath);
    // Refuse to register stacks missing their runtime authorization policy.
    if (!hasCompose || !hasOpaPolicy) return null;

    const [hasEnv, beforeStart, afterStart, beforeStop, afterStop, harnesses] = await Promise.all([
        fileExists(path.join(stackPath, ".env")),
        fileExists(path.join(stackPath, "before-start.sh")),
        fileExists(path.join(stackPath, "after-start.sh")),
        fileExists(path.join(stackPath, "before-stop.sh")),
        fileExists(path.join(stackPath, "after-stop.sh")),
        readSelectedHarnesses(stackPath),
    ]);

    return {
        name,
        path: stackPath,
        hasEnv,
        hasOpaPolicy,
        hooks: { beforeStart, afterStart, beforeStop, afterStop },
        ...(harnesses ? { harnesses } : {}),
    };
}

/**
 * List all available stacks
 */
export async function listStacks(): Promise<StackInfo[]> {
    const now = Date.now();
    if (cachedStacks && now - lastCacheTime < CACHE_TTL_MS) {
        return cachedStacks;
    }

    const stacksDir = getStacksDir();

    if (!(await fileExists(stacksDir))) {
        return [];
    }

    const stacks = await Promise.all(
        (await listStackDirectories(stacksDir)).map(({ name, path: stackPath }) =>
            readStackInfo(name, stackPath)),
    );

    cachedStacks = stacks.filter((stack): stack is StackInfo => stack !== null);
    lastCacheTime = Date.now();
    return cachedStacks;
}

/**
 * Get a specific stack by name
 */
export async function getStack(name: string): Promise<StackInfo | null> {
    const stacksDir = getStacksDir();
    const stackPath = path.join(stacksDir, name);

    try {
        const stat = await fsp.stat(stackPath);
        if (!stat.isDirectory()) return null;
    } catch {
        return null;
    }

    return readStackInfo(name, stackPath);
}

/**
 * Validate that a stack name is safe (no path traversal)
 */
export function isValidStackName(name: string): boolean {
    // Only allow alphanumeric, dash, underscore
    return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Startup security check: scan all stack directories and report which ones
 * are excluded due to missing policy.wasm. Returns the names of
 * excluded stacks so the caller can log or act on them.
 */
export async function validateStacksSecurity(): Promise<{ registered: string[]; excluded: string[] }> {
    const stacksDir = getStacksDir();
    const registered: string[] = [];
    const excluded: string[] = [];

    if (!(await fileExists(stacksDir))) {
        return { registered, excluded };
    }

    const results = await Promise.all((await listStackDirectories(stacksDir)).map(async ({ name, path: stackPath }) => {
        const { hasCompose, hasOpaPolicy } = await stackRequiredFiles(stackPath);
        return hasCompose ? { name, hasOpaPolicy } : null;
    }));

    for (const result of results) {
        if (!result) continue;
        if (result.hasOpaPolicy) {
            registered.push(result.name);
        } else {
            excluded.push(result.name);
        }
    }

    return { registered, excluded };
}
