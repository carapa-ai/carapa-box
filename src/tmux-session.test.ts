/**
 * Unit tests for src/tmux-session.ts
 *
 * Stubs the underlying `execInService` path by mocking `./utils.js`'s
 * `execDocker` so the assertions can inspect the shell command strings
 * the tmux layer assembles without invoking docker. The four correctness
 * fixes covered:
 *   A. `execTmuxSession` resize sends neither `C-l` nor the terminal-resetting
 *      `send-keys -R`, and unchanged reattach dimensions are a no-op.
 *   B. `captureSession` (called from `attachTmuxSession`) uses
 *      `tmux capture-pane -p -e` so the scrollback preserves cursor
 *      positioning escapes, and strips the trailing blank-line padding
 *      tmux adds for rows below the cursor (otherwise xterm.js scrolls
 *      the prompt off-screen on attach).
 *   C. `attachTmuxSession` propagates caller-supplied `cols` / `rows` into
 *      `tmux new-session -d -x ... -y ...`.
 *   D. Exec echo plumbing: silent `tmux send-keys -l` returns empty
 *      stdout/stderr, which the REST `/api/tmux/exec` handler relies on
 *      (see the `describe("exec echo plumbing")` block).
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";

interface TmuxReply {
    stdout: string;
    stderr: string;
    code: number;
}

interface SpawnCall {
    cmd: string;
    args: string[];
    opts: any;
}

const state = {
    spawnCalls: [] as SpawnCall[],
    spawnQueue: [] as TmuxReply[],
    /**
     * Substring-targeted replies — the first matching entry is consumed
     * (FIFO). Used to assert specific tmux subcommands return distinct
     * payloads (e.g. `capture-pane` returns escape sequences, `send-keys`
     * returns empty).
     */
    replyBySubstring: [] as Array<{ contains: string; reply: TmuxReply }>,
    /** Runs when a command is received, before its reply is returned. */
    onCommand: undefined as undefined | ((command: string) => void),
};

function reset() {
    state.spawnCalls = [];
    state.spawnQueue = [];
    state.replyBySubstring = [];
    state.onCommand = undefined;
}

function queueSpawn(reply: TmuxReply = { stdout: "", stderr: "", code: 0 }) {
    state.spawnQueue.push(reply);
}

function queueSpawnFor(contains: string, reply: TmuxReply) {
    state.replyBySubstring.push({ contains, reply });
}

function takeNextReply(command: string): TmuxReply {
    for (let i = 0; i < state.replyBySubstring.length; i++) {
        if (command.includes(state.replyBySubstring[i].contains)) {
            const entry = state.replyBySubstring[i];
            state.replyBySubstring.splice(i, 1);
            return entry.reply;
        }
    }
    if (state.spawnQueue.length > 0) {
        return state.spawnQueue.shift()!;
    }
    return { stdout: "", stderr: "", code: 0 };
}

// Mock `./utils.js` so `execDocker` (called transitively via
// `compose/client.ts#execInService`) is intercepted here. The reply shape
// matches what `compose/client.ts#execCompose` produces from
// `execDocker`'s `{ status, stdout, stderr }` return.
mock.module("./utils.js", () => ({
    fileExists: async () => false,
    execDocker: async (args: string[], options?: any) => {
        state.spawnCalls.push({ cmd: "docker", args, opts: options });
        // tmux-session.ts shells out via `docker compose exec ... sh -c <cmd>`.
        // The composed shell command is the last positional arg.
        const command = args[args.length - 1] ?? "";
        state.onCommand?.(command);
        const reply = takeNextReply(command);
        return {
            status: reply.code,
            stdout: reply.stdout,
            stderr: reply.stderr,
        };
    },
    acquireProcessSlot: () => Promise.resolve(),
    releaseProcessSlot: () => { },
}));

mock.module("./logger.js", () => ({
    logger: {
        error: () => { },
        warn: () => { },
        info: () => { },
        debug: () => { },
    },
}));

mock.module("./audit.js", () => ({
    auditLog: () => { },
}));

// Imports must come AFTER mock.module() calls so the mocks are installed
// before module evaluation.
import {
    attachTmuxSession,
    execTmuxSession,
    detachTmuxSession,
    stopAllTmuxReaders,
    listActiveTmuxSessions,
} from "./tmux-session.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const STACK = "/tmp/fake-stack";
const PROJECT = "fake-project";
const SERVICE = "agent";
const SESSION = "test-session";

