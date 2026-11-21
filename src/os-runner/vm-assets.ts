/**
 * What an OpenShell microVM sandbox is built from. The VM driver boots a root
 * filesystem archive, not a Docker image, and mounts host directories, not Docker
 * volumes. So the runner turns the Docker image it is configured with into a rootfs
 * archive (once per image id) and copies a Docker volume the sandbox needs (the harness
 * volume) into a host directory (once per volume name, which changes with each release).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

export interface VmImage {
    /** Short image id: the archive and the sandbox's spec digest follow it. */
    id: string;
    /** Rootfs archive for `openshell sandbox create --from`. */
    rootfs: string;
    /** The image's PATH: a rootfs archive carries no image environment. */
    path: string;
}

export interface DockerResult { code: number; out: string }
/** Runs a program (docker, sh); injected by tests. */
export type DockerExec = (argv: string[], options?: { timeoutMs?: number }) => Promise<DockerResult>;

/** Default executor for the docker and openshell CLIs. */
export const spawnExec: DockerExec = (argv, options) => new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    const timer = options?.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
    child.on("error", error => { if (timer) clearTimeout(timer); resolve({ code: 127, out: String(error) }); });
    child.on("close", code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 137, out }); });
});

const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export class VmAssets {
    private readonly images = new Map<string, Promise<VmImage>>();
    private readonly volumes = new Map<string, Promise<string>>();

    constructor(private readonly dir: string, private readonly docker: string = "docker", private readonly exec: DockerExec = spawnExec) {}

    private async run(argv: string[], what: string, timeoutMs = 120_000): Promise<string> {
        const result = await this.exec([this.docker, ...argv], { timeoutMs });
        if (result.code !== 0) throw new Error(`docker ${what} failed (${result.code}): ${result.out.trim().slice(-400)}`);
        return result.out;
    }

    /**
     * The rootfs archive of a Docker image, exported when the image id (and `links`) has no archive yet.
     * `links` (guest path -> target) are symlinks written into the archive: a VM mounts few directories,
     * so paths the image expects (a harness volume's bin dir) point into the ones it does mount.
     */
    image(ref: string, links: Record<string, string> = {}): Promise<VmImage> {
        const key = `${ref}\0${JSON.stringify(links)}`;
        let pending = this.images.get(key);
        if (!pending) {
            pending = this.exportImage(ref, links);
            this.images.set(key, pending);
            // Only concurrent callers share an export: a later call sees a newer image under the same tag.
            void pending.finally(() => this.images.delete(key)).catch(() => undefined);
        }
        return pending;
    }

    private async exportImage(ref: string, links: Record<string, string>): Promise<VmImage> {
        const inspected = (await this.run(["image", "inspect", "--format", "{{.Id}}\n{{json .Config.Env}}", ref], `image inspect ${ref}`)).trim().split("\n");
        const imageId = (inspected[0] ?? "").replace(/^sha256:/, "").slice(0, 16);
        if (!/^[0-9a-f]{16}$/.test(imageId)) throw new Error(`docker image inspect ${ref} returned no image id`);
        const entries = Object.entries(links);
        const id = entries.length ? `${imageId}-${createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 8)}` : imageId;
        let imagePath = FALLBACK_PATH;
        try {
            const env = JSON.parse(inspected[1] ?? "[]") as string[];
            imagePath = env.find(entry => entry.startsWith("PATH="))?.slice("PATH=".length) || FALLBACK_PATH;
        } catch { /* keep the fallback */ }

        const rootfs = path.join(this.dir, "rootfs", `${id}.tar.gz`);
        if (!fs.existsSync(rootfs)) {
            fs.mkdirSync(path.dirname(rootfs), { recursive: true, mode: 0o700 });
            logger.info({ image: ref, id }, "[runner] exporting image as a VM rootfs");
            let container: string | null = null;
            const partial = `${rootfs}.partial`;
            try {
                if (entries.length) {
                    // A short root container writes the links; the stopped container is what gets exported.
                    // The name is set before `docker run`, so a failed run (created, exited non-zero) is removed below too.
                    container = `os-runner-vm-${randomBytes(4).toString("hex")}`;
                    const script = 'while [ "$#" -gt 1 ]; do rm -rf "$1"; mkdir -p "$(dirname "$1")"; ln -s "$2" "$1"; shift 2; done';
                    await this.run(["run", "--user", "0", "--name", container, "--entrypoint", "sh", ref, "-c", script, "sh", ...entries.flat()], `link paths in ${ref}`);
                } else {
                    container = (await this.run(["create", ref], `create ${ref}`)).trim();
                }
                const piped = await this.exec(["sh", "-c", '"$1" export "$2" | gzip -1 > "$3"', "sh", this.docker, container, partial], { timeoutMs: 900_000 });
                if (piped.code !== 0) throw new Error(`docker export ${ref} failed (${piped.code}): ${piped.out.trim().slice(-300)}`);
                fs.renameSync(partial, rootfs);
            } finally {
                fs.rmSync(partial, { force: true });
                if (container) await this.exec([this.docker, "rm", container]);
            }
        }
        return { id, rootfs, path: imagePath };
    }

    /** A host directory holding the content of a Docker volume, copied once per volume name. */
    volume(name: string, helperImage: string): Promise<string> {
        let pending = this.volumes.get(name);
        if (!pending) {
            pending = this.copyVolume(name, helperImage);
            this.volumes.set(name, pending);
            pending.catch(() => this.volumes.delete(name));
        }
        return pending;
    }

    private async copyVolume(name: string, helperImage: string): Promise<string> {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Invalid volume name: ${name}`);
        const target = path.join(this.dir, "volumes", name);
        if (fs.existsSync(target)) return target;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const partial = `${target}.partial`;
        fs.rmSync(partial, { recursive: true, force: true });
        fs.mkdirSync(partial, { mode: 0o700 });
        logger.info({ volume: name }, "[runner] copying a Docker volume for the VM sandbox");
        // The helper image's own user reads the volume and writes the copy, so the files stay owned by the same uid.
        await this.run(["run", "--rm", "--entrypoint", "cp", "-v", `${name}:/src:ro`, "-v", `${partial}:/dst`, helperImage, "-a", "/src/.", "/dst/"], `copy volume ${name}`, 1_800_000);
        fs.renameSync(partial, target);
        return target;
    }
}
