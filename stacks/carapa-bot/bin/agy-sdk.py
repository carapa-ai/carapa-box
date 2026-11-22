#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# agy-sdk.py — drive the Antigravity agent via the google-antigravity Python SDK
# and emit parser-native JSON events, so the Antigravity agent reaches structured
# output parity with the other harnesses (Claude/Codex/Gemini/OpenCode/cursor-acp).
#
# WHY this exists: the `agy` CLI's headless mode (`agy --print`) emits PLAIN TEXT
# only — no tool calls, no token usage, no session id — so it fell through the
# board parser's plain-text fallback. The SDK exposes the same harness runtime
# programmatically with a structured event stream (resp.chunks), which we map to
# the JSONL shapes carapa-board/src/stream/parsers.ts already understands.
#
# AUTH: the SDK is a Gemini-API client (NOT the agy OAuth backend). It reads
# A dummy GEMINI_API_KEY satisfies SDK validation; GOOGLE_GEMINI_BASE_URL routes
# inference to api-relay, which owns and injects the real Google key. No sandbox
# secret file or OAuth credential is read.
#
# OUTPUT EVENTS (one JSON object per line, flushed immediately):
#   {"type":"init","session_id":"<id>"}                              once, at start
#   {"type":"text","part":{"type":"text","text":"<delta>"}}          per answer delta
#   {"type":"tool_use","tool_name":"<name>","parameters":{...}}      per tool call
#   {"type":"tool_result","tool_name":"<name>","output":...}         per finished tool call
#   {"type":"result","result":"<final text>","session_id":"<id>",
#    "is_error":false,"usage":{"input_tokens":N,"output_tokens":M}}  end of each turn
# The trailing `result` line doubles as the per-turn end-of-turn sentinel that the
# warm launcher (run_persistent_agy in run-agent.sh) watches for.
#
# MODES:
#   --once "<prompt>"   one turn, then exit (ephemeral / kanban task runs)
#   --warm              long-lived; read one `{"prompt": "..."}` JSON line per turn
#                       from stdin, keeping the in-memory Conversation alive across
#                       turns (this is how multi-turn memory works — the SDK has no
#                       cross-process resume).
# ─────────────────────────────────────────────────────────────────────────────
import argparse
import asyncio
import json
import logging
import os
import re
import sys
import uuid
from urllib.parse import urlsplit


def configure_relay_auth() -> str:
    """Also protect standalone --once/--warm callers, outside the TS launcher."""
    endpoint = os.environ.get("GOOGLE_GEMINI_BASE_URL") or "http://api-relay:8080/google"
    url = urlsplit(endpoint)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Antigravity relay endpoint must be an HTTP(S) base URL without credentials, query or fragment")
    for name in list(os.environ):
        if re.fullmatch(r"GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_.*|GCLOUD_PROJECT|CLOUDSDK_CORE_PROJECT|GOOGLE_GENAI_USE_VERTEXAI|ANTIGRAVITY_ACP_API_KEY_FILE", name, re.I):
            del os.environ[name]
    key = "carapa-relay-placeholder"
    os.environ["GEMINI_API_KEY"] = key
    os.environ["GOOGLE_GEMINI_BASE_URL"] = endpoint.rstrip("/")
    bypass = ",".join(dict.fromkeys(filter(None, (os.environ.get("NO_PROXY", "") + "," + os.environ.get("no_proxy", "") + "," + url.hostname).split(","))))
    os.environ["NO_PROXY"] = bypass
    os.environ["no_proxy"] = bypass
    return key


# Sanitize before importing the SDK: its modules may capture environment values.
configure_relay_auth()

from google.antigravity import Agent, LocalAgentConfig, hooks
from google.antigravity.hooks import policy
from google.antigravity import types as agt


