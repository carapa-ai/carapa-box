import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { fileExists, execDocker } from "./utils.js";
import { logger } from "./logger.js";

export interface ManagedService {
  /**
   * Host-side Compose project directory used by restart_service. Keep it
   * outside every sandbox-writable path: Compose trusts every file in it.
   */
  composeDir?: string;
  /** Host-side build context for docker build (default: composeDir). */
  buildDir?: string;
  /** Additional host paths exposed read-only to the short-lived Compose helper. */
  helperReadOnlyPaths?: string[];
  /** HTTP health endpoint (kept for external monitoring). */
  healthUrl?: string;
  /** Docker image / service name. */
  service: string;
  /** Dockerfile path relative to the build context (default: "Dockerfile"). */
  dockerfile?: string;
  /**
   * "host-request" queues the build for a host-side runner instead of
   * running docker build here (default: "docker").
   */
  build?: "docker" | "host-request";
}

type ManagedServices = Record<string, ManagedService>;

/**
 * Resolve $ENV_VAR and ${ENV_VAR} references in a string value.
 * Throws an error naming the variable when it is unset or empty, so a missing
 * variable never silently turns into a different path.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(
    /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g,
    (_, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const resolved = process.env[name];
      if (!resolved) throw new Error(`environment variable ${name} is not set`);
      return resolved;
    },
  );
}

/**
 * Load managed services config from config/managed-services.yaml.
 * Resolves $ENV_VAR / ${ENV_VAR} references in composeDir, buildDir, helperReadOnlyPaths
 * and healthUrl values.
 * Returns empty object if file doesn't exist.
 * Throws an error naming the entry when it is not an object or lacks a
 * non-empty `service`.
 */
export async function loadManagedServices(
  configDir: string,
): Promise<ManagedServices> {
  const configPath = path.join(configDir, "managed-services.yaml");
  if (!(await fileExists(configPath))) return {};
  const parsed: unknown = parse(await fsp.readFile(configPath, "utf-8")) ?? {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed-services.yaml must be a mapping of service names to entries");
  }
  const raw = parsed as Record<string, unknown>;
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`managed-services.yaml entry "${name}" must be an object`);
    }
    const service = (entry as { service?: unknown }).service;
    if (typeof service !== "string" || !service.trim()) {
      throw new Error(`managed-services.yaml entry "${name}" requires a non-empty "service"`);
    }
  }
  for (const [name, svc] of Object.entries(raw as ManagedServices)) {
    const resolve = (field: string, value: string): string => {
      try {
        return resolveEnvVars(value);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`managed-services.yaml entry "${name}" ${field}: ${reason}`);
      }
    };
    if (svc.composeDir) svc.composeDir = resolve("composeDir", svc.composeDir);
    if (svc.buildDir) svc.buildDir = resolve("buildDir", svc.buildDir);
    if (svc.helperReadOnlyPaths) {
      svc.helperReadOnlyPaths = svc.helperReadOnlyPaths.map((p) =>
        resolve("helperReadOnlyPaths", p),
      );
    }
    if (svc.healthUrl) svc.healthUrl = resolve("healthUrl", svc.healthUrl);
  }
  return raw as ManagedServices;
}

/**
 * POSIX sh snippet that sets `sha` to the 7-char commit of the checkout at
 * `${CTX_DIR:-/ctx}` (read straight from .git, no git binary needed), or
 * `unknown` when it cannot be resolved. Never exits non-zero.
 */
export const GIT_COMMIT_RESOLVER_SCRIPT = `
sha=unknown
g="\${CTX_DIR:-/ctx}/.git"
cand=
if [ -d "$g" ] && [ -r "$g/HEAD" ]; then
  head=$(head -n 1 "$g/HEAD" 2>/dev/null) || head=
  case "$head" in
    "ref: "*)
      ref=\${head#ref: }
      if [ -f "$g/$ref" ]; then
        cand=$(head -n 1 "$g/$ref" 2>/dev/null) || cand=
      elif [ -f "$g/packed-refs" ]; then
        cand=$(awk -v r="$ref" '$2 == r { print $1; exit }' "$g/packed-refs" 2>/dev/null) || cand=
      fi
      ;;
    *) cand=$head ;;
  esac
  case "$cand" in
    ""|*[!0-9a-f]*) ;;
    *) if [ "\${#cand}" -ge 7 ]; then sha=$(printf %s "$cand" | cut -c1-7); fi ;;
  esac
fi
`;

