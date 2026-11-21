#!/usr/bin/env python3
"""Codex http_headers_helper. Its stdout is private input to the MCP client."""
import json
import sys
from pathlib import Path


def read_token(filename):
    token = Path(filename).read_text().strip()
    if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError("Invalid credential file")
    return token


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.stdout.isatty():
            raise ValueError("Only invoke through the configured MCP client")
        print(json.dumps({"Authorization": "Bearer " + read_token(sys.argv[1])}))
    except (OSError, ValueError):
        print("CarapaBox credential unavailable; check the configured token file.", file=sys.stderr)
        sys.exit(1)