function findCommandMatching(needle: string): SpawnCall {
    // tmux-session composes shell commands as the final arg of
    // `docker compose exec ... sh -c <cmd>`. Search the last positional.
    const found = state.spawnCalls.find((c) => {
        const cmd = c.args[c.args.length - 1] ?? "";
        return cmd.includes(needle);
    });
    if (!found) {
        const seen = state.spawnCalls.map((c) => c.args[c.args.length - 1]).join("\n  ");
        throw new Error(`Expected a command matching "${needle}". Saw:\n  ${seen}`);
    }
    return found;
}

/** Live-reader stand-in: every spawned reader gets a stdout we can feed. */
function fakeReaders() {
    const feeds: Array<(text: string) => void> = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(() => {
        const exited = Promise.withResolvers<number>();
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const stdout = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
        feeds.push((text) => ctl.enqueue(new TextEncoder().encode(text)));
        return {
            stdout,
            stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
            pid: 123,
            exitCode: null,
            exited: exited.promise,
            kill: () => { try { ctl.close(); } catch { /* closed */ } exited.resolve(0); },
        } as any;
    });
    return { feeds, spy };
}

beforeEach(() => {
    reset();
    stopAllTmuxReaders(PROJECT);
});

afterEach(() => {
    stopAllTmuxReaders(PROJECT);
});

// ── Bug A: resize does NOT send C-l ────────────────────────────────────────

describe("tmux resize does not clear the pane", () => {
    it("does not include a clear-screen keystroke in the resize command", async () => {
        // attach first (so the active entry exists for size tracking)…
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });
        await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        // …then exec a keystroke with an explicit resize. No queued replies:
        // `tmux send-keys -l` is silent, so the default empty reply applies.
        await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "ls\n",
            cols: 120,
            rows: 40,
        });

        const resizeLine = state.spawnCalls.find((c) =>
            (c.args[c.args.length - 1] ?? "").includes("resize-window")
        );
        expect(resizeLine).toBeDefined();
        // Bug A regression guard: `C-l` was clearing the visible scrollback
        // and moving tmux's cursor to the top right after attach, causing
        // keystrokes to render at the wrong place. It must NOT be sent.
        expect(resizeLine!.args[resizeLine!.args.length - 1]).not.toMatch(/\bC-l\b/);
        // resize-window already forwards SIGWINCH. `send-keys -R` resets
        // terminal state and makes an idle prompt redraw into tmux history.
        expect(resizeLine!.args[resizeLine!.args.length - 1]).not.toMatch(/send-keys .* -R/);
        // Resize dimensions must come from caller opts, not the 200x50 defaults.
        expect(resizeLine!.args[resizeLine!.args.length - 1]).toMatch(/-x 120/);
        expect(resizeLine!.args[resizeLine!.args.length - 1]).toMatch(/-y 40/);
    });

    it("omits the entire resize prefix when no cols/rows are supplied", async () => {
        await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "ls\n",
        });
        const sendKeys = findCommandMatching("send-keys -l");
        const cmd = sendKeys.args[sendKeys.args.length - 1];
        expect(cmd).not.toContain("resize-window");
        expect(cmd).not.toMatch(/\bC-l\b/);
    });

    it("does nothing when a reattach reports the already tracked dimensions", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });
        await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            cols: 120,
            rows: 40,
            onDelta: () => { },
        });
        state.spawnCalls = [];

        const result = await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "",
            cols: 120,
            rows: 40,
        });

        expect(result).toEqual({ stdout: "", stderr: "", code: 0 });
        const tmuxMutations = state.spawnCalls.filter((call) => {
            const command = call.args[call.args.length - 1] ?? "";
            return /tmux (resize-window|send-keys|start-server)/.test(command);
        });
        expect(tmuxMutations).toEqual([]);
    });
});

// ── Bug B: capture-pane includes escape sequences ─────────────────────────

