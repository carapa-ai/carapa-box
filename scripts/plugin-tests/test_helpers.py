import http.server
import importlib.util
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

import tomlkit

REPO = Path(__file__).resolve().parents[2]
PACKAGE = Path(os.environ.get("CARAPA_PLUGIN_TEST_PACKAGE", REPO / "plugins/carapa-box"))
RUNTIME = Path(os.environ.get("CARAPA_PLUGIN_TEST_RUNTIME", PACKAGE / "scripts"))
sys.path.insert(0, str(RUNTIME))
spec = importlib.util.spec_from_file_location("box_plugin", RUNTIME / "box_plugin.py")
box = importlib.util.module_from_spec(spec)
spec.loader.exec_module(box)


class Helpers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="box plugin ' space ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config.toml"
        self.inventory = self.root / "hosts.json"
        self.token = self.root / "token ' file"
        self.token.write_text("private-fixture-token")
        self.token.chmod(0o600)
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "PYTHONPATH": str(RUNTIME)}

    def cli(self, *args, success=True):
        result = subprocess.run([sys.executable, str(RUNTIME / "box_plugin.py"), "--config", str(self.config),
                                 "--inventory", str(self.inventory), *args], env=self.env, cwd=self.root,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertNotIn("private-fixture-token", result.stdout + result.stderr)
        self.assertNotIn("admin-fixture-token", result.stdout + result.stderr)
        return result

    def register(self, name="carapa_box_a", url="http://127.0.0.1:3100", *options, success=True):
        return self.cli("connection", name, "--url", url, "--token-file", str(self.token), *options, success=success)

    def test_updates_preserve_other_servers_comments_and_policies(self):
        original = '# keep comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "unrelated"\nargs = ["one"]\n'
        self.config.write_text(original)
        self.register()
        self.register("carapa_box_b", "https://box.example.com", "--repo-root", "/srv/box repo")
        document = tomlkit.parse(self.config.read_text())
        document["mcp_servers"]["carapa_box_a"]["enabled_tools"] = ["sandbox_list"]
        self.config.write_text(tomlkit.dumps(document))
        self.register("carapa_box_a", "http://127.0.0.1:3200", "--update")
        parsed = tomlkit.parse(self.config.read_text())
        self.assertEqual(parsed["mcp_servers"]["other"], {"command": "unrelated", "args": ["one"]})
        self.assertEqual(parsed["mcp_servers"]["carapa_box_a"]["enabled_tools"], ["sandbox_list"])
        self.assertEqual(parsed["mcp_servers"]["carapa_box_b"]["url"], "https://box.example.com")
        self.assertIn("# keep comment", self.config.read_text())
        saved = self.config.read_bytes()
        self.register(success=False)
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertNotIn("url", json.loads(self.inventory.read_text())["hosts"]["carapa_box_a"])

    def test_header_helper_reads_rotated_file_and_fails_closed(self):
        self.register()
        entry = tomlkit.parse(self.config.read_text())["mcp_servers"]["carapa_box_a"]
        command = shlex.split(entry["http_headers_helper"])
        result = subprocess.run(command, capture_output=True, text=True, cwd=self.root)
        self.assertEqual(json.loads(result.stdout), {"Authorization": "Bearer private-fixture-token"})
        self.token.write_text("rotated-token")
        self.assertIn("rotated-token", subprocess.check_output(command, text=True))
        for invalid in ("", "secret\ninjected"):
            self.token.write_text(invalid)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("injected", result.stderr)
        self.token.unlink()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_invalid_inputs_leave_state_untouched(self):
        for name, url in [("../../escape", "http://127.0.0.1:3100"), ("carapa_box_a", "http://remote.example:3100"),
                          ("carapa_box_a", "https://user:secret@box.example"), ("carapa_box_a", "https://box.example?token=secret")]:
            self.register(name, url, success=False)
        self.assertFalse(self.config.exists())
        self.assertFalse(self.inventory.exists())
        self.config.write_text('broken = "private-fixture-token\n')
        self.register(success=False)
        self.assertFalse(self.inventory.exists())

    def test_config_and_inventory_cannot_overwrite_each_other(self):
        self.inventory = self.config
        self.register(success=False)
        self.assertFalse(self.config.exists())

    def test_other_process_listener_is_not_a_ready_tunnel(self):
        with socket.socket() as owned:
            owned.bind(("127.0.0.1", 0))
            owned.listen()
            original = box.subprocess.run
            try:
                box.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess([], 0, str(os.getpid()), "")
                box.tunnel_listener_ready("fixture.service", owned.getsockname()[1])
                child = subprocess.Popen([sys.executable, "-u", "-c",
                    "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1]); sys.stdin.read()"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                try:
                    port = int(child.stdout.readline())
                    with self.assertRaises(box.InputError):
                        box.tunnel_listener_ready("fixture.service", port)
                finally:
                    child.communicate(timeout=5)
            finally:
                box.subprocess.run = original

    def test_authenticated_checks_admin_redaction_and_redirect_refusal(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == "/health":
                    code, body = 200, {"name": "carapa-box"}
                elif self.headers.get("Authorization") != ("Bearer admin-fixture-token" if self.path.startswith("/api/admin/") else "Bearer private-fixture-token"):
                    code, body = 401, {}
                elif self.path == "/api/tools":
                    code, body = 200, [{"name": "sandbox_list"}]
                elif self.path == "/api/admin/stacks":
                    code, body = 200, []
                elif self.path == "/api/admin/info":
                    code, body = 200, {"name": "fixture", "custom_secret": "private-fixture-token"}
                else:
                    self.send_response(302)
                    self.send_header("Location", "https://unrelated.invalid")
                    self.end_headers()
                    return
                self.send_response(code)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.register("carapa_box_a", f"http://127.0.0.1:{server.server_port}/api/mcp")
                self.cli("check", "carapa_box_a")
                self.cli("admin", "carapa_box_a", "--path", "/api/admin/info", success=False)
                self.register("carapa_box_a", f"http://127.0.0.1:{server.server_port}/api/mcp",
                              "--admin-token-file", str(self.token), "--update", success=False)
                admin = self.root / "admin-token"
                admin.write_text("admin-fixture-token")
                self.register("carapa_box_a", f"http://127.0.0.1:{server.server_port}/api/mcp",
                              "--admin-token-file", str(admin), "--update")
                self.cli("check", "carapa_box_a")
                result = self.cli("admin", "carapa_box_a", "--path", "/api/admin/info")
                self.assertEqual(json.loads(result.stdout)["custom_secret"], "[redacted]")
                self.cli("admin", "carapa_box_a", "--path", "/api/admin/redirect", success=False)
            finally:
                server.shutdown()
                thread.join()

    def test_tunnel_port_conflict_and_targeted_service_lifecycle(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            port = occupied.getsockname()[1]
            self.register("carapa_box_a", f"http://127.0.0.1:{port}", "--ssh-alias", "private-box")
            unit_dir = self.root / "units"
            self.cli("tunnel", "carapa_box_a", "install", "--unit-dir", str(unit_dir), success=False)
            self.assertFalse(unit_dir.exists())
        self.cli("tunnel", "carapa_box_a", "install", "--unit-dir", str(unit_dir))
        unit = unit_dir / "carapa-box-tunnel-carapa_box_a.service"
        self.assertTrue(unit.exists())
        self.register("carapa_box_a", "http://127.0.0.1:39999", "--update", success=False)
        self.assertEqual(tomlkit.parse(self.config.read_text())["mcp_servers"]["carapa_box_a"]["url"], f"http://127.0.0.1:{port}")
        other = unit_dir / "unrelated.service"
        other.write_text("operator-owned")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        log = self.root / "systemctl.jsonl"
        fake = bin_dir / "systemctl"
        fake.write_text(f"#!{sys.executable}\nimport json,sys\nwith open({str(log)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n")
        fake.chmod(0o700)
        self.env["PATH"] = str(bin_dir) + os.pathsep + self.env["PATH"]
        self.cli("tunnel", "carapa_box_a", "stop")
        self.cli("tunnel", "carapa_box_a", "remove")
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(calls, [["--user", "disable", "--now", unit.name],
                                 ["--user", "disable", "--now", unit.name], ["--user", "daemon-reload"]])
        self.assertFalse(unit.exists())
        self.assertEqual(other.read_text(), "operator-owned")
        self.assertNotIn("tunnel", json.loads(self.inventory.read_text())["hosts"]["carapa_box_a"])
        self.assertTrue(self.token.exists())

    def test_remove_drops_tunnel_whose_unit_is_gone_even_if_systemctl_fails(self):
        self.register("carapa_box_a", "http://127.0.0.1:39998", "--ssh-alias", "private-box")
        unit_dir = self.root / "units"
        self.cli("tunnel", "carapa_box_a", "install", "--unit-dir", str(unit_dir))
        (unit_dir / "carapa-box-tunnel-carapa_box_a.service").unlink()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "systemctl"
        fake.write_text(f"#!{sys.executable}\nimport sys\nsys.exit(1)\n")
        fake.chmod(0o700)
        self.env["PATH"] = str(bin_dir) + os.pathsep + self.env["PATH"]
        self.cli("tunnel", "carapa_box_a", "remove", success=False)
        self.assertNotIn("tunnel", json.loads(self.inventory.read_text())["hosts"]["carapa_box_a"])
        self.cli("tunnel", "carapa_box_a", "install", "--unit-dir", str(unit_dir))

    def test_secret_setup_generates_distinct_private_tokens_and_preserves_existing(self):
        script = PACKAGE / "references/setup/scripts/ensure-controller-secrets.sh"
        directory = self.root / "controller-secrets"
        def provision(ok=True):
            r = subprocess.run(["bash", str(script), "--secrets-dir", str(directory)],
                               capture_output=True, text=True, cwd=self.root)
            self.assertEqual(r.returncode == 0, ok, r.stdout + r.stderr)
            for token in directory.glob("carapa_box_*_token"):
                if token.read_text().strip():
                    self.assertNotIn(token.read_text().strip(), r.stdout + r.stderr)
        provision()
        api, admin = directory / "carapa_box_api_token", directory / "carapa_box_admin_token"
        original = [api.read_bytes(), admin.read_bytes()]
        self.assertNotEqual(*original)
        self.assertEqual(api.stat().st_mode & 0o777, 0o600)
        self.assertEqual(admin.stat().st_mode & 0o777, 0o600)
        provision()
        self.assertEqual([api.read_bytes(), admin.read_bytes()], original)
        admin.unlink()
        provision()
        self.assertEqual(api.read_bytes(), original[0])
        admin.write_bytes(api.read_bytes().strip())
        provision(False)
        self.assertEqual(api.read_bytes(), original[0])
        admin.write_text("")
        provision(False)
        self.assertEqual(admin.read_text(), "")

    def test_packaged_setup_resources_work_without_checkout_relative_imports(self):
        helper = PACKAGE / "references/setup/scripts/inspect-setup.sh"
        (self.root / "docker-compose.yml").write_text("services: {}\n")
        result = subprocess.run(["bash", str(helper), "--repo-root", str(self.root)], cwd="/tmp", capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Repository:", result.stdout)
        self.assertNotIn("private-fixture-token", result.stdout)


if __name__ == "__main__":
    unittest.main()