# The SDK reports provider-side failures (rate limits / quota / terminated runs)
# only via the root logger (e.g. "WARNING:root:System step error (HTTP 429) ...
# Agent execution terminated due to error") — they do NOT appear as exceptions or
# error chunks. Capture them so a turn that ends with no text because of one can
# be surfaced to the board as an error instead of a blank assistant message.
_TURN_ERRORS: list[str] = []


class _TurnErrorCapture(logging.Handler):
    _KEYS = ("terminated due to error", "quota", "rate limit", "ratelimit",
             "429", "resource_exhausted", "permission denied", "exceeded")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
        except Exception:
            return
        if record.levelno >= logging.WARNING and any(k in msg.lower() for k in self._KEYS):
            _TURN_ERRORS.append(msg)


logging.getLogger().addHandler(_TurnErrorCapture())


def emit(obj: dict) -> None:
    """Write one JSON event line to stdout and flush (the launcher tails this live)."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _tool_name(name) -> str:
    """ToolCall.name is `BuiltinTools | str`; BuiltinTools is a str-enum -> use .value."""
    return getattr(name, "value", None) or str(name)


def _tool_output(value):
    """ToolResult.result is a str or a pydantic result (RunCommandResult(output=...))."""
    if hasattr(value, "model_dump"):
        value = value.model_dump(exclude_none=True)
        if isinstance(value, dict) and list(value) == ["output"]:
            return value["output"]
    return value


# resp.chunks carries ToolCall but never ToolResult; results only reach this
# hook, right after their call. Its id differs from the ToolCall id, so the
# launcher pairs a result with the oldest open call of the same tool name.
@hooks.post_tool_call
async def _report_tool_result(result) -> None:
    event = {"type": "tool_result", "tool_name": _tool_name(result.name),
             "output": _tool_output(result.result)}
    if result.error:
        event["error"] = str(result.error)
    emit(event)


def _usage(resp) -> dict:
    """Map UsageMetadata -> the parser's result.usage block.

    prompt_token_count = input; candidates + thoughts = output. Their sum equals
    total_token_count, which is what the board adds up (input + output). We omit
    the cached count because it is a subset of prompt_token_count and would be
    double-counted by the parser's additive total.
    """
    u = getattr(resp, "usage_metadata", None)
    if not u:
        return {}
    inp = getattr(u, "prompt_token_count", None) or 0
    out = (getattr(u, "candidates_token_count", None) or 0) + (
        getattr(u, "thoughts_token_count", None) or 0
    )
    return {"input_tokens": inp, "output_tokens": out}


async def run_turn(agent: "Agent", prompt: str, session_id: str) -> bool:
    """Run one chat turn, streaming events; always finish with a `result` line.

    Returns True on a normally-completed turn, False if the turn raised (an
    infra-level failure, e.g. the harness WS dropped) — the warm loop uses this
    to exit so a dead harness doesn't poison every subsequent turn.
    """
    answer_parts: list[str] = []
    is_error = False
    fatal = False  # True only on a real infra failure (harness/WS dead) -> exit daemon
    interrupted = False
    _TURN_ERRORS.clear()
    # Buffer consecutive Thought deltas and flush them as ONE reasoning block when
    # other output (text / tool call / result) arrives — avoids fragmenting the
    # reasoning into many tiny blockquotes.
    pending_thought: list[str] = []

    def _flush_thought() -> None:
        if pending_thought:
            # codex-style reasoning item -> renders as an italic "thinking"
            # blockquote (same shape Codex/cursor-acp use), kept separate from the
            # answer so it shows progress during long tool-heavy turns without
            # polluting the final message.
            emit({"type": "item.completed",
                  "item": {"type": "reasoning", "text": "".join(pending_thought)}})
            pending_thought.clear()

    try:
        resp = await agent.chat(prompt)
        async for item in resp.chunks:
            # Answer text deltas — stream as parser-native text parts.
            if isinstance(item, agt.Text):
                _flush_thought()
                txt = item.text or ""
                if txt:
                    answer_parts.append(txt)
                    emit({"type": "text", "part": {"type": "text", "text": txt}})
            # Reasoning ("thoughts") — buffer; surfaced as a reasoning block (not
            # part of the answer, not counted into result text).
            elif isinstance(item, agt.Thought):
                if item.text:
                    pending_thought.append(item.text)
            # Tool invocation.
            elif isinstance(item, agt.ToolCall):
                _flush_thought()
                emit({
                    "type": "tool_use",
                    "tool_name": _tool_name(item.name),
                    "parameters": item.args or {},
                })
        _flush_thought()  # trailing reasoning (e.g. turn cut off before an answer)
        usage = _usage(resp)
        final_text = "".join(answer_parts)
        # Prefer the SDK's resolved text if our concatenation came up empty.
        if not final_text:
            try:
                final_text = await resp.text()
            except Exception:
                final_text = ""
        # A turn that produced no text BECAUSE the provider errored (rate limit /
        # quota / terminated run) should be reported as an error, not a blank
        # bubble. The harness is still alive though (it ended the turn, not the
        # process), so this is NOT fatal — keep the warm daemon for the next turn.
        if not final_text and _TURN_ERRORS:
            is_error = True
            final_text = ("Antigravity produced no response — Gemini provider error "
                          "(likely rate limit / quota): " + _TURN_ERRORS[-1].strip()[:300])
    except asyncio.CancelledError:
        # Composer Stop cancels only this turn. Keep the Agent context/transport
        # alive so the next prompt continues the same in-memory conversation.
        interrupted = True
        final_text = ""
        usage = {}
    except Exception as e:  # infra failure (e.g. harness WS dropped) -> fatal
        is_error = True
        fatal = True
        final_text = f"{type(e).__name__}: {e}"
        usage = {}

    result = {
        "type": "result",
        "result": final_text,
        "session_id": session_id,
        "is_error": is_error,
    }
    if usage:
        result["usage"] = usage
    if interrupted:
        result["stop_reason"] = "interrupted"
    emit(result)
    # Keep the warm daemon alive across reported (non-fatal) errors like rate
    # limits; only exit on a real infra failure so the launcher relaunches fresh.
    return not fatal


def build_config(args) -> LocalAgentConfig:
    """LocalAgentConfig with autonomous tool use enabled (policy.allow_all())."""
    kwargs: dict = {"policies": [policy.allow_all()], "hooks": [_report_tool_result],
                    "api_key": configure_relay_auth()}
    if args.system:
        kwargs["system_instructions"] = args.system
    if args.work_dir:
        kwargs["workspaces"] = [args.work_dir]
    # NOTE: do NOT set conversation_id from the session id. conversation_id is a
    # RESUME handle — the harness tries to stat an existing trajectory file
    # (/tmp/antigravity_*/traj-<id>) and aborts with "conversation not found" if
    # it's absent (which it always is on a first turn). Warm mode keeps the
    # Conversation in memory across turns, so no resume id is needed; cross-process
    # resume (save_dir + conversation_id) is out of scope for v1.
    # Only forward a model if it looks like a Gemini/Antigravity model (the board
    # may pass a Claude model name for other harnesses — ignore those here).
    if args.model and not args.model.lower().startswith("claude"):
        kwargs["model"] = args.model
    return LocalAgentConfig(**kwargs)


async def main_async(args) -> int:
    session_id = args.session_id or uuid.uuid4().hex
    if args.work_dir:
        try:
            os.chdir(args.work_dir)
        except OSError:
            pass

    try:
        agent_cm = Agent(build_config(args))
        # `async with Agent(...) as agent` binds the Agent; mirror that, but fall
        # back to the Agent object itself if __aenter__ returns None.
        agent = (await agent_cm.__aenter__()) or agent_cm
    except Exception as e:
        # Startup failure (most commonly a missing/invalid GEMINI_API_KEY, which
        # the SDK rejects fast). Surface it as a structured error result instead
        # of an empty result + opaque traceback.
        emit({
            "type": "result",
            "result": f"agy-sdk startup failed: {type(e).__name__}: {e}",
            "session_id": session_id,
            "is_error": True,
        })
        return 1

    try:
        emit({"type": "init", "session_id": session_id})

        if args.once:
            prompt = args.prompt
            if prompt is None:  # no positional -> take the whole stdin as the prompt
                prompt = sys.stdin.read()
            await run_turn(agent, prompt, session_id)
            return 0

        # Warm loop: keep stdin consumption concurrent with agent.chat so an
        # interrupt control message can cancel one turn without terminating the
        # in-memory Conversation.
        loop = asyncio.get_event_loop()
        input_queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def read_input() -> None:
            while True:
                raw = await loop.run_in_executor(None, sys.stdin.readline)
                await input_queue.put(raw if raw else None)
                if not raw:
                    return

        pending_lines: list[str | None] = []
        input_reader = asyncio.create_task(read_input())
        while True:
            line = pending_lines.pop(0) if pending_lines else await input_queue.get()
            if line is None:  # FIFO write side closed -> shut the conversation down
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                # Tolerate a bare (non-JSON) prompt line.
                message = {"prompt": line}
            prompt = message.get("prompt", "")
            if prompt:
                turn = asyncio.create_task(run_turn(agent, prompt, session_id))
                ok = True
                input_closed = False
                while not turn.done():
                    control = asyncio.create_task(input_queue.get())
                    done, _ = await asyncio.wait(
                        {turn, control}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if turn in done:
                        if control.done():
                            pending_lines.append(control.result())
                        control.cancel()
                        try:
                            await control
                        except asyncio.CancelledError:
                            pass
                        break
                    control_line = control.result()
                    if control_line is None:
                        input_closed = True
                        turn.cancel()
                        await turn
                        break
                    try:
                        control_message = json.loads(control_line)
                    except json.JSONDecodeError:
                        control_message = {}
                    if control_message.get("prompt"):
                        pending_lines.append(control_line)
                    if control_message.get("action") == "interrupt":
                        turn.cancel()
                        try:
                            ok = await turn
                        except asyncio.CancelledError:
                            # The control line can win the scheduling race before
                            # run_turn executes its first instruction.
                            emit({
                                "type": "result",
                                "result": "",
                                "session_id": session_id,
                                "is_error": False,
                                "stop_reason": "interrupted",
                            })
                            ok = True
                        break
                if turn.done() and not turn.cancelled():
                    ok = turn.result()
                if not ok:
                    # Infra-level failure (e.g. harness WS dropped). Exit so the
                    # launcher relaunches a fresh daemon on the next turn rather
                    # than reusing a half-dead one for the rest of the conversation.
                    break
                if input_closed:
                    break
        input_reader.cancel()
        try:
            await input_reader
        except asyncio.CancelledError:
            pass
        return 0
    finally:
        # Always tear the Agent/connection down cleanly (mirrors `async with`).
        try:
            await agent_cm.__aexit__(None, None, None)
        except Exception:
            pass


def parse_args(argv):
    p = argparse.ArgumentParser(description="Antigravity SDK harness shim")
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true",
                      help="run one turn (prompt from positional arg or stdin) then exit")
    mode.add_argument("--warm", action="store_true",
                      help="long-lived: read one JSON prompt line per turn from stdin")
    p.add_argument("prompt", nargs="?", default=None,
                   help="prompt text for --once mode (the launcher appends it as the trailing arg)")
    p.add_argument("--session-id", default="", help="stable conversation/session id")
    p.add_argument("--system", default="", help="system instructions")
    p.add_argument("--work-dir", default="", help="workspace directory")
    p.add_argument("--model", default="", help="model name (gemini/* only; ignored otherwise)")
    return p.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
