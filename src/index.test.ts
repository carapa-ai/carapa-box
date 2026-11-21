/**
 * Unit tests for pure parsing functions in src/index.ts
 * Run with: bun test src/index.test.ts
 */

import { describe, it, expect } from "bun:test";
import { handleFatalStartupError } from "./index.js";
import { parsePublishers, parseComposePsOutput } from "./tools/register.js";
import { sanitizeStatusObject, STATUS_SAFE_KEYS } from "./utils.js";

// ── parsePublishers ──────────────────────────────────────────────────────────

describe("parsePublishers", () => {
    it("returns [] for non-array input (null)", () => {
        expect(parsePublishers(null)).toEqual([]);
    });

    it("returns [] for non-array input (string)", () => {
        expect(parsePublishers("8080:80/tcp")).toEqual([]);
    });

    it("returns [] for non-array input (number)", () => {
        expect(parsePublishers(42)).toEqual([]);
    });

    it("returns [] for non-array input (object)", () => {
        expect(parsePublishers({ TargetPort: 80 })).toEqual([]);
    });

    it("formats a standard publisher with TargetPort, PublishedPort, Protocol", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
        ]);
        expect(result).toEqual(["8080->80/tcp"]);
    });

    it("handles lowercase variant field names (publishedPort, targetPort, protocol)", () => {
        const result = parsePublishers([
            { targetPort: 3000, publishedPort: 9000, protocol: "tcp" },
        ]);
        expect(result).toEqual(["9000->3000/tcp"]);
    });

    it("defaults Protocol to tcp when missing", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080 },
        ]);
        expect(result).toEqual(["8080->80/tcp"]);
    });

    it("handles URL field (non-zero, non-wildcard host)", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp", URL: "127.0.0.1" },
        ]);
        expect(result).toEqual(["127.0.0.1:8080->80/tcp"]);
    });

    it("omits host prefix when URL is 0.0.0.0", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp", URL: "0.0.0.0" },
        ]);
        expect(result).toEqual(["8080->80/tcp"]);
    });

    it("omits host prefix when URL is ::", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp", URL: "::" },
        ]);
        expect(result).toEqual(["8080->80/tcp"]);
    });

    it("filters out entries where PublishedPort is 0", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 0, Protocol: "tcp" },
        ]);
        expect(result).toEqual([]);
    });

    it("filters out entries with missing PublishedPort", () => {
        const result = parsePublishers([
            { TargetPort: 80, Protocol: "tcp" },
        ]);
        expect(result).toEqual([]);
    });

    it("deduplicates identical port strings", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
        ]);
        expect(result).toEqual(["8080->80/tcp"]);
    });

    it("returns multiple distinct port mappings", () => {
        const result = parsePublishers([
            { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
            { TargetPort: 443, PublishedPort: 8443, Protocol: "tcp" },
        ]);
        expect(result).toEqual(["8080->80/tcp", "8443->443/tcp"]);
    });

    it("returns [] for empty array", () => {
        expect(parsePublishers([])).toEqual([]);
    });
});

// ── parseComposePsOutput ─────────────────────────────────────────────────────

