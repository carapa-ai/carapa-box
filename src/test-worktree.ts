/**
 * Integration tests for sandbox_worktree operations.
 *
 * Runs against the LIVE carapa-box HTTP server — does NOT spawn its own.
 *
 * Requires:
 *   - carapa-box running in HTTP mode with ENABLE_SANDBOX_GIT=1
 *   - A running stack with a git repo (carapa-bot with carapa-board instance)
 *   - SSH_KEYS_FOLDER configured in stack .env
 *
 * Run with: bun run test:worktree
 *
 * Environment variables:
 *   BOX_URL          - carapa-box URL (default: http://localhost:3100)
 *   BOX_TOKEN        - CARAPA_BOX_API_TOKEN for auth (reads from .env if not set)
 *   TEST_STACK       - Stack name (default: carapa-bot)
 *   TEST_INSTANCE    - Instance name (default: carapa-board)
 *   TEST_BRANCH      - Branch name for test worktree (default: test-wt-<timestamp>)
 *   TEST_BASE        - Base branch (default: develop)
 */

import fs from "node:fs";
import path from "node:path";

// --- Config ---

const BOX_URL = process.env.BOX_URL || "http://host.docker.internal:3100";

function loadToken(): string {
    if (process.env.BOX_TOKEN) return process.env.BOX_TOKEN;
    // Try reading from .env
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        const match = content.match(/^CARAPA_BOX_API_TOKEN=(.+)$/m);
        if (match) return match[1].trim();
    }
    return "";
}

const TOKEN = loadToken();
const STACK = process.env.TEST_STACK || "carapa-bot";
const INSTANCE = process.env.TEST_INSTANCE || "carapa-board";
const BRANCH = process.env.TEST_BRANCH || `test-wt-${Date.now()}`;
const BASE = process.env.TEST_BASE || "develop";

// --- MCP HTTP client ---

let sessionId: string | null = null;
let requestId = 0;

async function mcpRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = ++requestId;
    const body: any = { jsonrpc: "2.0", id, method, params };

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const resp = await fetch(BOX_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });

    // Capture session ID from first response
    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId) sessionId = newSessionId;

    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const contentType = resp.headers.get("content-type") || "";

    // MCP Streamable HTTP may return SSE or JSON
    let json: any;
    if (contentType.includes("text/event-stream")) {
        const text = await resp.text();
        // Extract JSON from SSE data lines
        const dataLines = text.split("\n").filter(l => l.startsWith("data: "));
        for (const line of dataLines) {
            try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.id === id) { json = parsed; break; }
            } catch { }
        }
        if (!json) throw new Error(`No matching response in SSE stream for id=${id}`);
    } else {
        json = await resp.json();
    }

    if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
}

async function initialize(): Promise<void> {
    await mcpRequest("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-worktree", version: "1.0.0" },
    });
}

async function callTool(name: string, args?: Record<string, unknown>): Promise<string> {
    const result = await mcpRequest("tools/call", { name, arguments: args || {} });
    const text = result?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n") || "";
    if (result?.isError) {
        throw new Error(`Tool error: ${text}`);
    }
    return text;
}

// --- Test harness ---

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    process.stdout.write(`  ${name}... `);
    try {
        await fn();
        console.log("ok");
        passed++;
    } catch (error: any) {
        console.log("FAIL");
        console.error(`    ${error.message.split("\n")[0]}`);
        failed++;
    }
}

function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(msg);
}

// --- Tests ---

async function main() {
    console.log(`\nWorktree tests (${BOX_URL} stack=${STACK} instance=${INSTANCE} branch=${BRANCH} base=${BASE})\n`);

    // Check health first
    try {
        const resp = await fetch(`${BOX_URL}/health`);
        if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`);
    } catch (err: any) {
        console.error(`Cannot reach carapa-box at ${BOX_URL}: ${err.message}`);
        console.error("Make sure carapa-box is running in HTTP mode (--http)");
        process.exit(1);
    }

    await initialize();

    // --- sandbox_git ---

    await test("sandbox_git: local git log", async () => {
        const output = await callTool("sandbox_git", {
            name: STACK,
            command: "log --oneline -3",
            instance: INSTANCE,
        });
        assert(output.length > 0, "Expected git log output");
        assert(!output.includes("not a git repository"), `Not a git repo: ${output}`);
    });

    await test("sandbox_git: remote pull via SSH", async () => {
        const output = await callTool("sandbox_git", {
            name: STACK,
            command: `pull --ff-only origin ${BASE}`,
            instance: INSTANCE,
        });
        assert(
            output.includes("up to date") || output.includes("Updating") || output.includes("Fast-forward"),
            `Unexpected pull output: ${output}`,
        );
    });

    // --- sandbox_worktree: add ---

    await test("worktree add creates branch", async () => {
        const output = await callTool("sandbox_worktree", {
            name: STACK,
            action: "add",
            branch: BRANCH,
            base: BASE,
            instance: INSTANCE,
        });
        assert(
            output.includes("worktree_path=") || output.includes("Worktree created"),
            `Unexpected add output: ${output}`,
        );
    });

    // --- sandbox_worktree: list ---

    await test("worktree list shows new branch", async () => {
        const output = await callTool("sandbox_worktree", {
            name: STACK,
            action: "list",
            instance: INSTANCE,
        });
        assert(output.includes(BRANCH), `Branch ${BRANCH} not in list`);
    });

    // --- sandbox_worktree: reset ---

    await test("worktree reset succeeds", async () => {
        const output = await callTool("sandbox_worktree", {
            name: STACK,
            action: "reset",
            branch: BRANCH,
            base: BASE,
            instance: INSTANCE,
        });
        assert(
            output.includes("HEAD is now at") || output.includes("Worktree reset to"),
            `Unexpected reset output: ${output}`,
        );
    });

    await test("worktree reset points to base HEAD", async () => {
        const baseLog = await callTool("sandbox_git", {
            name: STACK,
            command: `log --oneline -1 ${BASE}`,
            instance: INSTANCE,
        });
        const baseCommit = baseLog.split(" ")[0];

        const wtLog = await callTool("sandbox_git", {
            name: STACK,
            command: `log --oneline -1 ${BRANCH}`,
            instance: INSTANCE,
        });
        const wtCommit = wtLog.split(" ")[0];

        assert(baseCommit === wtCommit, `Worktree HEAD (${wtCommit}) != base HEAD (${baseCommit})`);
    });

    // --- sandbox_worktree: remove ---

    await test("worktree remove cleans up", async () => {
        const output = await callTool("sandbox_worktree", {
            name: STACK,
            action: "remove",
            branch: BRANCH,
            instance: INSTANCE,
        });
        assert(!output.includes("Failed"), `Remove failed: ${output}`);
    });

    await test("worktree list no longer shows removed branch", async () => {
        const output = await callTool("sandbox_worktree", {
            name: STACK,
            action: "list",
            instance: INSTANCE,
        });
        assert(!output.includes(BRANCH), `Branch ${BRANCH} still in list after remove`);
    });

    // --- Summary ---
    console.log(`\n${passed}/${passed + failed} passed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
