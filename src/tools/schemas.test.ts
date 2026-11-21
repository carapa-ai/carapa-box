import { describe, expect, test } from "bun:test";
import * as z from "zod";
import { SandboxProxyAliasesSchema, SandboxStartSchema } from "./schemas.js";

const schema = z.object(SandboxProxyAliasesSchema);

describe("sandbox proxy aliases schema", () => {
    test("accepts a bounded alias update", () => {
        expect(schema.safeParse({
            name: "demo-site",
            instance: "demo-site",
            aliases: ["demo-site.ex.test", "demo-site.example.org"],
        }).success).toBe(true);
    });

    test("requires an alias array capped at eight entries", () => {
        expect(schema.safeParse({ name: "demo-site" }).success).toBe(false);
        expect(schema.safeParse({
            name: "demo-site",
            aliases: Array.from({ length: 9 }, (_, index) => `${index}.example.com`),
        }).success).toBe(false);
    });
});

describe("sandbox start schema instance", () => {
    const startSchema = z.object(SandboxStartSchema);

    test("rejects path traversal and separators in instance", () => {
        expect(startSchema.safeParse({ name: "x", instance: "../x" }).success).toBe(false);
        expect(startSchema.safeParse({ name: "x", instance: "a/b" }).success).toBe(false);
    });

    test("rejects an empty instance", () => {
        expect(startSchema.safeParse({ name: "x", instance: "" }).success).toBe(false);
    });

    test("accepts existing instance ids", () => {
        expect(startSchema.safeParse({ name: "x", instance: "carapa-board" }).success).toBe(true);
        expect(startSchema.safeParse({ name: "x", instance: "user_1" }).success).toBe(true);
        expect(startSchema.safeParse({ name: "x" }).success).toBe(true);
    });
});
