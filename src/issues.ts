import { shellQuote } from "./utils.js";
// @ts-ignore -- shared with the standalone relay
import { githubApi } from "../egress-proxy/api-relay/provider-account-config.mjs";

export type IssueProvider = "gitlab" | "github";

export interface IssueConfig {
    provider: IssueProvider;
    token: string;
    repo: string;
    apiUrl: string;
}

export interface IssueParams {
    action: "list" | "get" | "list_comments";
    issue_number?: number;
    state?: string;
    page?: number;
    per_page?: number;
}

interface GitRepository {
    host: string;
    repo: string;
}

/** Parse an HTTPS, ssh://, or SCP-style Git remote into a canonical identity. */
export function parseGitRepository(gitRepo: string): GitRepository | { error: string } {
    const value = gitRepo.trim();
    let host: string;
    let repoPath: string;

    try {
        const scpMatch = value.match(/^[^/@:\s]+@([^/:\s]+):(.+)$/);
        if (scpMatch) {
            host = scpMatch[1];
            repoPath = scpMatch[2];
        } else {
            const parsed = new URL(value);
            if (!parsed.hostname || !["http:", "https:", "ssh:"].includes(parsed.protocol)) {
                return { error: `Unsupported GIT_REPO URL: ${gitRepo}` };
            }
            host = parsed.hostname;
            repoPath = parsed.pathname;
        }
        repoPath = decodeURIComponent(repoPath);
    } catch {
        return { error: `GIT_REPO must be an HTTPS or SSH Git remote URL (got: ${gitRepo})` };
    }

    repoPath = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    const segments = repoPath.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) {
        return { error: `GIT_REPO contains an invalid repository path: ${gitRepo}` };
    }
    return { host: host.toLowerCase(), repo: segments.join("/") };
}

/**
 * The issue API target for a Git remote, using a Provider accounts GitLab or
 * GitHub account. The account's server must be the remote's server: a token
 * is never sent to another host.
 */
export function issueConfigFor(
    gitRepo: string,
    account: { provider: IssueProvider; host: string; key: string; label: string },
): IssueConfig | { error: string } {
    const repository = parseGitRepository(gitRepo);
    if ("error" in repository) return repository;
    const segments = repository.repo.split("/").length;
    if (account.provider === "github" && segments !== 2) {
        return { error: `GitHub GIT_REPO must identify owner/repository (got: ${gitRepo})` };
    }
    if (account.provider === "gitlab" && segments < 2) {
        return { error: `GitLab GIT_REPO must identify namespace/repository (got: ${gitRepo})` };
    }
    // The account host may carry a port; a Git remote's SSH port says nothing about the web server.
    const accountHost = account.host.toLowerCase();
    if (accountHost.split(":")[0] !== repository.host) {
        return { error: `Account ${account.label} is for ${accountHost}, not ${repository.host}` };
    }
    const api = account.provider === "github" ? githubApi(accountHost) : { host: accountHost, pathPrefix: "" };
    return { provider: account.provider, token: account.key, repo: repository.repo, apiUrl: `https://${api.host}${api.pathPrefix}` };
}

/**
 * Validate that required parameters are present for a given action.
 */
export function validateParams(params: IssueParams): string | null {
    const { action, issue_number } = params;

    if (["get", "list_comments"].includes(action) && !issue_number) {
        return `issue_number is required for action "${action}"`;
    }
    return null;
}

function addPaginationParams(query: URLSearchParams, params: IssueParams): void {
    query.set("page", String(params.page || 1));
    query.set("per_page", String(params.per_page || 20));
}

function curlGet(headers: string, url: string): string {
    return `curl -s -w '\\n%{http_code}' ${headers} ${shellQuote(url)}`;
}

/**
 * Build a shell command string that uses curl to call the GitLab or GitHub API.
 * The token is referenced as $ISSUE_TOKEN (passed via docker --env-file).
 */
export function buildCurlCommand(config: IssueConfig, params: IssueParams): string {
    return config.provider === "github" ? buildGitHubCurl(config, params) : buildGitLabCurl(config, params);
}

// --- GitHub ---

function buildGitHubCurl(config: IssueConfig, params: IssueParams): string {
    const base = `${config.apiUrl}/repos/${config.repo}`;
    const headers = `-H "Authorization: Bearer $ISSUE_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"`;
    const state = (s?: string) => (s === "closed" || s === "all" ? s : "open");

    switch (params.action) {
        case "list": {
            // GitHub lists pull requests as issues too; the caller skips them.
            const qs = new URLSearchParams();
            qs.set("state", state(params.state));
            addPaginationParams(qs, params);
            return curlGet(headers, `${base}/issues?${qs.toString()}`);
        }
        case "get":
            return curlGet(headers, `${base}/issues/${params.issue_number}`);

        case "list_comments": {
            const qs = new URLSearchParams();
            addPaginationParams(qs, params);
            return curlGet(headers, `${base}/issues/${params.issue_number}/comments?${qs.toString()}`);
        }
    }
}

// --- GitLab ---

function buildGitLabCurl(config: IssueConfig, params: IssueParams): string {
    const encodedRepo = encodeURIComponent(config.repo);
    const base = `${config.apiUrl}/api/v4/projects/${encodedRepo}`;
    const headers = `-H "PRIVATE-TOKEN: $ISSUE_TOKEN" -H "Content-Type: application/json"`;

    // GitLab uses different state names for filtering
    const mapState = (s?: string) => (s === "closed" || s === "all" ? s : "opened");

    switch (params.action) {
        case "list": {
            const qs = new URLSearchParams();
            qs.set("state", mapState(params.state));
            addPaginationParams(qs, params);
            return curlGet(headers, `${base}/issues?${qs.toString()}`);
        }
        case "get":
            return curlGet(headers, `${base}/issues/${params.issue_number}`);

        case "list_comments": {
            const qs = new URLSearchParams();
            qs.set("sort", "asc");
            qs.set("order_by", "created_at");
            addPaginationParams(qs, params);
            return curlGet(headers, `${base}/issues/${params.issue_number}/notes?${qs.toString()}`);
        }

    }
}

// --- Helpers ---

const MAX_RESPONSE_SIZE = 4 * 1024 * 1024; // 4MB (bytes)

/**
 * Parse curl output that ends with HTTP status code (from -w '\n%{http_code}').
 * Returns { body, statusCode, isError }.
 */
export function parseCurlResponse(output: string): { body: string; statusCode: number; isError: boolean } {
    const lines = output.trimEnd().split("\n");
    const lastLine = lines[lines.length - 1];
    const statusCode = parseInt(lastLine, 10);

    if (isNaN(statusCode) || statusCode < 100 || statusCode > 599) {
        return { body: output, statusCode: 0, isError: true };
    }

    const body = lines.slice(0, -1).join("\n");

    if (Buffer.byteLength(body) > MAX_RESPONSE_SIZE) {
        return {
            body: `response exceeds ${MAX_RESPONSE_SIZE} bytes; request a smaller per_page`,
            statusCode,
            isError: true,
        };
    }

    return {
        body,
        statusCode,
        isError: statusCode >= 400,
    };
}
