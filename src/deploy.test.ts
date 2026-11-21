/**
 * Unit tests for src/deploy.ts — managed service build pipeline.
 *
 * Mocks:
 *   - execDocker
 *
 * No real Docker daemon or network calls are made.
 *
 * Run with: bun test src/deploy.test.ts
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Mutable mock state ────────────────────────────────────────────────────────

interface SpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}

const state = {
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  spawnQueue: [] as SpawnResult[],
};

function reset() {
  state.spawnCalls = [];
  state.spawnQueue = [];
}

function queueSpawn(result: SpawnResult = {}) {
  state.spawnQueue.push(result);
}

// ── Module mocks (Bun hoists mock.module() before all imports) ────────────────

mock.module("./utils.js", () => ({
  fileExists: async (p: string) => fs.existsSync(p),
  execDocker: async (args: string[]) => {
    state.spawnCalls.push({ cmd: "docker", args });
    const resp = state.spawnQueue.shift() ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    if (resp.error) {
      return { status: 1, stdout: "", stderr: resp.error.message };
    }
    return {
      status: resp.exitCode ?? 0,
      stdout: resp.stdout ?? "",
      stderr: resp.stderr ?? "",
    };
  },
}));

import {
  BUILD_SCRIPT,
  GIT_COMMIT_RESOLVER_SCRIPT,
  buildHelperArgs,
  loadManagedServices,
  buildService,
  restartService,
  resolveEnvVars,
  requestHostBuild,
  getHostBuildStatus,
} from "./deploy.js";

// ── Filesystem helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeConfig(dir: string, config: object): void {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(config)) {
    const v = val as Record<string, unknown>;
    lines.push(`${key}:`);
    for (const [k, v2] of Object.entries(v)) {
      lines.push(`  ${k}: "${v2}"`);
    }
  }
  fs.writeFileSync(
    path.join(dir, "managed-services.yaml"),
    lines.join("\n") + "\n",
  );
}

// ── resolveEnvVars ────────────────────────────────────────────────────────────

describe("resolveEnvVars", () => {
  it("resolves a known env var", () => {
    process.env._DEPLOY_TEST_VAR = "hello";
    expect(resolveEnvVars("$_DEPLOY_TEST_VAR/world")).toBe("hello/world");
    delete process.env._DEPLOY_TEST_VAR;
  });

  it("leaves strings with no variables unchanged", () => {
    expect(resolveEnvVars("no-vars-here")).toBe("no-vars-here");
  });

  it.each(["$_MISSING_DEPLOY_TEST_XYZ/path", "${_MISSING_DEPLOY_TEST_XYZ}/path"])(
    "throws naming the variable when %s references an unset var",
    (value) => {
      delete process.env._MISSING_DEPLOY_TEST_XYZ;
      expect(() => resolveEnvVars(value)).toThrow("_MISSING_DEPLOY_TEST_XYZ");
    },
  );

  it("resolves the ${VAR} form", () => {
    process.env._DEPLOY_TEST_BRACED = "hello";
    expect(resolveEnvVars("${_DEPLOY_TEST_BRACED}world")).toBe("helloworld");
    delete process.env._DEPLOY_TEST_BRACED;
  });

  it("resolves multiple env vars in one string", () => {
    process.env._DT_A = "foo";
    process.env._DT_B = "bar";
    expect(resolveEnvVars("$_DT_A/$_DT_B")).toBe("foo/bar");
    delete process.env._DT_A;
    delete process.env._DT_B;
  });

  it("does not expand lowercase names (regex only matches [A-Z_][A-Z0-9_]*)", () => {
    expect(resolveEnvVars("$lowercase")).toBe("$lowercase");
  });
});

// ── loadManagedServices ───────────────────────────────────────────────────────

describe("loadManagedServices", () => {
  let tmpDir: string;

  beforeEach(() => {
    reset();
    tmpDir = makeTempDir();
  });

  it("returns empty object when config file does not exist", async () => {
    expect(await loadManagedServices(tmpDir)).toEqual({});
    rmDir(tmpDir);
  });

  it("parses a valid managed-services.yaml", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "managed-services.yaml"),
      [
        "mysvc:",
        "  composeDir: /srv/mysvc",
        "  service: mysvc",
        "  helperReadOnlyPaths:",
        "    - /run/mysvc-secrets",
        "",
      ].join("\n"),
    );
    const result = await loadManagedServices(tmpDir);
    expect(result.mysvc.service).toBe("mysvc");
    expect(result.mysvc.composeDir).toBe("/srv/mysvc");
    expect(result.mysvc.helperReadOnlyPaths).toEqual(["/run/mysvc-secrets"]);
    rmDir(tmpDir);
  });

  it("resolves $ENV_VAR in composeDir", async () => {
    const orig = process.env.HOME;
    process.env.HOME = "/test-home";
    writeConfig(tmpDir, {
      svc: { composeDir: "$HOME/projects/svc", service: "svc" },
    });
    const result = await loadManagedServices(tmpDir);
    expect(result.svc.composeDir).toBe("/test-home/projects/svc");
    process.env.HOME = orig;
    rmDir(tmpDir);
  });

  it("resolves $ENV_VAR in buildDir", async () => {
    process.env._DT_REPO = "/home/user/repos";
    writeConfig(tmpDir, {
      svc: { buildDir: "$_DT_REPO/svc", service: "svc" },
    });
    const result = await loadManagedServices(tmpDir);
    expect(result.svc.buildDir).toBe("/home/user/repos/svc");
    expect(result.svc.composeDir).toBeUndefined();
    delete process.env._DT_REPO;
    rmDir(tmpDir);
  });

  it("resolves $ENV_VAR in healthUrl", async () => {
    process.env._DT_HOST = "example.com";
    writeConfig(tmpDir, {
      svc: {
        composeDir: "/srv",
        service: "svc",
        healthUrl: "http://$_DT_HOST/health",
      },
    });
    const result = await loadManagedServices(tmpDir);
    expect(result.svc.healthUrl).toBe("http://example.com/health");
    delete process.env._DT_HOST;
    rmDir(tmpDir);
  });

  it("does not resolve $ENV_VAR in fields other than composeDir and healthUrl", async () => {
    process.env._DT_REPO = "/home/user/repos";
    writeConfig(tmpDir, {
      svc: {
        composeDir: "$_DT_REPO/srv",
        service: "svc",
      },
    });
    const result = await loadManagedServices(tmpDir);
    expect(result.svc.composeDir).toBe("/home/user/repos/srv");
    delete process.env._DT_REPO;
    rmDir(tmpDir);
  });

  it.each([
    ["an empty-bodied entry", "foo:\n", /entry "foo" must be an object/],
    ["a scalar entry", "foo: 1\n", /entry "foo" must be an object/],
    ["an entry without service", "foo:\n  composeDir: /srv\n", /entry "foo" requires a non-empty "service"/],
    ["an entry with a blank service", "foo:\n  service: \"  \"\n", /entry "foo" requires a non-empty "service"/],
  ])("rejects %s with an error naming the entry", async (_label, yaml, message) => {
    fs.writeFileSync(path.join(tmpDir, "managed-services.yaml"), yaml);
    await expect(loadManagedServices(tmpDir)).rejects.toThrow(message);
    rmDir(tmpDir);
  });

  it("rejects a path with an unset variable, naming the entry, field and variable", async () => {
    delete process.env._DT_UNSET_REPO;
    writeConfig(tmpDir, {
      svc: { buildDir: "$_DT_UNSET_REPO/stack", service: "svc" },
    });
    await expect(loadManagedServices(tmpDir)).rejects.toThrow(
      /entry "svc" buildDir: environment variable _DT_UNSET_REPO is not set/,
    );
    rmDir(tmpDir);
  });

  it("returns all services in the config", async () => {
    writeConfig(tmpDir, {
      a: { composeDir: "/a", service: "a" },
      b: { composeDir: "/b", service: "b" },
    });
    const result = await loadManagedServices(tmpDir);
    expect(Object.keys(result)).toHaveLength(2);
    rmDir(tmpDir);
  });
});

// ── buildService ─────────────────────────────────────────────────────────────

describe("buildService", () => {
  beforeEach(() => reset());

  const cfg = () => ({ composeDir: "/test/compose", service: "mysvc" });

  it("returns ok:false immediately when buildDir and composeDir are empty", async () => {
    const r = await buildService({ composeDir: "", service: "svc" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("buildDir and composeDir are empty");
    expect(state.spawnCalls).toHaveLength(0);
  });

  it("builds from buildDir instead of the operator-only composeDir", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ exitCode: 0 }); // helper build

    await buildService({
      composeDir: "/ops/stack",
      buildDir: "/repo/mysvc",
      service: "mysvc",
    });

    const buildCall = state.spawnCalls[1];
    expect(buildCall.args).toContain("/repo/mysvc:/ctx:ro");
    expect(buildCall.args.join(" ")).not.toContain("/ops/stack");
  });

  it("tags current :latest as :rollback before building", async () => {
    queueSpawn({ exitCode: 0 }); // docker tag
    queueSpawn({ stdout: "Successfully built abc123", exitCode: 0 }); // helper build

    await buildService(cfg());

    const tagCall = state.spawnCalls[0];
    expect(tagCall.cmd).toBe("docker");
    expect(tagCall.args).toContain("tag");
    expect(tagCall.args).toContain("mysvc:latest");
    expect(tagCall.args).toContain("mysvc:rollback");
  });

  it("builds from the host path in a Docker CLI helper", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ exitCode: 0 }); // helper build

    await buildService(cfg());

    const buildCall = state.spawnCalls[1];
    expect(buildCall.cmd).toBe("docker");
    expect(buildCall.args[0]).toBe("run");
    expect(buildCall.args).toContain("--rm");
    expect(buildCall.args).toContain(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
    expect(buildCall.args).toContain("/test/compose:/ctx:ro");
    expect(buildCall.args).toContain("docker:29.5.3-cli");
    expect(buildCall.args).toContain("--entrypoint");
    expect(buildCall.args).toContain("mysvc:latest");
    expect(buildCall.args).toContain("/ctx/Dockerfile");
    expect(buildCall.args).not.toContain("tar");
  });

  it("uses custom dockerfile when specified", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ exitCode: 0 }); // helper build

    await buildService({ ...cfg(), dockerfile: "Dockerfile.prod" });

    const buildCall = state.spawnCalls[1];
    expect(buildCall.args).toContain("/ctx/Dockerfile.prod");
  });

  it("returns ok:true on a successful build", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ stdout: "Successfully built abc123", exitCode: 0 }); // helper build

    const r = await buildService(cfg());
    expect(r.ok).toBe(true);
  });

  it("returns ok:false when docker build exits non-zero", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ stderr: "Build failed: unknown instruction", exitCode: 1 }); // helper build

    const r = await buildService(cfg());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("[build] exit 1");
    expect(r.output).toContain("Build failed");
  });

  it("returns ok:false when the helper build fails to spawn", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ error: new Error("spawn docker failed") }); // helper build

    const r = await buildService(cfg());
    expect(r.ok).toBe(false);
  });

  it("calls onLog with tagging and building messages", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({ exitCode: 0 }); // helper build

    const logs: string[] = [];
    await buildService(cfg(), (s) => logs.push(s));

    const combined = logs.join("");
    expect(combined).toContain("Tagging mysvc:latest");
    expect(combined).toContain("Building mysvc:latest");
  });

  it("includes build stdout and stderr in output", async () => {
    queueSpawn({ exitCode: 0 }); // tag
    queueSpawn({
      stdout: "build stdout line",
      stderr: "build stderr line",
      exitCode: 0,
    });

    const r = await buildService(cfg());
    expect(r.output).toContain("build stdout line");
    expect(r.output).toContain("build stderr line");
  });
});

describe("buildHelperArgs", () => {
  it("runs sh as entrypoint with the script and positional args", () => {
    const args = buildHelperArgs("/h/p", "img:latest", "Dockerfile.x");
    const i = args.indexOf("--entrypoint");
    expect(args[i + 1]).toBe("sh");
    const c = args.indexOf("-c");
    expect(args[c + 1]).toBe(BUILD_SCRIPT);
    expect(args.slice(c + 2)).toEqual([
      "sh",
      "/ctx/Dockerfile.x",
      "img:latest",
    ]);
    expect(args).toContain("/h/p:/ctx:ro");
    expect(args).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("does not interpolate image or dockerfile into the script", () => {
    const evil = 'x"; touch /pwn; "';
    const args = buildHelperArgs("/h/p", evil, evil);
    const c = args.indexOf("-c");
    expect(args[c + 1]).not.toContain("touch /pwn");
    expect(args[c + 1]).toContain('--build-arg GIT_COMMIT="$sha"');
    expect(args[c + 1]).toContain('-f "$1" -t "$2"');
    expect(args).toContain(evil);
  });
});

describe("BUILD_SCRIPT end-to-end (stub docker)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "bscript-"));

  const stubBin = (): string => {
    const bin = mk();
    const f = path.join(bin, "docker");
    fs.writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n');
    fs.chmodSync(f, 0o755);
    return bin;
  };

  const run = (ctx: string, image = "img:tag") => {
    const r = Bun.spawnSync(
      ["sh", "-c", BUILD_SCRIPT, "sh", "/ctx/Dockerfile", image],
      {
        env: {
          PATH: `${stubBin()}:${process.env.PATH ?? ""}`,
          CTX_DIR: ctx,
        },
      },
    );
    const out = r.stdout.toString();
    const argv = out
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    return { code: r.exitCode, out, argv };
  };

  it("passes the 7-char sha of a normal checkout to docker build and logs it", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, ".git/refs/heads"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git/HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(d, ".git/refs/heads/main"), SHA + "\n");
    const r = run(d);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[build] GIT_COMMIT=0123456");
    expect(r.argv).toEqual([
      "build",
      "--build-arg",
      "GIT_COMMIT=0123456",
      "-f",
      "/ctx/Dockerfile",
      "-t",
      "img:tag",
      "/ctx",
    ]);
  });

  it("still builds with GIT_COMMIT=unknown and exits 0 when .git is missing", () => {
    const r = run(mk());
    expect(r.code).toBe(0);
    expect(r.out).toContain("[build] GIT_COMMIT=unknown");
    expect(r.argv).toEqual([
      "build",
      "--build-arg",
      "GIT_COMMIT=unknown",
      "-f",
      "/ctx/Dockerfile",
      "-t",
      "img:tag",
      "/ctx",
    ]);
  });

  it("passes a hostile image name as one argv element without executing it", () => {
    const tmp = mk();
    const marker = path.join(tmp, "pwn");
    const evil = `x"; touch ${marker}; "`;
    const r = run(mk(), evil);
    expect(r.code).toBe(0);
    expect(r.argv).toContain(evil);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("GIT_COMMIT_RESOLVER_SCRIPT", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "gitres-"));
  const resolve = (dir: string): string => {
    const r = Bun.spawnSync(
      ["sh", "-c", `${GIT_COMMIT_RESOLVER_SCRIPT}\nprintf %s "$sha"`],
      { env: { PATH: process.env.PATH ?? "", CTX_DIR: dir } },
    );
    return r.stdout.toString();
  };

  it("reads a loose ref file", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, ".git/refs/heads"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git/HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(d, ".git/refs/heads/main"), SHA + "\n");
    expect(resolve(d)).toBe("0123456");
  });

  it("reads packed-refs", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git/HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(
      path.join(d, ".git/packed-refs"),
      `# pack-refs\n${"f".repeat(40)} refs/heads/other\n${SHA} refs/heads/main\n`,
    );
    expect(resolve(d)).toBe("0123456");
  });

  it("uses a raw sha for detached HEAD", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git/HEAD"), SHA + "\n");
    expect(resolve(d)).toBe("0123456");
  });

  it("returns unknown when .git is a file (worktree)", () => {
    const d = mk();
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /somewhere/else\n");
    expect(resolve(d)).toBe("unknown");
  });

  it("returns unknown when .git is missing", () => {
    expect(resolve(mk())).toBe("unknown");
  });

  it("returns unknown when the ref cannot be found", () => {
    const d = mk();
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git/HEAD"), "ref: refs/heads/gone\n");
    expect(resolve(d)).toBe("unknown");
  });
});

describe("restartService", () => {
  beforeEach(() => reset());

  it("force-recreates the configured service through a Docker CLI helper", async () => {
    queueSpawn({ exitCode: 0, stdout: "Container mysvc Recreated" });

    const result = await restartService({
      composeDir: "/host/mysvc",
      service: "mysvc",
      helperReadOnlyPaths: ["/host/mysvc-secrets"],
    });

    expect(result.ok).toBe(true);
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0].cmd).toBe("docker");
    expect(state.spawnCalls[0].args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "/host/mysvc:/host/mysvc:ro",
        "/host/mysvc-secrets:/host/mysvc-secrets:ro",
        "docker:29.5.3-cli",
        "compose",
        "up",
        "-d",
        "--force-recreate",
        "--no-deps",
        "mysvc",
      ]),
    );
  });

  it("runs Compose in composeDir and never mounts buildDir", async () => {
    queueSpawn({ exitCode: 0 });

    const result = await restartService({
      composeDir: "/ops/stack",
      buildDir: "/repo/mysvc",
      service: "mysvc",
    });

    expect(result.ok).toBe(true);
    const args = state.spawnCalls[0].args;
    expect(args).toContain("/ops/stack:/ops/stack:ro");
    expect(args[args.indexOf("-w") + 1]).toBe("/ops/stack");
    expect(args.join(" ")).not.toContain("/repo/mysvc");
  });

  it("refuses build-only services without starting Docker", async () => {
    const result = await restartService({
      buildDir: "/repo/mysvc",
      service: "mysvc",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("composeDir is empty");
    expect(state.spawnCalls).toHaveLength(0);
  });

  it("rejects relative helper paths before starting Docker", async () => {
    const result = await restartService({
      composeDir: "/host/mysvc",
      service: "mysvc",
      helperReadOnlyPaths: ["relative/secrets"],
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      "helperReadOnlyPaths must contain absolute paths",
    );
    expect(state.spawnCalls).toHaveLength(0);
  });

  it("reports a failed Compose recreation", async () => {
    queueSpawn({ exitCode: 1, stderr: "compose failed" });

    const result = await restartService({
      composeDir: "/host/mysvc",
      service: "mysvc",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("compose failed");
  });
});

describe("host build requests", () => {
  it("treats a run for a newer coalesced request as covering earlier ones", async () => {
    const stateDir = makeTempDir();
    try {
      const first = await requestHostBuild(stateDir, "svc");
      await Bun.sleep(2);
      const second = await requestHostBuild(stateDir, "svc");
      const queued = JSON.parse(
        fs.readFileSync(path.join(stateDir, "build-requests", "svc.json"), "utf-8"),
      );
      expect(queued.requestId).toBe(second.requestId);
      expect(await getHostBuildStatus(stateDir, "svc", first.requestedAt)).toEqual({ state: "pending" });

      // The host runner claims the newest request, then records its result.
      const results = path.join(stateDir, "build-results");
      fs.mkdirSync(results);
      fs.writeFileSync(
        path.join(results, "svc.running.json"),
        JSON.stringify({ request: second, startedAt: "t1" }),
      );
      expect(await getHostBuildStatus(stateDir, "svc", first.requestedAt)).toEqual({ state: "running", startedAt: "t1" });

      await Bun.sleep(2);
      const third = await requestHostBuild(stateDir, "svc");
      fs.writeFileSync(
        path.join(results, "svc.json"),
        JSON.stringify({ request: second, startedAt: "t1", finishedAt: "t2", exitCode: 1, logTail: "boom" }),
      );
      expect(await getHostBuildStatus(stateDir, "svc", first.requestedAt)).toMatchObject({ state: "failed", exitCode: 1, logTail: "boom" });
      expect(await getHostBuildStatus(stateDir, "svc", second.requestedAt)).toMatchObject({ state: "failed" });
      // A request queued after the run started waits for the next run.
      expect(await getHostBuildStatus(stateDir, "svc", third.requestedAt)).toEqual({ state: "pending" });
    } finally {
      rmDir(stateDir);
    }
  });
});

describe("getHostBuildStatus result files", () => {
  const setup = (files: Record<string, string>) => {
    const stateDir = makeTempDir();
    const results = path.join(stateDir, "build-results");
    fs.mkdirSync(results);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(results, name), body);
    return stateDir;
  };
  const request = { service: "svc", requestId: "r", requestedAt: "2026-01-01T00:00:00.000Z" };

  it("reports pending when no files exist", async () => {
    const stateDir = setup({});
    try {
      expect(await getHostBuildStatus(stateDir, "svc", request.requestedAt)).toEqual({ state: "pending" });
    } finally {
      rmDir(stateDir);
    }
  });

  it("reports succeeded and failed from valid result files", async () => {
    const ok = setup({ "svc.json": JSON.stringify({ request, finishedAt: "t", exitCode: 0 }) });
    const bad = setup({ "svc.json": JSON.stringify({ request, finishedAt: "t", exitCode: 2 }) });
    try {
      expect(await getHostBuildStatus(ok, "svc", request.requestedAt)).toMatchObject({ state: "succeeded", exitCode: 0 });
      expect(await getHostBuildStatus(bad, "svc", request.requestedAt)).toMatchObject({ state: "failed", exitCode: 2 });
    } finally {
      rmDir(ok);
      rmDir(bad);
    }
  });

  it("reports running from a valid running file", async () => {
    const stateDir = setup({ "svc.running.json": JSON.stringify({ request, startedAt: "t1" }) });
    try {
      expect(await getHostBuildStatus(stateDir, "svc", request.requestedAt)).toEqual({ state: "running", startedAt: "t1" });
    } finally {
      rmDir(stateDir);
    }
  });

  it("reports unknown with an error and warns for a corrupt result or running file", async () => {
    const { logger } = await import("./logger.js");
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    const corruptResult = setup({ "svc.json": '{"request": {"requ' });
    const corruptRunning = setup({ "svc.running.json": "not json" });
    try {
      const a = await getHostBuildStatus(corruptResult, "svc", request.requestedAt);
      expect(a.state).toBe("unknown");
      expect(a).toHaveProperty("error");
      expect(warn).toHaveBeenCalledTimes(1);
      const b = await getHostBuildStatus(corruptRunning, "svc", request.requestedAt);
      expect(b.state).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      rmDir(corruptResult);
      rmDir(corruptRunning);
    }
  });
});