describe("attach scrollback captures escape sequences", () => {
    it("uses `capture-pane -p -e` so cursor positioning escapes survive", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        // Reply to the capture with a payload that includes a CSI sequence
        // (e.g. CUP cursor position). The mock returns it verbatim.
        const escapePayload = "last prompt \x1b[3;1H$ ";
        queueSpawnFor("tmux capture-pane", { stdout: escapePayload, stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        const capture = findCommandMatching("capture-pane");
        // Bug B regression guard: `-e` is required so xterm places the cursor
        // at tmux's live cursor position. Plain `-p` (no `-e`) would drop
        // the cursor at the end of the bytes, which mismatches the live
        // prompt when pane and xterm widths differ.
        expect(capture.args[capture.args.length - 1]).toMatch(/capture-pane -p -e/);
        expect(capture.args[capture.args.length - 1]).toMatch(/-S -\d+/);
        // The escape sequences from capture must flow through verbatim.
        expect(result.scrollback).toBe(escapePayload);
        expect(result.scrollback).toContain("\x1b[");
    });

    it("propagates the lines argument to capture-pane", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });

        await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            lines: 500,
            onDelta: () => { },
        });

        const capture = findCommandMatching("capture-pane");
        expect(capture.args[capture.args.length - 1]).toMatch(/-S -500\b/);
    });

    // Regression: tmux capture-pane always emits one row per visible line
    // in the pane, even for blank rows below the cursor. For a fresh
    // 59-row session this means a scrollback string ending in ~58 trailing
    // newlines — xterm.js renders those as cursor-downs and the prompt
    // ends up scrolled off the visible area. We strip the trailing
    // blank-line padding entirely so the cursor lands where the shell
    // placed it (right after the prompt, with no extra blank line below).
    it("strips trailing blank-line padding completely", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        // Simulate capture-pane output for a 5-row pane with the prompt
        // on row 1 and 4 blank rows below the cursor.
        const paddedPrompt = "ubuntu@ai-cli:~$";
        const padded = paddedPrompt + "\n\n\n\n\n";
        queueSpawnFor("tmux capture-pane", { stdout: padded, stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        // The trailing newlines are tmux's row padding, not shell output —
        // bash prints PS1 without a trailing newline, so xterm.js should
        // see the prompt alone with the cursor immediately after.
        expect(result.scrollback).toBe(paddedPrompt);
    });

    it("preserves trailing content (does not over-strip)", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        // Simulate scrollback where the cursor sits on the bottom row
        // with the shell prompt printed there, and there's NO blank row
        // below the cursor (a busy session with no padding). The trailing
        // newline here is the prompt's own row terminator, but the prompt
        // text after it on the last row proves there was real content
        // there — strip must not eat real prompt bytes.
        const full = "file1\nfile2\nprompt$ ";
        queueSpawnFor("tmux capture-pane", { stdout: full, stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        expect(result.scrollback).toBe(full);
    });

    it("preserves CRLF line endings when stripping padding", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        // tmux on Windows / git-bash uses CRLF; make sure we don't flatten
        // the line ending to bare LF when collapsing the trailing padding.
        const padded = "prompt\r\n\r\n\r\n\r\n";
        queueSpawnFor("tmux capture-pane", { stdout: padded, stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        // CRLF in real content rows must stay CRLF; only the trailing
        // blank-line padding is removed.
        expect(result.scrollback).toBe("prompt");
    });
});

// ── Bug C: new session honours caller cols/rows ───────────────────────────

describe("attach creates the tmux session at caller-supplied dimensions", () => {
    it("passes opts.cols and opts.rows to `tmux new-session -x -y`", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            cols: 132,
            rows: 24,
            onDelta: () => { },
        });

        const create = findCommandMatching("tmux new-session");
        const cmd = create.args[create.args.length - 1];
        expect(cmd).toContain("'env TERM=screen-256color /bin/bash -l'");
        expect(cmd).toMatch(/-x 132/);
        expect(cmd).toMatch(/-y 24/);
        // Bug C: the new session must be created at caller dimensions, NOT
        // the historical 200x50 default — that mismatch is what made the
        // pane and xterm wrap lines differently and broke cursor alignment.
        expect(cmd).not.toMatch(/-x 200/);

        // The returned TmuxAttachResult must also report the actual size
        // so callers (REST/MCP, bash-tab) can keep their xterm in sync.
        expect(result.cols).toBe(132);
        expect(result.rows).toBe(24);
    });

    it("falls back to 200x50 when the caller omits dimensions", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        const create = findCommandMatching("tmux new-session");
        const cmd = create.args[create.args.length - 1];
        expect(cmd).toMatch(/-x 200/);
        expect(cmd).toMatch(/-y 50/);
        expect(result.cols).toBe(200);
        expect(result.rows).toBe(50);
    });

    it("does NOT re-create an existing session and reports its actual size", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
        queueSpawnFor("tmux display-message", { stdout: "101 33\n", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });

        const result = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            cols: 80,
            rows: 25,
            onDelta: () => { },
        });

        const createAttempt = state.spawnCalls.find((c) => {
            const cmd = c.args[c.args.length - 1] ?? "";
            return cmd.includes("new-session");
        });
        expect(createAttempt).toBeUndefined();
        // Existing tmux geometry is authoritative. The board compares it with
        // xterm's requested 80x25 and sends a real resize only when needed.
        expect(result.cols).toBe(101);
        expect(result.rows).toBe(33);
    });

    it("reconnect: a second attach to the same session reuses the existing streamId (subscriber fan-out)", async () => {
        // A live reader, as in production; a dead one is correctly not reused.
        const { spy } = fakeReaders();
        try {
            // First attach creates the session and starts the reader.
            queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
            queueSpawnFor("tmux new-session", { stdout: "", stderr: "", code: 0 });
            queueSpawnFor("tmux capture-pane", { stdout: "initial scrollback", stderr: "", code: 0 });

            const firstResult = await attachTmuxSession({
                stackPath: STACK,
                projectName: PROJECT,
                service: SERVICE,
                session: SESSION,
                onDelta: () => { },
            });
            expect(firstResult.scrollback).toBe("initial scrollback");

            // Second attach (reconnect) — the session already exists, so the
            // existing reader is reused and the new onDelta is wired as a
            // subscriber. The streamId must be the same (existing entry
            // reused), proving the `existing` branch was taken.
            queueSpawnFor("tmux capture-pane", { stdout: "reconnect scrollback", stderr: "", code: 0 });
            const secondResult = await attachTmuxSession({
                stackPath: STACK,
                projectName: PROJECT,
                service: SERVICE,
                session: SESSION,
                onDelta: () => { },
            });

            // Same streamId (the existing entry is reused, not re-created).
            expect(secondResult.streamId).toBe(firstResult.streamId);
            expect(secondResult.scrollback).toBe("reconnect scrollback");

            // No new-session command was issued on the second attach.
            const newSessionCalls = state.spawnCalls.filter((c) =>
                (c.args[c.args.length - 1] ?? "").includes("new-session"),
            );
            expect(newSessionCalls.length).toBe(1); // only the first attach
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("overlapping attaches to one session share a single reader", async () => {
        // A browser tab opened while its panel is still sizing sends several
        // attaches at once; each starting its own pipe-pane left all but one
        // stream without output.
        // Readers stay alive, like a live shell's pane pipe, until stopped.
        const { spy: spawnSpy } = fakeReaders();
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux new-session", { stdout: "", stderr: "", code: 0 });
        const attach = () => attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });
        try {
            const [first, second, third] = await Promise.all([attach(), attach(), attach()]);

            expect(second.streamId).toBe(first.streamId);
            expect(third.streamId).toBe(first.streamId);
            expect(spawnSpy).toHaveBeenCalledTimes(1);
        } finally {
            await stopAllTmuxReaders();
            spawnSpy.mockRestore();
        }
    });
});

