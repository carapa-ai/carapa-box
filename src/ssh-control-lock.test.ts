import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runs the lock-open lines of the real script against a temp runtime directory.
const script = fs.readFileSync(path.join(import.meta.dir, "../stacks/carapa-bot/bin/ssh-control.sh"), "utf8");
const lockOpen = script.slice(script.indexOf("# lock-open begin"), script.indexOf("# lock-open end"));

function openLock(prepare: (lock: string) => void) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-lock-"));
    try {
        prepare(path.join(runtime, "control.lock"));
        const result = Bun.spawnSync(["bash", "-c", `set -euo pipefail; runtime=$1; ${lockOpen}\nflock -w 10 9; echo reached`, "bash", runtime],
            { timeout: 5000, killSignal: "SIGKILL" });
        return { exitCode: result.exitCode, stdout: result.stdout.toString(), kind: fs.lstatSync(path.join(runtime, "control.lock")).isFile() };
    } finally {
        fs.rmSync(runtime, { recursive: true, force: true });
    }
}

test("ssh-control.sh replaces a FIFO at the lock path instead of blocking on it", () => {
    expect(lockOpen).toContain("control.lock");
    const result = openLock((lock) => { Bun.spawnSync(["mkfifo", lock]); });
    expect(result).toEqual({ exitCode: 0, stdout: "reached\n", kind: true });
});

test("ssh-control.sh replaces a symlinked lock path", () => {
    const result = openLock((lock) => { fs.symlinkSync("/dev/null", lock); });
    expect(result).toEqual({ exitCode: 0, stdout: "reached\n", kind: true });
});
