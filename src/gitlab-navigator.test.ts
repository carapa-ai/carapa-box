import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", ".claude", "skills", "gitlab-navigator", "scripts", "main.ts");

let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      const json = (body: unknown, status = 200) => Response.json(body, { status });
      if (url.pathname === "/api/v4/user") return json({ username: "alice", name: "Alice" });
      if (url.pathname === "/api/v4/version") return json({ message: "403 Forbidden" }, 403);
      if (url.pathname === "/api/v4/projects") return json([]);
      // GET /groups list entries carry no projects/subgroups arrays.
      if (url.pathname === "/api/v4/groups") {
        return json([{ full_path: "team", visibility: "private", web_url: "http://gitlab/groups/team" }]);
      }
      if (url.pathname === "/api/v4/merge_requests") {
        // Older GitLab rejects reviewer_username with 400; the unfiltered query works.
        if (url.searchParams.has("reviewer_username")) return json({ error: "bad param" }, 400);
        return json([{ iid: 7, state: "opened", title: "Fallback MR", author: { username: "bob" } }]);
      }
      if (url.pathname === "/api/v4/projects/p/repository/files/a.txt") {
        return json({
          file_path: "a.txt",
          size: 12,
          ref: "main",
          last_commit_id: "abcdef123456",
          encoding: "base64",
          content: Buffer.from("héllo ✓").toString("base64"),
        });
      }
      return json({ message: "404 Not Found" }, 404);
    },
  });
});

afterAll(() => server.stop(true));

async function run(...args: string[]) {
  requests = [];
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: { GITLAB_API_URL: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("gitlab-navigator HTTP errors", () => {
  test("mr-review falls back to the unfiltered query when the reviewer filter is rejected", async () => {
    const r = await run("mr-review");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Fallback MR");
    expect(requests.filter((p) => p.startsWith("/api/v4/merge_requests"))).toHaveLength(2);
  });

  test("test reports an unknown version when /version fails", async () => {
    const r = await run("test");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("GitLab version: unknown");
    expect(r.stdout).toContain("Connection OK.");
  });
});

describe("gitlab-navigator file", () => {
  test("decodes base64 content as UTF-8", async () => {
    const r = await run("file", "p", "a.txt");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("héllo ✓");
  });
});

describe("gitlab-navigator groups", () => {
  test("does not print project/subgroup counts the list endpoint cannot provide", async () => {
    const r = await run("groups");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("team");
    expect(r.stdout).toContain("Visibility: private");
    expect(r.stdout).not.toMatch(/Projects: \d|Subgroups: \d/);
  });
});