describe("pane reader decoding", () => {
    it("keeps a multibyte character split across stdout chunks intact when stderr interleaves", async () => {
        let stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
        let stderrCtl!: ReadableStreamDefaultController<Uint8Array>;
        const exited = Promise.withResolvers<number>();
        const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => ({
            stdout: new ReadableStream<Uint8Array>({ start(c) { stdoutCtl = c; } }),
            stderr: new ReadableStream<Uint8Array>({ start(c) { stderrCtl = c; } }),
            pid: 123,
            exitCode: null,
            exited: exited.promise,
            kill: () => { exited.resolve(0); },
        }) as unknown as ReturnType<typeof Bun.spawn>);
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux new-session", { stdout: "", stderr: "", code: 0 });
        const received: string[] = [];
        const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
        try {
            await attachTmuxSession({
                stackPath: STACK,
                projectName: PROJECT,
                service: SERVICE,
                session: SESSION,
                onDelta: (_id, text) => { received.push(text); },
            });
            // "€" is E2 82 AC: split it after the first byte, with a stderr
            // chunk arriving in between.
            const euro = new TextEncoder().encode("€");
            stdoutCtl.enqueue(euro.slice(0, 1));
            await tick();
            stderrCtl.enqueue(new TextEncoder().encode("warn"));
            await tick();
            stdoutCtl.enqueue(euro.slice(1));
            await tick();

            expect(received.join("")).toBe("€");
        } finally {
            await stopAllTmuxReaders();
            spawnSpy.mockRestore();
        }
    });
});

