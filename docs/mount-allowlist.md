# Mount Path Allowlist

Prevents sandbox containers from bind-mounting arbitrary host directories.

## Problem

When CarapaBoard calls `sandbox_start`, it passes environment variables like
`LOCAL_REPO` and `GROUP_DIR` that become Docker bind mount sources in the
stack's `docker-compose.yml`:

```yaml
volumes:
  - ${LOCAL_REPO}:${WORKSPACE_PATH}
  - ${GROUP_DIR}:/workspace/group
```

Without validation, a compromised caller — or a rogue agent that modifies
project settings — could set `LOCAL_REPO` to any host path (e.g. `/etc`, `/root/.ssh`) and gain read/write access to it inside the next sandbox container.

## Solution

CarapaBox validates mount-path env var **values** against a read-only
allowlist before calling `docker compose up`.

### Flow

```
caller → sandbox_start(env: {LOCAL_REPO: "/home/user/project", ...})
       → filterEnvPassthrough()   ← filters which env KEYS pass through
       → validateMountPaths()     ← validates env VALUES against allowlist
       → prepareSandboxDirectory() ← creates/checks workspace and IPC as controller UID/GID
       → startStack()             ← docker compose up (only if allowed)
```

### Enforcement point

`src/security.ts` → `validateMountPaths(env)`:

- Reads `config/mount-allowlist.yaml` (cached with mtime invalidation)
- Checks each path-type env key (`LOCAL_REPO`, `GROUP_DIR`, `IPC_MOUNT`, `AGENT_HOME`, `EXTRA_MOUNT_1`, `EXTRA_MOUNT_2`); the matching `EXTRA_MOUNT_N_NAME` folder names are also validated against the
  `allowed` base directories
- Returns an error string if any path is outside the allowlist, `null` if OK
- Called in `sandbox_start` (`src/tools/register.ts`) before workspace/IPC directory preparation and `startStack()`

## Configuration

### File location

```
carapa-box/config/mount-allowlist.yaml
```

Mounted into the container as `/app/config/mount-allowlist.yaml:ro`.

### Format

```yaml
# Host directories allowed as bind-mount sources.
# Empty list = no restriction (dev mode).
allowed:
  - /home/{user}/{your_repo}
```

Each entry is a base directory. Any path equal to or nested under an allowed
base is permitted. Path resolution uses `path.resolve()` to normalize before
comparison.

### Deny by default

When the `allowed` array is **empty** (or the file is missing), all mount paths
are **blocked**. You must explicitly list every allowed base directory.

## Editing the allowlist

The file is mounted read-only from the host. To update:

```bash
# Edit on the host
vim carapa-box/config/mount-allowlist.yaml

# No restart needed — the file is re-read on every sandbox_start call
# (cached with mtime check, so changes are picked up immediately)
```

No container rebuild is required.

## Security properties

1. **Read-only mount** — the config directory is `./config:/app/config:ro`,
   so even if the carapa-box process is compromised, the allowlist cannot be
   modified from inside the container.

2. **Deny by default** — if the file is unreadable or malformed, the
   fallback is `{ allowed: [] }`, which means no paths are permitted (once
   enforcement is active).

3. **No agent access** — agents run in separate sandbox containers and have
   no mount to the carapa-box config directory.

4. **Pre-Docker validation** — paths are checked before `docker compose up`
   is called, so an invalid path never reaches the Docker daemon.

## Isolation between projects

The allowlist decides which host directories a sandbox may mount. It does not
decide how many projects share one directory; that is an operator choice made
through `AGENT_HOME` and `GROUP_DIR`.

### `AGENT_HOME`: shared or per project

`stacks/carapa-bot/docker-compose.yml` mounts the same `AGENT_HOME` twice: read-write at
`/home/ubuntu` and read-only at `/opt/carapa/agent-home` (same
`AGENT_HOME_SUBPATH`). The read-only copy only protects the skill and rule views
that link to it. It does **not** stop the sandbox from writing the same files
through `/home/ubuntu`.

