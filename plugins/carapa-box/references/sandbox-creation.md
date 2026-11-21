# Create a sandbox

Treat creation as one guided workflow: gather prerequisites, prepare authorized configuration,
start through native MCP, then verify the requested instance. Do not use `sandbox_start` as a
validation probe: startup hooks may change files before a later check fails.

## Establish the request and prerequisites

Keep the selected MCP controller from the conversation. "A new carapa-bot named demo" means
stack template `carapa-bot` and instance `demo`; it does not mean creating a new stack definition.
Use native `sandbox_list` to find the template and `sandbox_ps` filtered by instance to check for
an existing instance. Do not restart an existing instance as a side effect of creation.

Use the selected connection's operator inventory for read-only inspection when native discovery
does not expose setup requirements. Inspect the actual deployed stack's documentation, required
Compose inputs, startup hooks, and non-secret defaults. A checkout's bundled stacks may differ
from the controller's mounted stack directory. For container deployments, inspect the selected
container's mount mappings and effective settings; do not assume its `/app/stacks` or `/app/config`
paths exist on the operator host. For a remote controller, use its selected SSH host. Inspect only
the necessary configuration fields; do not dump `.env` files or Docker environment arrays that may
contain credentials.

Collect missing inputs together before launching. Explain them in terms of what the sandbox will
use. For CarapaBot, when required by the deployed stack:

- **Project folder** (`LOCAL_REPO`): the code/workspace directory on the controller's Docker host.
- **Persistent data folder** (`GROUP_DIR`): the group's persistent files, using the deployed stack's
  documented layout and initialization requirements.

Reuse values explicitly established for this new instance, or a documented per-instance default.
Do not reuse another sandbox's project/group data merely because it is already allowed. If the
operator has a designated root for new sandboxes, propose an instance-specific child under it.
If no suitable defaults are known, ask one concise question for the project folder and any other
missing choices. Offer verified allowed locations when useful, and explain that a new location
can require operator configuration. Do not require the user to know environment-variable names.

## Check paths before launch

Resolve paths on the intended Docker host. Expand `~` only after identifying the relevant host
account's home directory; a remote host's home is not the local Codex account's home. Confirm the
selected paths, directory existence/type, intended contents, and access for the configured service
identity. Missing paths are not proof that the user intended an empty project; preserve existing
data and follow stack initialization requirements for new directories.

Check every required mount input against the effective `config/mount-allowlist.yaml`, including
stack-required IPC and agent-home paths. Keep credentials outside all proposed mount roots.
If read-only operator inspection is unavailable, explain the exact unverified prerequisite rather
than claiming the paths are ready or broadening access.

When a chosen directory is blocked, show the smallest useful change. For example, a requested
`/home/user/demo-group` can be authorized as that exact directory; allowing `/home/user` is not
necessary. An existing, narrower approved root may be an alternative, but let the user choose
before relocating their project or data.

Use the operator skill for necessary configuration work. Prepare the concrete host-side change,
preserve existing entries, and apply it within the user's existing authorization. Obtain missing
authorization for new mount access when it has not been covered; a launch failure alone does not
authorize expanding access. Respect explicit exclusions on containers or stack directories.
Finish other authorized preparation before asking, so any approval covers a specific change.
Do not hand the user a container-only path as an edit instruction or disable read-only mounts.
Check the deployed controller's reload behavior and verify effective state after any change.

## Start and verify

Call the selected server's native `sandbox_start` with the template as `name`, the requested
instance as `instance`, and the resolved non-secret inputs as `env`. Credentials must not enter
tool arguments. Verify the specific instance with a fresh `sandbox_ps` query and inspect bounded
logs when startup is unhealthy.

If startup fails, inspect the instance before retrying. A lack of running containers does not prove
that hooks created no files or other resources. Report the verified state precisely and address
the actual failure. Do not automatically relaunch, switch controllers, or delete partial state.

Report the instance, controller, project/data folders, and verified running state. Offer a browser
link only for an actual verified dashboard or application; the MCP/API endpoint is configuration.