/** Helper-container script: $1 = dockerfile path, $2 = image name. */
export const BUILD_SCRIPT = `${GIT_COMMIT_RESOLVER_SCRIPT}
echo "[build] GIT_COMMIT=$sha"
exec docker build --build-arg GIT_COMMIT="$sha" -f "$1" -t "$2" /ctx
`;

/** Docker CLI image for the helper containers that run docker/compose commands. */
function composeCliImage(): string {
  return process.env.CARAPA_COMPOSE_CLI_IMAGE || "docker:29.5.3-cli";
}

/** Build the `docker run` argv for the helper container (no shell interpolation). */
export function buildHelperArgs(
  hostPath: string,
  imageName: string,
  dockerfile: string,
): string[] {
  return [
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${hostPath}:/ctx:ro`,
    "--entrypoint",
    "sh",
    composeCliImage(),
    "-c",
    BUILD_SCRIPT,
    "sh",
    path.posix.join("/ctx", dockerfile),
    imageName,
  ];
}

/**
 * Build the Docker image for a managed service:
 *   0. Tag current :latest as :rollback (best-effort)
 *   1. Run Docker CLI in a helper container with the host context mounted
 */
export async function buildService(
  config: ManagedService,
  onLog?: (msg: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const lines: string[] = [];
  const buildDir = config.buildDir || config.composeDir;

  if (!buildDir) {
    return {
      ok: false,
      output:
        "buildDir and composeDir are empty — check env var resolution in managed-services.yaml",
    };
  }

  const imageName = `${config.service}:latest`;

  // Step 0: Tag current image as rollback (best-effort)
  if (config.service) {
    const rollbackTag = `${config.service}:rollback`;
    onLog?.(`Tagging ${imageName} → ${rollbackTag}\n`);
    await execDocker(["tag", imageName, rollbackTag]);
  }

  // Step 1: Build from the mounted host context in a Docker CLI helper.
  // Docker applies .dockerignore before sending the context to the daemon,
  // while the hardened controller remains isolated from the host path.
  const dockerfile = config.dockerfile || "Dockerfile";
  onLog?.(`Building ${imageName} from ${buildDir}...\n`);

  try {
    const result = await execDocker(buildHelperArgs(buildDir, imageName, dockerfile), {
      onLog,
    });

    lines.push(`[build] exit ${result.status}`);
    if (result.stdout) lines.push(result.stdout);
    if (result.stderr) lines.push(result.stderr);
    if (result.status !== 0) {
      return { ok: false, output: lines.join("\n") };
    }
  } catch (err) {
    lines.push(
      `[build] error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, output: lines.join("\n") };
  }

  return { ok: true, output: lines.join("\n") };
}

