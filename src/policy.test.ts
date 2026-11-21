/**
 * Unit tests for src/policy.ts
 * Mocks @open-policy-agent/opa-wasm so no real WASM execution takes place.
 * Uses real temp directories so fs calls (existsSync/statSync/readFileSync)
 * work normally — no need to mock node:fs.
 */

import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Mock: logger ───────────────────────────────────────────────────────────
// Silence policy.ts log calls — must be registered before policy.ts is loaded.

const loggedErrors: unknown[][] = [];

mock.module("./logger.js", () => ({
    logger: {
        error: (...args: unknown[]) => { loggedErrors.push(args); },
        warn: () => {},
        info: () => {},
        debug: () => {},
    },
}));

// ── Mock: @open-policy-agent/opa-wasm ──────────────────────────────────────
// policyRegistry maps file-content strings to fake LoadedPolicy objects.
// loadPolicy reads the bytes written to disk and looks up the matching mock.

const policyRegistry = new Map<string, { evaluate: (input: unknown) => unknown[] }>();

mock.module("@open-policy-agent/opa-wasm", () => ({
    loadPolicy: async (bytes: Buffer) => {
        const key = bytes.toString("utf-8");
        const policy = policyRegistry.get(key);
        if (!policy) {
            throw new Error(`[test] No mock registered for wasm bytes: "${key}"`);
        }
        return policy;
    },
}));

import {
    evaluatePolicy,
    hasOpaPolicy,
    policyCacheForTests,
    type PolicyInput,
} from "./policy.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Temp config dir used as CARAPA_BOX_CONFIG_DIR so tests never touch the repo tree. */
let configDir = "";
/** Path to <configDir>/policies/base.wasm, reassigned per test. */
let BASE_WASM_PATH = "";
let BASE_REGO_PATH = "";
let savedConfigDir: string | undefined;

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
}

function rmDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

const sampleInput: PolicyInput = {
    command: "echo hello",
    segments: ["echo hello"],
    binary: "echo",
    service: "web",
    stack: "mystack",
    env_keys: [],
    tool: "bash",
};

// ── Global cleanup ─────────────────────────────────────────────────────────

afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
});

// ── Per-test reset ─────────────────────────────────────────────────────────

function loadedPolicies(): Array<{ path: string; mtime: number }> {
    return Array.from(policyCacheForTests(), ([p, c]) => ({ path: p, mtime: c.mtime }));
}

beforeEach(() => {
    savedConfigDir = process.env.CARAPA_BOX_CONFIG_DIR;
    configDir = makeTempDir();
    fs.mkdirSync(path.join(configDir, "policies"));
    BASE_WASM_PATH = path.join(configDir, "policies", "base.wasm");
    BASE_REGO_PATH = path.join(configDir, "policies", "base.rego");
    process.env.CARAPA_BOX_CONFIG_DIR = configDir;
    policyRegistry.clear();
    policyCacheForTests().clear();
    loggedErrors.length = 0;
});

afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CARAPA_BOX_CONFIG_DIR;
    else process.env.CARAPA_BOX_CONFIG_DIR = savedConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
});

// ── hasOpaPolicy ───────────────────────────────────────────────────────────

describe("hasOpaPolicy", () => {
    it("returns true when policy.wasm exists in the stack directory", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, "policy.wasm"), "dummy");
            expect(await hasOpaPolicy(dir)).toBe(true);
        } finally {
            rmDir(dir);
        }
    });

    it("returns false when policy.wasm is absent from the stack directory", async () => {
        const dir = makeTempDir();
        try {
            expect(await hasOpaPolicy(dir)).toBe(false);
        } finally {
            rmDir(dir);
        }
    });

    it("returns false for a path that does not exist at all", async () => {
        expect(await hasOpaPolicy("/tmp/definitely-does-not-exist-xyz")).toBe(false);
    });
});

// ── policy cache ───────────────────────────────────────────────────────────