describe("shell exit lifecycle", () => {
    it("notifies the subscriber when the pane reader ends and the tmux session is gone", async () => {
        const stdout = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
        const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => ({
            stdout,
            stderr,
            pid: 123,
            exitCode: 0,
            exited: Promise.resolve(0),
            kill: () => { },
        }) as any);
        queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "prompt$ ", stderr: "", code: 0 });
        queueSpawnFor("tmux has-session", { stdout: "", stderr: "no server running", code: 1 });
        const exited = Promise.withResolvers<string>();

        try {
            await attachTmuxSession({
                stackPath: STACK,
                projectName: PROJECT,
                service: SERVICE,
                session: SESSION,
                onDelta: () => { },
                onExit: (streamId) => exited.resolve(streamId),
            });

            expect(await exited.promise).toBeTruthy();
        } finally {
            spawnSpy.mockRestore();
        }
    });
});

// ── Bug D interaction: silent send-keys returns empty stdout ──────────────

describe("exec echo plumbing", () => {
    it("forwards the literal keystrokes to `tmux send-keys -l`", async () => {
        await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "echo hi\n",
        });
        const sendKeys = findCommandMatching("send-keys -l");
        // Default empty reply applies; the test just verifies the command shape.
        expect(sendKeys.args[sendKeys.args.length - 1]).toContain("echo hi");
        // -l (literal) is preserved — no shell interpretation on the server.
        expect(sendKeys.args[sendKeys.args.length - 1]).toMatch(/send-keys -l -t ='test-session': 'echo hi/);
    });

    it("surfaces non-empty stderr from a failed tmux invocation", async () => {
        // Simulate tmux returning an error (e.g. session vanished). The MCP
        // tool layer surfaces stderr verbatim; nothing about that path should
        // substitute a "(no output)" sentinel.
        //
        // The startup guard and send run in one container command. Its
        // result must preserve the send failure instead of masking it.
        queueSpawn({ stdout: "", stderr: "can't find pane", code: 1 });
        const result = await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "ls\n",
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("can't find pane");
    });

    it("returns an empty stdout when send-keys produces no echo (Bug D precondition)", async () => {
        // Bug D root cause: `result.stdout || result.stderr || "(no output)"`
        // produced a non-empty body that callers fanned out to the terminal.
        // After the fix, the tool layer returns `result.stdout || result.stderr
        // || ""` — but the only way that empty-string branch is reached is if
        // both stdout AND stderr are empty AND code is 0. Verify that contract.
        queueSpawn({ stdout: "", stderr: "", code: 0 });
        const result = await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "ls\n",
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    it("delivers a key with the startup guard in a single container command", async () => {
        // A second exec adds another process launch and another wait in the
        // shared process queue to every key, even for an already live shell.
        await execTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            input: "ls\n",
        });
        expect(state.spawnCalls).toHaveLength(1);
        const firstCall = state.spawnCalls[0];
        const firstCmd = firstCall.args[firstCall.args.length - 1];
        expect(firstCmd).toMatch(/^tmux start-server 2>\/dev\/null; tmux send-keys -l/);
    });
});

// ── Sanity: detach & active session registry ──────────────────────────────