/** Recreate a managed Compose service from its current image. */
export async function restartService(
  config: ManagedService,
  onLog?: (msg: string) => void,
): Promise<{ ok: boolean; output: string }> {
  if (!config.composeDir) {
    return {
      ok: false,
      output:
        "composeDir is empty — restart is disabled for build-only services; otherwise check env var resolution in managed-services.yaml",
    };
  }
  if (!config.service) {
    return { ok: false, output: "service is empty in managed-services.yaml" };
  }

  const composeArgs = [
    "compose",
    "up",
    "-d",
    "--force-recreate",
    "--no-deps",
    config.service,
  ];
  let result: Awaited<ReturnType<typeof execDocker>>;

  // Host-mode CarapaBox can execute Compose in the project directly. The
  // hardened controller intentionally does not mount managed repositories,
  // so use a short-lived Docker CLI container with the host path mounted at
  // the identical absolute path. Compose then resolves bind mounts exactly
  // as it would when invoked on the host.
  if (await fileExists(path.join(config.composeDir, "docker-compose.yml"))) {
    result = await execDocker(composeArgs, {
      cwd: config.composeDir,
      onLog,
    });
  } else {
    const helperArgs = [
      "run",
      "--rm",
      "--user",
      "0",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${config.composeDir}:${config.composeDir}:ro`,
    ];
    for (const readOnlyPath of config.helperReadOnlyPaths ?? []) {
      if (!path.isAbsolute(readOnlyPath)) {
        return {
          ok: false,
          output: `helperReadOnlyPaths must contain absolute paths: ${readOnlyPath}`,
        };
      }
      helperArgs.push("-v", `${readOnlyPath}:${readOnlyPath}:ro`);
    }
    helperArgs.push(
      "-w",
      config.composeDir,
      composeCliImage(),
      ...composeArgs,
    );
    result = await execDocker(helperArgs, {
      onLog,
    });
  }

  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  };
}

/** A queued host build. Requests for one service share a file, so repeats coalesce. */
export interface HostBuildRequest {
  service: string;
  requestId: string;
  requestedAt: string;
}

export type HostBuildStatus =
  | { state: "pending" }
  | { state: "unknown"; error: string }
  | { state: "running"; startedAt: string }
  | {
      state: "succeeded" | "failed";
      exitCode: number;
      finishedAt: string;
      logPath?: string;
      logTail?: string;
    };

/**
 * Write `<stateDir>/build-requests/<service>.json` for the host runner.
 * CarapaBox only records the service name; the host decides what to run.
 */
export async function requestHostBuild(
  stateDir: string,
  service: string,
): Promise<HostBuildRequest> {
  const dir = path.join(stateDir, "build-requests");
  await fsp.mkdir(dir, { recursive: true });
  const request: HostBuildRequest = {
    service,
    requestId: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  const file = path.join(dir, `${service}.json`);
  const tmp = `${file}.${request.requestId}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(request)}\n`);
  await fsp.rename(tmp, file);
  return request;
}

/** Shape of a runner-written build-results file once `covers` has checked `request`. */
interface BuildRecord {
  request: { requestedAt: string };
  exitCode: number;
  finishedAt: string;
  startedAt: string;
  logPath?: string;
  logTail?: string;
}

type JsonRead = { value: unknown } | { error: string };

/** Missing file reads as `{ value: null }`; any other failure is reported, not hidden. */
async function readJson(file: string): Promise<JsonRead> {
  try {
    return { value: JSON.parse(await fsp.readFile(file, "utf-8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: null };
    const error = `${file}: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`[host-build] cannot read build status file ${error}`);
    return { error };
  }
}

/**
 * Status of the request made at `requestedAt`. The runner always builds the
 * newest queued request, so a run for a later request also covers this one.
 */
export async function getHostBuildStatus(
  stateDir: string,
  service: string,
  requestedAt: string,
): Promise<HostBuildStatus> {
  const dir = path.join(stateDir, "build-results");
  const covers = (entry: unknown): entry is BuildRecord => {
    const at = (entry as { request?: { requestedAt?: unknown } } | null)?.request?.requestedAt;
    return typeof at === "string" && at >= requestedAt;
  };

  const resultRead = await readJson(path.join(dir, `${service}.json`));
  const result = "value" in resultRead ? resultRead.value : null;
  if (covers(result)) {
    return {
      state: result.exitCode === 0 ? "succeeded" : "failed",
      exitCode: result.exitCode,
      finishedAt: result.finishedAt,
      logPath: result.logPath,
      logTail: result.logTail,
    };
  }
  const runningRead = await readJson(path.join(dir, `${service}.running.json`));
  const running = "value" in runningRead ? runningRead.value : null;
  if (covers(running)) return { state: "running", startedAt: running.startedAt };
  const error = "error" in resultRead ? resultRead.error : "error" in runningRead ? runningRead.error : null;
  if (error) return { state: "unknown", error };
  return { state: "pending" };
}
