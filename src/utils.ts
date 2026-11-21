import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getStack, listStacks } from "./config.js";
import { listProjects } from "./compose/client.js";
import { logger } from "./logger.js";
import { ingressDirectory } from './ingress.js';
import { MAX_OUTPUT_BYTES } from "./capped-append.js";

// ── Shared utilities ──────────────────────────────────────────────────────

export async function fileExists(p: string): Promise<boolean> {
    try { await fsp.access(p); return true; } catch { return false; }
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Drain a stream, keeping at most MAX_OUTPUT_BYTES of decoded text. Excess is
 * read and discarded (so the child never blocks on a full pipe) and the
 * truncation marker is appended once.
 */
async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let length = 0;
    let truncated = false;
    const take = (text: string) => {
        if (!text || truncated) return;
        const room = MAX_OUTPUT_BYTES - length;
        if (text.length > room) {
            parts.push(text.slice(0, room));
            length = MAX_OUTPUT_BYTES;
            truncated = true;
        } else {
            parts.push(text);
            length += text.length;
        }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        take(decoder.decode(value, { stream: true }));
    }
    take(decoder.decode());
    return parts.join("") + (truncated ? "\n...[truncated]" : "");
}

/** True only when every non-empty stderr line reports a vanished Docker object. */
export function onlyMissingDockerObjects(stderr: string): boolean {
    const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length > 0 && lines.every(line => /no such (object|container|network)/i.test(line));
}

/** Split whitespace-delimited values emitted by Docker CLI formatters. */
export function splitDockerOutput(output: string): string[] {
    return output.trim().split(/\s+/).filter(Boolean);
}

