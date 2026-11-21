#!/usr/bin/python3
"""Narrow observation journal mutations for CarapaBoard's control plane."""

import base64
import binascii
import hashlib
import json
import os
import re
import sys


BOUNDARY = "/workspace"
ALLOWED_FILES = {"observations.md", "observations.md.bak"}
LINE_RE = re.compile(r"^-\s*\[(\w+)\]\s*(.+)$")


def fail(message: str) -> None:
    sys.stderr.write(f"observations-tool: {message}\n")
    raise SystemExit(2)


def decode_text(value: str, label: str) -> str:
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        fail(f"invalid base64 {label}")


def workspace_root(value: str) -> str:
    root = os.path.realpath(decode_text(value, "workspace root"))
    try:
        if os.path.commonpath((BOUNDARY, root)) != BOUNDARY:
            fail("workspace root is outside /workspace")
    except ValueError:
        fail("invalid workspace root")
    if not os.path.isdir(root):
        fail("workspace root does not exist")
    return root


def append_observations(args: list[str]) -> None:
    if len(args) != 2:
        fail("usage: observations-tool.py append ROOT_B64 CONTENT_B64")
    root = workspace_root(args[0])
    content = decode_text(args[1], "observation content")
    observations_dir = os.path.join(root, ".agent", "reflections")
    os.makedirs(observations_dir, exist_ok=True)
    observations_path = os.path.realpath(
        os.path.join(observations_dir, "observations.md")
    )
    if os.path.commonpath((root, observations_path)) != root:
        fail("observation path escapes workspace root")
    with open(observations_path, "a", encoding="utf-8") as handle:
        handle.write(content)


def hashes(value: str) -> set[str]:
    return {
        hashlib.sha256(word.encode()).hexdigest()
        for word in value.lower().split()
        if len(word) > 2
    }


def scrub_observations(args: list[str]) -> None:
    if len(args) != 2:
        fail("usage: observations-tool.py scrub HASHES_B64 ROOT_B64")
    try:
        decoded = json.loads(decode_text(args[0], "target hashes"))
    except json.JSONDecodeError:
        fail("target hashes must be JSON")
    if not isinstance(decoded, list) or not all(
        isinstance(item, str) and re.fullmatch(r"[0-9a-f]{64}", item)
        for item in decoded
    ):
        fail("target hashes must be SHA-256 strings")
    target = set(decoded)
    root = workspace_root(args[1])

    for current, directories, files in os.walk(root, followlinks=False):
        directories[:] = [
            name
            for name in directories
            if not os.path.islink(os.path.join(current, name))
        ]
        for name in files:
            if name not in ALLOWED_FILES:
                continue
            file_path = os.path.join(current, name)
            if os.path.islink(file_path):
                continue
            relative = os.path.relpath(file_path, root).split(os.sep)
            own_group = relative == [".agent", "reflections", name]
            own_objective = (
                len(relative) == 5
                and relative[0] == "objectives"
                and relative[2:4] == [".agent", "reflections"]
            )
            if not own_group and not own_objective:
                continue
            with open(file_path, "r", encoding="utf-8") as handle:
                original = handle.read()
            kept = []
            for line in original.split("\n"):
                match = LINE_RE.match(line)
                remove = False
                if match:
                    if match.group(1).lower() == "forgotten":
                        remove = True
                    else:
                        candidate = hashes(match.group(2).strip())
                        hits = len(target.intersection(candidate))
                        remove = bool(
                            target
                            and candidate
                            and hits / min(len(target), len(candidate)) >= 0.5
                        )
                if not remove:
                    kept.append(line)
            scrubbed = "\n".join(kept)
            if scrubbed != original:
                temp_path = file_path + ".privacy-tmp"
                with open(temp_path, "w", encoding="utf-8") as handle:
                    handle.write(scrubbed)
                os.replace(temp_path, file_path)


def main() -> None:
    if len(sys.argv) < 2:
        fail("expected append or scrub subcommand")
    command = sys.argv[1]
    if command == "append":
        append_observations(sys.argv[2:])
    elif command == "scrub":
        scrub_observations(sys.argv[2:])
    else:
        fail("unknown subcommand")


if __name__ == "__main__":
    main()
