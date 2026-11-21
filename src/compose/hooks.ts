import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { toHostPath } from "./client.js";
import { fileExists } from "../utils.js";
import { cappedAppend } from "../capped-append.js";
import { logger } from "../logger.js";

export type HookType = "before-start" | "after-start" | "before-stop" | "after-stop";

const HOOK_TIMEOUT_MS = 120_000; // 2 minutes

export interface HookResult {
    executed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
}

const UNSAFE_HOOK_ENV_KEYS = new Set([
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "IFS", "PATH", "CDPATH", "GLOBIGNORE", "PROMPT_COMMAND",
]);

// Interpreter and tool variables that make bun, node, python, git, docker, ssh
// or the C library load code or config chosen by the caller (BUN_OPTIONS=-e ...,
// NODE_OPTIONS=--require ..., DOCKER_HOST=..., GIT_CONFIG_*, PYTHONSTARTUP, ...).
// Matched case-insensitively so npm_config_* is covered too.
const UNSAFE_HOOK_ENV_PREFIXES = [
    "LD_", "DYLD_", "GLIBC_", "BUN_", "NODE_", "NPM_", "DENO_", "PYTHON", "PERL", "RUBY",
    "DOCKER_", "GIT_", "XDG_", "JAVA_", "_JAVA_", "JDK_JAVA_",
];
const UNSAFE_HOOK_ENV_EXTRA_KEYS = new Set(["HOME", "TMPDIR", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "SSH_AUTH_SOCK", "GCONV_PATH", "NLSPATH", "LOCPATH", "HOSTALIASES", "GOFLAGS"]);
// Hook scripts read GIT_REPO as plain data (stacks/*/before-start.sh).
const SAFE_HOOK_ENV_KEYS = new Set(["GIT_REPO"]);

function isUnsafeHookEnvKey(key: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return true;
    if (SAFE_HOOK_ENV_KEYS.has(key)) return false;
    const upper = key.toUpperCase();
    return (
        UNSAFE_HOOK_ENV_KEYS.has(key) ||
        UNSAFE_HOOK_ENV_EXTRA_KEYS.has(upper) ||
        UNSAFE_HOOK_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    );
}

/** Keys of a caller-supplied env map that must never reach a controller hook. */
export function findUnsafeHookEnvKeys(env: Record<string, string> | undefined): string[] {
    return Object.keys(env ?? {}).filter(isUnsafeHookEnvKey);
}

/**
 * Drop env keys that change bash, dynamic-loader or interpreter behaviour
 * (exported functions, startup files, LD_*, BUN_OPTIONS, NODE_OPTIONS, ...),
 * so they cannot run code in the controller.
 */
export function sanitizeHookEnv(extraEnv: Record<string, string> | undefined): {
    env: Record<string, string>;
    dropped: string[];
} {
    const env: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(extraEnv ?? {})) {
        if (isUnsafeHookEnvKey(key)) {
            dropped.push(key);
        } else {
            env[key] = value;
        }
    }
    return { env, dropped };
}

/**
 * Run a lifecycle hook script if it exists
 */
export async function runHook(
    stackDir: string,
    hook: HookType,
    extraEnv: Record<string, string> = {},
    onLog?: (msg: string) => void,
    timeoutMs: number = HOOK_TIMEOUT_MS
): Promise<HookResult> {
    const scriptPath = path.join(stackDir, `${hook}.sh`);

    // Check if hook exists
    if (!(await fileExists(scriptPath))) {
        return { executed: false, exitCode: 0, stdout: "", stderr: "" };
    }

    const sanitized = sanitizeHookEnv(extraEnv);
    if (sanitized.dropped.length > 0) {
        logger.warn({ hook, dropped: sanitized.dropped }, "Dropped unsafe hook env keys");
    }

    return new Promise((resolve) => {
        let resolved = false;
        const child = spawn("bash", [scriptPath], {
            cwd: stackDir,
            detached: true, // own process group so a timeout can kill all descendants
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ...sanitized.env,
                STACK_DIR: toHostPath(stackDir),
                HOOK_TYPE: hook,
            },
        });

        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try {
                process.kill(-child.pid!, "SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
            resolve({
                executed: true,
                exitCode: 124,
                stdout: stdout.trim(),
                stderr: (stderr + `\nHook timed out after ${Math.round(timeoutMs / 1000)}s`).trim(),
            });
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
            const str = chunk.toString();
            stdout = cappedAppend(stdout, str);
            if (onLog) onLog(str);
        });

        child.stderr?.on("data", (chunk) => {
            const str = chunk.toString();
            stderr = cappedAppend(stderr, str);
            if (onLog) onLog(str);
        });

        child.on("close", (code, signal) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
            resolve({
                executed: true,
                exitCode,
                stdout: stdout.trim(),
                stderr: (signal ? `${stderr}\nHook terminated by ${signal}` : stderr).trim(),
            });
        });

        child.on("error", (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({
                executed: false,
                exitCode: 1,
                stdout: "",
                stderr: `Failed to run ${hook}.sh: ${err.message}`,
            });
        });
    });
}

/**
 * Format hook result for display
 */
export function formatHookResult(hook: HookType, result: HookResult, includeOutput: boolean = true): string {
    if (!result.executed) {
        return "";
    }

    const lines: string[] = [];
    lines.push(`[${hook}] exit code: ${result.exitCode}`);

    if (includeOutput && result.stdout) {
        lines.push(result.stdout);
    }
    if (result.stderr && result.exitCode !== 0) {
        lines.push(`stderr: ${result.stderr}`);
    }

    return lines.join("\n");
}
