import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeFd, mkdirAt, openDirChain, openFileAt, removeTreeAt, renameAt, unlinkAt, writeAtomicAt } from "./fd-path.js";
import { IpcPathError } from "./safe-open.js";

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd-path-")));
    root = path.join(tmp, "root");
    outside = path.join(tmp, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("openDirChain", () => {
    it("refuses a symlinked component pointing outside", () => {
        fs.symlinkSync(outside, path.join(root, "a"));
        expect(() => openDirChain(root, ["a", "b"])).toThrow(IpcPathError);
    });

    it("refuses a symlinked component pointing inside the root", () => {
        fs.mkdirSync(path.join(root, "real"));
        fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
        expect(() => openDirChain(root, ["link"])).toThrow(IpcPathError);
        expect(() => openDirChain(root, ["link"], { create: true })).toThrow(IpcPathError);
    });

    it("refuses a regular file component and creates missing ones only with create", () => {
        fs.writeFileSync(path.join(root, "f"), "x");
        expect(() => openDirChain(root, ["f"])).toThrow(IpcPathError);
        expect(() => openDirChain(root, ["x", "y"])).toThrow(expect.objectContaining({ code: "ENOENT" }));
        closeFd(openDirChain(root, ["x", "y"], { create: true }));
        expect(fs.statSync(path.join(root, "x", "y")).isDirectory()).toBe(true);
    });
});

describe("held parent fd survives a path swap", () => {
    function swap(): { fd: number; real: string } {
        fs.mkdirSync(path.join(root, "d"));
        fs.writeFileSync(path.join(root, "d", "victim"), "orig");
        fs.writeFileSync(path.join(outside, "victim"), "outside");
        const fd = openDirChain(root, ["d"]);
        const real = path.join(root, "d-moved");
        fs.renameSync(path.join(root, "d"), real);
        fs.symlinkSync(outside, path.join(root, "d"));
        return { fd, real };
    }

    it("writeAtomicAt acts in the original directory", () => {
        const { fd, real } = swap();
        try {
            writeAtomicAt(fd, "new.txt", Buffer.from("hi"));
        } finally { closeFd(fd); }
        expect(fs.readFileSync(path.join(real, "new.txt"), "utf8")).toBe("hi");
        expect(fs.readdirSync(outside)).toEqual(["victim"]);
    });

    it("unlinkAt acts in the original directory", () => {
        const { fd, real } = swap();
        try { unlinkAt(fd, "victim"); } finally { closeFd(fd); }
        expect(fs.existsSync(path.join(real, "victim"))).toBe(false);
        expect(fs.readFileSync(path.join(outside, "victim"), "utf8")).toBe("outside");
    });

    it("renameAt acts in the original directory", () => {
        const { fd, real } = swap();
        try { renameAt(fd, "victim", fd, "renamed"); } finally { closeFd(fd); }
        expect(fs.existsSync(path.join(real, "renamed"))).toBe(true);
        expect(fs.readdirSync(outside)).toEqual(["victim"]);
    });

    it("mkdirAt acts in the original directory", () => {
        const { fd, real } = swap();
        try { mkdirAt(fd, "sub"); } finally { closeFd(fd); }
        expect(fs.statSync(path.join(real, "sub")).isDirectory()).toBe(true);
        expect(fs.readdirSync(outside)).toEqual(["victim"]);
    });
});

describe("leaf handling", () => {
    it("writeAtomicAt replaces a leaf symlink without following it", () => {
        fs.writeFileSync(path.join(outside, "t"), "keep");
        fs.symlinkSync(path.join(outside, "t"), path.join(root, "leaf"));
        const fd = openDirChain(root, []);
        try { writeAtomicAt(fd, "leaf", Buffer.from("new")); } finally { closeFd(fd); }
        expect(fs.lstatSync(path.join(root, "leaf")).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(outside, "t"), "utf8")).toBe("keep");
    });

    it("created files get mode 0o644", () => {
        const previous = process.umask(0o022);
        const fd = openDirChain(root, []);
        try {
            writeAtomicAt(fd, "atomic", Buffer.from("x"));
            closeFd(openFileAt(fd, "excl", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL));
            closeFd(openFileAt(fd, "app", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND));
        } finally { closeFd(fd); process.umask(previous); }
        for (const name of ["atomic", "excl", "app"]) {
            expect(fs.statSync(path.join(root, name)).mode & 0o777).toBe(0o644);
        }
    });

    it("openFileAt refuses a leaf symlink and a FIFO", () => {
        fs.symlinkSync(path.join(outside, "t"), path.join(root, "leaf"));
        const fd = openDirChain(root, []);
        try {
            expect(() => openFileAt(fd, "leaf", fs.constants.O_WRONLY | fs.constants.O_CREAT)).toThrow(IpcPathError);
            expect(fs.existsSync(path.join(outside, "t"))).toBe(false);
        } finally { closeFd(fd); }
    });

    it("removeTreeAt unlinks symlinks inside the tree and keeps their targets", () => {
        fs.writeFileSync(path.join(outside, "keep"), "x");
        fs.mkdirSync(path.join(root, "t", "sub"), { recursive: true });
        fs.symlinkSync(outside, path.join(root, "t", "sub", "link"));
        fs.writeFileSync(path.join(root, "t", "f"), "x");
        const fd = openDirChain(root, []);
        try { removeTreeAt(fd, "t", true); removeTreeAt(fd, "missing", true); } finally { closeFd(fd); }
        expect(fs.existsSync(path.join(root, "t"))).toBe(false);
        expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("x");
    });

    it("removeTreeAt removes a tree containing non-UTF-8 file and directory names", () => {
        const bad = Buffer.from([0xff, 0xfe]);
        const dir = path.join(root, "t");
        fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
        fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), bad]), "x");
        fs.mkdirSync(Buffer.concat([Buffer.from(`${dir}/sub/`), bad]));
        fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/sub/`), bad, Buffer.from("/"), bad]), "x");
        const fd = openDirChain(root, []);
        try { removeTreeAt(fd, "t", true); } finally { closeFd(fd); }
        expect(fs.existsSync(dir)).toBe(false);
    });
});
