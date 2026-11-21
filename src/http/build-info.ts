import fs from "node:fs";
import path from "node:path";

export interface BuildInfo {
    version: string;
    buildTime: string | null;
    startedAt: string;
}

/** Nearest ancestor of `from` holding a package.json (the app root), independent of cwd. */
export function findAppRoot(from: string = import.meta.dir): string {
    let dir = from;
    for (;;) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return from;
        dir = parent;
    }
}

function readTrimmed(file: string): string | null {
    try {
        return fs.readFileSync(file, "utf8").trim() || null;
    } catch {
        return null;
    }
}

/** Reads VERSION / BUILD_TIME stamped at image build time; missing files fall back to dev values. */
export function readBuildInfo(root: string = findAppRoot(), startedAt: string = new Date().toISOString()): BuildInfo {
    return {
        version: readTrimmed(path.join(root, "VERSION")) ?? "development",
        buildTime: readTrimmed(path.join(root, "BUILD_TIME")),
        startedAt,
    };
}
