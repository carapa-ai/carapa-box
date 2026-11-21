import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Simple test runner for CarapaBox
 * Run with: bun run src/test.ts
 */

async function callMcpTool(tool: string, args?: Record<string, string>): Promise<string> {
    const argsStr = args
        ? Object.entries(args)
            .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
            .join(" ")
        : "";
    const cmd = `bun x mcporter call --stdio 'bun src/index.ts' ${tool} ${argsStr}`.trim();

    return new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", cmd], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk) => stdout += chunk.toString());
        child.stderr?.on("data", (chunk) => stderr += chunk.toString());

        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr || `Exit code: ${code}`));
            }
        });
    });
}

async function main() {
    console.log("\n🧪 CarapaBox Docker Sandbox Tests\n");

    let passed = 0;
    let total = 0;

    async function test(name: string, fn: () => Promise<void>) {
        total++;
        process.stdout.write(`running: ${name}... `);
        try {
            await fn();
            console.log("✅");
            passed++;
        } catch (error: any) {
            console.log("❌");
            console.error(`   Error: ${error.message}`);
            // Log full error details for debugging
            if (error.output) console.error(`   Output: ${error.output}`);
        }
    }

    // Test 1: sandbox_list
    await test("sandbox_list returns array", async () => {
        const output = await callMcpTool("sandbox_list");
        const stacks = JSON.parse(output);
        if (!Array.isArray(stacks)) throw new Error("Expected array");
        if (stacks.length === 0) throw new Error("Expected at least one stack");
        if (!stacks[0].name) throw new Error("Stack missing name property");
    });

    // Test 2: sandbox_start with hooks
    await test("sandbox_start with hooks", async () => {
        const output = await callMcpTool("sandbox_start", { name: "example" });
        if (!output.includes("started successfully")) throw new Error(`Unexpected: ${output}`);
        if (!output.includes("before-start")) throw new Error("before-start hook not executed");
        if (!output.includes("after-start")) throw new Error("after-start hook not executed");
    });

    // Test 3: sandbox_status
    await test("sandbox_status shows running", async () => {
        const output = await callMcpTool("sandbox_status", { name: "example" });
        if (!output.includes("running")) throw new Error(`Expected running state: ${output}`);
    });

    // Wait a bit for container to be fully ready
    await new Promise(r => setTimeout(r, 2000));

    // Test 4: a bare stack override is normalized to
    // /usr/local/stack-cli-bin/fs-tool.sh and executed without PATH lookup.
    await test("sandbox_exec normalizes and executes a trusted wrapper", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "fs-tool.sh read-file /__carapabox_test_missing__"
        });
        if (!output.includes("__NOT_FOUND__")) {
            throw new Error(`Expected trusted fs-tool.sh output, got: [${output}]`);
        }
    });

    // Test 5: sandbox_exec blocked command
    await test("sandbox_exec blocked command fails", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "whoami"
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 6: sandbox_exec pipe bypass check
    await test("pipe bypass is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "echo 'hi' | whoami"
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 7: sandbox_exec redirection bypass check
    await test("redirection bypass is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "echo 'owned' > /tmp/pwned"
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 8: sandbox_exec subshell bypass check ($())
    await test("subshell $() bypass is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'echo $(whoami)'
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 9: sandbox_exec backtick bypass check (``)
    await test("backtick bypass is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'echo `whoami`'
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 10: sandbox_exec command chaining bypass (;)
    await test("command chaining (;) is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'ls -la ; whoami'
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 11: sandbox_exec newline bypass
    await test("newline command injection is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'echo "hi"\nwhoami'
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 12: sandbox_exec variable expansion bypass
    await test("variable expansion bypass is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'echo ${WHOAMI:-whoami}'
        });
        if (!output.includes("Security Error")) {
            throw new Error(`Expected Security Error for variable expansion, got: [${output || "EMPTY"}]`);
        }
    });

    // Test 13: Strict by default - no policy denies
    await test("missing policy.wasm is denied (strict default)", async () => {
        const configPath = path.join(process.cwd(), "stacks/example/policy.wasm");
        const backupPath = path.join(process.cwd(), "stacks/example/policy.wasm.bak");
        const originalContent = fs.readFileSync(configPath);

        try {
            fs.renameSync(configPath, backupPath);
            const output = await callMcpTool("sandbox_exec", {
                name: "example",
                service: "sandbox",
                command: "fs-tool.sh read-file /__carapabox_test_missing__"
            });
            if (!output.includes("Stack or instance not found")) {
                throw new Error(`Expected stack registration rejection for missing policy, got: [${output}]`);
            }
        } finally {
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, configPath);
            } else {
                fs.writeFileSync(configPath, originalContent);
            }
        }
    });

    // Test 13b: Strict Mode - Service not listed in policy
    await test("strict default blocks unlisted service", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "other-service",
            command: "fs-tool.sh read-file /__carapabox_test_missing__"
        });
        if (!output.includes("Security Error")) throw new Error(`Expected Security Error, got: [${output}]`);
    });

    // Test 14: Environment Variable Hijacking
    await test("inline env var assignment is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: 'PATH=/tmp:$PATH ls'
        });
        if (!output.includes("Security Error")) {
            throw new Error(`Expected Security Error for env var hijack, got: [${output || "EMPTY"}]`);
        }
    });

    // Test 15: exact immediate stack override paths execute too.
    await test("sandbox_exec executes an exact stack override path", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "/usr/local/stack-cli-bin/fs-tool.sh read-file /__carapabox_test_missing__"
        });
        if (!output.includes("__NOT_FOUND__")) {
            throw new Error(`Expected trusted fs-tool.sh output, got: [${output}]`);
        }
    });

    // Test 16: sandbox_stop
    await test("sandbox_stop example", async () => {
        const output = await callMcpTool("sandbox_stop", { name: "example" });
        if (!output.includes("stopped")) throw new Error(`Unexpected: ${output}`);
    });

    // Test 6: Invalid stack name
    await test("invalid stack name rejected", async () => {
        const output = await callMcpTool("sandbox_start", { name: "../etc" });
        if (!output.includes("Invalid stack name")) throw new Error(`Expected rejection: ${output}`);
    });

    // Test 18: Variable Expansion Block ($PATH)
    await test("direct variable expansion ($VAR) is blocked", async () => {
        const output = await callMcpTool("sandbox_exec", {
            name: "example",
            service: "sandbox",
            command: "fs-tool.sh read-file $PATH"
        });
        if (!output.includes("Security Error") || !output.includes("variable expansion")) {
            throw new Error(`Expected Security Error for $PATH expansion, got: [${output}]`);
        }
    });

    console.log(`\n${passed}/${total} tests passed\n`);
    process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);
