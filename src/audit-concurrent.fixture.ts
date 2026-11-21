// Child-process fixture for audit.test.ts: fires 20 concurrent auditLog calls.
// Run in its own process so AUDIT_LOG_PATH is read fresh at import time.
import { auditLog, flushAudit } from "./audit.js";

for (let i = 0; i < 20; i++) {
    auditLog({
        timestamp: new Date().toISOString(),
        tool: "t",
        stack: "s",
        service: "svc",
        command: `cmd-${i}`,
        projectName: "p",
        allowed: true,
    });
}
await flushAudit();
