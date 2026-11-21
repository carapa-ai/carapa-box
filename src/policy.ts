import { getConfigDir } from "./installation-paths.js";
/**
 * OPA/Rego policy engine for CarapaBox.
 *
 * Evaluates command execution requests against compiled Rego WASM bundles.
 * Stacks must have a compiled policy.wasm to be registered.
 *
 * Policy composition: base policy denials always override stack-level allows.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileExists } from "./utils.js";
import { loadPolicy, type LoadedPolicy } from "@open-policy-agent/opa-wasm";
import { logger } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface PolicyInput {
    command: string;
    segments: string[];
    binary: string;
    service: string;
    stack: string;
    env_keys: string[];
    tool: string;
    /** True only when argv is executed without any shell (see sandbox_exec). */
    shell_free?: boolean;
}

interface PolicyResult {
    allow: boolean;
    reason: string;
    policy_name: string;
}

interface CachedPolicy {
    policy: LoadedPolicy;
    mtime: number;
}

// ── Module state ──────────────────────────────────────────────────────────

const policyCache = new Map<string, CachedPolicy>();

/** Failures already logged, keyed by path + mtime, so a broken file logs once. */
const loggedLoadFailures = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────

function resolvePoliciesDir(): string {
    return path.join(getConfigDir(), "policies");
}

/**
 * Load a compiled WASM policy bundle, with mtime-based caching.
 * Returns null if the file doesn't exist.
 */
async function loadWasmPolicy(wasmPath: string): Promise<LoadedPolicy | null> {
    let stat;
    try {
        stat = await fsp.stat(wasmPath);
    } catch {
        // Missing or inaccessible policies are treated as unavailable, as
        // they were when existence was checked before stat'ing the file.
        return null;
    }

    const mtime = Math.floor(stat.mtimeMs);
    try {
        const cached = policyCache.get(wasmPath);

        if (cached && cached.mtime === mtime) {
            return cached.policy;
        }

        const wasmBytes = await fsp.readFile(wasmPath);
        const policy = await loadPolicy(wasmBytes);
        policyCache.set(wasmPath, { policy, mtime });
        return policy;
    } catch (err) {
        const failureKey = `${wasmPath}:${mtime}`;
        if (!loggedLoadFailures.has(failureKey)) {
            loggedLoadFailures.add(failureKey);
            logger.error({ wasmPath, err }, "[POLICY] Failed to load WASM policy");
        }
        return null;
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Check if a stack has an OPA policy bundle available.
 */
export async function hasOpaPolicy(stackPath: string): Promise<boolean> {
    return fileExists(path.join(stackPath, "policy.wasm"));
}

/**
 * Evaluate a command against the OPA policy engine.
 *
 * Evaluation order:
 * 1. Run base policy — if any deny rules match, reject immediately.
 * 2. Run stack policy — must produce an explicit allow.
 *
 * Returns a PolicyResult with allow/deny, reason, and policy name.
 */
export async function evaluatePolicy(
    stackPath: string,
    input: PolicyInput
): Promise<PolicyResult> {
    const policiesDir = resolvePoliciesDir();
    let baseWasm = path.join(policiesDir, "base.wasm");
    const baseRego = path.join(policiesDir, "base.rego");
    const stackWasm = path.join(stackPath, "policy.wasm");

    // ── Step 1: Base policy (deny rules) ──────────────────────────────
    if (!(await fileExists(baseWasm)) && process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR) {
        // Image-baked fallback, used only when the configured dir has no base.wasm.
        const builtinWasm = path.join(process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR, "base.wasm");
        if (await fileExists(builtinWasm)) baseWasm = builtinWasm;
    }
    const basePolicy = await loadWasmPolicy(baseWasm);
    if (!basePolicy && ((await fileExists(baseWasm)) || (await fileExists(baseRego)))) {
        // A base policy is expected (a base.wasm bundle exists at the resolved path,
        // or base.rego ships) but it is missing or fails to load: fail closed
        // instead of skipping the base denies. Only when neither exists is the
        // base step skipped.
        const missingKey = `${baseWasm}:missing`;
        if (!loggedLoadFailures.has(missingKey) && !(await fileExists(baseWasm))) {
            loggedLoadFailures.add(missingKey);
            logger.error({ wasmPath: baseWasm }, "[POLICY] base.wasm not found; denying all commands until policies are compiled (build.sh)");
        }
        return {
            allow: false,
            reason: "base policy not loaded: compile with build.sh",
            policy_name: "base.missing",
        };
    }
    if (basePolicy) {
        const baseResult = basePolicy.evaluate(input);
        if (baseResult && baseResult.length > 0) {
            const result = baseResult[0]?.result;
            // Base policy entrypoint is carapabox/base/deny — returns the deny set directly as an array
            const denyReasons = Array.isArray(result) ? result : (result?.deny && Array.isArray(result.deny) ? result.deny : []);
            if (denyReasons.length > 0) {
                return {
                    allow: false,
                    reason: denyReasons[0],
                    policy_name: "base.deny",
                };
            }
        }
    }

    // ── Step 2: Stack policy (allow rules) ────────────────────────────
    const stackPolicy = await loadWasmPolicy(stackWasm);
    if (!stackPolicy) {
        return {
            allow: false,
            reason: `No policy.wasm found for stack at ${stackPath}`,
            policy_name: "missing_policy",
        };
    }

    const stackResult = stackPolicy.evaluate(input);
    if (stackResult && stackResult.length > 0) {
        const result = stackResult[0]?.result;

        // Stack policy's result rule returns { allow, reason, policy_name } directly.
        // stackResult[0]?.result is already that object — there is no extra nesting.
        if (result && "allow" in result) {
            return {
                allow: !!result.allow,
                reason: result.reason || (result.allow ? "Allowed by stack policy" : "Denied by stack policy"),
                policy_name: result.policy_name || "stack",
            };
        }

        // Fallback: policy emits only a deny set without a result rule
        if (result?.deny && Array.isArray(result.deny) && result.deny.length > 0) {
            return {
                allow: false,
                reason: result.deny[0],
                policy_name: "stack.deny",
            };
        }
    }

    return {
        allow: false,
        reason: "Stack policy did not produce an allow decision",
        policy_name: "stack.default_deny",
    };
}

/** Test-only access to the module-level policy cache. */
export function policyCacheForTests(): Map<string, { mtime: number }> {
    loggedLoadFailures.clear();
    return policyCache;
}