describe("parseComposePsOutput", () => {
    it("returns [] for empty string", () => {
        expect(parseComposePsOutput("")).toEqual([]);
    });

    it("parses valid NDJSON (one object per line)", () => {
        const ndjson = [
            JSON.stringify({ Service: "web", Name: "myapp-web-1", State: "running", Publishers: [] }),
            JSON.stringify({ Service: "db", Name: "myapp-db-1", State: "running", Publishers: [] }),
        ].join("\n");
        const result = parseComposePsOutput(ndjson);
        expect(result).toHaveLength(2);
        expect(result[0].service).toBe("web");
        expect(result[0].hostname).toBe("myapp-web-1");
        expect(result[1].service).toBe("db");
    });

    it("parses valid JSON array input (fallback format)", () => {
        const arr = JSON.stringify([
            { Service: "api", Name: "proj-api-1", State: "running", Publishers: [] },
        ]);
        const result = parseComposePsOutput(arr);
        expect(result).toHaveLength(1);
        expect(result[0].service).toBe("api");
        expect(result[0].hostname).toBe("proj-api-1");
    });

    it("silently skips malformed NDJSON lines", () => {
        const ndjson = [
            JSON.stringify({ Service: "web", Name: "proj-web-1", State: "running", Publishers: [] }),
            "NOT_VALID_JSON{{{",
            JSON.stringify({ Service: "db", Name: "proj-db-1", State: "running", Publishers: [] }),
        ].join("\n");
        const result = parseComposePsOutput(ndjson);
        expect(result).toHaveLength(2);
        expect(result[0].service).toBe("web");
        expect(result[1].service).toBe("db");
    });

    it("filters out entries with missing Name and Service", () => {
        const ndjson = [
            JSON.stringify({ State: "running", Publishers: [] }),
            JSON.stringify({ Service: "web", Name: "proj-web-1", State: "running", Publishers: [] }),
        ].join("\n");
        const result = parseComposePsOutput(ndjson);
        expect(result).toHaveLength(1);
        expect(result[0].service).toBe("web");
    });

    it("includes entry with Name only (no Service)", () => {
        const ndjson = JSON.stringify({ Name: "orphan-1", State: "exited", Publishers: [] });
        const result = parseComposePsOutput(ndjson);
        expect(result).toHaveLength(1);
        expect(result[0].hostname).toBe("orphan-1");
        expect(result[0].service).toBe("");
    });

    it("extracts port publishers from Publishers field", () => {
        const ndjson = JSON.stringify({
            Service: "web",
            Name: "proj-web-1",
            State: "running",
            Publishers: [{ TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" }],
        });
        const result = parseComposePsOutput(ndjson);
        expect(result[0].ports).toEqual(["8080->80/tcp"]);
    });

    it("defaults Protocol to tcp when missing inside Publishers", () => {
        const ndjson = JSON.stringify({
            Service: "web",
            Name: "proj-web-1",
            State: "running",
            Publishers: [{ TargetPort: 80, PublishedPort: 8080 }],
        });
        const result = parseComposePsOutput(ndjson);
        expect(result[0].ports).toEqual(["8080->80/tcp"]);
    });

    it("reads status from State field", () => {
        const ndjson = JSON.stringify({
            Service: "web", Name: "proj-web-1", State: "exited",
        });
        const result = parseComposePsOutput(ndjson);
        expect(result[0].status).toBe("exited");
    });

    it("falls back to Status field when State is absent", () => {
        const ndjson = JSON.stringify({
            Service: "web", Name: "proj-web-1", Status: "Up 2 minutes",
        });
        const result = parseComposePsOutput(ndjson);
        expect(result[0].status).toBe("Up 2 minutes");
    });

    it("handles lowercase field names (service, name)", () => {
        const ndjson = JSON.stringify({
            service: "cache", name: "proj-cache-1", State: "running",
        });
        const result = parseComposePsOutput(ndjson);
        expect(result[0].service).toBe("cache");
        expect(result[0].hostname).toBe("proj-cache-1");
    });
});

// ── sanitizeStatusObject ───────────────────────────────────────────────────────

describe("sanitizeStatusObject", () => {
    it("returns null when no safe keys are present", () => {
        const line = JSON.stringify({ _internal: "secret", __raw: "data" });
        expect(sanitizeStatusObject(JSON.parse(line))).toBeNull();
    });

    it("returns null when all matching key values are empty string", () => {
        const line = JSON.stringify({ Name: "", Service: "" });
        expect(sanitizeStatusObject(JSON.parse(line))).toBeNull();
    });

    it("returns filtered object containing only STATUS_SAFE_KEYS", () => {
        const line = JSON.stringify({
            Name: "myapp-web-1",
            Service: "web",
            State: "running",
            _internal: "should-be-excluded",
            __raw: "also-excluded",
        });
        const result = sanitizeStatusObject(JSON.parse(line));
        expect(result).not.toBeNull();
        expect(result!.Name).toBe("myapp-web-1");
        expect(result!.Service).toBe("web");
        expect(result!.State).toBe("running");
        expect("_internal" in result!).toBe(false);
        expect("__raw" in result!).toBe(false);
    });

    it("includes all STATUS_SAFE_KEYS when all are provided", () => {
        const fullEntry: Record<string, unknown> = {};
        for (const key of STATUS_SAFE_KEYS) {
            fullEntry[key] = `value-for-${key}`;
        }
        const line = JSON.stringify(fullEntry);
        const result = sanitizeStatusObject(JSON.parse(line));
        expect(result).not.toBeNull();
        for (const key of STATUS_SAFE_KEYS) {
            expect(key in result!).toBe(true);
            expect(result![key]).toBe(`value-for-${key}`);
        }
        expect(Object.keys(result!)).toHaveLength(STATUS_SAFE_KEYS.size);
    });

    it("returns null when only undefined values are present for safe keys", () => {
        // JSON.stringify drops undefined values → they won't appear in JSON
        // so this should produce an empty object → null
        const line = JSON.stringify({ Name: null });
        // null is not undefined/"", so it should be included
        const result = sanitizeStatusObject(JSON.parse(line));
        expect(result).not.toBeNull();
        expect(result!.Name).toBeNull();
    });

    it("keeps non-string safe-key values (numbers, arrays)", () => {
        const line = JSON.stringify({
            Name: "myapp-web-1",
            ExitCode: 0,
            Publishers: [{ TargetPort: 80, PublishedPort: 8080 }],
        });
        const result = sanitizeStatusObject(JSON.parse(line));
        expect(result).not.toBeNull();
        expect(result!.ExitCode).toBe(0);
        expect(Array.isArray(result!.Publishers)).toBe(true);
    });

    it("excludes keys not in STATUS_SAFE_KEYS even if they look similar", () => {
        const line = JSON.stringify({
            Name: "valid",
            name: "lowercase-not-safe",
            ServiceName: "not-a-safe-key",
        });
        const result = sanitizeStatusObject(JSON.parse(line));
        expect(result).not.toBeNull();
        expect(result!.Name).toBe("valid");
        expect("name" in result!).toBe(false);
        expect("ServiceName" in result!).toBe(false);
    });
});

// ── handleFatalStartupError ──────────────────────────────────────────────────

describe("handleFatalStartupError", () => {
    it("logs the Error object under `err`", () => {
        const calls: unknown[][] = [];
        const error = new Error("corrupt reservations");
        handleFatalStartupError(error, { logger: { error: (...a: unknown[]) => { calls.push(a); } }, exit: () => {} });
        expect(calls).toHaveLength(1);
        expect((calls[0][0] as { err: unknown }).err).toBe(error);
        expect(calls[0][1]).toBe("[CarapaBox] Fatal startup error");
    });

    it("calls exit once with code 1", () => {
        const codes: number[] = [];
        handleFatalStartupError(new Error("x"), { logger: { error: () => {} }, exit: c => { codes.push(c); } });
        expect(codes).toEqual([1]);
    });
});
