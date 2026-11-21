package carapabox.stack.example

import data.carapabox.base
import rego.v1

default allow := false

allow if {
    input.service == "sandbox"
    count(input.segments) == 1
    regex.match(`^/usr/local/(ai|stack)-cli-bin/[^/[:space:]]+([[:space:]]|$)`, input.command)
}

deny contains reason if {
    some reason in base.deny
}

result := {"allow": false, "reason": reason, "policy_name": "example.deny"} if {
    some reason in deny
}

result := {"allow": true, "reason": "Allowed by example policy", "policy_name": "example.allow"} if {
    allow
    count(deny) == 0
}

result := {"allow": false, "reason": "No matching allow rule for this service/command", "policy_name": "example.default_deny"} if {
    not allow
    count(deny) == 0
}
