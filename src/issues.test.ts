import { describe, expect, test } from "bun:test";
import { buildCurlCommand, issueConfigFor, parseCurlResponse, parseGitRepository } from "./issues.js";

describe("Git repository parsing", () => {
    test.each([
        "https://gitlab.example.com/group/project.git",
        "ssh://git@gitlab.example.com:31022/group/project.git",
        "git@gitlab.example.com:group/project.git",
    ])("derives a GitLab namespace and repository from %s", (gitRepo) => {
        expect(parseGitRepository(gitRepo)).toEqual({
            host: "gitlab.example.com",
            repo: "group/project",
        });
    });

    test("preserves nested GitLab groups", () => {
        expect(parseGitRepository("https://gitlab.example.com/group/subgroup/project.git"))
            .toEqual({ host: "gitlab.example.com", repo: "group/subgroup/project" });
    });
});

describe("issueConfigFor", () => {
    const account = { provider: "gitlab" as const, host: "gitlab.example.com", key: "glpat-test", label: "GitLab (relay client php)" };
    const github = { provider: "github" as const, host: "github.com", key: "ghp-test", label: "GitHub (shared accounts)" };

    test("targets the account's server for a remote on that server", () => {
        expect(issueConfigFor("ssh://git@GitLab.example.com:31022/group/project.git", account))
            .toEqual({ provider: "gitlab", token: "glpat-test", repo: "group/project", apiUrl: "https://gitlab.example.com" });
        expect(issueConfigFor("https://gitlab.example.com/group/project", { ...account, host: "gitlab.example.com:8443" }))
            .toMatchObject({ apiUrl: "https://gitlab.example.com:8443" });
    });

    test("uses GitHub's API host: api.github.com, or /api/v3 on Enterprise", () => {
        expect(issueConfigFor("git@github.com:org/repo.git", github))
            .toEqual({ provider: "github", token: "ghp-test", repo: "org/repo", apiUrl: "https://api.github.com" });
        expect(issueConfigFor("https://ghe.example.com/org/repo.git", { ...github, host: "ghe.example.com" }))
            .toMatchObject({ apiUrl: "https://ghe.example.com/api/v3" });
        expect(issueConfigFor("https://github.com/org/team/repo.git", github))
            .toEqual({ error: expect.stringContaining("owner/repository") });
    });

    test("never sends the token to another server", () => {
        expect(issueConfigFor("https://gitlab.other.example/group/project.git", account))
            .toEqual({ error: expect.stringContaining("not gitlab.other.example") });
        expect(issueConfigFor("https://gitlab.example.com/org/repo.git", github))
            .toEqual({ error: expect.stringContaining("not gitlab.example.com") });
    });

    test("rejects a remote without a namespace", () => {
        expect(issueConfigFor("https://gitlab.example.com/project.git", account))
            .toEqual({ error: expect.stringContaining("namespace/repository") });
    });
});

describe("issue comments", () => {
    test("builds paginated GitLab note and GitHub comment requests", () => {
        expect(buildCurlCommand({
            provider: "github",
            token: "unused",
            repo: "org/repo",
            apiUrl: "https://api.github.com",
        }, { action: "list_comments", issue_number: 42 }))
            .toContain("'https://api.github.com/repos/org/repo/issues/42/comments?page=1&per_page=20'");
        expect(buildCurlCommand({
            provider: "gitlab",
            token: "unused",
            repo: "group/project",
            apiUrl: "https://gitlab.example.com",
        }, { action: "list_comments", issue_number: 42, page: 2, per_page: 50 }))
            .toContain("/issues/42/notes?sort=asc&order_by=created_at&page=2&per_page=50");
    });
});

describe("Git repository shell safety", () => {
    const badChars = ["\"", "$", "`", ";", " ", "("];

    test.each(badChars)("rejects repo segments containing %p in every remote form", (ch) => {
        const encoded = encodeURIComponent(`x${ch}echo`);
        for (const gitRepo of [
            `https://github.com/acme/${encoded}`,
            `ssh://git@github.com/acme/${encoded}`,
            `git@github.com:acme/x${ch}echo`,
            `git@github.com:acme/x${ch}; echo`,
        ]) {
            expect(parseGitRepository(gitRepo)).toEqual({ error: expect.any(String) });
        }
    });

    test.each([
        ["https://github.com/acme/my-repo.git", "acme/my-repo"],
        ["git@github.com:acme/repo_1.git", "acme/repo_1"],
        ["https://gitlab.com/group/sub.group/proj", "sub.group/proj"],
    ])("still parses valid remote %s", (gitRepo, suffix) => {
        const parsed = parseGitRepository(gitRepo);
        expect("error" in parsed).toBe(false);
        expect((parsed as { repo: string }).repo.endsWith(suffix)).toBe(true);
    });

    const actions = [
        { action: "list" },
        { action: "get", issue_number: 1 },
        { action: "list_comments", issue_number: 1 },
    ];

    test.each(actions.flatMap((params) => (["gitlab", "github"] as const).map((provider) => ({ ...params, provider }))))("single-quotes the URL for %o", ({ provider, ...params }) => {
        const apiUrl = provider === "github" ? "https://api.github.com" : "https://gitlab.example.com";
        const cmd = buildCurlCommand({
            provider,
            token: "unused",
            repo: "acme/x'; echo LEAK=$ISSUE_TOKEN; echo '",
            apiUrl,
        }, params as never);
        expect(cmd).toContain(`'${apiUrl}/`);
        // Only the injected quote is escaped; no double-quoted URL remains.
        expect(cmd).not.toMatch(/"https?:\/\//);
        expect(cmd).toContain("'\"'\"'");
        // The injected payload must not appear outside a single-quoted argument.
        const unquoted = cmd.replace(/'(?:[^']|'"'"')*'/g, "''");
        expect(unquoted).not.toContain("LEAK");
    });
});

describe("parseCurlResponse", () => {
    const LIMIT = 4 * 1024 * 1024;

    test("oversize 2xx body is an error, never a JSON prefix", () => {
        const pad = LIMIT + 1 - JSON.stringify([{ d: "" }]).length;
        const json = JSON.stringify([{ d: "x".repeat(pad) }]);
        expect(Buffer.byteLength(json)).toBe(LIMIT + 1);
        const r = parseCurlResponse(`${json}\n200`);
        expect(r.isError).toBe(true);
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain("per_page");
        expect(r.body).toContain(String(LIMIT));
        expect(r.body.startsWith("[")).toBe(false);
    });

    test("~1 MB JSON array is returned unchanged", () => {
        const data = Array.from({ length: 10 }, (_, i) => ({ i, description: "y".repeat(100_000) }));
        const r = parseCurlResponse(`${JSON.stringify(data)}\n200`);
        expect(r.isError).toBe(false);
        expect(JSON.parse(r.body)).toEqual(data);
    });

    test("limit is measured in bytes, not UTF-16 length", () => {
        const body = "€".repeat(Math.floor(LIMIT / 3) + 1);
        expect(body.length).toBeLessThan(LIMIT);
        expect(parseCurlResponse(`${body}\n200`).isError).toBe(true);
    });

    test("missing or invalid status line is an error", () => {
        expect(parseCurlResponse("{}\n000")).toMatchObject({ isError: true, statusCode: 0 });
        expect(parseCurlResponse("garbage")).toMatchObject({ isError: true, statusCode: 0 });
    });

    test("4xx keeps status code", () => {
        expect(parseCurlResponse('{"message":"404 Not Found"}\n404')).toMatchObject({ isError: true, statusCode: 404 });
    });
});
