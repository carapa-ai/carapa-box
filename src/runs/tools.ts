/**
 * MCP tools for the Box-owned IPC tree (`sandbox_ipc`, `sandbox_ipc_sync`).
 *
 * The IPC tree lives on the Box host; Board reaches it only through these
 * tools so the two can run on different machines.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { getStack, isValidStackName, listStacks } from "../config.js";
import { logger } from "../logger.js";
import { applyIpcOps, IpcStore, resolveGroupsRoot, resolveIpcRoot, validateRelativePath, type IpcOp } from "./ipc-store.js";
import { syncIpcRoot, type SyncRequest } from "./ipc-sync.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
// `any` in `cb`: one registrar signature serves tools with different zod schemas, and the MCP SDK's
// per-schema callback types cannot be expressed here; `unknown` would reject handlers that destructure typed args.
export type ToolFn = (name: string, description: string, schema: Record<string, z.ZodType>, cb: (args: any, extra: any) => Promise<any>) => unknown;

const json = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const failure = (error: unknown): ToolResult => json({ error: error instanceof Error ? error.message : String(error) }, true);

const ProjectSchema = {
    tree: z.enum(["ipc", "group"]).optional().describe("'ipc' (default): the sandbox IPC tree; 'group': a project group directory on this box (project = group folder)"),
    project: z.string().optional().describe("IPC project directory '<stack>-<instance>' (alternative to name/instance), or the group folder when tree='group'"),
    name: z.string().optional().describe("Sandbox stack name (e.g. 'carapa-bot')"),
    instance: z.string().optional().describe("Instance ID; the IPC project is '<name>-<instance>'"),
} as const;

type ProjectArgs = { tree?: "ipc" | "group"; project?: string; name?: string; instance?: string };

/** A project's group directory on this box (multi-host placement). */
function groupStore(folder: string): IpcStore {
    const segments = validateRelativePath(folder);
    if (segments.length !== 1) throw new Error(`Invalid group folder: ${folder}`);
    return new IpcStore(path.join(resolveGroupsRoot(), folder));
}

/** Resolve the project-scoped IPC store for a stack instance or an IPC project name. */
async function projectIpcStore({ tree, project, name, instance }: ProjectArgs): Promise<IpcStore> {
    if (tree === "group") {
        if (!project) throw new Error("tree='group' requires project (the group folder)");
        return groupStore(project);
    }
    if (project) {
        // Stack names may contain '-': pick the longest stack that prefixes the project.
        const stacks = (await listStacks()).map(stack => stack.name).sort((a, b) => b.length - a.length);
        const stackName = stacks.find(stack => project === stack || project.startsWith(`${stack}-`));
        if (!stackName) throw new Error(`No stack owns IPC project: ${project}`);
        const stack = await getStack(stackName);
        return IpcStore.forProject(project, stack?.path);
    }
    if (!name || !isValidStackName(name)) throw new Error(`Invalid stack name: ${name}`);
    const stack = await getStack(name);
    if (!stack) throw new Error(`Stack not found: ${name}`);
    return IpcStore.forProject(instance ? `${name}-${instance}` : name, stack.path);
}

/**
 * Make `runs/` writable before a start. An unwritable tree left by an older
 * root-owned bind mount is moved aside (never deleted) when the caller has
 * confirmed the whole stack is stopped.
 */
async function prepareRunsDir(store: IpcStore, archiveUnwritable: boolean): Promise<{ archivedTo?: string }> {
    const runs = path.join(store.projectDir, "runs");
    try {
        await fsp.mkdir(runs, { recursive: true });
        await fsp.access(runs, fsp.constants.W_OK | fsp.constants.X_OK);
        return {};
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!archiveUnwritable || (code !== "EACCES" && code !== "EPERM")) throw error;
    }
    const archivedTo = `${store.projectDir}.stale-${Date.now()}`;
    await fsp.rename(store.projectDir, archivedTo);
    await fsp.mkdir(runs, { recursive: true });
    logger.warn({ projectDir: store.projectDir, archivedTo }, "[IPC] Archived an unwritable IPC directory before start");
    return { archivedTo };
}

/** IPC project directories under every stack's IPC root. */
async function listIpcProjects(): Promise<string[]> {
    const listed = await listStacks();
    const roots = new Set<string>();
    for (const stack of listed) {
        try { roots.add(await resolveIpcRoot(stack.path)); } catch { /* stack without IPC */ }
    }
    const stacks = listed.map(stack => stack.name);
    const projects = new Set<string>();
    for (const root of roots) {
        let entries: import("node:fs").Dirent[] = [];
        try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.includes(".stale-")) continue;
            if (stacks.some(stack => entry.name === stack || entry.name.startsWith(`${stack}-`))) projects.add(entry.name);
        }
    }
    return [...projects].sort();
}