describe("policy cache", () => {
    it("returns an empty array when no policies have been loaded", () => {
        expect(loadedPolicies()).toEqual([]);
    });

    it("returns an entry with path and mtime after a policy is loaded", async () => {
        const dir = makeTempDir();
        try {
            const stackPolicy = {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "test" } }],
            };
            policyRegistry.set("stack-data", stackPolicy);
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-data");

            await evaluatePolicy(dir, sampleInput);

            const loaded = loadedPolicies();
            expect(loaded.length).toBeGreaterThan(0);

            const entry = loaded.find((e) => e.path.endsWith("policy.wasm"));
            expect(entry).toBeDefined();
            expect(typeof entry!.mtime).toBe("number");
            expect(entry!.mtime).toBeGreaterThan(0);
        } finally {
            rmDir(dir);
        }
    });

    it("cache entries survive across multiple evaluations (mtime-based hit)", async () => {
        const dir = makeTempDir();
        try {
            let callCount = 0;
            const stackPolicy = {
                evaluate: () => {
                    callCount++;
                    return [{ result: { allow: true, reason: "ok", policy_name: "test" } }];
                },
            };
            policyRegistry.set("stack-cached", stackPolicy);
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-cached");

            await evaluatePolicy(dir, sampleInput);
            await evaluatePolicy(dir, sampleInput);

            // loadPolicy (via @opa-wasm) should only be called once due to caching;
            // evaluate() is called twice (once per evaluatePolicy call) but
            // loadPolicy itself is called only on cache miss.
            expect(callCount).toBe(2);
            expect(loadedPolicies().length).toBe(1);
        } finally {
            rmDir(dir);
        }
    });
});

// ── evaluatePolicy ─────────────────────────────────────────────────────────

