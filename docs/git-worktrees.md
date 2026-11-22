# Git Worktrees

The `sandbox_worktree` tool provides a mechanism for AI agents to work on isolated task branches within the same repository without interfering with the main workspace or other active tasks.

## Why Worktrees?

Standard Docker bind-mounts lock a container to a single branch/state of a repository. If multiple agents try to work on different tasks in the same repository simultaneously, they would overwrite each other's changes.

Git Worktrees solve this by creating separate checkouts of the same repository that share the same `.git` database but have unique working directories.

## How it Works

1. **Isolation**: Worktrees are created inside a `.worktrees/` directory in the project root.
2. **Persistence**: The worktrees live on the host filesystem (managed via the `LOCAL_REPO` path), ensuring changes persist across container restarts.
3. **Environment Sync**: CarapaBox can automatically symlink essential files (like `.env` or `config/local.php`) from the main repository into each new worktree.
4. **Auto-pull**: Both `add` and `reset` actions pull the latest changes from origin via SSH before operating, ensuring worktrees start from the most recent remote state.

## Tool: `sandbox_worktree`

### Actions

- `add`: Creates a new isolated worktree, or explicitly re-provisions an existing one. Pulls the specified base branch from origin first when SSH credentials are configured, restores symlinks, and runs setup hooks.
- `reuse`: Validates an existing managed checkout and returns its path and preview port without pulling, switching branches, scanning the index, restoring symlinks, or running setup hooks. A missing preview registration is restored separately. Returns `worktree_missing=1` only for a missing directory; invalid checkouts and transport failures are errors, not permission to replace files.
- `remove`: Deletes a worktree and prunes the git metadata.
- `list`: Lists all active worktrees.
- `reset`: Resets a worktree to the latest state of the base branch. Pulls from origin, then does `git reset --hard` + `git clean -fd`. Used by "Start over" to give agents a clean slate.

### Parameters

- `name`: Stack name.
- `action`: `add`, `reuse`, `remove`, `list`, or `reset`.
- `branch`: The branch name (required for `add`/`reuse`/`remove`/`reset`).
- `base`: (Optional) Base branch to create from or reset to (default: `HEAD` for add, remote default for reset).
- `instance`: (Optional) Instance ID if running multiple copies.
- `localRepo`: (Optional) Host-side repo path. Resolved automatically from the running container's bind mounts if not provided.
- `symlinkFiles`: (Optional) List of files to symlink from the main repo (e.g., `[".env", "config/local.php"]`).
- `service`: (Optional) Service name to exec into (default: `agent`).

### Example Usage (MCP)

```json
{
  "name": "carapa-bot",
  "action": "add",
  "branch": "feature/xyz",
  "base": "develop",
  "instance": "carapa-board",
  "symlinkFiles": [".env"]
}
```

This creates a new worktree at `{LOCAL_REPO}/.worktrees/feature/xyz/`. The tool returns the full host-side path.

## Worktree Hooks

