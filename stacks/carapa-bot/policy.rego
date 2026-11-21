# Stack: carapa-bot

package carapabox.stack.carapa_bot

import data.carapabox.base
import rego.v1

default allow := false

# ── Service: agent ──

# sandbox_exec normalizes and validates this immediate trusted-bin child before
# policy evaluation, audit logging, and shell-free execution.
allow if {
    input.service == "agent"
    count(input.segments) == 1
    regex.match(`^/usr/local/(ai|stack)-cli-bin/[^/[:space:]]+([[:space:]]|$)`, input.command)
}

# ── Inherit base deny rules ──

deny contains reason if {
    some reason in base.deny
}

# ── Final decision ──

result := {"allow": false, "reason": reason, "policy_name": "carapa_bot.deny"} if {
    some reason in deny
}

result := {"allow": true, "reason": "Allowed by carapa_bot policy", "policy_name": "carapa_bot.allow"} if {
    allow
    count(deny) == 0
}

result := {"allow": false, "reason": "No matching allow rule for this service/command", "policy_name": "carapa_bot.default_deny"} if {
    not allow
    count(deny) == 0
}
