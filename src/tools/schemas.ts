import * as z from "zod";

// --- TOOL SCHEMAS ---
// Pre-defining schemas with `as const` reduces type inference depth
// and prevents "Type instantiation is excessively deep" errors

export const SandboxPsSchema = {
    instance: z.string().optional().describe("Filter by a specific instance ID/project name"),
} as const;

export const SandboxStartSchema = {
    name: z.string().describe("Name of the sandbox stack to start (e.g. 'openclaw', 'example')"),
    instance: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe("Instance ID for running multiple copies (e.g., 'user123'). If omitted, uses stack name."),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for lifecycle hooks. Do NOT include secrets - these may be logged."),
    service: z.string().optional().describe("Agent Compose service for relay token registration and the optional project .agent/after-start.sh hook. Defaults to 'agent'; stacks without that service skip the project hook when no service is specified."),
} as const;

export const SandboxProxyAliasesSchema = {
    name: z.string().describe("Name of the sandbox stack"),
    instance: z.string().optional().describe("Instance ID if running multiple copies"),
    aliases: z.array(z.string()).max(8).describe("Public hostname aliases for the generated nginx route"),
} as const;

export const SandboxLogsSchema = {
    name: z.string().describe("Name of the sandbox or instance"),
    service: z.string().optional().describe("Name of the service (optional if stack has a single service)"),
    tail: z.number().optional().describe("Number of newest lines to show (default: 1000)"),
    instance: z.string().optional().describe("Instance ID if running multiple copies"),
} as const;

export type ServiceInfo = { service: string; hostname: string; status: string; ports: string[]; ip: string };