/** Parse `docker compose ps --format json` output: one JSON array or one JSON object per line. */
export function parseComposePsJson(output: string): unknown {
    const raw = output.trim();
    return raw.startsWith("[") ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const MAX_CONCURRENT_PROCESSES = 10;
let activeProcessCount = 0;
const processQueue: Array<() => void> = [];

/**
 * Acquire a process slot. Resolves true when a slot was taken (caller must
 * release it) and false when the signal aborted first (no slot taken).
 */
export async function acquireProcessSlot(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (processQueue.length > 50) {
        logger.warn({ queueSize: processQueue.length }, "[SEMAPHORE] High process queue detected");
    }
    if (activeProcessCount < MAX_CONCURRENT_PROCESSES) {
        activeProcessCount++;
        return true;
    }
    return new Promise<boolean>(resolve => {
        const onAbort = () => {
            const i = processQueue.indexOf(waiter);
            if (i >= 0) processQueue.splice(i, 1);
            resolve(false);
        };
        const waiter = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        };
        processQueue.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Test helpers for semaphore state. */
export function getProcessSlotStats() {
    return { active: activeProcessCount, queued: processQueue.length };
}

export function releaseProcessSlot() {
    activeProcessCount--;
    if (processQueue.length > 0) {
        activeProcessCount++;
        const next = processQueue.shift();
        if (next) next();
    }
}

/** Run a docker CLI command asynchronously using Bun's native spawn. */
export async function execDocker(
    args: string[],
    options?: {
        onLog?: (msg: string) => void;
        signal?: AbortSignal;
        cwd?: string;
        env?: Record<string, string>;
        /** The caller already holds a process slot and releases it itself. */
        slotHeld?: boolean;
    }
): Promise<{ status: number; stdout: string; stderr: string; spawnFailed?: boolean }> {
    const signal = options?.signal;
    const slotHeld = options?.slotHeld === true;
    const aborted = { status: 130, stdout: "", stderr: "aborted" };
    if (!slotHeld && !(await acquireProcessSlot(signal))) return aborted;
    const dockerEnv = {
        DOCKER_HOST: process.env.DOCKER_HOST,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: process.env.TERM,
        ...(options?.env || {}),
    };
    let abort: (() => void) | undefined;

    try {
        if (signal?.aborted) return aborted;
        const proc = Bun.spawn(["docker", ...args], {
            cwd: options?.cwd,
            stdout: "pipe",
            stderr: "pipe",
            env: dockerEnv,
        });

        // Handle abort signal. Keep the listener removable so a long-lived
        // caller signal does not retain every completed subprocess.
        abort = signal ? () => proc.kill() : undefined;
        if (signal && abort) signal.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) proc.kill();

        const [stdoutText, stderrText] = await Promise.all([
            readCapped(proc.stdout),
            readCapped(proc.stderr),
        ]);

        if (options?.onLog) {
            if (stdoutText) options.onLog(stdoutText);
            if (stderrText) options.onLog(stderrText);
        }

        const status = await proc.exited;

        return {
            status,
            stdout: stdoutText,
            stderr: stderrText,
        };
    } catch (err: any) {
        logger.error({ args, err }, "execDocker failed to spawn");
        return { status: 1, stdout: "", stderr: err.message, spawnFailed: true };
    } finally {
        if (signal && abort) signal.removeEventListener("abort", abort);
        if (!slotHeld) releaseProcessSlot();
    }
}

/**
 * Run a docker command that a sandbox can make hang (an `exec` into its
 * container). The signal stops a real process; the race also bounds a caller
 * whose exec ignores it. A timeout is reported as status 124. The timer starts
 * only once a process slot is held: time queued behind other docker calls
 * must not count as a hang. The slot is held until the exec settles, even
 * after 124 is returned.
 */
export async function execDockerWithTimeout(
    exec: typeof execDocker,
    args: string[],
    timeoutMs: number,
): Promise<{ status: number; stdout: string; stderr: string; spawnFailed?: boolean }> {
    await acquireProcessSlot();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run: ReturnType<typeof execDocker>;
    try {
        run = exec(args, { signal: controller.signal, slotHeld: true });
    } catch (err) {
        releaseProcessSlot();
        throw err;
    }
    // The slot frees when the child has really exited, not when 124 is
    // returned, so a slow-to-die child still counts toward the process limit.
    run.then(() => {}, () => {}).then(releaseProcessSlot);
    const timedOut = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({ status: 124, stdout: "", stderr: `docker ${args[0]} timed out after ${timeoutMs}ms` });
        }, timeoutMs);
    });
    try {
        return await Promise.race([run, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

// ── Stack/project resolution ──────────────────────────────────────────────

/**
 * Resolve a ConfigFiles path to a local stack path.
 * Handles container-internal paths (e.g. /app/stacks/carapa-bot/docker-compose.yml)
 * by matching the stack directory name against known local stacks.
 */
async function resolveLocalStackPath(configFiles: string): Promise<string | undefined> {
    const firstConfig = configFiles.split(",")[0].trim();
    if (!firstConfig) return undefined;

    const dirPath = path.dirname(firstConfig);

    // If the path exists locally, use it directly
    if (await fileExists(dirPath)) return dirPath;

    // Cross-context: extract stack name from .../stacks/<name>/docker-compose.yml
    const parentDir = path.basename(dirPath);
    const grandParent = path.basename(path.dirname(dirPath));
    if (grandParent === "stacks") {
        const stack = await getStack(parentDir);
        if (stack) return stack.path;
    }

    return undefined;
}

/**
 * Common helper to resolve a stack path and project name from either a stack name or project name.
 */
export async function resolveStackAndProject(name: string, instance?: string) {
    const stack = await getStack(name);
    let projectName = instance ? `${name}-${instance}` : name;
    let stackPath = stack?.path;

    if (!stack) {
        // Check if 'name' is actually an instance project name
        try {
            const projs = await listProjects();
            const projects = JSON.parse(projs.stdout);
            const project = projects.find((p: any) => p.Name === name);
            if (project && project.ConfigFiles) {
                stackPath = await resolveLocalStackPath(project.ConfigFiles);
                projectName = name;
            }
        } catch {
            // listProjects failed, likely no docker or first run
        }
    }

    return { stackPath, projectName };
}

// ── Docker project resolution ────────────────────────────────────────────

export const STATUS_SAFE_KEYS = new Set(["Name", "Service", "State", "Status", "ExitCode", "Health", "Image", "Project", "Publishers", "Networks", "IP", "IPAddress", "Address", "Ports", "ImageID", "RunningImageID", "NeedsRestart", "UpToDate"]);

/**
 * Filter an object to only include keys safe for the status tool.
 * Takes an object directly to avoid redundant string parsing.
 */
export function sanitizeStatusObject(obj: any): Record<string, unknown> | null {
    if (!obj || typeof obj !== "object") return null;
    
    const result: Record<string, unknown> = {};
    let hasValue = false;
    for (const key in obj) {
        if (STATUS_SAFE_KEYS.has(key)) {
            result[key] = obj[key];
            if (obj[key] !== "") hasValue = true;
        }
    }
    return hasValue ? result : null;
}

function isInside(dir: string, file: string): boolean {
    const rel = path.relative(path.resolve(dir), path.resolve(file));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve docker compose projects to local stack paths.
 * Handles path mismatch when stacks were started from a containerized box
 * (ConfigFiles contain container-internal paths like /app/stacks/...)
 * but the CLI/server runs on the host (stacksDir is the host path).
 */
export async function resolveOwnedProjects(
    projects: Array<{ Name: string; ConfigFiles: string }>,
    stacksDir: string,
    deps: {
        listStacks: typeof listStacks;
        execDocker: typeof execDocker;
        readFile: typeof fsp.readFile;
        workingDirectories?: ReadonlyMap<string, readonly string[]>;
    } = { listStacks, execDocker, readFile: fsp.readFile },
): Promise<Array<{ name: string; localStackPath: string }>> {
    // Build a map of known stack names to their local paths
    const stackMap = new Map<string, string>();
    for (const stack of (await deps.listStacks())) {
        stackMap.set(stack.name, stack.path);
    }

    const resolved: Array<{ name: string; localStackPath: string }> = [];

    for (const p of projects) {
        const configFiles = (p.ConfigFiles || "").split(",");
        let localStackPath = "";

        for (const file of configFiles) {
            const trimmedFile = file.trim();
            if (!trimmedFile) continue;

            // Direct path match (same context that started it)
            if (isInside(stacksDir, trimmedFile)) {
                localStackPath = path.dirname(trimmedFile);
                break;
            }

            // Realpath match (symlinks etc.)
            try {
                const absFile = await fsp.realpath(trimmedFile);
                if (isInside(stacksDir, absFile)) {
                    localStackPath = path.dirname(absFile);
                    break;
                }
            } catch { /* intentionally swallowed: realpath failed (missing file, broken symlink, or permission error), fall through to next resolution strategy */ }

            // Cross-context match: check if path is .../stacks/<known-stack>/docker-compose.yml
            // This handles container paths like /app/stacks/carapa-bot/docker-compose.yml
            // when running on the host where stacksDir is different
            const fileName = path.basename(trimmedFile);
            const parentDir = path.basename(path.dirname(trimmedFile));
            const grandParent = path.basename(path.dirname(path.dirname(trimmedFile)));
            if (fileName === "docker-compose.yml" && grandParent === "stacks" && stackMap.has(parentDir)) {
                localStackPath = stackMap.get(parentDir)!;
                break;
            }
        }

        // Migrated projects use a private Compose file. Resolve their original
        // stack from Compose's working-directory label, never a project-name guess.
        if (!localStackPath && /^[a-z0-9][a-z0-9_-]*$/.test(p.Name)) {
            const privateFile = path.join(ingressDirectory(), 'compose', `${p.Name}.json`);
            const expectedFiles = new Set([
                privateFile,
                path.join('/app/ingress/compose', `${p.Name}.json`),
                ...(process.env.INGRESS_STATE_HOST_DIR ? [path.join(process.env.INGRESS_STATE_HOST_DIR, 'compose', `${p.Name}.json`)] : []),
            ]);
            if (configFiles.some(file => expectedFiles.has(file.trim()))) {
                try {
                    const model = JSON.parse(await deps.readFile(privateFile, 'utf8'));
                    if (model.name === p.Name) {
                        let candidates: readonly string[];
                        if (deps.workingDirectories) {
                            candidates = deps.workingDirectories.get(p.Name) ?? [];
                        } else {
                            const result = await deps.execDocker(['ps', '-a', '--filter', `label=com.docker.compose.project=${p.Name}`,
                                '--format', '{{.Label "com.docker.compose.project.working_dir"}}']);
                            if (result.status !== 0) continue;
                            candidates = result.stdout.trim().split('\n');
                        }
                        const directories = [...new Set(candidates.filter(Boolean))];
                        if (directories.length === 1) {
                            const original = directories[0];
                            const stackName = path.basename(original);
                            const knownPath = stackMap.get(stackName);
                            if (knownPath && (original === knownPath || path.basename(path.dirname(original)) === 'stacks')) localStackPath = knownPath;
                        }
                    }
                } catch { /* Missing/corrupt state cannot establish project ownership. */ }
            }
        }

        if (localStackPath) {
            resolved.push({ name: p.Name, localStackPath });
        }
    }

    return resolved;
}

// ── .env file helpers ─────────────────────────────────────────────────────

/**
 * Value of a `KEY=value` line's right-hand side as parseEnvFile reads it: trimmed, a quoted value loses its
 * quotes and an optional ` # comment`, an unquoted value loses its ` # comment` (a `#` without preceding whitespace stays).
 * Same rule as the os-runner parser.
 */
export function unquoteEnvValue(raw: string): string {
    const val = raw.trim();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(val);
    return quoted ? quoted[2] : val.replace(/\s+#.*$/, "");
}

/**
 * Format a value for a .env line. Values that Bun or compose would read differently unquoted
 * (` #` starts a comment, `$` interpolates, surrounding quotes get stripped) are wrapped in quotes.
 */
function quoteEnvValue(val: string): string {
    if (!/\s#|\$|^["']/.test(val)) return val;
    if (!val.includes("'")) return `'${val}'`;
    if (!/["$\\]/.test(val)) return `"${val}"`;
    return val; // no quoting form keeps this value literal in every reader
}

/**
 * Parse a .env file into a Record<string, string>
 */
export async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    try {
        const content = await fsp.readFile(filePath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const match = trimmed.match(/^(?:export\s+)?([^=]+)=(.*)$/);
            if (match) env[match[1].trim()] = unquoteEnvValue(match[2]);
        }
    } catch {
        // intentionally swallowed: .env file may be absent or unreadable; caller receives a partial/empty env record, which is the correct fallback
    }
    return env;
}

/**
 * Merge updates into a .env file: lines of submitted keys are updated in place,
 * new keys are appended, every other line (comments, blanks, unknown keys) is kept as-is.
 * Written atomically via a unique temp file + rename; the existing file mode is preserved.
 * Callers must validate that keys/values contain no newlines.
 */
export async function mergeEnvFile(filePath: string, updates: Record<string, string>): Promise<void> {
    let existing = "";
    let mode: number | undefined;
    try {
        existing = await fsp.readFile(filePath, "utf-8");
        mode = (await fsp.stat(filePath)).mode & 0o777;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const lines = existing === "" ? [] : existing.split(/\r?\n/);
    const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    if (trailingNewline) lines.pop();
    const seen = new Set<string>();
    const out = lines.map(line => {
        const match = line.match(/^(\s*(?:export\s+)?)([^=#\s][^=]*?)\s*=(.*)$/);
        if (!match || !Object.hasOwn(updates, match[2])) return line;
        // Rewrite every line of the key: parsers use the last occurrence
        seen.add(match[2]);
        // Unchanged value: keep the line so its original quoting survives
        if (unquoteEnvValue(match[3]) === updates[match[2]]) return line;
        return `${match[1].trimStart()}${match[2]}=${quoteEnvValue(updates[match[2]])}`;
    });
    for (const [key, val] of Object.entries(updates)) {
        if (!seen.has(key)) out.push(`${key}=${quoteEnvValue(val)}`);
    }
    const content = out.join(eol) + (out.length > 0 && (trailingNewline || existing === "") ? eol : "");

    const tmp = `${filePath}.${randomUUID()}.tmp`;
    try {
        await fsp.writeFile(tmp, content, { encoding: "utf-8", mode: mode ?? 0o600 });
        if (mode !== undefined) await fsp.chmod(tmp, mode);
        await fsp.rename(tmp, filePath);
    } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
    }
}
