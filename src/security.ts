import { getConfigDir } from "./installation-paths.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hasOpaPolicy, evaluatePolicy, type PolicyInput } from "./policy.js";
import { parseYamlList } from "./yaml-utils.js";
import { parse as parseYaml } from "yaml";

/**
 * Filter an env record through the stack's env_passthrough allowlist.
 * Reads from env-passthrough.yaml in the stack directory.
 * Only keys listed in the allowlist are returned.
 * Returns an empty object if no allowlist is defined or the file is missing.
 */
export async function filterEnvPassthrough(
    stackPath: string,
    env: Record<string, string>
): Promise<Record<string, string>> {
    const yamlPath = path.join(stackPath, "env-passthrough.yaml");
    try {
        const content = await fsp.readFile(yamlPath, "utf-8");
        const allowlist = parseYamlList(content, "allowed_keys");
        const filtered: Record<string, string> = {};
        for (const key of allowlist) {
            if (key in env) filtered[key] = env[key];
        }
        return filtered;
    } catch {
        // intentionally swallowed: env-passthrough.yaml unreadable, no env vars passed through (safe default — no caller env leaks into sandbox)
        return {};
    }
}

const COMPOSE_FILE_NAME_RE = /^docker-compose[A-Za-z0-9._-]*\.yml$/;

/**
 * Validate a caller-supplied COMPOSE_FILE value. Every ':'-separated entry must
 * be a bare docker-compose*.yml name that exists in the stack directory.
 * Returns a [SECURITY] error message, or null when valid.
 */
export async function validateComposeFileEnv(
    stackPath: string,
    value: string
): Promise<string | null> {
    const entries = value.split(":");
    for (const entry of entries) {
        if (
            !COMPOSE_FILE_NAME_RE.test(entry)
            || entry.startsWith("docker-compose.override.")
            || entry.includes("/")
            || entry.includes("..")
        ) {
            return `[SECURITY] COMPOSE_FILE entry "${entry}" rejected: only bare docker-compose*.yml names (no paths, no override files) are allowed`;
        }
        try {
            await fsp.access(path.join(stackPath, entry));
        } catch {
            return `[SECURITY] COMPOSE_FILE entry "${entry}" rejected: file not found in stack directory`;
        }
    }
    return null;
}

// ── Command validation (OPA-only) ────────────────────────────────────────

const MAX_COMMAND_LENGTH = 8192;
export const TRUSTED_BIN_CONTAINER_PATH = "/usr/local/ai-cli-bin";
export const STACK_BIN_CONTAINER_PATH = "/usr/local/stack-cli-bin";

export type TrustedCommand = {
    argv: string[];
    command: string;
    executable: string;
};

function quoteCommandArgument(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const RESTART_RECOVERY_RECEIPT_RE =
    /^(run-agent\.sh \/workspace\/ipc\/runs\/([A-Za-z0-9][A-Za-z0-9._-]*)) && : > \/workspace\/ipc\/runs\/\2\/\.restart-recovery-dispatched$/;

/**
 * Recognise the Board's exact restart-recovery launch form
 * `run-agent.sh /workspace/ipc/runs/<id> && : > /workspace/ipc/runs/<id>/.restart-recovery-dispatched`.
 * Returns the shell-free command part and the receipt path the box must create after exit 0, or null.
 */
export function splitRestartRecoveryReceipt(command: string): { command: string; receipt: string } | null {
    const match = RESTART_RECOVERY_RECEIPT_RE.exec(command);
    if (!match) return null;
    const id = match[2];
    if (id === "." || id === ".." || id.includes("..")) return null;
    return { command: match[1], receipt: `/workspace/ipc/runs/${id}/.restart-recovery-dispatched` };
}

/** Parse one shell-like invocation without permitting shell evaluation. */
export function parseCommandArgv(command: string): { ok: true; argv: string[] } | { ok: false; reason: string } {
    const argv: string[] = [];
    let word = "";
    let wordStarted = false;
    let quote: "'" | '"' | null = null;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) {
            // An unquoted backslash-newline is a line continuation: it neither
            // becomes part of the argument nor starts a new one.
            if (ch !== "\n") {
                word += ch;
                wordStarted = true;
            }
            escaped = false;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else if (quote === '"' && ch === "\\") {
                const next = command[i + 1];
                if (next === undefined) {
                    return { ok: false, reason: "Unterminated quote or escape sequence." };
                }
                // POSIX-like double-quote semantics: backslash is special only
                // before $, `, ", \, or newline. Otherwise it is literal.
                if ("$`\"\\".includes(next)) {
                    word += next;
                    i++;
                } else if (next === "\n") {
                    i++;
                } else {
                    word += "\\";
                }
            } else if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) {
                return { ok: false, reason: "Command substitution is not allowed." };
            } else {
                word += ch;
            }
            wordStarted = true;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            wordStarted = true;
            continue;
        }
        if (ch === "\n" || ch === "\r") {
            return { ok: false, reason: "Multiple command segments are not allowed." };
        }
        if (/\s/.test(ch)) {
            if (wordStarted) {
                argv.push(word);
                word = "";
                wordStarted = false;
            }
            continue;
        }
        if ("|&;<>".includes(ch)) {
            return { ok: false, reason: `Shell control operator '${ch}' is not allowed.` };
        }
        if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
            return { ok: false, reason: "Command substitution is not allowed." };
        }
        word += ch;
        wordStarted = true;
    }
    if (quote || escaped) return { ok: false, reason: "Unterminated quote or escape sequence." };
    if (wordStarted) argv.push(word);
    if (argv.length === 0) return { ok: false, reason: "Command is empty." };
    return { ok: true, argv };
}

