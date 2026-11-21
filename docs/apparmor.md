# AppArmor Implementation

CarapaBox uses AppArmor for mandatory access control (MAC) on infrastructure
services (web, database, proxy). AppArmor complements the existing seccomp
syscall filters and `cap_drop: ALL` capability restrictions to provide
defence-in-depth at the filesystem, network, and capability level.

> **Note:** Agent containers running under gVisor (`runtime: runsc`) do not need
> AppArmor or seccomp — gVisor provides its own syscall interception and
> filesystem access control. The `apparmor-agent` profile is only needed for
> agent containers still running on the default `runc` runtime.

## Architecture

### Four role-based profiles

Each profile follows the principle of least privilege — only the paths and
operations required by that service role are permitted.

| Profile | Kernel name | Services | Purpose |
|---|---|---|---|
| `apparmor-agent` | `carapabox-agent` | carapa-bot, openclaw, example, carapa-mail, carapa-wa-link| Read/write workspaces, execute CLI tools, access network via egress proxy. **Redundant when using gVisor (`runtime: runsc`).** |
| `apparmor-web` | `carapabox-web` | nginx (×5), snappymail | Serve static content, proxy to PHP-FPM, read-only web root |
| `apparmor-database` | `carapabox-database` | mariadb (×3), minio | Database file I/O, IPC, client connections |
| `apparmor-proxy` | `carapabox-proxy` | squid, api-relay, llama-proxy | Network proxying, credential injection, logging |

### How profiles are applied

Each service references its profile via `security_opt` in Docker Compose:

```yaml
security_opt:
  - no-new-privileges:true
  - seccomp:../../security/seccomp-default.json
  - apparmor=carapabox-agent
```

Docker passes the profile name to the kernel at container start. The profile
must already be loaded into the kernel before the container starts.

### File locations

```
security/
├── apparmor-agent        # Agent profile (Bun, Node, PHP, Python runtimes)
├── apparmor-web          # Web server profile (nginx, snappymail)
├── apparmor-database     # Database profile (mariadb, minio)
├── apparmor-proxy        # Proxy profile (squid, api-relay, llama-proxy)
└── install-apparmor.sh   # Installs and loads all profiles into the kernel
```

## Installation

### First-time setup

```bash
cd carapa-box
sudo bash security/install-apparmor.sh
```

This copies profiles to `/etc/apparmor.d/containers/` and loads them via
`apparmor_parser`. All containers must be restarted after loading.

### Reload a single profile after editing

```bash
sudo apparmor_parser -r security/apparmor-agent
```

Then restart the affected containers:


### Unload all profiles

```bash
sudo apparmor_parser -R /etc/apparmor.d/containers/apparmor-*
```

### Check loaded profiles

```bash
sudo aa-status | grep carapabox
```

## Profile anatomy (agent)

The agent profile is the most permissive of the four and serves as a good
reference for understanding the rule structure.

### Deny rules (always win over allows)

```
deny /etc/shadow rwklx          # password hashes
deny /etc/gshadow rwklx         # group password hashes
deny /etc/sudoers rwklx         # sudo configuration
deny /proc/*/environ r          # environment variables of all processes
deny /proc/sysrq-trigger rwklx  # kernel SysRq
deny /proc/kcore rwklx          # physical memory
deny /proc/kmsg rwklx           # kernel messages
deny /sys/** w                  # sysfs writes (reads allowed selectively)
deny /root/** rwklx             # root home directory
deny /dev/sd* rwklx             # block devices
deny mount                      # prevent filesystem mounts
```

### Permission flags

| Flag | Meaning | Example use |
|---|---|---|
| `r` | Read | Reading config files |
| `w` | Write | Writing to workspaces |
| `k` | Lock (`flock`/`fcntl`) | SQLite WAL mode |
| `l` | Link (hard link / rename) | Atomic file renames |
| `m` | mmap with `PROT_EXEC` | Loading shared libraries, JIT compilation |
| `x` | Execute via `execve()` | Running binaries |
| `ix` | Inherit execute (keep current profile) | Running CLI tools |

### Bun runtime requirements

The agent profile includes rules required by the Bun JavaScript runtime, which
is used by carapa-wa-link and may be used by projects agents work on:

| Rule | Why Bun needs it |
|---|---|
| `/app/ r` | Bun reads the app directory itself during startup |
| `/app/** rwklm` | SQLite locking (`k`), atomic rename (`l`), JIT mmap (`m`) |
| `/proc/sys/vm/mmap_min_addr r` | Bun checks the mmap lower bound for JIT safety |
| `/proc/[0-9]*/statm r` | Memory stats for heap monitoring |
| `/proc/[0-9]*/mem r` | Bun reads own process memory at runtime |
| `/sys/fs/cgroup/** r` | Reads `memory.max`/`memory.high` to size its heap |
| `/usr/** mrix` | `m` on library paths for `mmap(PROT_EXEC)` during .so loading |

These rules are safe for non-Bun agents — they are all read-only on
non-sensitive paths, and `/proc/[0-9]*/mem` access is contained by the
container's PID namespace isolation.

## Troubleshooting

### Step 1 — Confirm AppArmor is the cause

Temporarily disable AppArmor for the service by commenting out the line in
`docker-compose.yml`:

```yaml
security_opt:
  - no-new-privileges:true
  - seccomp:../../security/seccomp-default.json
  # - apparmor=carapabox-agent       # <-- disabled for testing
```

