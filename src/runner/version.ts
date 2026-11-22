import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FALLBACK_VERSION = "0.1.0";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Short git commit of the checkout in `cwd`, or the fallback when git fails. */
export function runnerVersion(cwd: string = REPO_ROOT): string {
    try {
        const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return /^[0-9a-f]+$/.test(sha) ? sha : FALLBACK_VERSION;
    } catch {
        return FALLBACK_VERSION;
    }
}
