# Managed Services

Managed services are system-level components (like the Carapa Board or the Brain agent) whose Docker images are built and restarted by the CarapaBox orchestrator.

## Configuration

Managed services are defined in `config/managed-services.yaml`.

Example configuration:

```json
{
  "carapa-board": {
    "composeDir": "$CARAPA_BOARD_STACK_DIR",
    "buildDir": "$CARAPA_BOARD_DIR",
    "helperReadOnlyPaths": ["/home/youruser/.carapa/secrets/board"],
    "healthUrl": "http://localhost:3000/health",
    "service": "carapa-board"
  },
  "carapa-brain": {
    "buildDir": "$CARAPA_BRAIN_DIR",
    "service": "agent"
  }
}
```

### Variable expansion

`composeDir`, `buildDir`, `helperReadOnlyPaths` and `healthUrl` expand `$VAR`
and `${VAR}` references (names match `[A-Z_][A-Z0-9_]*`) from the orchestrator's
environment, anywhere in the value. A referenced variable that is unset or
empty is an error naming the entry, field and variable; it never expands to an
empty string.

### Fields

- `composeDir`: (Optional) The absolute host path of the Compose project that
  `restart_service` runs. Omit it for build-only services; `restart_service`
  then refuses the service.
- `buildDir`: (Optional) The absolute host path used as the Docker build
  context. Defaults to `composeDir`.
- `helperReadOnlyPaths`: (Optional) Absolute host paths mounted read-only at the
  same locations in the short-lived Compose helper. Add directories containing
  file-backed Compose secrets or configs so Compose can validate them before it
  asks the host Docker daemon to bind-mount them.
- `service`: The Docker image name to build.
- `healthUrl`: (Optional) A URL for external health monitoring.
- `dockerfile`: (Optional) Dockerfile path relative to the build context (default: `Dockerfile`).
- `build`: (Optional) `docker` (default) or `host-request`. See
  [Host builds](#host-builds).

### Keep the Compose project out of agent reach

Compose trusts every file in `composeDir`: `docker-compose.yml`, any
`compose.yaml` or `*.override.yml` it discovers, and `.env`, which can set
`COMPOSE_FILE` and every `${VAR}` used in mounts. A sandbox that can write
there can add `privileged: true` or a host `/` mount and gain host root on the
next `restart_service`.

When agents edit the service's repository, keep the deployment Compose file
and `.env` in an operator-only directory outside every mount allowlist entry,
set `composeDir` to that directory and `buildDir` to the repository. The
deployment Compose file must be self-contained: do not `include` or `extends`
files from the repository, and take security profiles and secrets from
operator-only paths. Bind mounts whose source is inside the repository remain
agent-controlled; an agent could replace such a directory with a symlink.

```yaml
carapa-board:
  composeDir: /home/youruser/my-stacks/carapa-board
  buildDir: /home/youruser/carapa-board
  helperReadOnlyPaths:
    - /home/youruser/my-stacks/security
    - /home/youruser/.carapa/secrets/board
  service: carapa-board
```

## Tools

### `build_service`

Builds the Docker image for the service using `docker build`. The Docker daemon reads the Dockerfile and build context from the host filesystem — no container-side mounts needed.

Before building, the current `:latest` image is tagged as `:rollback` for easy recovery.

At the default `info` log level, CarapaBox logs the build start and result.
Failed builds include only the last 10 output lines, capped at 2,000 characters.
Set `LOG_LEVEL=debug` to include detailed build output and configuration in the
controller logs. The tool response always includes the full build output.

### `build_service_status`

Reports a queued host build for a `host-request` service. Pass the
`requestedAt` value returned by `build_service`. The response is JSON with
`state` set to `pending`, `running`, `succeeded` or `failed`; finished builds
also include `exitCode`, `finishedAt`, `logPath` and `logTail`.

### `restart_service`

Runs `docker compose up -d --force-recreate --no-deps <service>` for the
configured managed service. This replaces the running container so a newly
built `:latest` image is actually used.

## Host builds

Some images are built by host scripts that CarapaBox must not run, such as
`my-stacks/build-all.sh --brain`, which also rebuilds every image derived from
CarapaBrain. Set `build: host-request` on such a service:

```yaml
carapa-brain:
  buildDir: /home/youruser/carapa-brain
  service: carapa-brain
  build: host-request
```

`build_service` then only writes `build-requests/<service>.json` in the
CarapaBox state directory (`CARAPA_BOX_STATE_DIR`) and returns
`{"status":"queued","service":…,"requestId":…,"requestedAt":…}`. The request
names the service only; the host runner decides which command it maps to.
Repeated requests for one service overwrite the same file, so they coalesce
into one build.

A host runner (for CarapaBrain, `my-stacks/scripts/host-build-runner.py`, run
from cron) waits until no newer request has arrived for 30 seconds, claims the
newest request by moving it to `build-results/<service>.running.json`, runs
the build, and writes
`build-results/<service>.json`. A result answers every request made at or
before the request it claimed. No container is restarted.

## Restart Mechanism

Restart is explicit. Call `restart_service` after `build_service` when the new
image is ready to replace the running container. Graceful CarapaBrain updates
may still use deploy events and their service watcher.

## Rollback

To roll back to a previous image:

```bash
docker tag carapa-board:rollback carapa-board:latest
```

Call `restart_service` to recreate the container from the rollback image.
