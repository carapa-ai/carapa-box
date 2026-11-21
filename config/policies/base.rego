# CarapaBox base security policy
# Shared deny rules for all stacks: command length, shell injection, dangerous interpreters.
# Stack-specific policies import this package and add their own allow/deny rules.

package carapabox.base

import rego.v1

# Maximum command length in bytes
max_command_length := 8192

# Binaries that can execute arbitrary code via arguments
dangerous_interpreters := {
    "sh", "bash", "zsh", "ash", "dash",
    "python", "python3", "python2",
    "php", "node", "perl", "ruby", "lua",
    "eval", "exec", "source",
    "env", "printenv", "export", "set",
}

# Flags that turn interpreters into arbitrary code execution
dangerous_flags := {"-c", "-r", "-e", "--eval", "--code"}

# ── Deny rules ────────────────────────────────────────────────────────────

# Command exceeds maximum length
deny contains reason if {
    count(input.command) > max_command_length
    reason := sprintf("Command exceeds maximum length (%d > %d bytes)", [count(input.command), max_command_length])
}

# Inline environment variable assignments (VAR=val command)
deny contains reason if {
    some seg in input.segments
    trimmed := trim_space(seg)
    regex.match(`^[a-zA-Z_][a-zA-Z0-9_]*=`, trimmed)
    reason := sprintf("Inline environment variable assignment blocked: %s", [trimmed])
}

# The three expansion rules below are skipped when input.shell_free == true:
# the caller executes argv directly with no shell, so nothing is evaluated.

# Backtick command substitution
deny contains reason if {
    some seg in input.segments
    not input.shell_free == true
    trimmed := trim_space(seg)
    contains(trimmed, "`")
    reason := sprintf("Backtick command substitution blocked in: %s", [trimmed])
}

# $() subshell expansion
deny contains reason if {
    some seg in input.segments
    not input.shell_free == true
    trimmed := trim_space(seg)
    contains(trimmed, "$(")
    reason := sprintf("Subshell expansion blocked in: %s", [trimmed])
}

# $VAR variable expansion (but not $() which is caught above)
deny contains reason if {
    some seg in input.segments
    not input.shell_free == true
    trimmed := trim_space(seg)
    not contains(trimmed, "$(")
    not contains(trimmed, "`")
    regex.match(`\$[A-Za-z_]`, trimmed)
    reason := sprintf("Variable expansion blocked in: %s", [trimmed])
}

# Dangerous interpreter + eval flag combination
deny contains reason if {
    some seg in input.segments
    trimmed := trim_space(seg)
    words := split(trimmed, " ")
    binary := lower(split(words[0], "/")[count(split(words[0], "/")) - 1])
    binary in dangerous_interpreters
    some word in words
    lower(word) in dangerous_flags
    reason := sprintf("Dangerous interpreter '%s' with eval flag blocked", [binary])
}
