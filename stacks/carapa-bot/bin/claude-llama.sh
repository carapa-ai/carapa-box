#!/bin/bash
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_BASE_URL=http://llama-proxy:${LLAMA_PORT:-8881}
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${LLAMA_CONTEXT_WINDOW:-80000}

exec claude --model qwen3.6:80k "$@"
