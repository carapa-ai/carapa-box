package carapabox.stack.carapa_bot_test

import data.carapabox.stack.carapa_bot
import rego.v1

decision(command) := result if {
    result := carapa_bot.result with input as {
        "service": "agent", "command": command, "segments": [command]
    }
}

test_normalized_trusted_bin_allowed if {
    decision("/usr/local/ai-cli-bin/measure-agent-run.mjs /workspace/ipc/runs/1 1785144213302").allow
    decision("/usr/local/stack-cli-bin/run-agent.sh /workspace/ipc/runs/1").allow
    decision("/usr/local/stack-cli-bin/carapa-repository-scan /workspace/group 1").allow
    decision("/usr/local/stack-cli-bin/stack-specific-tool --flag").allow
    decision("/usr/local/stack-cli-bin/tmux-tool.sh create agent-session 200 50").allow
    decision("/usr/local/stack-cli-bin/tmux-tool.sh send agent-session").allow
    decision("/usr/local/stack-cli-bin/tmux-tool.sh kill agent-session").allow
}

test_default_deny_other_paths_and_services if {
    not decision("carapa-repository-scan /workspace/group 2").allow
    not decision("tmux has-session -t agent-session").allow
    not decision("tmux-tool.sh has agent-session").allow
    not decision("find /workspace/group -name .git").allow
    not decision("/usr/local/stack-cli-bin/nested/tool").allow
    not carapa_bot.result.allow with input as {
        "service": "browser",
        "command": "/usr/local/stack-cli-bin/run-agent.sh",
        "segments": ["/usr/local/stack-cli-bin/run-agent.sh"],
    }
}

test_base_deny_precedes_allow if {
    result := decision("/usr/local/stack-cli-bin/run-agent.sh $HOME")
    not result.allow
    result.policy_name == "carapa_bot.deny"
}

shell_free_decision(command) := result if {
    result := carapa_bot.result with input as {
        "service": "agent", "command": command, "segments": [command], "shell_free": true
    }
}

test_shell_free_allows_literal_expansion_chars if {
    shell_free_decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$this->db' src").allow
    shell_free_decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$(document)' src").allow
    shell_free_decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '`x`' src").allow
}

test_without_shell_free_expansion_still_denied if {
    not decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$this->db' src").allow
    not decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$(document)' src").allow
    not decision("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '`x`' src").allow
    not carapa_bot.result.allow with input as {
        "service": "agent", "shell_free": false,
        "command": "/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$this->db'",
        "segments": ["/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$this->db'"],
    }
}

test_shell_free_keeps_length_deny if {
    long := concat("", ["/usr/local/ai-cli-bin/fs-tool.sh ", concat("", [x | some i in numbers.range(1, 8200); x := "a"])])
    not carapa_bot.result.allow with input as {
        "service": "agent", "shell_free": true, "command": long, "segments": [long],
    }
}

test_shell_free_keeps_inline_assignment_deny if {
    not carapa_bot.result.allow with input as {
        "service": "agent", "shell_free": true,
        "command": "FOO=x /usr/local/ai-cli-bin/fs-tool.sh",
        "segments": ["FOO=x /usr/local/ai-cli-bin/fs-tool.sh"],
    }
}

test_shell_free_keeps_dangerous_interpreter_deny if {
    cmd := "/usr/local/ai-cli-bin/bash -c ls"
    result := carapa_bot.result with input as {
        "service": "agent", "shell_free": true, "command": cmd, "segments": [cmd],
    }
    not result.allow
    result.policy_name == "carapa_bot.deny"
}
