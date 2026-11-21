import { describe, expect, it } from "bun:test";
import { bindHostError, isLoopbackHost, resolveBindHost } from "./bind.js";

describe("bind policy", () => {
    it("defaults to loopback", () => {
        expect(resolveBindHost([], {})).toBe("127.0.0.1");
        expect(resolveBindHost([], { MCP_SANDBOX_HOST: "0.0.0.0" })).toBe("0.0.0.0");
        expect(resolveBindHost(["--host=::1"], { MCP_SANDBOX_HOST: "0.0.0.0" })).toBe("::1");
    });

    it("recognises loopback hosts", () => {
        for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
        for (const host of ["0.0.0.0", "::", "192.168.1.5", "box.local"]) expect(isLoopbackHost(host)).toBe(false);
    });

    it("refuses non-loopback binds without an API token", () => {
        expect(bindHostError("127.0.0.1", undefined)).toBeNull();
        expect(bindHostError("0.0.0.0", "secret")).toBeNull();
        expect(bindHostError("0.0.0.0", undefined)).toContain("CARAPA_BOX_API_TOKEN");
        expect(bindHostError("0.0.0.0", "")).toContain("CARAPA_BOX_API_TOKEN");
    });
});