| | Shared `AGENT_HOME` (several projects, one directory) | Per-project `AGENT_HOME` |
| --- | --- | --- |
| What a sandbox can change | Any file under the shared home, which every other project runs or loads: `.claude/settings.json` (hooks), `.codex/config.toml`, shell rc files, `.agent/` skills and rules | Only that project's own home |
| Credentials and history | Shared (OAuth sessions, CLI history) | Separate |
| Effect of a compromised or careless project | Can alter what the other projects execute on their next start | Contained to the project |

### `GROUP_DIR`: own folder or parent `groups/`

- **Default, including main agents:** `GROUP_DIR` is the project's own group
  folder, mounted at `/workspace/group`. The sandbox can write that folder (its
  `CLAUDE.md`, memory, `.agent/rules`, `.agent/skills`) and nothing of other
  projects. Per-user main agents also mount only their own folder; the legacy
  global main agent that used the parent directory is retired in CarapaBoard.
- **Parent `groups/` directory (admin option):** if an admin points `GROUP_DIR`
  at the directory that contains all group folders, that sandbox gets write
  access to **every** project's group folder, including their `.agent/rules` and
  `.agent/skills`. It must be inside the mount allowlist like any other
  `GROUP_DIR`, so list the parent only on a host where that reach is intended.

### Recommendation

| Goal | Setup |
| --- | --- |
| Convenience: one login, shared skills and settings, trusted projects only | Shared `AGENT_HOME`; each project keeps its own `GROUP_DIR` |
| Isolation: projects that must not influence each other | Per-project `AGENT_HOME` **and** per-project `GROUP_DIR`; never a parent `groups/` directory |

For credential separation in the relay, see [API relay setup](api-relay-setup.md).

## Checked env keys

Currently validated (defined in `MOUNT_PATH_ENV_KEYS` in `src/security.ts`):

| Key          | Purpose                                                          |
| ------------ | ---------------------------------------------------------------- |
| `LOCAL_REPO` | Host directory bind-mounted as the agent's workspace             |
| `GROUP_DIR`  | Host directory bind-mounted as `/workspace/group`                |
| `IPC_MOUNT`  | Host directory for per-instance IPC (args, output, exit_code)    |
| `AGENT_HOME` | Host directory bind-mounted as the agent's home (`/home/ubuntu`) |

Other env vars (`WORKSPACE_PATH`, `DEFAULT_BRANCH`, `GIT_REPO`) are either
container-internal paths, URLs, or non-path values and don't need mount
validation.

`COMPOSE_FILE` is different: it makes `docker compose` load host files, which
would bypass the allowlist. A caller-supplied `COMPOSE_FILE` in `sandbox_start`
is validated (values from the stack `.env` stay trusted). Each `:`-separated
entry must match `^docker-compose[A-Za-z0-9._-]*\.yml$`, must not start with
`docker-compose.override.`, contain no `/` or `..`, and must exist in the stack
directory; otherwise a `[SECURITY]` error is returned before any hook or compose
call. `sandbox_exec` drops `COMPOSE_FILE` from the caller env entirely.

## Relationship to other security controls

| Control                | What it does                                           | Layer            |
| ---------------------- | ------------------------------------------------------ | ---------------- |
| `env-passthrough.yaml` | Filters which env **keys** pass through                | Key filtering    |
| **Mount allowlist**    | Validates env **values** (paths) against allowed bases | Value validation |
| seccomp profiles       | Restricts syscalls inside containers                   | Kernel           |
| AppArmor profiles      | Restricts file/network access inside containers        | Kernel           |
| `read_only: true`      | Prevents overlay rootfs writes                         | Container config |

The mount allowlist is the **only** control that prevents untrusted paths
from becoming Docker bind mount sources. All other controls operate after
the mount is already in place.
