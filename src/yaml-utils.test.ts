import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { parseYamlList } from "./yaml-utils.js";
import { filterEnvPassthrough } from "./security.js";

describe("parseYamlList", () => {
    it("strips inline comments and unquotes", () => {
        expect(parseYamlList("k:\n  - LOCAL_REPO   # x\n", "k")).toEqual(["LOCAL_REPO"]);
        expect(parseYamlList('k:\n  - "example.com"  # ok\n', "k")).toEqual(["example.com"]);
        expect(parseYamlList("k:\n  - 'a b'\n", "k")).toEqual(["a b"]);
    });

    it("matches key only at a boundary", () => {
        const doc = "allowed_keys:\n  - K1\nallowed:\n  - A1\n  - A2\n";
        expect(parseYamlList(doc, "allowed")).toEqual(["A1", "A2"]);
        expect(parseYamlList("allowed_keys:\n  - A\n", "allowed")).toEqual([]);
    });

    it("handles CRLF like LF", () => {
        const lf = "k:\n  - a # c\n  - \"b\"\n";
        expect(parseYamlList(lf.replace(/\n/g, "\r\n"), "k")).toEqual(parseYamlList(lf, "k"));
    });

    it("handles flow and block numbers/strings", () => {
        expect(parseYamlList('host_ports: [8080, "9000"]', "host_ports")).toEqual(["8080", "9000"]);
        expect(parseYamlList('host_ports:\n  - 8080\n  - "9000"\n', "host_ports")).toEqual(["8080", "9000"]);
    });

    it("matches yaml.parse for the shipped example", () => {
        const content = fs.readFileSync("config/policies/network-base.example.yaml", "utf8");
        const got = parseYamlList(content, "allowed_domains");
        expect(got.length).toBe(parse(content).allowed_domains.length);
        for (const g of got) expect(/[#\s]/.test(g)).toBe(false);
    });

    it("throws on invalid YAML (fail closed)", () => {
        const tab = "allowed_domains:\n\t- a.com   # c\n\t- \"b.com\"\n";
        expect(() => parse(tab)).toThrow();
        expect(() => parseYamlList(tab, "allowed_domains")).toThrow();
        const dup = "k:\n  - a # c\nk:\n  - b\n";
        expect(() => parse(dup)).toThrow();
        expect(() => parseYamlList(dup, "k")).toThrow();
    });

    it("returns [] for missing key or empty file", () => {
        expect(parseYamlList("other:\n  - a\n", "k")).toEqual([]);
        expect(parseYamlList("", "k")).toEqual([]);
    });

    it("keeps a commented env-passthrough key", async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-utils-"));
        try {
            fs.writeFileSync(path.join(tmp, "env-passthrough.yaml"), "allowed_keys:\n  - LOCAL_REPO   # comment\n");
            expect(await filterEnvPassthrough(tmp, { LOCAL_REPO: "/r", OTHER: "x" })).toEqual({ LOCAL_REPO: "/r" });
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
