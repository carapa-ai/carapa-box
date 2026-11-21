claude mcp remove --scope user carapa-board 2>/dev/null || true
#claude mcp remove carapa-wa-link 2>/dev/null || true
claude mcp remove carapa-mail 2>/dev/null || true

# Register MCP servers — route through api-relay for auth injection.
# Board tools apply to every project folder (user scope). A project can still
# add servers (claude mcp add, or a .mcp.json) or redefine carapa-board: local
# and project scopes take precedence over user scope for the same name.
claude mcp add --scope user --transport http carapa-board http://api-relay:8080/mcp-relay/mcp/carapa-board
#claude mcp add --transport http sandbox http://api-relay:8080/sandbox-relay/mcp

# Optional: connect carapa-wa-link MCP if reachable via api-relay
#if wget -q --spider --timeout=2 http://api-relay:8080/carapa-wa-link/health 2>/dev/null; then
#claude mcp add --transport http carapa-wa-link http://api-relay:8080/carapa-wa-link/mcp
#fi

# carapa-mail is added per run by bin/runtime/carapa-mail.ts when the project enables it.

claude mcp list
