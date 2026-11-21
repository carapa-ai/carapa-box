#!/usr/bin/env python3
"""Configure direct Codex MCP connections and operate their SSH tunnels."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import tomlkit
from headers import read_token

NAME = re.compile(r"carapa_box_[a-z0-9][a-z0-9_-]*\Z")
ALIAS = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.@-]*\Z")
MARKER = "# Managed by carapa-box-plugin\n"


class InputError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise InputError(message)


def absolute(value):
    path = Path(value).expanduser()
    require(path.is_absolute(), "Use an absolute path")
    require(not any(c in str(path) for c in "\n\r\x00"), "Invalid path")
    return str(path)


def endpoint(value):
    url = urllib.parse.urlsplit(value)
    require(url.scheme in ("http", "https") and url.hostname and not url.username
            and not url.password and not url.query and not url.fragment, "Invalid controller URL")
    require(url.scheme == "https" or url.hostname in ("127.0.0.1", "::1", "localhost"),
            "Remote endpoints require HTTPS; use an SSH tunnel for private HTTP")
    require(url.port is None or 0 < url.port < 65536, "Invalid controller port")
    return url


def atomic_write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".carapa-box-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def locked(paths):
    handles = []
    try:
        for path in sorted(set(paths)):
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            handle = open(str(path) + ".carapa-box.lock", "a")
            handles.append(handle)
            fcntl.flock(handle, fcntl.LOCK_EX)
        yield
    finally:
        for handle in reversed(handles):
            handle.close()


def read_state(args):
    config = tomlkit.parse(args.config.read_text() if args.config.exists() else "")
    inventory = json.loads(args.inventory.read_text()) if args.inventory.exists() else {"version": 1, "hosts": {}}
    require(inventory.get("version") == 1 and isinstance(inventory.get("hosts"), dict), "Unsupported operator inventory")
    return config, inventory


def save_state(args, config, inventory):
    text = tomlkit.dumps(config)
    tomlkit.parse(text)
    # Validate both before replacing either; roll back the first if the second fails.
    metadata = json.dumps(inventory, indent=2) + "\n"
    old = args.config.read_text() if args.config.exists() else None
    mode = args.config.stat().st_mode & 0o777 if args.config.exists() else 0o600
    atomic_write(args.config, text, mode)
    try:
        atomic_write(args.inventory, metadata)
    except OSError:
        if old is None:
            args.config.unlink()
        else:
            atomic_write(args.config, old, mode)
        raise


def connection(args):
    require(NAME.fullmatch(args.name), "Server names must start with carapa_box_ and use lowercase letters, digits, _ or -")
    endpoint(args.url)
    token_file = absolute(args.token_file)
    read_token(token_file)  # Never register a silently unauthenticated connection.
    if args.ssh_alias:
        require(ALIAS.fullmatch(args.ssh_alias), "Use an SSH configuration alias")
    if args.repo_root:
        require(args.repo_root.startswith("/"), "Use an absolute checkout path on the operator host")
        absolute(args.repo_root)  # A remote path must not be resolved on this machine.
    if args.admin_token_file:
        require(read_token(absolute(args.admin_token_file)) != read_token(token_file),
                "Admin and API credentials must be different")
    with locked([args.config, args.inventory]):
        config, inventory = read_state(args)
        servers = config.setdefault("mcp_servers", tomlkit.table())
        existing = servers.get(args.name)
        require(existing is None or args.update, "Connection exists; inspect it and use --update to change this server")
        old_url = existing.get("url") if existing is not None else None
        entry = existing if existing is not None else tomlkit.table()
        # Retain native tool policies/timeouts; remove superseded transport/auth fields.
        for key in ("command", "args", "env", "env_vars", "cwd", "experimental_environment",
                    "bearer_token_env_var", "http_headers", "env_http_headers", "oauth", "auth"):
            entry.pop(key, None)
        entry["url"] = args.url
        entry["http_headers_helper"] = shlex.join([sys.executable, str(Path(__file__).with_name("headers.py")), token_file])
        entry.setdefault("enabled", True)
        entry.setdefault("required", False)
        entry.setdefault("startup_timeout_sec", 20)
        entry.setdefault("tool_timeout_sec", 300)
        servers[args.name] = entry
        host = inventory["hosts"].setdefault(args.name, {})
        if host.get("tunnel"):
            require(args.url == old_url and
                    (not args.ssh_alias or args.ssh_alias == host.get("ssh_alias")),
                    "Remove the existing tunnel before changing its endpoint or SSH alias")
        host["token_file"] = token_file
        for key in ("ssh_alias", "repo_root", "mode", "admin_token_file"):
            value = getattr(args, key)
            if value is not None:
                host[key] = absolute(value) if key.endswith("file") else value
        save_state(args, config, inventory)
    print(f"Configured direct MCP server {args.name}. Reload MCP connections or start a new task.")


def selected(args):
    config, inventory = read_state(args)
    server = config.get("mcp_servers", {}).get(args.name)
    host = inventory["hosts"].get(args.name)
    require(server is not None and host is not None, "Unknown connection; configure this named host first")
    endpoint(server["url"])
    return config, inventory, server, host


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(url, path, token=None, method="GET", data=None):
    # Preserve reverse-proxy prefixes while replacing the optional MCP suffix.
    base = url.rstrip("/")
    if base.endswith("/api/mcp"):
        base = base[:-8]
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=5) as response:
            return response.status, response.read(1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, b""  # Do not expose server error bodies/credentials.


def check(args):
    _, _, server, host = selected(args)
    token = read_token(host["token_file"])
    status, body = request(server["url"], "/health")
    require(status == 200 and json.loads(body).get("name") == "carapa-box", "Controller health check failed")
    for credential in (None, "carapa-box-plugin-invalid-probe"):
        status, _ = request(server["url"], "/api/tools", credential)
        require(status == 401, "Controller did not reject a missing/invalid API credential")
    status, body = request(server["url"], "/api/tools", token)
    require(status == 200 and isinstance(json.loads(body), list), "Authenticated tool discovery failed")
    print(f"{args.name}: health, authentication rejection, and authenticated tool listing passed.")
    if host.get("admin_token_file"):
        admin_token = read_token(host["admin_token_file"])
        require(admin_token != token, "Admin and API credentials must be different")
        for credential in (None, "carapa-box-plugin-invalid-probe", token):
            status, _ = request(server["url"], "/api/admin/stacks", credential)
            require(status == 401, "Admin routes must reject missing, invalid, and API credentials")
        status, _ = request(server["url"], "/api/admin/stacks", admin_token)
        require(status == 200, "Separate admin authentication failed")
        status, _ = request(server["url"], "/api/tools", admin_token)
        require(status == 401, "API routes must reject the admin credential")
        print("Separate admin authentication and API/admin isolation passed.")
    print("Use the native MCP tools to verify MCP sessions and sandbox behavior.")


def systemd_arg(value):
    require(not any(c in value for c in "\n\r\x00"), "Invalid service argument")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def tunnel_unit(ssh, alias, local_port, remote_port):
    argv = [ssh, "-NT", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
            "-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}", alias]
    return MARKER + "\n".join([
        "[Unit]", "Description=CarapaBox direct MCP SSH tunnel", "StartLimitIntervalSec=0", "",
        "[Service]", "Type=simple", "ExecStart=" + " ".join(map(systemd_arg, argv)),
        "Restart=on-failure", "RestartSec=3", "UMask=0077", "", "[Install]", "WantedBy=default.target", ""])


def systemctl(*args):
    result = subprocess.run(["systemctl", "--user", *args], capture_output=True)
    require(result.returncode == 0, "systemd user operation failed; inspect the named unit with systemctl --user status")


def tunnel_listener_ready(unit_name, port):
    """Do not mistake a different authenticated loopback server for our SSH tunnel."""
    result = subprocess.run(["systemctl", "--user", "show", "--property=MainPID", "--value", unit_name],
                            capture_output=True, text=True)
    require(result.returncode == 0 and result.stdout.strip().isdigit(), "Cannot identify the tunnel process")
    pid = int(result.stdout.strip())
    require(pid > 0, "Tunnel process is not running")
    proc = Path(f"/proc/{pid}")
    owned_sockets = set()
    for fd in (proc / "fd").iterdir():
        try:
            owned_sockets.add(os.readlink(fd))
        except FileNotFoundError:
            pass  # An unrelated descriptor can close during inspection.
    for line in (proc / "net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        if fields[1] == f"0100007F:{port:04X}" and fields[3] == "0A" and f"socket:[{fields[9]}]" in owned_sockets:
            return
    raise InputError("The tunnel process does not own the configured loopback listener")


def tunnel(args):
    require(NAME.fullmatch(args.name), "Invalid connection name")
    unit_name = f"carapa-box-tunnel-{args.name}.service"
    with locked([args.config, args.inventory]):
        config, inventory, server, host = selected(args)
        url = endpoint(server["url"])
        if args.action == "install":
            require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.port, "Tunnel connection URL must use http://127.0.0.1:<port>")
            require(host.get("ssh_alias") and ALIAS.fullmatch(host["ssh_alias"]), "Set the connection's SSH alias first")
            require(0 < args.remote_port < 65536, "Invalid remote port")
            unit = args.unit_dir / unit_name
            require(not unit.exists() or unit.read_text().startswith(MARKER), "Refusing to replace an unmanaged service")
            require(not host.get("tunnel"), "Tunnel already installed; remove it before reinstalling")
            # Refuse to attach the MCP client to a different listener accidentally.
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", url.port))
            ssh = shutil.which("ssh")
            require(ssh, "OpenSSH client is missing")
            atomic_write(unit, tunnel_unit(ssh, host["ssh_alias"], url.port, args.remote_port))
            host["tunnel"] = {"unit_path": str(unit), "remote_port": args.remote_port}
            atomic_write(args.inventory, json.dumps(inventory, indent=2) + "\n")
            print(f"Installed {unit}. Run tunnel {args.name} start to activate it.")
            return
        metadata = host.get("tunnel")
        require(metadata, "No managed tunnel installed for this connection")
        unit = Path(metadata["unit_path"])
        # A removal must still be able to drop the inventory entry after the unit file is gone.
        unit_gone = args.action == "remove" and not unit.exists()
        require(unit.name == unit_name and (unit_gone or (unit.is_file() and unit.read_text().startswith(MARKER))),
                "Managed tunnel service is missing or was replaced")
        if args.action == "start":
            systemctl("daemon-reload")
            systemctl("enable", "--now", str(unit))
            deadline = time.monotonic() + args.wait
            while True:
                try:
                    # Both the owned service and authenticated controller must be ready.
                    systemctl("is-active", "--quiet", unit_name)
                    tunnel_listener_ready(unit_name, url.port)
                    check(args)
                    break
                except (OSError, ValueError, InputError):
                    if time.monotonic() >= deadline:
                        raise InputError("Tunnel not ready; inspect its service and SSH known_hosts. It remains enabled for reconnects.") from None
                    time.sleep(0.25)
        elif args.action == "stop":
            systemctl("disable", "--now", unit_name)
        elif args.action == "status":
            systemctl("is-active", "--quiet", unit_name)
            tunnel_listener_ready(unit_name, url.port)
            check(args)
        elif args.action == "remove":
            try:
                systemctl("disable", "--now", unit_name)
            except InputError:
                if not unit_gone:
                    raise
                # Best-effort stop of a service whose unit file is already gone.
            unit.unlink(missing_ok=True)
            del host["tunnel"]
            atomic_write(args.inventory, json.dumps(inventory, indent=2) + "\n")
            systemctl("daemon-reload")
        print(f"{args.name}: tunnel {args.action} completed.")


def redact(value):
    if isinstance(value, dict):
        return {k: ("[redacted]" if re.search(r"token|secret|password|api.?key|authorization|credential", k, re.I) else redact(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def admin(args):
    _, _, server, host = selected(args)
    require(args.path.startswith("/api/admin/") and ".." not in args.path and "#" not in args.path,
            "Use a CarapaBox /api/admin/ path")
    require(host.get("admin_token_file"), "Admin access requires --admin-token-file; update this connection first")
    token = read_token(host["admin_token_file"])
    require(token != read_token(host["token_file"]), "Admin and API credentials must be different")
    body = Path(args.body_file).read_bytes() if args.body_file else None
    if body is not None:
        json.loads(body)
    require(args.method != "GET" or body is None, "GET cannot have a request body")
    status, response = request(server["url"], args.path, token, args.method, body)
    require(200 <= status < 300, f"Admin API returned HTTP {status}; no changes were retried")
    # Audit entries can contain free-form command output. Do not print these automatically.
    if args.path.split("?")[0] == "/api/admin/logs":
        require(args.output_file, "Audit logs require --output-file for operator inspection")
    if args.output_file:
        atomic_write(Path(absolute(args.output_file)), response.decode())
        print("Admin response saved privately to the requested file.")
    else:
        print(json.dumps(redact(json.loads(response or b"{}")), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml")
    parser.add_argument("--inventory", type=Path, default=Path.home() / ".config/carapa-box-plugin/hosts.json")
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("connection", help="Add/update one native MCP server")
    register.add_argument("name")
    register.add_argument("--url", required=True)
    register.add_argument("--token-file", required=True)
    register.add_argument("--admin-token-file")
    register.add_argument("--ssh-alias")
    register.add_argument("--repo-root")
    register.add_argument("--mode", choices=["container", "host"])
    register.add_argument("--update", action="store_true")
    commands.add_parser("list")
    probe = commands.add_parser("check")
    probe.add_argument("name")
    tun = commands.add_parser("tunnel")
    tun.add_argument("name")
    tun.add_argument("action", choices=["install", "start", "stop", "status", "remove"])
    tun.add_argument("--remote-port", type=int, default=3100)
    tun.add_argument("--unit-dir", type=Path, default=Path.home() / ".config/systemd/user")
    tun.add_argument("--wait", type=int, default=30)
    adm = commands.add_parser("admin")
    adm.add_argument("name")
    adm.add_argument("--path", required=True)
    adm.add_argument("--method", choices=["GET", "POST", "PUT", "DELETE"], default="GET")
    adm.add_argument("--body-file")
    adm.add_argument("--output-file")
    args = parser.parse_args()
    args.config = args.config.expanduser().resolve()
    args.inventory = args.inventory.expanduser().resolve()
    require(args.config != args.inventory, "Codex config and operator inventory must be different files")
    if args.command == "connection":
        connection(args)
    elif args.command == "list":
        config, inventory = read_state(args)
        print(json.dumps({name: {**host, "url": config.get("mcp_servers", {}).get(name, {}).get("url")}
                          for name, host in inventory["hosts"].items()}, indent=2))
    elif args.command == "check":
        check(args)
    elif args.command == "tunnel":
        args.unit_dir = args.unit_dir.expanduser().resolve()
        require(args.wait > 0, "Wait must be positive")
        tunnel(args)
    elif args.command == "admin":
        admin(args)


if __name__ == "__main__":
    try:
        main()
    except InputError as error:
        print("carapa-box-plugin: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("carapa-box-plugin: operation failed; check file permissions, configuration syntax, and connectivity. No credentials were printed.", file=sys.stderr)
        sys.exit(1)