export function registerIpcTools(tool: ToolFn): void {
    const FolderSchema = { folder: z.string().describe("Group folder of a project placed on this box") } as const;
    tool(
        "group_list",
        "List a directory inside a project's group directory on this box.",
        { ...FolderSchema, path: z.string().optional().describe("Relative directory (default: the group root)") },
        async (args) => {
            const { folder, path: rel } = args as { folder: string; path?: string };
            try {
                return json({ entries: await groupStore(folder).list(rel ?? "") });
            } catch (error) {
                return failure(error);
            }
        },
    );
    tool(
        "group_read",
        "Read a file inside a project's group directory on this box (base64 data, offset/maxBytes for large files).",
        { ...FolderSchema, path: z.string(), offset: z.number().optional(), maxBytes: z.number().optional() },
        async (args) => {
            const { folder, path: rel, offset, maxBytes } = args as { folder: string; path: string; offset?: number; maxBytes?: number };
            try {
                return json(await groupStore(folder).read(rel, offset ?? 0, maxBytes));
            } catch (error) {
                return failure(error);
            }
        },
    );
    tool(
        "group_write",
        "Write (atomic) or delete a file inside a project's group directory on this box.",
        {
            ...FolderSchema,
            path: z.string(),
            data: z.string().optional().describe("File content; base64 when encoding='base64'"),
            encoding: z.enum(["utf8", "base64"]).optional(),
            remove: z.boolean().optional().describe("Delete the file (recursive for directories)"),
        },
        async (args) => {
            const { folder, path: rel, data, encoding, remove } = args as { folder: string; path: string; data?: string; encoding?: "utf8" | "base64"; remove?: boolean };
            try {
                const store = groupStore(folder);
                if (remove) await store.remove(rel, true);
                else await store.write(rel, Buffer.from(data ?? "", encoding === "base64" ? "base64" : "utf8"));
                return json({ ok: true });
            } catch (error) {
                return failure(error);
            }
        },
    );

    tool(
        "sandbox_ipc_projects",
        "List IPC project directories ('<stack>-<instance>') that exist on this Box.",
        {},
        async () => {
            try {
                return json({ projects: await listIpcProjects() });
            } catch (error) {
                return failure(error);
            }
        },
    );

    tool(
        "sandbox_ipc",
        "Batch file operations on a sandbox's IPC directory (the tree mounted at /workspace/ipc). Paths are relative to the project IPC directory. Ops: stat, read (offset/maxBytes, base64 data), write (utf8|base64; atomic|append|exclusive), list, remove, mkdir, rename, prepareRuns.",
        {
            ...ProjectSchema,
            ops: z.array(z.record(z.string(), z.any())).max(500).describe("Operations applied in order; each returns its own result"),
        },
        async (args) => {
            const { ops, ...target } = args as ProjectArgs & { ops: Array<Record<string, unknown>> };
            try {
                const store = await projectIpcStore(target);
                const results: unknown[] = [];
                const batch: IpcOp[] = [];
                const flush = async () => { if (batch.length) results.push(...(await applyIpcOps(store, batch.splice(0)))); };
                for (const op of ops) {
                    if (op.op === "prepareRuns") {
                        await flush();
                        try {
                            results.push({ ok: true, op: "prepareRuns", ...(await prepareRunsDir(store, op.archiveUnwritable === true)) });
                        } catch (error) {
                            results.push({ ok: false, op: "prepareRuns", error: error instanceof Error ? error.message : String(error) });
                        }
                    } else {
                        batch.push(op as unknown as IpcOp);
                    }
                }
                await flush();
                return json({ results });
            } catch (error) {
                return failure(error);
            }
        },
    );

    tool(
        "sandbox_ipc_sync",
        "Replicate one IPC subtree with a caller-side replica. Applies the caller's pushed changes, then returns remote changes relative to the caller's base manifest (append-only resume by byte offset for large files; completion markers only after their data).",
        {
            ...ProjectSchema,
            root: z.string().describe("Subtree relative to the project IPC directory, e.g. 'runs/run-123' or 'sessions'"),
            base: z.record(z.string(), z.tuple([z.number(), z.number().nullable()])).optional().describe("Last agreed state: relative path -> [size, remote mtimeMs|null]"),
            push: z.array(z.object({
                op: z.enum(["write", "remove", "mkdir"]),
                path: z.string(),
                data: z.string().optional(),
                offset: z.number().optional(),
                recursive: z.boolean().optional(),
            })).max(2000).optional().describe("Caller-side changes, applied before the diff (base64 data)"),
            maxBytes: z.number().optional().describe("Byte budget for returned file data"),
            replicaId: z.string().optional().describe("Caller replica id; when the IPC root carries the same marker the trees are shared and nothing is replicated"),
            exclude: z.array(z.string().max(100)).max(50).optional().describe("Additional directory names to skip"),
        },
        async (args) => {
            const { tree, project, name, instance, ...request } = args as ProjectArgs & SyncRequest;
            try {
                const store = await projectIpcStore({ tree, project, name, instance });
                return json(await syncIpcRoot(store, request));
            } catch (error) {
                return failure(error);
            }
        },
    );
}
