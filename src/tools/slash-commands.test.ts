import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLASH_COMMANDS_SCRIPT, parseSlashCommands } from "./slash-commands.js";

const rec = (t: string, n: string, d: string) => `${t}\x1f${n}\x1f${d}\x1e`;

async function run(home: string): Promise<string> {
    const p = Bun.spawn(["sh", "-c", SLASH_COMMANDS_SCRIPT], {
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
}

describe("parseSlashCommands", () => {
    test("keeps special characters, skips malformed", () => {
        const stdout =
            rec("skill", "a", "back\\slash") +
            rec("skill", "b", "Match \\d+ digits") +
            rec("command", "c", "C:\\Users\\me") +
            rec("command", "d", "Deploy\tnow") +
            rec("skill", "e", '"quoted"') +
            rec("skill", "f", "trail\r") +
            "garbage\x1f only two\x1e" +
            rec("other", "g", "bad type") +
            rec("skill", "", "no name");
        const r = parseSlashCommands(stdout);
        expect(r.map((x) => x.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
        expect(r[1].description).toBe("Match \\d+ digits");
        expect(r[3].description).toBe("Deploy\tnow");
        expect(r[4].description).toBe('"quoted"');
        expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    });
});

describe("SLASH_COMMANDS_SCRIPT", () => {
    test("returns all entries", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "slash-"));
        try {
            const skill = (d: string, body: string) => {
                mkdirSync(join(tmp, ".claude/skills", d), { recursive: true });
                writeFileSync(join(tmp, ".claude/skills", d, "SKILL.md"), body);
            };
            skill("good", "---\nname: good\ndescription: Fine\n---\n");
            skill("regex", "---\nname: regex\ndescription: Match \\d+ digits\n---\n");
            skill("winpath", "---\nname: winpath\ndescription: C:\\Users\\me\n---\n");
            skill("crlf", "---\r\nname: crlf-skill\r\ndescription: Windows file\r\n---\r\n");
            mkdirSync(join(tmp, ".claude/commands"), { recursive: true });
            writeFileSync(join(tmp, ".claude/commands/deploy.md"), "---\ndescription: Deploy\tnow\n---\n");
            writeFileSync(join(tmp, ".claude/commands/quoted.md"), '---\nname: quoted\ndescription: Say "x"\n---\n');

            const r = parseSlashCommands(await run(tmp));
            expect(r).toContainEqual({ name: "good", description: "Fine", type: "skill" });
            expect(r).toContainEqual({ name: "regex", description: "Match \\d+ digits", type: "skill" });
            expect(r).toContainEqual({ name: "winpath", description: "C:\\Users\\me", type: "skill" });
            expect(r).toContainEqual({ name: "crlf-skill", description: "Windows file", type: "skill" });
            expect(r).toContainEqual({ name: "deploy", description: "Deploy\tnow", type: "command" });
            expect(r).toContainEqual({ name: "quoted", description: 'Say "x"', type: "command" });
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("empty HOME gives []", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "slash-"));
        try {
            const r = parseSlashCommands(await run(tmp));
            expect(r.filter((x) => x.name === "good")).toEqual([]);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