async function validateStackExecutable(trustedBin: string, hostTarget: string): Promise<string | null> {
    try {
        const [binReal, targetReal, targetStat] = await Promise.all([
            fsp.realpath(trustedBin),
            fsp.realpath(hostTarget),
            fsp.stat(hostTarget),
        ]);
        if (path.dirname(targetReal) !== binReal) {
            return "Trusted executable symlink escapes the stack bin directory.";
        }
        if (!targetStat.isFile() || (targetStat.mode & 0o111) === 0) {
            return "Trusted executable is not a regular executable file.";
        }
        return null;
    } catch {
        return "Trusted executable is missing or inaccessible.";
    }
}

/** Resolve sandbox_exec's first token to a stack override or image-built default. */
export async function resolveTrustedCommand(stackPath: string, requested: string): Promise<
    { ok: true; value: TrustedCommand } | { ok: false; reason: string; command?: string }
> {
    if (requested.length > MAX_COMMAND_LENGTH) {
        return { ok: false, reason: `Command exceeds maximum length (${requested.length} > ${MAX_COMMAND_LENGTH} bytes).` };
    }
    const parsed = parseCommandArgv(requested);
    if (!parsed.ok) return parsed;
    const requestedExecutable = parsed.argv[0];
    let executableName: string;
    let containerBin: string;
    let validateStackPath = false;
    if (requestedExecutable.startsWith("/")) {
        executableName = path.basename(requestedExecutable);
        const builtInExecutable = `${TRUSTED_BIN_CONTAINER_PATH}/${executableName}`;
        const stackExecutable = `${STACK_BIN_CONTAINER_PATH}/${executableName}`;
        if (requestedExecutable === stackExecutable && executableName !== "") {
            containerBin = STACK_BIN_CONTAINER_PATH;
            validateStackPath = true;
        } else if (requestedExecutable === builtInExecutable && executableName !== "") {
            containerBin = TRUSTED_BIN_CONTAINER_PATH;
        } else {
            return { ok: false, reason: `Executable must be an immediate child of ${STACK_BIN_CONTAINER_PATH} or ${TRUSTED_BIN_CONTAINER_PATH}.` };
        }
    } else {
        if (requestedExecutable.includes("/") || requestedExecutable === "." || requestedExecutable === "..") {
            return { ok: false, reason: `Bare executable names must not contain a path.` };
        }
        executableName = requestedExecutable;
        // Published stacks keep bin/ as build input, without mounting it. An
        // explicit stack declaration keeps source files from shadowing the image.
        let source: unknown;
        try {
            source = parseYaml(await fsp.readFile(path.join(stackPath, "docker-compose.yml"), "utf8"))?.["x-carapa-command-source"];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return { ok: false, reason: "Cannot read the stack command source." };
            }
        }
        if (source !== undefined && source !== "image" && source !== "stack") {
            return { ok: false, reason: "Invalid x-carapa-command-source; expected image or stack." };
        }
        const hostTarget = path.join(stackPath, "bin", executableName);
        try {
            if (source === "image") {
                containerBin = TRUSTED_BIN_CONTAINER_PATH;
            } else {
                await fsp.lstat(hostTarget);
                containerBin = STACK_BIN_CONTAINER_PATH;
                validateStackPath = true;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return { ok: false, reason: "Trusted executable override is inaccessible." };
            }
            containerBin = TRUSTED_BIN_CONTAINER_PATH;
        }
    }

    const trustedBin = path.join(stackPath, "bin");
    const hostTarget = path.join(trustedBin, executableName);
    const argv = [`${containerBin}/${executableName}`, ...parsed.argv.slice(1)];
    const normalizedCommand = argv.map(quoteCommandArgument).join(" ");
    if (validateStackPath) {
        const reason = await validateStackExecutable(trustedBin, hostTarget);
        if (reason) return { ok: false, reason, command: normalizedCommand };
    }

    return { ok: true, value: { argv, command: normalizedCommand, executable: executableName } };
}