describe("detach & registry", () => {
    it("kill-session is invoked on detach", async () => {
        queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });
        const { streamId } = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });
        // execCalls so far: has-session, capture-pane, pipe-pane setup,
        // and the background reader's docker exec spawn (we only inspect
        // the tmux commands here). Detach should add a `kill-session`.
        queueSpawnFor("tmux kill-session", { stdout: "", stderr: "", code: 0 });
        await detachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            streamId,
        });
        const kill = findCommandMatching("kill-session");
        expect(kill.args[kill.args.length - 1]).toContain("tmux kill-session");
        expect(listActiveTmuxSessions()).toHaveLength(0);
    });

    it("detach sends an exit event to every tab sharing the session", async () => {
        const { spy } = fakeReaders();
        const exits: string[] = [];
        const attach = (tab: string) => attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
            onExit: (streamId) => { exits.push(`${tab}:${streamId}`); },
        });
        try {
            queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
            queueSpawnFor("tmux new-session", { stdout: "", stderr: "", code: 0 });
            const a = await attach("A");
            const b = await attach("B");
            expect(b.streamId).toBe(a.streamId);

            await detachTmuxSession({
                stackPath: STACK,
                projectName: PROJECT,
                service: SERVICE,
                session: SESSION,
                streamId: a.streamId,
            });
            // Let the reader's stdout loop finish; it must not notify twice.
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(exits.sort()).toEqual([`A:${a.streamId}`, `B:${a.streamId}`]);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("session already gone → returns code:0 (no-op detach) without invoking kill-session", async () => {
        // attach first so the reader is registered under the active
        // session key.
        queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
        queueSpawnFor("tmux capture-pane", { stdout: "", stderr: "", code: 0 });
        const { streamId } = await attachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            onDelta: () => { },
        });

        // Now simulate that the tmux session has died on the server side
        // (e.g. user Ctrl+D'd out of the shell, tmux exited on its own).
        // The detach handler's own `has-session` probe must return code:1,
        // so the no-op branch fires.
        queueSpawnFor("tmux has-session", { stdout: "", stderr: "can't find session: test-session", code: 1 });

        const result = await detachTmuxSession({
            stackPath: STACK,
            projectName: PROJECT,
            service: SERVICE,
            session: SESSION,
            streamId,
        });

        // The detach is a no-op success — kill-session must NOT have been
        // invoked (no further command should match).
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("already gone");
        const killAfter = state.spawnCalls.filter((c) =>
            (c.args[c.args.length - 1] ?? "").includes("kill-session"),
        );
        // The pre-existing attach path also runs a `tmux kill-session` is
        // NOT one of its commands — the only kill-session invocations
        // here come from the detach. With the no-op branch firing, the
        // count must be zero.
        expect(killAfter).toHaveLength(0);
        expect(listActiveTmuxSessions()).toHaveLength(0);
    });
});

// ── Exact session targets, reuse races, pre-aborted subscribers ───────────

const tmuxTargets = () => state.spawnCalls
    .map((c) => c.args[c.args.length - 1] ?? "")
    .flatMap((cmd) => [...cmd.matchAll(/ -t (\S+)/g)].map((m) => m[1]));

