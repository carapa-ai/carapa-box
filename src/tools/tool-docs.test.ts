import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, toolRegistry } from "./register.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOL_SHAPED = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** Tool names from llms.txt bullets of the form "- `name` — ...". */
export function parseLlmsToolNames(text: string): string[] {
    return [...text.matchAll(/^- `([^`]+)` — /gm)].map((m) => m[1]).filter((n) => TOOL_SHAPED.test(n));
}

/** Tool names from README table rows ("| `name` | ...") inside the "## MCP Tools" section. */
export function parseReadmeToolNames(text: string): string[] {
    const start = text.search(/^## MCP Tools\s*$/m);
    if (start < 0) return [];
    const rest = text.slice(start + 1);
    const next = rest.search(/^## /m);
    const section = next < 0 ? rest : rest.slice(0, next);
    return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]).filter((n) => TOOL_SHAPED.test(n));
}

/** Compare documented tool names with registered ones; returns problems (empty = in sync). */
export function compareToolDocs(registered: Iterable<string>, documented: Iterable<string>): { missing: string[]; unregistered: string[] } {
    const reg = new Set(registered);
    const doc = new Set(documented);
    return {
        missing: [...reg].filter((n) => !doc.has(n)).sort(),
        unregistered: [...doc].filter((n) => !reg.has(n)).sort(),
    };
}

// Tools that register only under an env flag; enabled below so they are checked too.
const CONDITIONAL_ENV = ["ENABLE_SANDBOX_GIT", "ENABLE_GIT_ISSUES"];

function registeredToolNames(): string[] {
    const saved = CONDITIONAL_ENV.map((k) => [k, process.env[k]] as const);
    for (const k of CONDITIONAL_ENV) process.env[k] = "true";
    try {
        // Only tool() is called during registration; a no-op stands in for the MCP server.
        const fake = { tool: () => undefined } as unknown as McpServer;
        registerTools(fake, true);
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    return [...toolRegistry.keys()];
}

describe("compareToolDocs", () => {
    it("reports a documented name that is not registered", () => {
        const r = compareToolDocs(["sandbox_list"], ["sandbox_list", "sandbox_tmux_attach"]);
        expect(r.unregistered).toEqual(["sandbox_tmux_attach"]);
        expect(r.missing).toEqual([]);
    });
    it("reports a registered name missing from the doc", () => {
        const r = compareToolDocs(["sandbox_list", "build_service"], ["sandbox_list"]);
        expect(r.missing).toEqual(["build_service"]);
        expect(r.unregistered).toEqual([]);
    });
    it("is clean when both agree", () => {
        expect(compareToolDocs(["a_b"], ["a_b"])).toEqual({ missing: [], unregistered: [] });
    });
});

describe("doc parsers", () => {
    it("parses only tool-shaped llms.txt bullets", () => {
        const text = "- `sandbox_list` — x\n- `stdio` — y\n- **stdio**: z\n";
        expect(parseLlmsToolNames(text)).toEqual(["sandbox_list"]);
    });
    it("parses only first-column README rows in the MCP Tools section", () => {
        const text = "## Intro\n| `other_tool` | x |\n## MCP Tools\n| Tool | D |\n| `sandbox_ps` | `instance?` |\n## Next\n| `later_tool` | x |\n";
        expect(parseReadmeToolNames(text)).toEqual(["sandbox_ps"]);
    });
});

describe("tool docs match the runtime registry", () => {
    const names = registeredToolNames();

    it("registers tools", () => {
        expect(names.length).toBeGreaterThan(10);
    });

    it("public/llms.txt lists exactly the registered tools", () => {
        const doc = parseLlmsToolNames(fs.readFileSync(path.join(ROOT, "public/llms.txt"), "utf8"));
        expect(compareToolDocs(names, doc)).toEqual({ missing: [], unregistered: [] });
    });

    it("README MCP Tools tables list exactly the registered tools", () => {
        const doc = parseReadmeToolNames(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"));
        expect(compareToolDocs(names, doc)).toEqual({ missing: [], unregistered: [] });
    });
});
