#!/usr/bin/env python3
"""Synchronize canonical setup resources, or export a self-contained plugin copy."""
import argparse
from pathlib import Path
import shutil

repo = Path(__file__).resolve().parents[1]
plugin = repo / "plugins/carapa-box"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, help="New destination directory; never overwrites an existing package")
args = parser.parse_args()
canonical = repo / ".agent/skills/setup"
if args.output:
    shutil.copytree(plugin, args.output, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    target = args.output / "references/setup"
else:
    target = plugin / "references/setup"
# Exporting is read-only for the source package, allowing independent test runs.
# Only this generated subtree is replaced; its source of truth stays in .agent/skills/setup.
if target.exists():
    shutil.rmtree(target)
shutil.copytree(canonical, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
if args.output:
    print(f"Exported plugin: {args.output.resolve()}")
else:
    print("Synchronized canonical setup resources into the distributable plugin.")