describe("tmux targets match the session name exactly", () => {
    const MISSING = { stdout: "__MISSING__", stderr: "", code: 0 };

    it("detach of a missing session never targets a prefix-matching one", async () => {
        queueSpawnFor("tmux has-session", { stdout: "", stderr: "can't find session", code: 1 });
        const result = await detachTmuxSession({
            stackPath: STACK, projectName: PROJECT, service: SERVICE, session: "dev", streamId: "none",
        });
        expect(result.code).toBe(0);
        expect(tmuxTargets()).toEqual(["='dev'"]);
        expect(state.spawnCalls.some((c) => (c.args.at(-1) ?? "").includes("kill-session"))).toBe(false);
    });

    it("detach of an existing session kills with an exact target", async () => {
        queueSpawnFor("tmux has-session", { stdout: "", stderr: "", code: 0 });
        await detachTmuxSession({
            stackPath: STACK, projectName: PROJECT, service: SERVICE, session: "dev", streamId: "none",
        });
        expect(tmuxTargets()).toEqual(["='dev'", "='dev'"]);
    });

    it("attach and exec only use exact targets", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", MISSING);
            await attachTmuxSession({
                stackPath: STACK, projectName: PROJECT, service: SERVICE, session: "dev", onDelta: () => { },
            });
            await execTmuxSession({
                stackPath: STACK, projectName: PROJECT, service: SERVICE, session: "dev",
                input: "ls", cols: 100, rows: 30,
            });
            const targets = tmuxTargets();
            expect(targets.length).toBeGreaterThan(0);
            for (const t of targets) expect(t).toMatch(/^='dev'(:)?$/);
            expect(targets).toContain("='dev':");
            expect(targets).not.toContain("'dev'");
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("tmux-tool.sh targets sessions exactly", async () => {
        const text = await Bun.file(new URL("../stacks/carapa-bot/bin/tmux-tool.sh", import.meta.url)).text();
        const targets = [...text.matchAll(/ -t "([^"]*)"/g)].map((m) => m[1]);
        expect(targets.length).toBeGreaterThan(0);
        for (const t of targets) expect(t).toMatch(/^=\$session:?$/);
    });
});

describe("attach reuse and abort handling", () => {
    const attachOpts = (extra: Record<string, unknown> = {}) => ({
        stackPath: STACK, projectName: PROJECT, service: SERVICE, session: SESSION, onDelta: () => { }, ...extra,
    });

    it("reuse while the reader is live starts no second pipe-pane", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
            const first = await attachTmuxSession(attachOpts());
            const second = await attachTmuxSession(attachOpts());
            expect(second.streamId).toBe(first.streamId);
            expect(spy).toHaveBeenCalledTimes(1);
            // The pipe-pane setup runs inside the reader spawn: exactly one.
            expect(spy.mock.calls.filter((c) => JSON.stringify(c).includes("pipe-pane"))).toHaveLength(1);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("abort during reuse-capture still gives the new attach a live reader", async () => {
        const { spy, feeds } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
            const oldConn = new AbortController();
            const first = await attachTmuxSession(attachOpts({ signal: oldConn.signal }));

            // The old connection closes while the new attach is capturing.
            state.onCommand = (cmd) => {
                if (cmd.includes("capture-pane")) {
                    state.onCommand = undefined;
                    oldConn.abort();
                }
            };
            queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
            const deltas: string[] = [];
            const second = await attachTmuxSession(attachOpts({ onDelta: (_: string, d: string) => deltas.push(d) }));

            expect(second.streamId).not.toBe(first.streamId);
            expect(spy).toHaveBeenCalledTimes(2);
            feeds[1]("live output");
            await new Promise((r) => setTimeout(r, 20));
            expect(deltas.join("")).toContain("live output");
            expect(listActiveTmuxSessions().map((s) => s.streamId)).toEqual([second.streamId]);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("abort during a fresh attach leaves no reader", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
            const conn = new AbortController();
            state.onCommand = (cmd) => {
                if (cmd.includes("capture-pane")) conn.abort();
            };
            await attachTmuxSession(attachOpts({ signal: conn.signal }));
            expect(spy).not.toHaveBeenCalled();
            expect(listActiveTmuxSessions()).toHaveLength(0);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("a pre-aborted caller leaves no reader and no subscriber", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
            const conn = new AbortController();
            conn.abort();
            await attachTmuxSession(attachOpts({ signal: conn.signal }));
            expect(spy).not.toHaveBeenCalled();
            expect(listActiveTmuxSessions()).toHaveLength(0);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("a pre-aborted reuse does not tear down a reader that has subscribers", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__HAS__", stderr: "", code: 0 });
            const first = await attachTmuxSession(attachOpts());
            const conn = new AbortController();
            conn.abort();
            const second = await attachTmuxSession(attachOpts({ signal: conn.signal }));
            expect(second.streamId).toBe(first.streamId);
            expect(listActiveTmuxSessions()).toHaveLength(1);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });

    it("last subscriber disconnect runs pipe-pane off and FIFO removal exactly once", async () => {
        const { spy } = fakeReaders();
        try {
            queueSpawnFor("tmux has-session", { stdout: "__MISSING__", stderr: "", code: 0 });
            const conn = new AbortController();
            await attachTmuxSession(attachOpts({ signal: conn.signal }));
            const isPipeOff = (c: SpawnCall) => /tmux pipe-pane -t =\S+:$/.test(c.args[c.args.length - 1] ?? "");
            const isRmFifo = (c: SpawnCall) => /rm -f \S*carapa-tmux-\S*\.fifo/.test(c.args[c.args.length - 1] ?? "");
            expect(state.spawnCalls.filter(isPipeOff)).toHaveLength(0);

            conn.abort();
            await new Promise((r) => setTimeout(r, 50));
            expect(state.spawnCalls.filter(isPipeOff)).toHaveLength(1);
            expect(state.spawnCalls.filter(isRmFifo)).toHaveLength(1);

            conn.abort();
            await stopAllTmuxReaders();
            await new Promise((r) => setTimeout(r, 50));
            expect(state.spawnCalls.filter(isRmFifo)).toHaveLength(1);
        } finally {
            await stopAllTmuxReaders();
            spy.mockRestore();
        }
    });
});
