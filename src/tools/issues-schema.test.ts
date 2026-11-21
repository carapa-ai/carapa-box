import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { registerTools } from "./register.js";

let schema: Record<string, z.ZodTypeAny> | undefined;
let previous: string | undefined;

beforeAll(() => {
    previous = process.env.ENABLE_GIT_ISSUES;
    process.env.ENABLE_GIT_ISSUES = "1";
    const fakeServer = {
        tool: (name: string, _d: string, s: Record<string, z.ZodTypeAny>) => {
            if (name === "sandbox_issues") schema = s;
        },
    };
    registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], false);
});

afterAll(() => {
    if (previous === undefined) delete process.env.ENABLE_GIT_ISSUES;
    else process.env.ENABLE_GIT_ISSUES = previous;
});

describe("sandbox_issues action enum", () => {
    it("accepts exactly list, get and list_comments", () => {
        const action = schema!.action as z.ZodEnum;
        expect(action.options).toEqual(["list", "get", "list_comments"]);
    });

    for (const removed of ["create", "update", "comment", "close", "reopen"]) {
        it(`rejects removed action ${removed}`, () => {
            expect(schema!.action.safeParse(removed).success).toBe(false);
        });
    }

    it("no longer exposes write parameters", () => {
        for (const key of ["title", "body", "labels", "assignees"]) {
            expect(schema).not.toHaveProperty(key);
        }
    });
});
