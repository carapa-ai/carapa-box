# Minimal stack policy for exercising the real command-validation boundary.
# Base denials are evaluated separately by src/policy.ts.
package carapabox.test_stack

import rego.v1

default allow := false

allow if {
    input.service == "agent"
    count(input.segments) > 0
    every segment in input.segments {
        some pattern in {"ls *", "pgrep *", "echo *"}
        glob.match(pattern, ["/"], segment)
    }
}

result := {"allow": true, "policy_name": "test_stack.allow"} if allow
else := {"allow": false, "reason": "No matching allow rule", "policy_name": "test_stack.default_deny"}
