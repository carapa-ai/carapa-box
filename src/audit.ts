import fs from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
    timestamp: string;
    tool: string;
    stack: string;
    service: string;
    command: string;
    /** Original caller input when command has been normalized before execution. */
    requested_command?: string;
    projectName: string;
    allowed: boolean;
    reason?: string;
    exitCode?: number;
    /** Name of the OPA policy rule that matched (when using Rego policies). */
    policy_name?: string;
}

/**
 * Resolve the audit log file path.
 * Priority: AUDIT_LOG_PATH env → /var/log/carapabox/ (named volume in container)
 *           → <repo>/generated/audit.jsonl (host dev mode; generated/ is
 *           gitignored so it never dirties the checkout).
 */
export function resolveAuditLogPath(): string {
    if (process.env.AUDIT_LOG_PATH) return process.env.AUDIT_LOG_PATH;
    // In container: named volume at /var/log/carapabox is always writable
    try {
        fs.accessSync("/var/log/carapabox", fs.constants.W_OK);
        return "/var/log/carapabox/audit.jsonl";
    } catch { /* not in container or not writable */ }
    // Host dev mode: gitignored generated/ next to the project, resolved from
    // this module (not cwd). An untracked file elsewhere blocks task merges.
    const dir = path.resolve(import.meta.dir, "..", "generated");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* append will fail quietly */ }
    return path.join(dir, "audit.jsonl");
}

const auditLogPath = resolveAuditLogPath();

/** Maximum audit log size before rotation (50 MB). */
const MAX_AUDIT_LOG_BYTES = 50 * 1024 * 1024;

/**
 * Serializes every append and rotation check through one promise chain so a
 * rename can never race an append, and rotation happens exactly once per
 * threshold crossing.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Rotate the audit log if it exceeds MAX_AUDIT_LOG_BYTES.
 * Keeps one rotated backup (.1). Errors are never thrown.
 */
async function rotateIfNeeded(): Promise<void> {
    try {
        const s = await stat(auditLogPath);
        if (s.size >= MAX_AUDIT_LOG_BYTES) {
            await rename(auditLogPath, auditLogPath + ".1");
        }
    } catch {
        // File doesn't exist yet or stat failed — nothing to rotate.
    }
}

/**
 * Write a single audit log entry as a JSON line.
 * Never throws — failures are silently reported to stderr so they never
 * interrupt the tool execution they are auditing.
 */
export function auditLog(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + "\n";
    queue = queue.then(async () => {
        try {
            await appendFile(auditLogPath, line, { encoding: "utf-8", flag: "a" });
            await rotateIfNeeded();
        } catch (err) {
            process.stderr.write(`[AUDIT] Failed to write audit log to ${auditLogPath}: ${err}\n`);
        }
    });
}

/** Test helper: resolves once all queued audit writes have completed. */
export function flushAudit(): Promise<void> {
    return queue;
}