For apps that should start with the main sandbox, use the separate
[project `.agent/after-start.sh` hook](../README.md#project-startup-hook).
It runs from the service's configured checkout on managed sandbox starts,
independently of worktree creation and removal.

A project can ship two optional, repo-owned hooks that CarapaBox runs around the worktree lifecycle. They keep project-specific provisioning (asset builds, per-worktree databases, …) inside the project, so CarapaBox stays stack-agnostic.

| Hook | When it runs | Purpose |
|------|--------------|---------|
| `.agent/worktree-setup.sh` | After symlink provisioning on `add` (including explicit re-provisioning of an existing directory) and `reset`; never on the lightweight `reuse` action | Build assets, clone a per-worktree DB, rewrite the worktree's own `.env`, etc. |
| `.agent/worktree-teardown.sh` | On `remove`, **before** the worktree is deleted (files + CWD still present) | Drop the per-worktree resources the setup hook created. |
| `.agent/worktree-commit.sh` | Before task-branch `commit`, `prepare_review`, and `merge` | Commit and import changes from project-owned linked repositories. |
| `.agent/worktree-inspect.sh` | On `sandbox_branch:inspect` | Return linked repository diffs in a `CARAPA_HOOK_RESULT=<json>` line. |
| `.agent/worktree-pre-merge.sh` | After the primary merge preflight, before any persistent merge | Preflight linked repositories without changing their base branches. |
| `.agent/worktree-merge.sh` | After all preflights, before the primary merge | Merge linked repositories and return their merge metadata. |

Contract:

- **CWD** is the worktree root. The hook derives the main checkout itself (e.g. via `git worktree list`).
- Both hooks are **optional** — if the file is absent, CarapaBox skips it silently (no regression for projects that don't define them).
- Setup/teardown hooks are **best-effort** by default. Set
  `WORKTREE_HOOKS_STRICT=1` in the stack environment to make their failures
  task-fatal. Commit/pre-merge/merge hooks are authoritative when present.
- `sandbox_worktree:reset` runs teardown, resets and cleans the primary
  worktree, restores configured symlinks, then reruns setup.
- Board stage transitions use `reuse` for a persisted or recovered worktree.
  They call `add` only on initial creation or confirmed absence. Provisioning
  changes made by an operator require an explicit `add` or `reset`; ordinary
  transitions still run their Testing/Review checkpoint and evidence checks.
- Upgrade CarapaBox before deploying a Board version that uses `reuse`. An
  older Box rejects the new action; Board fails the launch rather than
  silently falling back to repeated provisioning.

### Provisioning environment

CarapaBox forwards a set of environment variables to both hooks via the container's environment (`docker compose exec -e KEY` with values supplied from the host process environment), **never as argv values** — so provisioning secrets never appear on the hook's command line or in `ps` inside the container.

CarapaBox computes these per invocation:

| Env var | Meaning |
|---------|---------|
| `WT_PATH` | Absolute path of the worktree (CWD is already this — useful for sanity). |
| `WT_BRANCH` | Branch name. |
| `WT_SLUG` | DB-safe slug derived from the branch (≤40 chars, `[a-z0-9_]`). |
| `WT_ACTION` | Lifecycle action (`add`, `reuse`, `reset`, `commit`, `prepare_review`, `pre_merge`, `merge`, `archive`, `cleanup`, or `remove`). |
| `WT_BASE_BRANCH` | Configured default branch for branch hooks. |
| `WT_COMMIT_MESSAGE` | Commit message selected by the lifecycle caller. |

In addition, `PROVISION_*` keys are read from the stack `.env` and forwarded to the hooks. Any value given is readable by the project's agent, because `.agent/worktree-*.sh` hooks are repo content the agent can edit.

A stack that needs DB provisioning declares values like:

```ini
PROVISION_DB_HOST=mariadb
PROVISION_DB_PORT=3306
PROVISION_DB_USER=provisioner          # has CREATE/DROP DATABASE + read on the source DB
PROVISION_DB_PASS=…                     # forwarded via env only, never argv
PROVISION_BASE_DB=demo_app               # source DB to clone from
```

The hook prefers these over reading any creds from `MAIN/.env`. A stack that doesn't need provisioning simply omits the `PROVISION_*` keys, and its hooks receive only the `WT_*` vars.

## Per-worktree nginx preview

A stack can give every task worktree its own nginx server block, so a task can
browse its own checkout at `http://nginx:<port>/`. The feature is opt-in:

- the stack directory contains `nginx-wt.conf.tmpl`, and
- the stack's nginx service mounts a **writable** `nginx-wt/` folder at
  `/etc/nginx/conf.d/wt` (compose: `${STACK_DIR}/nginx-wt:/etc/nginx/conf.d/wt`).

Without the template, previews are skipped silently.

Template placeholders (replaced when the conf is written):

| Placeholder | Replaced with |
|-------------|---------------|
| `__BRANCH__` | The worktree branch slug |
| `__PORT__` | The allocated port, the lowest free one in 8081–8980 |

The template's `root` should use nginx variables that the instance's main nginx
conf sets from its own `LOCAL_REPO` / `WEB_ROOT_PATH`, so one template serves
every instance of the stack and each preview serves that instance's repository.

Naming and ownership: every instance of a stack mounts the same `nginx-wt/`
folder, so each conf is named `<projectName>@<branch>.conf` (the compose
project name, `<stack>-<instance>` or `<stack>`). Project names and branches
share one slug charset (`a-z 0-9 . _ -`, starting alphanumeric) that never
contains `@`, so the name splits unambiguously and no instance can match another
instance's confs, whatever its hyphens. A project name outside that charset gets
no preview.

- `add`, `reuse` and `reset` keep this instance's existing port for the branch.
- Pruning on `add`/`reset` deletes only this instance's confs whose branch is no
  longer in its `.worktrees`. Other instances' confs are never deleted, and
  pruning is skipped when the worktree list could not be read.
- `remove` deletes only this instance's conf for that branch.
- Port allocation treats every conf in the folder as used, so ports stay unique
  across instances. The allocation lock lives in the shared folder
  (`.preview.lock`), so concurrent `add`/`reset` calls from different instances
  serialize; if the lock cannot be taken within 60 s the call creates no
  preview (a lock older than 5 minutes counts as stale).
- `sandbox_ps` lists only the previews of the instance it reports.

The port is written to `<worktree>/.preview-url` as `http://nginx:<port>/`
(add `.preview-url` to the repo's `.gitignore`) and returned as a
`preview_port=<n>` line in the `add`/`reset` response.

## Tool: `sandbox_git`

Runs git commands on the sandbox workspace. Local commands (status, log, diff, etc.) exec into the running agent container. Remote commands (push, pull, fetch) run in a temporary `carapa/git-ssh` container with SSH keys mounted read-only — keys never enter the sandbox.

### Parameters

- `name`: Stack name.
- `command`: Git command to run (e.g. `push origin develop`, `log --oneline -5`).
- `instance`: (Optional) Instance ID.
- `service`: (Optional) Service name for local commands (default: `agent`).
- `localRepo`: (Optional) Host-side repo path for remote commands.

## CLI Usage

Both tools are available via the CLI:

```bash
# List worktrees
bun call worktree carapa-bot list -i carapa-board

# Add a worktree from develop
bun call worktree carapa-bot add my-branch -b develop -i carapa-board

# Reset a worktree to latest develop
bun call worktree carapa-bot reset my-branch -b develop -i carapa-board

# Remove a worktree
bun call worktree carapa-bot remove my-branch -i carapa-board

# Git log inside the sandbox
bun call git -i carapa-board carapa-bot log --oneline -5

# Check current branch
bun call git -i carapa-board carapa-bot branch

# Pull latest (via SSH)
bun call git -i carapa-board carapa-bot pull --ff-only origin develop

# Push a branch (via SSH)
bun call git -i carapa-board carapa-bot push origin my-branch
```

### CLI Options

- `-i <instance>`: Instance ID (e.g. `carapa-board`)
- `-b <base>`: Base branch for worktree add/reset
- `-s <service>`: Service name override

For `bun call git`, `-i`/`-s` go before the stack name; everything after the stack is passed to git unchanged (so `status -s`, `checkout -b feat` and `commit -m "fix bug"` work as typed). The old quoted form (`bun call git <stack> "log --oneline -5"`) still works.

## "Start Over" Flow

When a task is re-run with "Start over" in CarapaBoard:

1. Task transcript and output are cleared
2. `session_id` is cleared (agent starts a fresh session)
3. `sandbox_worktree` is called with `action: "reset"`:
   - Pulls latest base branch from origin via SSH
   - Resets the worktree to the base branch HEAD (`git reset --hard`)
   - Cleans untracked files (`git clean -fd`)
4. The reset is **awaited** before task execution begins

## Repo Path Resolution

The repo path for remote git operations is resolved in this order:

1. Explicit `localRepo` parameter from the caller
2. Inspecting the running container's bind mounts (via `docker inspect`)
3. `LOCAL_REPO` from the stack `.env` file
4. Docker named volume `{projectName}_workspace` (fallback)

This handles the case where `LOCAL_REPO` is overridden at start time (e.g. CarapaBoard passes its own repo path via env passthrough).

## Cleanup

Use `action: "remove"` once a task is completed (e.g., after the branch is merged) to keep the host filesystem clean.

## Testing

Integration tests are available at `src/test-worktree.ts`:

```bash
bun run test:worktree
```

Tests require a running carapa-box HTTP server with `ENABLE_SANDBOX_GIT=1` and a running stack instance. Configure via environment variables:

- `BOX_URL`: carapa-box URL (default: `http://host.docker.internal:3100`)
- `BOX_TOKEN`: Auth token (reads from `.env` if not set)
- `TEST_STACK`: Stack name (default: `carapa-bot`)
- `TEST_INSTANCE`: Instance (default: `carapa-board`)
- `TEST_BASE`: Base branch (default: `develop`)
