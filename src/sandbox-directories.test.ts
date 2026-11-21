import { expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareSandboxDirectory } from "./sandbox-directories.js";

const VOLUME_JSON = JSON.stringify([{ Driver: "local", Options: { type: "none", o: "bind", device: "/host" } }]);
const pin = async () => ({ base: "/host", subpath: "projects", volume: "carapa-mount-test" });

test.each(["workspace", "IPC"] as const)("host %s creation preserves existing files and permits new writes", async (purpose) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "carapa-directory-test-"));
    const directory = path.join(root, "test-box");
    try {
        await prepareSandboxDirectory(directory, purpose);
        const before = await fsp.stat(directory);
        await fsp.writeFile(path.join(directory, "existing"), "keep");
        await prepareSandboxDirectory(directory, purpose);
        const after = await fsp.stat(directory);
        expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
        expect(await fsp.readFile(path.join(directory, "existing"), "utf8")).toBe("keep");
        await fsp.mkdir(path.join(directory, "runs"));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test("container directory helper uses the controller identity and propagates permission failures", async () => {
    const directory = "/host/projects/test-box";
    let helperCalls = 0;
    const docker = async (args: string[]) => {
        if (args[0] === "volume") return { status: 0, stdout: args[1] === "inspect" ? VOLUME_JSON : "", stderr: "" };
        helperCalls++;
        expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
        expect(args[args.indexOf("--network") + 1]).toBe("none");
        expect(args[args.indexOf("--mount") + 1]).toBe("type=volume,src=carapa-mount-test,dst=/parent,volume-subpath=projects,volume-nocopy");
        expect(args.join(" ")).not.toContain("type=bind");
        expect(args.at(-1)).toBe("/parent/test-box");
        return { status: 1, stdout: "", stderr: "mkdir: Permission denied" };
    };
    await expect(prepareSandboxDirectory(directory, "workspace", docker, pin)).rejects.toThrow("Permission denied");
    expect(helperCalls).toBe(1);
});

test("container directory helper mounts the parent through a volume subpath, never a bind of the user path", async () => {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: args[1] === "inspect" ? VOLUME_JSON : "", stderr: "" };
    };
    await prepareSandboxDirectory("/host/projects/test-box", "IPC", docker, pin);
    const helper = calls.find((args) => args[0] === "run")!;
    expect(helper.join(" ")).toContain("volume-subpath=projects");
    expect(helper.join(" ")).not.toContain("type=bind");
    expect(helper.join(" ")).not.toContain("/host/projects,");
});

test("container directory helper is never run for a path with a comma", async () => {
    let helperCalls = 0;
    const docker = async () => {
        helperCalls++;
        return { status: 0, stdout: "", stderr: "" };
    };
    await expect(prepareSandboxDirectory("/srv/repos/a,src=/etc/b", "workspace", docker as never)).rejects.toThrow("comma, quote or control character");
    expect(helperCalls).toBe(0);
});

test("container directory helper pins a directory that is itself an allowlist base instead of its parent", async () => {
    const calls: string[][] = [];
    const pinned: string[] = [];
    const docker = async (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: args[1] === "inspect" ? VOLUME_JSON.replace("\"/host\"", "\"/host/home\"") : "", stderr: "" };
    };
    // Only the base itself is allowed; its parent would be rejected.
    const basePin = async (value: string) => {
        pinned.push(value);
        if (value !== "/host/home") throw new Error("[SECURITY] Mount path blocked");
        return { base: "/host/home", subpath: ".", volume: "carapa-mount-test" };
    };
    await prepareSandboxDirectory("/host/home", "workspace", docker, basePin);
    expect(pinned).toEqual(["/host/home"]);
    const helper = calls.find((args) => args[0] === "run")!;
    expect(helper.join(" ")).toContain("volume-subpath=.");
    expect(helper.join(" ")).not.toContain("type=bind");
    expect(helper.at(-1)).toBe("/parent");
    expect(helper.join(" ")).not.toContain("mkdir");
});
