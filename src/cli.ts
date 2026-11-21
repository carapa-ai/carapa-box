import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveStackAndProject, resolveOwnedProjects } from "./utils.js";
import { buildStack, stopStack, listProjects } from "./compose/client.js";
import { getStacksDir } from "./config.js";
import { runHook, formatHookResult } from "./compose/hooks.js";
import { logger } from "./logger.js";
import { GIT_USAGE, parseGitCliArgs } from "./cli-git-args.js";

/**
 * Fast Native CLI client for CarapaBox
 */

const aliases: Record<string, string> = {
    "list": "sandbox_list",
    "start": "sandbox_start",
    "stop": "sandbox_stop",
    "build": "local_build", // Special local-only command
    "stop-all": "local_stop_all", // Special local-only command
    "status": "sandbox_status",
    "exec": "sandbox_exec",
    "logs": "sandbox_logs",
    "ps": "sandbox_ps",
    "git": "sandbox_git",
    "worktree": "sandbox_worktree",
};

const internalLogHandler = (msg: string) => {
    process.stderr.write(msg);
};

async function main() {
    // Keep one-shot CLI runs quiet unless a log level was explicitly configured.
    logger.level = process.env.LOG_LEVEL || "warn";
    const args = process.argv.slice(2);
    // Ensure colors are preserved across processes
    process.env.FORCE_COLOR = "1";

    if (args.length === 0) {
        console.log("\n🚀 MCP Sandbox CLI");
        console.log("-------------------");
        console.log("Usage: bun call <tool|alias> [arguments] [-i instance]\n");
        console.log("Commands:");
        console.log("  - list      : List available stacks");
        console.log("  - start     : Start a stack");
        console.log("  - stop      : Stop a stack");
        console.log("  - build     : Build images (CLI only)");
        console.log("  - stop-all  : Stop all running instances (CLI only)");
        console.log("  - ps        : List running instances");
        console.log("  - exec      : Run command in instance");
        console.log("  - logs      : View instance logs");
        console.log("  - git       : Run git command in instance (bun call git [-i instance] <stack> <git-command...>)");
        console.log("  - worktree  : Manage git worktrees (add/remove/list/reset)");
        process.exit(0);
    }

    const toolName = aliases[args[0]] || args[0];
    const restArgs = args.slice(1);

    // `git` forwards everything after the stack to git, so its flags must not reach parseArgs.
    const gitArgs = toolName === "sandbox_git" ? parseGitCliArgs(restArgs) : null;
    if (toolName === "sandbox_git" && !gitArgs) {
        logger.error(`❌ Error: Usage: ${GIT_USAGE}`);
        process.exit(1);
    }
    const { values, positionals } = gitArgs
        ? { values: { instance: gitArgs.instance, service: gitArgs.service, base: undefined }, positionals: [] as string[] }
        : parseArgs({
            args: restArgs,
            options: {
                instance: { type: "string", short: "i" },
                base: { type: "string", short: "b" },
                service: { type: "string", short: "s" },
            },
            allowPositionals: true,
        });

    // Handle LOCAL-ONLY commands first (don't even start the server)
    if (toolName === "local_build") {
        const name = positionals[0];
        const instance = values.instance;

        if (!name) {
            logger.error("❌ Error: Stack name required for build");
            process.exit(1);
        }

        const { stackPath, projectName } = await resolveStackAndProject(name, instance);

        if (!stackPath) {
            logger.error(`❌ Error: Stack or instance not found: ${name}`);
            process.exit(1);
        }

        try {
            logger.info(`🏗️  Building ${projectName}...`);
            // Run before-start hook as it often handles image prep/overrides
            const beforeResult = await runHook(stackPath, "before-start", { COMPOSE_PROJECT_NAME: projectName }, internalLogHandler);
            if (beforeResult.executed) {
                logger.info(formatHookResult("before-start", beforeResult));
            }

            await buildStack(stackPath, projectName, internalLogHandler);
            console.log(`✅ Successfully built images for ${projectName} at ${stackPath}`);
            process.exit(0);
        } catch (error: any) {
            logger.error(`❌ Build failed: ${error.message}`);
            process.exit(1);
        }
    }

    // LOCAL-ONLY: Stop all running compose projects managed by carapa-box
    if (toolName === "local_stop_all") {
        try {
            const projs = await listProjects();
            const allProjects = JSON.parse(projs.stdout);
            const rawStacksDir = getStacksDir();
            const stacksDir = fs.existsSync(rawStacksDir) ? fs.realpathSync(rawStacksDir) : path.resolve(rawStacksDir);

            const projects = await resolveOwnedProjects(allProjects, stacksDir);

            if (projects.length === 0) {
                console.log("No running carapa-box instances found.");
                process.exit(0);
            }

            logger.info(`🛑 Stopping ${projects.length} running instance(s)...`);

            let failed = 0;
            for (const project of projects) {
                try {
                    logger.info(`  Stopping ${project.name}...`);
                    await stopStack(project.localStackPath, project.name, internalLogHandler);
                    logger.info(`  ✅ ${project.name} stopped`);
                } catch (error: any) {
                    logger.error(`  ❌ Failed to stop ${project.name}: ${error.message}`);
                    failed++;
                }
            }

            console.log(`\nDone. ${projects.length - failed}/${projects.length} stopped successfully.`);
            process.exit(failed > 0 ? 1 : 0);
        } catch (error: any) {
            logger.error(`❌ Error listing projects: ${error.message}`);
            process.exit(1);
        }
    }

    // For everything else, connect to MCP server
    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const distServerPath = path.resolve(cliDir, "../dist/index.js");
    const srcServerPath = path.resolve(cliDir, "index.ts");
    const finalServerPath = fs.existsSync(distServerPath) ? distServerPath : srcServerPath;

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [finalServerPath],
        // The SDK only inherits a small env allowlist; pass the caller's env so exported config
        // (SANDBOX_STACKS_DIR, DOCKER_HOST, ENABLE_SANDBOX_GIT, ...) reaches the MCP server.
        env: {
            ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
            LOG_LEVEL: logger.level,
        },
        stderr: "inherit"
    });

    const client = new Client(
        { name: "cli-client", version: "1.0.0" },
        { capabilities: {} }
    );

    const timeout = setTimeout(() => {
        logger.error("❌ CLI Error: Request timed out (300s).");
        try { (transport as any)._process?.kill('SIGKILL'); } catch { /* intentionally swallowed: best-effort process kill during timeout, already exiting */ }
        process.exit(1);
    }, 300000);

    try {
        await client.connect(transport);

        const toolArgs: Record<string, any> = {};

        switch (toolName) {
            case "sandbox_list": break;
            case "sandbox_ps":
                if (positionals[0]) toolArgs.instance = positionals[0];
                break;
            case "sandbox_status":
                if (!positionals[0]) {
                    logger.error("❌ Error: Stack or instance name required. Usage: bun call status <stack|instance> [service]");
                    process.exit(1);
                }
                toolArgs.name = positionals[0];
                if (positionals[1]) toolArgs.service = positionals[1];
                break;
            case "sandbox_start":
            case "sandbox_stop":
                if (!positionals[0]) {
                    logger.error("❌ Error: Stack or instance name required. Usage: bun call <start|stop> <stack|instance> [instance]");
                    process.exit(1);
                }
                toolArgs.name = positionals[0];
                if (!values.instance && positionals[1] && !positionals[1].includes("=")) {
                    toolArgs.instance = positionals[1];
                }
                const envArgs: Record<string, string> = {};
                for (const arg of positionals.slice(1)) {
                    if (arg.includes("=")) {
                        const eq = arg.indexOf("=");
                        envArgs[arg.slice(0, eq)] = arg.slice(eq + 1);
                    }
                }
                if (Object.keys(envArgs).length > 0) {
                    toolArgs.env = envArgs;
                }
                break;
            case "sandbox_exec":
                if (positionals[0]) toolArgs.name = positionals[0];
                if (positionals.length === 2) {
                    toolArgs.service = "sandbox";
                    toolArgs.command = positionals[1];
                } else {
                    if (positionals[1]) toolArgs.service = positionals[1];
                    if (positionals[2]) toolArgs.command = positionals[2];
                }
                break;
            case "sandbox_logs":
                if (!positionals[0]) {
                    logger.error("❌ Error: Stack name required. Usage: bun call logs <stack> [service] [tail]");
                    process.exit(1);
                }
                toolArgs.name = positionals[0];
                if (positionals[1]) toolArgs.service = positionals[1];
                if (positionals[2]) toolArgs.tail = parseInt(positionals[2]);
                break;
            case "sandbox_git":
                // Usage: bun call git [-i instance] [-s service] <stack> <git-command...>
                toolArgs.name = gitArgs!.stack;
                toolArgs.command = gitArgs!.command;
                if (values.service) toolArgs.service = values.service;
                break;
            case "sandbox_worktree":
                // Usage: bun call worktree <stack> <add|reuse|remove|list|reset> [branch] [-b base] [-s service] [-i instance]
                if (!positionals[0] || !positionals[1]) {
                    logger.error("❌ Error: Usage: bun call worktree <stack> <add|reuse|remove|list|reset> [branch] [-b base] [-s service] [-i instance]");
                    process.exit(1);
                }
                toolArgs.name = positionals[0];
                toolArgs.action = positionals[1];
                if (positionals[2]) toolArgs.branch = positionals[2];
                if (values.base) toolArgs.base = values.base;
                if (values.service) toolArgs.service = values.service;
                break;
        }

        if (values.instance) toolArgs.instance = values.instance;

        const response = await client.callTool({
            name: toolName,
            arguments: toolArgs,
        });

        if (response.content && Array.isArray(response.content)) {
            for (const block of response.content) {
                if (block.type === "text") {
                    console.log(block.text);
                }
            }
        }

        if (response.isError) process.exit(1);
        clearTimeout(timeout);
        process.exit(0);
    } catch (error: any) {
        logger.error({ err: error.message }, "❌ Error");
        clearTimeout(timeout);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error({ err }, "💥 Critical Failure");
    process.exit(1);
});
