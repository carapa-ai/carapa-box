# Stack: egress-proxy

package carapabox.stack.egress_proxy

import data.carapabox.base
import rego.v1

default allow := false

# ── Service: squid ──

# Allowlist patterns for squid
squid_allowlist := {
    "squid -k reconfigure",
    "squid -k check",
    "cat /var/log/squid/access.log",
}

allow if {
    input.service == "squid"
    every seg in input.segments {
        trimmed := trim_space(seg)
        trimmed != ""
        some pattern in squid_allowlist
        glob.match(pattern, ["/"], trimmed)
    }
}

# ── Service: api-relay ──

# No commands allowed for api-relay (empty allowlist)

# ── Service: llama-proxy ──

# No commands allowed for llama-proxy (empty allowlist)

# ── Inherit base deny rules ──

deny contains reason if {
    some reason in base.deny
}

# ── Final decision ──

result := {"allow": false, "reason": reason, "policy_name": "egress_proxy.deny"} if {
    some reason in deny
}

result := {"allow": true, "reason": "Allowed by egress_proxy policy", "policy_name": "egress_proxy.allow"} if {
    allow
    count(deny) == 0
}

result := {"allow": false, "reason": "No matching allow rule for this service/command", "policy_name": "egress_proxy.default_deny"} if {
    not allow
    count(deny) == 0
}
