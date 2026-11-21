#!/usr/bin/python3
"""Deterministic identity-change regression test for repository scanner opens."""

import importlib.machinery
import os
import sys
import tempfile
from unittest import mock


scanner = importlib.machinery.SourceFileLoader("repository_scan", sys.argv[1]).load_module()

with tempfile.TemporaryDirectory() as temporary:
    os.mkdir(os.path.join(temporary, "original"))
    os.mkdir(os.path.join(temporary, "replacement"))
    parent = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
    replacement = os.open(os.path.join(temporary, "replacement"), os.O_RDONLY | os.O_DIRECTORY)
    original_stat = os.stat("original", dir_fd=parent, follow_symlinks=False)
    real_open = os.open

    def changed_open(name, flags, *, dir_fd=None):
        if name == "original" and dir_fd == parent:
            return os.dup(replacement)
        return real_open(name, flags, dir_fd=dir_fd)

    try:
        with mock.patch.object(scanner.os, "stat", return_value=original_stat), mock.patch.object(
            scanner.os, "open", side_effect=changed_open
        ):
            try:
                scanner.open_verified_directory(parent, "original")
            except OSError as exc:
                assert "changed" in str(exc)
            else:
                raise AssertionError("directory identity replacement was accepted")
    finally:
        os.close(replacement)
        os.close(parent)
