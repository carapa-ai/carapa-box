#!/bin/sh
# agent — Alias for claude with full permissions (no interactive prompts)
exec claude --permission-mode plan "$@"