describe("evaluatePolicy", () => {
    it("returns allow when stack policy produces { allow: true }", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("allow-policy", {
                evaluate: () => [{ result: { allow: true, reason: "permitted", policy_name: "mystack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "allow-policy");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.reason).toBe("permitted");
            expect(result.policy_name).toBe("mystack");
        } finally {
            rmDir(dir);
        }
    });

    it("returns deny when stack policy produces { allow: false }", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("deny-policy", {
                evaluate: () => [{ result: { allow: false, reason: "not permitted", policy_name: "mystack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "deny-policy");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.reason).toBe("not permitted");
        } finally {
            rmDir(dir);
        }
    });

    it("returns deny with policy_name=stack.deny when stack result has a deny array", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("deny-set-policy", {
                evaluate: () => [{ result: { deny: ["binary not allowed"] } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "deny-set-policy");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.reason).toBe("binary not allowed");
            expect(result.policy_name).toBe("stack.deny");
        } finally {
            rmDir(dir);
        }
    });

    it("returns default_deny when stack policy produces no decision", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("empty-policy", {
                evaluate: () => [],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "empty-policy");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("stack.default_deny");
        } finally {
            rmDir(dir);
        }
    });

    it("returns missing_policy deny when no policy.wasm exists in the stack dir", async () => {
        const dir = makeTempDir();
        try {
            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("missing_policy");
            expect(result.reason).toMatch(/No policy\.wasm found/);
        } finally {
            rmDir(dir);
        }
    });

    it("base policy denial overrides stack allow", async () => {
        const dir = makeTempDir();
        try {
            // Base policy returns a deny set (array result = deny reasons)
            policyRegistry.set("base-deny", {
                evaluate: () => [{ result: ["rm -rf denied by base"] }],
            });
            fs.writeFileSync(BASE_WASM_PATH, "base-deny");

            // Stack policy would allow — but base denial should win
            policyRegistry.set("stack-allow", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-allow");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.reason).toBe("rm -rf denied by base");
            expect(result.policy_name).toBe("base.deny");
        } finally {
            rmDir(dir);
        }
    });

    it("base policy denial also works with result.deny array shape", async () => {
        const dir = makeTempDir();
        try {
            // Base policy returns { deny: [...] } object shape
            policyRegistry.set("base-obj-deny", {
                evaluate: () => [{ result: { deny: ["disallowed tool"] } }],
            });
            fs.writeFileSync(BASE_WASM_PATH, "base-obj-deny");

            policyRegistry.set("stack-allow2", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-allow2");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.reason).toBe("disallowed tool");
            expect(result.policy_name).toBe("base.deny");
        } finally {
            rmDir(dir);
        }
    });

    it("skips base policy and uses stack allow when no base.wasm exists", async () => {
        const dir = makeTempDir();
        try {
            // Ensure base.wasm is absent
            try { fs.unlinkSync(BASE_WASM_PATH); } catch { /* ok */ }

            policyRegistry.set("stack-only", {
                evaluate: () => [{ result: { allow: true, reason: "fine", policy_name: "stack-only" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-only");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.policy_name).toBe("stack-only");
        } finally {
            rmDir(dir);
        }
    });

    it("denies with base.missing when base.rego exists but base.wasm is absent", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            policyRegistry.set("stack-ok", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("base.missing");
            expect(result.reason).toBe("base policy not loaded: compile with build.sh");
        } finally {
            rmDir(dir);
        }
    });

    it("denies with base.missing when base.wasm is corrupt", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            fs.writeFileSync(BASE_WASM_PATH, "corrupt-not-registered");
            policyRegistry.set("stack-ok2", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok2");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("base.missing");
        } finally {
            rmDir(dir);
        }
    });

    it("denies with base.missing when base.wasm is corrupt and base.rego is absent", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(BASE_WASM_PATH, "corrupt-no-rego");
            policyRegistry.set("stack-ok-norego", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok-norego");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("base.missing");
        } finally {
            rmDir(dir);
        }
    });

    it("does not fall back to the built-in base.wasm past a corrupt config one without base.rego", async () => {
        const dir = makeTempDir();
        const builtin = makeTempDir();
        const savedBuiltin = process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
        try {
            process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = builtin;
            fs.writeFileSync(BASE_WASM_PATH, "corrupt-no-rego-cfg");
            policyRegistry.set("builtin-ok-norego", { evaluate: () => [] });
            fs.writeFileSync(path.join(builtin, "base.wasm"), "builtin-ok-norego");
            policyRegistry.set("stack-ok-norego2", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok-norego2");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("base.missing");
        } finally {
            if (savedBuiltin === undefined) delete process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
            else process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = savedBuiltin;
            rmDir(dir);
            rmDir(builtin);
        }
    });

    it("denies with base.missing when only the built-in base.wasm exists and is corrupt", async () => {
        const dir = makeTempDir();
        const builtin = makeTempDir();
        const savedBuiltin = process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
        try {
            process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = builtin;
            fs.writeFileSync(path.join(builtin, "base.wasm"), "corrupt-builtin-norego");
            policyRegistry.set("stack-ok-norego3", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok-norego3");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("base.missing");
        } finally {
            if (savedBuiltin === undefined) delete process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
            else process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = savedBuiltin;
            rmDir(dir);
            rmDir(builtin);
        }
    });

    it("falls back to the built-in base.wasm when the config dir has none", async () => {
        const dir = makeTempDir();
        const builtin = makeTempDir();
        const savedBuiltin = process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
        try {
            process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = builtin;
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            policyRegistry.set("builtin-deny", { evaluate: () => [{ result: ["denied by builtin base"] }] });
            fs.writeFileSync(path.join(builtin, "base.wasm"), "builtin-deny");
            policyRegistry.set("stack-ok4", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok4");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.policy_name).toBe("base.deny");
            expect(result.reason).toBe("denied by builtin base");
        } finally {
            if (savedBuiltin === undefined) delete process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
            else process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = savedBuiltin;
            rmDir(dir);
            rmDir(builtin);
        }
    });

    it("does not use the built-in base.wasm when the config one is corrupt", async () => {
        const dir = makeTempDir();
        const builtin = makeTempDir();
        const savedBuiltin = process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
        try {
            process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = builtin;
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            fs.writeFileSync(BASE_WASM_PATH, "corrupt-config-base");
            policyRegistry.set("builtin-ok", { evaluate: () => [{ result: [] }] });
            fs.writeFileSync(path.join(builtin, "base.wasm"), "builtin-ok");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.policy_name).toBe("base.missing");
        } finally {
            if (savedBuiltin === undefined) delete process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR;
            else process.env.CARAPA_BOX_BUILTIN_POLICIES_DIR = savedBuiltin;
            rmDir(dir);
            rmDir(builtin);
        }
    });

    it("logs the base.wasm load failure once, not per call", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            await evaluatePolicy(dir, sampleInput);
            await evaluatePolicy(dir, sampleInput);
            await evaluatePolicy(dir, sampleInput);

            const baseLogs = loggedErrors.filter((a) => JSON.stringify(a[0]).includes("base.wasm"));
            expect(baseLogs).toHaveLength(1);
        } finally {
            rmDir(dir);
        }
    });

    it("keeps existing behaviour with a valid base policy and base.rego present", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(BASE_REGO_PATH, "package carapabox.base");
            policyRegistry.set("base-ok", { evaluate: () => [{ result: [] }] });
            fs.writeFileSync(BASE_WASM_PATH, "base-ok");
            policyRegistry.set("stack-ok3", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "stack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-ok3");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.policy_name).toBe("stack");
        } finally {
            rmDir(dir);
        }
    });

    it("base policy loaded but returns empty result — falls through to stack policy (covers line 117)", async () => {
        const dir = makeTempDir();
        try {
            // base.evaluate() returns [] → baseResult.length === 0 → condition on line 106 is false
            // execution falls through line 117 and proceeds to the stack policy
            policyRegistry.set("base-empty-result", {
                evaluate: () => [],
            });
            fs.writeFileSync(BASE_WASM_PATH, "base-empty-result");

            policyRegistry.set("stack-after-base-empty", {
                evaluate: () => [{ result: { allow: true, reason: "stack allowed", policy_name: "mystack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-after-base-empty");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.reason).toBe("stack allowed");
            expect(result.policy_name).toBe("mystack");
        } finally {
            rmDir(dir);
        }
    });

    it("base policy loaded and returns empty deny set — falls through to stack policy (covers line 116)", async () => {
        const dir = makeTempDir();
        try {
            // base.evaluate() returns a non-empty outer result but with an empty deny array
            // → baseResult.length > 0 is true, denyReasons resolves to []
            // → denyReasons.length > 0 is false → falls through line 116 to stack policy
            policyRegistry.set("base-empty-deny-set", {
                evaluate: () => [{ result: [] }],
            });
            fs.writeFileSync(BASE_WASM_PATH, "base-empty-deny-set");

            policyRegistry.set("stack-after-base-permissive", {
                evaluate: () => [{ result: { allow: true, reason: "stack allowed", policy_name: "mystack" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "stack-after-base-permissive");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.reason).toBe("stack allowed");
            expect(result.policy_name).toBe("mystack");
        } finally {
            rmDir(dir);
        }
    });

    it("catch path (lines 70-71): loadPolicy throws for unregistered bytes → returns missing_policy deny", async () => {
        const dir = makeTempDir();
        try {
            // Write bytes that are NOT registered in policyRegistry.
            // The mock's loadPolicy will throw, hitting the catch block in
            // loadWasmPolicy (policy.ts lines 70-71), which logs the error
            // and returns null.  evaluatePolicy then returns missing_policy.
            fs.writeFileSync(path.join(dir, "policy.wasm"), "unregistered");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("missing_policy");
        } finally {
            rmDir(dir);
        }
    });

    it("uses fallback reason string when stack result omits reason field", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("no-reason-policy", {
                evaluate: () => [{ result: { allow: true, policy_name: "nr" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "no-reason-policy");

            const result = await evaluatePolicy(dir, sampleInput);

            expect(result.allow).toBe(true);
            expect(result.reason).toBe("Allowed by stack policy");
        } finally {
            rmDir(dir);
        }
    });
});

// ── loadWasmPolicy cache behaviour ─────────────────────────────────────────

describe("loadWasmPolicy cache behaviour", () => {
    it("first call loads from disk and populates the cache", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("load-once", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "load-once" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "load-once");

            expect(loadedPolicies()).toHaveLength(0);
            await evaluatePolicy(dir, sampleInput);
            expect(loadedPolicies().length).toBeGreaterThan(0);
        } finally {
            rmDir(dir);
        }
    });

    it("second call with unchanged mtime returns the cached instance without re-reading the file", async () => {
        const dir = makeTempDir();
        const wasmFile = path.join(dir, "policy.wasm");
        try {
            policyRegistry.set("stable-v1", {
                evaluate: () => [{ result: { allow: true, reason: "stable", policy_name: "stable-v1" } }],
            });
            fs.writeFileSync(wasmFile, "stable-v1");
            const originalStat = fs.statSync(wasmFile);

            // First evaluation loads from disk and caches the policy
            const r1 = await evaluatePolicy(dir, sampleInput);
            expect(r1.policy_name).toBe("stable-v1");

            // Overwrite with bytes that are NOT registered in policyRegistry, then
            // restore the original mtime so the cache considers the file unchanged.
            // If caching works: same mtime → cached policy is used → r2.policy_name = "stable-v1"
            // If caching broken: new bytes read → mock throws → loadWasmPolicy returns null → missing_policy
            fs.writeFileSync(wasmFile, "unregistered-should-not-be-read");
            fs.utimesSync(wasmFile, originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000);

            const r2 = await evaluatePolicy(dir, sampleInput);
            expect(r2.policy_name).toBe("stable-v1");
            expect(r2.allow).toBe(true);
        } finally {
            rmDir(dir);
        }
    });

    it("reloads from disk when file mtime advances", async () => {
        const dir = makeTempDir();
        const wasmFile = path.join(dir, "policy.wasm");
        try {
            policyRegistry.set("mtime-v1", {
                evaluate: () => [{ result: { allow: true, reason: "v1", policy_name: "mtime-v1" } }],
            });
            policyRegistry.set("mtime-v2", {
                evaluate: () => [{ result: { allow: true, reason: "v2", policy_name: "mtime-v2" } }],
            });

            // Load v1 into cache
            fs.writeFileSync(wasmFile, "mtime-v1");
            const r1 = await evaluatePolicy(dir, sampleInput);
            expect(r1.policy_name).toBe("mtime-v1");

            // Overwrite with v2, then advance mtime by 60 s to guarantee cache invalidation
            fs.writeFileSync(wasmFile, "mtime-v2");
            const stat = fs.statSync(wasmFile);
            fs.utimesSync(wasmFile, stat.atimeMs / 1000, (stat.mtimeMs + 60_000) / 1000);

            // Cache must detect the changed mtime and reload → v2 policy is used
            const r2 = await evaluatePolicy(dir, sampleInput);
            expect(r2.policy_name).toBe("mtime-v2");
        } finally {
            rmDir(dir);
        }
    });

    it("missing .wasm file → returns missing_policy deny without throwing", async () => {
        const dir = makeTempDir();
        try {
            // No policy.wasm written; loadWasmPolicy returns null via existsSync guard
            const result = await evaluatePolicy(dir, sampleInput);
            expect(result.allow).toBe(false);
            expect(result.policy_name).toBe("missing_policy");
            expect(result.reason).toMatch(/No policy\.wasm found/);
        } finally {
            rmDir(dir);
        }
    });

    it("corrupted (unregistered) .wasm bytes → returns null gracefully, evaluatePolicy does not throw", async () => {
        const dir = makeTempDir();
        try {
            // Bytes not in policyRegistry → mock loadPolicy throws → caught → null returned
            fs.writeFileSync(path.join(dir, "policy.wasm"), "this-is-not-valid-wasm");

            const result = await evaluatePolicy(dir, sampleInput);
            expect(result.allow).toBe(false);
            // loadWasmPolicy returned null → evaluatePolicy treats stack as missing
            expect(result.policy_name).toBe("missing_policy");
        } finally {
            rmDir(dir);
        }
    });
});

// ── evaluatePolicy edge cases ──────────────────────────────────────────────

describe("evaluatePolicy edge cases", () => {
    it("empty command string does not throw", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("edge-empty", {
                evaluate: () => [{ result: { allow: false, reason: "empty", policy_name: "edge" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "edge-empty");

            const result = await evaluatePolicy(dir, { ...sampleInput, command: "", segments: [] });
            expect(typeof result.allow).toBe("boolean");
        } finally {
            rmDir(dir);
        }
    });

    it("100 KB command string does not crash", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("edge-long", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "edge-long" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "edge-long");

            const result = await evaluatePolicy(dir, {
                ...sampleInput,
                command: "x".repeat(100_000),
            });
            expect(typeof result.allow).toBe("boolean");
        } finally {
            rmDir(dir);
        }
    });

    it("10 concurrent evaluations against the same stack path are consistent and cache the policy once", async () => {
        const dir = makeTempDir();
        try {
            policyRegistry.set("concurrent-policy", {
                evaluate: () => [{ result: { allow: true, reason: "ok", policy_name: "concurrent" } }],
            });
            fs.writeFileSync(path.join(dir, "policy.wasm"), "concurrent-policy");

            const results = await Promise.all(
                Array.from({ length: 10 }, () => evaluatePolicy(dir, sampleInput))
            );

            for (const r of results) {
                expect(r.allow).toBe(true);
                expect(r.policy_name).toBe("concurrent");
            }

            // Exactly one cache entry per distinct wasm path
            const stackEntries = loadedPolicies().filter(
                (e) => e.path === path.join(dir, "policy.wasm")
            );
            expect(stackEntries).toHaveLength(1);
        } finally {
            rmDir(dir);
        }
    });
});

// ── with real WASM (integration, conditional) ─────────────────────────────
//
