#!/usr/bin/env python3
import asyncio
import importlib.util
import pathlib
import os
import sys
import types
import queue


class _LocalAgentConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class _Policy:
    @staticmethod
    def allow_all():
        return object()


class _Agent:
    def __init__(self, _config):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def chat(self, _prompt):
        class Response:
            async def _chunks(self):
                await asyncio.Event().wait()
                if False:
                    yield None

            chunks = _chunks(None)

        return Response()


google = types.ModuleType("google")
antigravity = types.ModuleType("google.antigravity")
hooks = types.ModuleType("google.antigravity.hooks")
sdk_types = types.ModuleType("google.antigravity.types")
antigravity.Agent = _Agent
antigravity.LocalAgentConfig = _LocalAgentConfig
hooks.policy = _Policy
for name in ("Text", "Thought", "ToolCall", "ToolResult"):
    setattr(sdk_types, name, type(name, (), {}))
sys.modules.update({
    "google": google,
    "google.antigravity": antigravity,
    "google.antigravity.hooks": hooks,
    "google.antigravity.types": sdk_types,
})

script = pathlib.Path(__file__).parents[1] / "bin" / "agy-sdk.py"
spec = importlib.util.spec_from_file_location("agy_sdk", script)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


async def test_interrupt_keeps_warm_agent_alive():
    events = []
    module.emit = events.append
    turn = asyncio.create_task(
        module.run_turn(_Agent(_LocalAgentConfig()), "long turn", "session-1")
    )
    await asyncio.sleep(0)
    turn.cancel()
    assert await turn is True
    assert events[-1]["type"] == "result"
    assert events[-1]["stop_reason"] == "interrupted"
    assert events[-1]["is_error"] is False


asyncio.run(test_interrupt_keeps_warm_agent_alive())


async def test_correction_queued_before_previous_turn_settles():
    """A fast runtime continuation must survive the result/turn-complete race."""
    lines = queue.Queue()
    lines.put('{"prompt":"original"}\n')
    prompts = []
    original_stdin, original_run_turn = module.sys.stdin, module.run_turn

    async def run_turn(_agent, prompt, _session_id):
        prompts.append(prompt)
        if prompt == "original":
            # The wrapper can respond to a result before the coroutine returns.
            lines.put('{"prompt":"correction"}\n')
            await asyncio.sleep(0.02)
        else:
            lines.put("")
        return True

    module.sys.stdin = types.SimpleNamespace(readline=lines.get)
    module.run_turn = run_turn
    try:
        args = types.SimpleNamespace(session_id="same-session", work_dir=None,
                                     system=None, model=None, once=False)
        assert await asyncio.wait_for(module.main_async(args), timeout=2) == 0
        assert prompts == ["original", "correction"]
    finally:
        module.sys.stdin, module.run_turn = original_stdin, original_run_turn


asyncio.run(test_correction_queued_before_previous_turn_settles())

os.environ.update({
    "GEMINI_API_KEY": "must-not-inherit", "GOOGLE_API_KEY": "another-account",
    "GOOGLE_APPLICATION_CREDENTIALS": "/unreadable/credential.json",
    "ANTIGRAVITY_ACP_API_KEY_FILE": "/unreadable/key",
    "GOOGLE_GEMINI_BASE_URL": "http://api-relay:8080/google",
    "NO_PROXY": "localhost", "no_proxy": "127.0.0.1",
})
config = module.build_config(types.SimpleNamespace(system=None, work_dir=None, model=None))
assert config.kwargs["api_key"] == "carapa-relay-placeholder"
assert os.environ["GEMINI_API_KEY"] == "carapa-relay-placeholder"
assert "GOOGLE_API_KEY" not in os.environ
assert "GOOGLE_APPLICATION_CREDENTIALS" not in os.environ
assert "ANTIGRAVITY_ACP_API_KEY_FILE" not in os.environ
assert os.environ["NO_PROXY"] == os.environ["no_proxy"] == "localhost,127.0.0.1,api-relay"
print("agy-sdk control tests passed")
