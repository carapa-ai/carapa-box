#!/bin/bash
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_BASE_URL=http://llama-proxy:${OLLAMA_PORT:-11434}
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${OLLAMA_CONTEXT_WINDOW:-250000}

exec claude --model ${OLLAMA_MODEL:-deepseek-v4-flash:cloud} "$@"
