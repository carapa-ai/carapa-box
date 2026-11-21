import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VmAssets, type DockerExec } from "./vm-assets.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A fake docker: one image with an id and environment; export and volume copy write what the real ones would. */
function fakeDocker() {
    const calls: string[][] = [];
    const exec: DockerExec = async (argv) => {
        calls.push(argv);
        const [, verb] = argv;
        if (verb === "image") return { code: 0, out: 'sha256:0123456789abcdef0123\n["HOME=/home/ubuntu","PATH=/opt/bun/bin:/usr/bin"]\n' };
        if (verb === "sh" || argv[0] === "sh") { fs.writeFileSync(argv[argv.length - 1], "archive"); return { code: 0, out: "" }; }
        if (verb === "create") return { code: 0, out: "container-1\n" };
        if (verb === "run" && argv.includes("--entrypoint") && argv.includes("cp")) {
            const dst = argv.find(arg => arg.endsWith(":/dst"))!.slice(0, -":/dst".length);
            fs.writeFileSync(path.join(dst, "launch.py"), "copied");
        }
        return { code: 0, out: "" };
    };
    return { exec, calls, has: (...words: string[]) => calls.filter(call => words.every(word => call.includes(word))).length };
}

describe("VM assets", () => {
    it("exports an image once per id and link set, and keeps the image's PATH", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-assets-"));
        dirs.push(dir);
        const docker = fakeDocker();
        const assets = new VmAssets(dir, "docker", docker.exec);

        const first = await assets.image("agent:latest");
        expect(first).toMatchObject({ id: "0123456789abcdef", path: "/opt/bun/bin:/usr/bin" });
        expect(fs.readFileSync(first.rootfs, "utf8")).toBe("archive");
        expect(docker.has("create")).toBe(1);
        expect(docker.has("rm", "container-1")).toBe(1);

        await assets.image("agent:latest");
        expect(docker.has("create")).toBe(1);

        // Links are written by a root container before the export, and a different set is a different archive.
        const linked = await assets.image("agent:latest", { "/opt/carapa-harness/bin": "/opt/carapa-harness-store/bin" });
        expect(linked.rootfs).not.toBe(first.rootfs);
        expect(linked.id).toStartWith("0123456789abcdef-");
        const run = docker.calls.find(call => call[1] === "run" && call.includes("--user"))!;
        expect(run.slice(-3)).toEqual(["sh", "/opt/carapa-harness/bin", "/opt/carapa-harness-store/bin"]);
    });

    it("removes the link container when its docker run fails", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-assets-"));
        dirs.push(dir);
        const docker = fakeDocker();
        const assets = new VmAssets(dir, "docker", async (argv, options) => {
            if (argv[1] === "run" && argv.includes("--user")) { docker.calls.push(argv); return { code: 126, out: "exec: sh: not found" }; }
            return docker.exec(argv, options);
        });
        await expect(assets.image("agent:latest", { "/a": "/b" })).rejects.toThrow("link paths in agent:latest failed");
        const run = docker.calls.find(call => call[1] === "run")!;
        const name = run[run.indexOf("--name") + 1];
        expect(docker.has("rm", name)).toBe(1);
    });

    it("copies a Docker volume to a host directory once", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-assets-"));
        dirs.push(dir);
        const docker = fakeDocker();
        const assets = new VmAssets(dir, "docker", docker.exec);
        const copy = await assets.volume("harness-live-1", "agent:latest");
        expect(fs.readFileSync(path.join(copy, "launch.py"), "utf8")).toBe("copied");
        expect(await assets.volume("harness-live-1", "agent:latest")).toBe(copy);
        expect(docker.has("run", "--entrypoint")).toBe(1);
        await expect(assets.volume("../escape", "agent:latest")).rejects.toThrow("Invalid volume name");
    });
});