Restart the container. If the crash stops, AppArmor is the cause.

### Step 2 — Read the denial log

AppArmor logs denied operations to the kernel ring buffer:

```bash
sudo dmesg | grep -i 'apparmor.*DENIED' | tail -30
```

Or with journalctl:

```bash
sudo journalctl -k | grep -i 'apparmor.*DENIED' | tail -30
```

Each line shows the operation, path, process, and requested permission:

```
apparmor="DENIED" operation="open" profile="carapabox-agent"
  name="/proc/sys/vm/mmap_min_addr" comm="bun" requested_mask="r" denied_mask="r"
```

Key fields:
- **`name`** — the path being accessed
- **`comm`** — the process that triggered the denial
- **`requested_mask`** — what the process tried to do (`r`ead, `w`rite, `k` lock, etc.)
- **`profile`** — which AppArmor profile denied it

### Step 3 — Switch to complain mode (optional)

Complain mode logs denials without actually blocking them — useful when a
service has many denials and you want to capture them all at once:

```bash
# Switch to complain mode (logs but does not enforce)
sudo aa-complain carapabox-agent

# Restart the container and exercise the failing operation
cd stacks/carapa-wa-link && docker compose up -d

# Collect all denials
sudo dmesg | grep 'apparmor.*ALLOWED' | tail -50

# Switch back to enforce mode
sudo aa-enforce carapabox-agent
```

> **Warning**: Complain mode disables enforcement. Do not leave it on in
> production.

### Step 4 — Add the missing rule

Edit the profile file (e.g. `/workspace/security/apparmor-agent`) and add the
rule. Follow these conventions:

- Use the **narrowest path possible** — prefer `/proc/sys/vm/mmap_min_addr r`
  over `/proc/sys/vm/** r`
- Use **read-only** unless write is specifically required
- Add a **comment** explaining why the rule exists
- Place the rule in the appropriate section (proc, device, workspace, etc.)

Example — adding a missing `/proc` read:

```
  /proc/sys/vm/mmap_min_addr r,   # Bun checks mmap lower bound
```

### Step 5 — Reload and test

```bash
# Reload the profile (no container restart needed for new containers)
sudo apparmor_parser -r /workspace/security/apparmor-agent

# Restart the affected service
cd /workspace/stacks/carapa-wa-link && docker compose up -d

# Verify no new denials
sudo dmesg | grep -i 'apparmor.*DENIED' | tail -10
```

### Step 6 — Verify enforcement is active

```bash
# Check the container is running under the correct profile
docker inspect <container_id> --format '{{ .HostConfig.SecurityOpt }}'
# Expected: [no-new-privileges:true seccomp=... apparmor=carapabox-agent]

# Check the profile is in enforce mode
sudo aa-status | grep carapabox
# Expected: carapabox-agent (enforce)
```

## Common pitfalls

### `/**` does not match the directory itself

The glob `/app/**` matches files *under* `/app/` but not `/app/` itself.
If a process needs to read the directory, add a separate rule:

```
/app/ r,
/app/** rw,
```

### `x` is not `m`

AppArmor's `x` (execute) controls `execve()`. The `m` flag controls
`mmap(PROT_EXEC)`. The dynamic linker uses `mmap(PROT_EXEC)` to load `.so`
text sections — so library paths need `m`, not just `x`:

```
/usr/** mrix,       # m = mmap exec, r = read, ix = inherit execute
```

### `deny` always wins

Deny rules override allow rules regardless of order. If you add
`/proc/self/environ r` but `deny /proc/*/environ r` also exists, access is
still denied. Narrow the deny rule if you need a specific exception.

### `deny /sys/** w` does not imply `allow /sys/** r`

AppArmor is deny-by-default. A `deny` rule explicitly blocks and logs the
access, but the *absence* of an allow rule also blocks (silently). To allow
reads under `/sys/`, you need an explicit allow:

```
deny /sys/** w,              # block writes, log violations
/sys/fs/cgroup/** r,         # explicitly allow cgroup reads
```

## Security layering

AppArmor is one of three mandatory access control layers applied to every
container:

```
┌──────────────────────────────────────────────┐
│  gVisor (agent containers only)              │  ← User-space kernel (replaces seccomp/AppArmor)
├──────────────────────────────────────────────┤
│  cap_drop: ALL + selective cap_add           │  ← Linux capabilities
├──────────────────────────────────────────────┤
│  seccomp (whitelist, SCMP_ACT_ERRNO)         │  ← Syscall filtering (infra services)
├──────────────────────────────────────────────┤
│  AppArmor (deny-by-default file/net/caps)    │  ← Path-based MAC (infra services)
├──────────────────────────────────────────────┤
│  no-new-privileges:true                      │  ← Prevents privilege escalation
├──────────────────────────────────────────────┤
│  Docker network isolation + egress proxy     │  ← Network segmentation
├──────────────────────────────────────────────┤
│  Agent → CarapaBox isolation                 │  ← No route to Docker socket
└──────────────────────────────────────────────┘
```

Each layer catches what the others miss:
- **gVisor** intercepts all syscalls in user space — kernel exploits never reach the host (agent containers)
- **Capabilities** limit *what* a process can do (e.g. no `CAP_NET_RAW`)
- **Seccomp** limits *which syscalls* a process can make (e.g. no `mount`) — infrastructure services
- **AppArmor** limits *which paths* a process can access (e.g. no `/etc/shadow`) — infrastructure services
