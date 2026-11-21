#!/bin/sh
# ── CarapaBot agent post-start hook ───────────────────────────────────────
# Runs on the HOST after `docker compose up` completes for each instance.
# Add any per-instance setup here (git guards, trust config, etc.)
set -e