/**
 * Validates if a command is allowed for a specific service in a stack.
 * Uses the OPA/Rego policy engine (policy.wasm). Stacks without a compiled
 * policy are rejected.
 */
export async function validateCommand(
    stackPath: string,
    service: string,
    command: string,
    tool = "sandbox_exec",
    options: { shellFree?: boolean } = {}
): Promise<{ allowed: boolean; reason?: string; policy_name: string }> {
    if (command.length > MAX_COMMAND_LENGTH) {
        return {
            allowed: false,
            reason: `Command exceeds maximum length (${command.length} > ${MAX_COMMAND_LENGTH} bytes).`,
            policy_name: "command_length"
        };
    }

    if (!(await hasOpaPolicy(stackPath))) {
        return {
            allowed: false,
            reason: "No policy.wasm found. Compile a .rego policy with: bash scripts/compile-policies.sh",
            policy_name: "missing_policy"
        };
    }

    const segResult = splitShellCommand(command);
    const segments = segResult.ok ? segResult.segments : [command];
    const firstSeg = segments[0]?.trim() || "";
    const binary = path.basename(firstSeg.split(/\s+/)[0] || "").toLowerCase();

    const input: PolicyInput = {
        command,
        segments: segments.map(s => s.trim()).filter(Boolean),
        binary,
        service,
        stack: path.basename(stackPath),
        env_keys: [],
        tool,
        shell_free: options.shellFree === true,
    };

    const result = await evaluatePolicy(stackPath, input);
    return {
        allowed: result.allow,
        reason: result.allow ? undefined : result.reason,
        policy_name: result.policy_name,
    };
}

// ── Shell command splitting ──────────────────────────────────────────────

/**
 * Splits a command string by shell operators |, ;, &&, ||, >, <, and newlines while respecting quotes.
 */
export function splitShellCommand(command: string): { ok: true; segments: string[] } | { ok: false; reason: string } {
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        const next = command[i + 1];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        // Inside single quotes a backslash is literal, like in the shell.
        if (inSingle) {
            if (ch === "'") inSingle = false;
            current += ch;
            continue;
        }

        if (ch === "\\") {
            escaped = true;
            current += ch;
            continue;
        }

        if (inDouble) {
            if (ch === '"') inDouble = false;
            current += ch;
            continue;
        }

        if (ch === "'") {
            inSingle = true;
            current += ch;
            continue;
        }

        if (ch === '"') {
            inDouble = true;
            current += ch;
            continue;
        }

        if (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<" || ch === "\n" || ch === "\r") {
            segments.push(current);
            current = "";

            if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) {
                i++;
            }
            continue;
        }

        current += ch;
    }

    if (inSingle || inDouble || escaped) {
        return { ok: false, reason: "Unterminated quote or escape sequence" };
    }

    segments.push(current);
    return { ok: true, segments: segments.filter(s => s.trim().length > 0) };
}

// ── Mount path allowlist ─────────────────────────────────────────────────

interface MountAllowlist {
    allowed: string[];
}

const MOUNT_ALLOWLIST_PATH = path.join(getConfigDir(), "mount-allowlist.yaml");

let cachedAllowlist: MountAllowlist | null = null;
let cachedMtime = 0;

async function loadMountAllowlist(): Promise<MountAllowlist> {
    try {
        const stat = await fsp.stat(MOUNT_ALLOWLIST_PATH);
        if (stat.mtimeMs !== cachedMtime || !cachedAllowlist) {
            const raw = await fsp.readFile(MOUNT_ALLOWLIST_PATH, "utf-8");
            cachedAllowlist = { allowed: parseYamlList(raw, "allowed") };
            cachedMtime = stat.mtimeMs;
        }
        return cachedAllowlist!;
    } catch {
        // intentionally swallowed: mount-allowlist.yaml unreadable, returns empty list;
        // empty allowlist = deny all mount paths (secure default)
        return { allowed: [] };
    }
}

