#!/usr/bin/env python3
"""Install stable local helper paths, independent of the plugin cache lifetime."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import venv

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--prefix", type=Path, default=Path.home() / ".local/share/carapa-box-plugin")
args = parser.parse_args()
root = args.prefix.expanduser().resolve()
source = Path(__file__).resolve().parent
root.mkdir(parents=True, exist_ok=True, mode=0o700)
venv_dir = root / "venv"
if not (venv_dir / "bin/python").exists():
    venv.EnvBuilder(with_pip=True).create(venv_dir)
python = venv_dir / "bin/python"
subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                "-r", str(source / "requirements.txt")], check=True)
for name in ("box_plugin.py", "headers.py", "requirements.txt"):
    target = root / name
    temporary = root / (name + ".new")
    shutil.copyfile(source / name, temporary)
    temporary.chmod(0o600)
    os.replace(temporary, target)
(root / "bin").mkdir(exist_ok=True)
launcher = root / "bin/carapa-box-plugin"
launcher.write_text("#!/bin/sh\nexec " + shlex.join([str(python), str(root / "box_plugin.py")]) + ' "$@"\n')
launcher.chmod(0o700)
print(f"Installed helper: {launcher}")
print("No MCP connections, credentials, tunnels, or controllers were changed.")