// Resolve existing components before evaluating "..". Lexically normalizing the
// whole path first would hide a symlink followed by a parent-directory traversal.
// Missing ordinary components are allowed for directories created at startup;
// dangling links, link loops, inaccessible paths and non-directory parents fail.
async function resolveMountPath(value: string): Promise<string> {
    const absolute = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
    const { root } = path.parse(absolute);
    const parts = absolute.slice(root.length).split(path.sep);
    let resolved = root;
    for (const [index, part] of parts.entries()) {
        if (!part || part === ".") continue;
        if (part === "..") {
            resolved = path.dirname(resolved);
            continue;
        }
        let next = path.join(resolved, part);
        let stat;
        try {
            stat = await fsp.lstat(next);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            resolved = next;
            continue;
        }
        if (stat.isSymbolicLink()) {
            next = await fsp.realpath(next);
            stat = await fsp.stat(next);
        }
        if (index < parts.length - 1 && !stat.isDirectory()) {
            throw new Error("Mount path traverses a non-directory.");
        }
        resolved = next;
    }
    return resolved;
}

export function containsPath(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

export async function isMountPathAllowed(hostPath: string): Promise<boolean> {
    let resolved: string;
    // Provider credentials must never be exposed by mounting either their
    // directory or an ancestor. Resolve existing symlinks before comparison.
    const credentialRoot = process.env.PROVIDER_ACCOUNTS_HOST_DIR || process.env.PROVIDER_ACCOUNTS_DIR;
    try {
        resolved = await resolveMountPath(hostPath);
        if (credentialRoot) {
            const secret = await resolveMountPath(credentialRoot);
            if (containsPath(secret, resolved) || containsPath(resolved, secret)) return false;
        }
    } catch {
        return false;
    }
    return (await resolvedAllowlistBases()).some((base) => containsPath(base, resolved));
}

// Characters that would add keys to a docker --mount CSV value.
export const UNSAFE_MOUNT_CHARS = /[,"\x00-\x1f\x7f]/;
export const MOUNT_PATH_ENV_KEYS = ["LOCAL_REPO", "GROUP_DIR", "IPC_MOUNT", "AGENT_HOME", "EXTRA_MOUNT_1", "EXTRA_MOUNT_2"];

// Extra mounts appear at /workspace/<name>. The name must be a plain folder
// name that cannot replace the IPC or group mounts, the primary workspace, or
// the other extra mount.
const RESERVED_WORKSPACE_NAMES = ["ipc", "group"];

function validateExtraMountNames(env: Record<string, string>): string | null {
    const names = new Set<string>();
    for (const slot of [1, 2]) {
        const name = env[`EXTRA_MOUNT_${slot}_NAME`];
        if (!name) continue;
        const reserved = RESERVED_WORKSPACE_NAMES.includes(name)
            || (env.WORKSPACE_PATH && path.posix.normalize(env.WORKSPACE_PATH) === `/workspace/${name}`)
            || names.has(name);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === ".." || reserved) {
            return `[SECURITY] Extra mount name blocked: EXTRA_MOUNT_${slot}_NAME="${name}" is invalid or conflicts with another /workspace mount.`;
        }
        names.add(name);
    }
    return null;
}

export async function validateMountPaths(env: Record<string, string>): Promise<string | null> {
    for (const key of MOUNT_PATH_ENV_KEYS) {
        const value = env[key];
        if (value && UNSAFE_MOUNT_CHARS.test(value)) {
            return `[SECURITY] Mount path blocked: ${key} contains a comma, quote or control character`;
        }
        if (value && !(await isMountPathAllowed(value))) {
            return `[SECURITY] Mount path blocked: ${key}="${value}" is not in the mount allowlist. ` +
                `Add the parent directory to ${MOUNT_ALLOWLIST_PATH}.`;
        }
    }

    return validateExtraMountNames(env);
}

// ── Pinned mount sources ─────────────────────────────────────────────────────
// Docker re-resolves symlinks in bind sources on every container start, so a
// validated path can be swapped for a link to "/" after the check. Mounts are
// instead handed to Docker as a volume subpath on a per-base bind volume;
// Docker opens the subpath with RESOLVE_NO_SYMLINKS on each start.

export interface PinnedMount {
    /** Canonical outermost allowlist base containing the path. */
    base: string;
    /** Canonical path relative to base ("." for the base itself, never containing ".."). */
    subpath: string;
    /** Name of the bind volume whose device is base. */
    volume: string;
}

export type DockerRunner = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

export function mountVolumeName(base: string): string {
    return `carapa-mount-${createHash("sha256").update(base).digest("hex").slice(0, 16)}`;
}

async function resolvedAllowlistBases(): Promise<string[]> {
    const { allowed } = await loadMountAllowlist();
    const bases: string[] = [];
    for (const entry of allowed) {
        try {
            bases.push(await resolveMountPath(entry));
        } catch { /* An unresolved allowlist entry grants no access. */ }
    }
    return bases;
}

/** True when the canonical path lies inside any allowlist base. Unresolvable paths fail closed (true). */
export async function isInsideAllowlistBase(value: string): Promise<boolean> {
    let resolved: string;
    try {
        resolved = await resolveMountPath(value);
    } catch {
        return true;
    }
    return (await resolvedAllowlistBases()).some((base) => containsPath(base, resolved));
}

/** Validate a mount source with isMountPathAllowed and describe it as (base volume, subpath). Throws on any failure. */
export async function pinMountSource(value: string): Promise<PinnedMount> {
    if (!value || UNSAFE_MOUNT_CHARS.test(value)) {
        throw new Error(`[SECURITY] Mount path blocked: "${value}" is empty or contains a comma, quote or control character`);
    }
    if (!(await isMountPathAllowed(value))) {
        throw new Error(`[SECURITY] Mount path blocked: "${value}" is not in the mount allowlist. Add the parent directory to ${MOUNT_ALLOWLIST_PATH}.`);
    }
    const resolved = await resolveMountPath(value);
    const containing = (await resolvedAllowlistBases()).filter((base) => containsPath(base, resolved));
    if (containing.length === 0) {
        throw new Error(`[SECURITY] Mount path blocked: "${value}" is not inside any allowlist base`);
    }
    const base = containing.reduce((outer, candidate) => (candidate.length < outer.length ? candidate : outer));
    if (UNSAFE_MOUNT_CHARS.test(base)) {
        throw new Error(`[SECURITY] Mount base blocked: "${base}" contains a comma, quote or control character`);
    }
    const subpath = path.relative(base, resolved) || ".";
    if (path.isAbsolute(subpath) || subpath.split(path.sep).includes("..")) {
        throw new Error(`[SECURITY] Mount path blocked: "${value}" escapes its allowlist base`);
    }
    return { base, subpath, volume: mountVolumeName(base) };
}

/** Create (or verify) the bind volume for base. An existing volume with another device is refused. */
export async function ensureBaseVolume(base: string, name: string, docker: DockerRunner): Promise<void> {
    const created = await docker([
        "volume", "create", "--driver", "local",
        "-o", "type=none", "-o", "o=bind", "-o", `device=${base}`, name,
    ]);
    // `volume create` on an existing name succeeds without comparing options,
    // so the volume is always inspected.
    const inspected = await docker(["volume", "inspect", name]);
    if (inspected.status !== 0) {
        throw new Error(`[SECURITY] Cannot create mount volume ${name}: ${(created.stderr || inspected.stderr).trim() || "docker volume inspect failed"}`);
    }
    let options: Record<string, string> | undefined;
    let driver: string | undefined;
    try {
        const parsed = JSON.parse(inspected.stdout);
        options = parsed[0]?.Options;
        driver = parsed[0]?.Driver;
    } catch { /* handled below */ }
    const bindOptions = (options?.o ?? "").split(",");
    if (driver !== "local" || options?.type !== "none" || !bindOptions.includes("bind") || options?.device !== base) {
        throw new Error(`[SECURITY] Mount volume ${name} exists with a different device (expected ${base}, found ${options?.device ?? "none"}); refusing to use it.`);
    }
}

export interface MountPin {
    key: string;
    /** The validated path string the pin was made from. */
    value: string;
    base: string;
    subpath: string;
}

/** Re-resolve every pinned source right before `up`; refuse if base or subpath moved. */
export async function verifyPinnedMounts(pins: MountPin[]): Promise<void> {
    for (const pin of pins) {
        let current: PinnedMount;
        try {
            current = await pinMountSource(pin.value);
        } catch (error) {
            throw new Error(`[SECURITY] Mount ${pin.key} changed after validation: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (current.base !== pin.base || current.subpath !== pin.subpath) {
            throw new Error(`[SECURITY] Mount ${pin.key} changed after validation (${pin.base}:${pin.subpath} -> ${current.base}:${current.subpath}); refusing to start.`);
        }
    }
}
