import type { RunV1TerminalStatus } from "../run-v1";
import { RunV1Writer } from "../run-v1";
import type { CodexRunnerArgs, JsonRecord, RpcMessage } from "./types";
import { array, record, string } from "./types";
import { createPlanRenderer, type PlanRenderer } from "./plans";

type PlanStatus = "pending" | "in_progress" | "completed";

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value)
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const value = record(entry);
      return string(value.text, string(value.content));
    })
    .filter(Boolean)
    .join("\n");
}

function reasoningText(item: JsonRecord): string {
  return [string(item.text), textBlocks(item.summary), textBlocks(item.content)]
    .filter(Boolean)
    .join("\n\n");
}

function planStatus(value: unknown): PlanStatus {
  if (value === "completed" || value === "done") return "completed";
  if (value === "inProgress" || value === "in_progress" || value === "active") {
    return "in_progress";
  }
  return "pending";
}

function terminalStatus(value: unknown): RunV1TerminalStatus {
  if (["interrupted", "cancelled", "canceled"].includes(String(value))) {
    return "interrupted";
  }
  if (["failed", "error"].includes(String(value))) return "failed";
  return "completed";
}

function failureMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  const object = record(value);
  return string(object.message, fallback);
}

function interactionId(message: RpcMessage): string {
  const params = record(message.params);
  return String(
    message.id ?? params.requestId ?? params.itemId ?? "codex-interaction",
  );
}

export class CodexRunV1Adapter {
  private readonly partialMessages = new Map<string, string>();
  private readonly completedMessages = new Set<string>();
  private readonly openTools = new Map<string, string>();
  private readonly interactions = new Set<string>();
  private started = false;
  private lastStatus: RunV1TerminalStatus = "completed";
  private lastStopReason = "end_turn";
  private lastError = "";

  constructor(
    private readonly writer: RunV1Writer,
    private readonly args: CodexRunnerArgs,
    private readonly renderPlan: PlanRenderer = createPlanRenderer(args),
  ) {}

  session(id: string, resumed: boolean): void {
    this.writer.append({
      type: "session",
      id,
      status: resumed ? "resumed" : "started",
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({
      type: "run",
      status: "started",
      ...(this.args.model ? { model: this.args.model } : {}),
      ...(this.args.reasoningEffort
        ? { reasoningEffort: this.args.reasoningEffort }
        : {}),
      ...(this.args.chatMode ? { mode: this.args.chatMode } : {}),
    });
  }

  beginTurn(model: string, reasoningEffort: string): void {
    this.start();
    this.writer.append({
      type: "run",
      status: "in_progress",
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  consume(message: RpcMessage): void {
    // App-server emits thread snapshots (including the previous turn's usage)
    // while initialize/resume is still in progress. The current run becomes
    // canonical only after main has published its session and run boundary.
    if (!this.started) return;
    const params = record(message.params);
    const item = record(params.item);
    switch (message.method) {
      case "item/agentMessage/delta":
      case "item/plan/delta":
        this.messageDelta(params);
        return;
      case "item/commandExecution/outputDelta":
        this.commandDelta(params);
        return;
      case "item/started":
        this.itemStarted(item);
        return;
      case "item/completed":
        this.itemCompleted(item);
        return;
      case "thread/tokenUsage/updated":
        this.usage(params);
        return;
      case "turn/plan/updated":
        this.plan(params);
        return;
      case "item/tool/requestUserInput":
      case "tool/requestUserInput":
        this.interactionRequested(message);
        return;
      case "serverRequest/resolved":
        this.interactionResolved(params);
        return;
      case "error":
        this.error(message);
        return;
      case "turn/completed":
        this.turnCompleted(params);
        return;
      default:
        return;
    }
  }

  runtimeError(error: unknown): void {
    this.start();
    const message = failureMessage(error, "Codex runtime failed");
    this.lastStatus = "failed";
    this.lastStopReason = "runtime_error";
    this.lastError = message;
    this.writer.append({ type: "error", message, fatal: true });
  }

  finish(): void {
    this.start();
    for (const [id, content] of this.partialMessages) {
      if (!content || this.completedMessages.has(id)) continue;
      this.writer.append({
        type: "message",
        id,
        role: "assistant",
        content,
        format: "markdown",
        status: "interrupted",
      });
    }
    for (const [id, name] of this.openTools) {
      this.writer.append({
        type: "tool_call",
        id,
        status: "failed",
        name,
        error: { message: "Codex turn ended before the tool completed" },
      });
    }
    for (const id of this.interactions) {
      this.writer.append({ type: "interaction", id, status: "cancelled" });
    }
    this.writer.finish(this.lastStatus, {
      stopReason: this.lastStopReason,
      ...(this.lastStatus === "failed" && this.lastError
        ? { error: { message: this.lastError } }
        : {}),
    });
  }

  private messageDelta(params: JsonRecord): void {
    const id = string(params.itemId, "codex-message");
    const delta = string(params.delta);
    if (!delta || this.completedMessages.has(id)) return;
    this.partialMessages.set(id, (this.partialMessages.get(id) ?? "") + delta);
    this.writer.append({ type: "message_delta", id, role: "assistant", delta });
  }

  private itemStarted(item: JsonRecord): void {
    const id = string(item.id);
    if (!id) return;
    if (item.type === "commandExecution") {
      this.openTools.set(id, "bash");
      this.writer.append({
        type: "tool_call",
        id,
        status: "started",
        name: "bash",
        category: "execute",
        input: {
          command: string(item.command),
          ...(item.cwd ? { cwd: item.cwd } : {}),
        },
      });
      return;
    }
    if (item.type === "mcpToolCall") {
      const server = string(item.server);
      const tool = string(item.tool, "mcp");
      const name = server ? `${server}/${tool}` : tool;
      this.openTools.set(id, name);
      this.writer.append({
        type: "tool_call",
        id,
        status: "started",
        name,
        category: "mcp",
        input: item.arguments ?? {},
      });
      return;
    }
    if (item.type === "fileChange") {
      this.openTools.set(id, "file_change");
      this.writer.append({
        type: "tool_call",
        id,
        status: "started",
        name: "file_change",
        category: "edit",
        input: { changes: array(item.changes || item.patch) },
      });
    }
  }

  private commandDelta(params: JsonRecord): void {
    const id = string(params.itemId);
    const delta = string(params.delta);
    if (!id || !delta) return;
    this.writer.append({
      type: "tool_call",
      id,
      status: "in_progress",
      outputDelta: delta,
    });
  }

  private itemCompleted(item: JsonRecord): void {
    const id = string(item.id);
    if ((item.type === "agentMessage" || item.type === "plan") && id) {
      const text = string(item.text) || this.partialMessages.get(id) || "";
      if (!text || this.completedMessages.has(id)) return;
      // Native proposed plans are assistant answers. The V1 plan event is
      // reserved for the separate turn/plan/updated progress checklist.
      const content = item.type === "plan" ? this.renderPlan(id, text) : text;
      this.completedMessages.add(id);
      this.writer.append({
        type: "message",
        id,
        role: "assistant",
        content,
        format: "markdown",
        status: "completed",
      });
      return;
    }
    if (item.type === "reasoning" && id) {
      const content = reasoningText(item);
      if (content) {
        this.writer.append({
          type: "thought",
          id,
          content,
          format: "markdown",
          status: "completed",
        });
      }
      return;
    }
    if (item.type === "commandExecution" && id) {
      const exitCode = Number.isFinite(Number(item.exitCode ?? item.exit_code))
        ? Number(item.exitCode ?? item.exit_code)
        : null;
      const failed =
        item.status === "failed" || (exitCode !== null && exitCode !== 0);
      this.openTools.delete(id);
      this.writer.append({
        type: "tool_call",
        id,
        status: failed ? "failed" : "completed",
        name: "bash",
        ...(item.aggregatedOutput ? { output: item.aggregatedOutput } : {}),
        exitCode,
        ...(failed
          ? {
              error: {
                message: `Command exited with code ${exitCode ?? "unknown"}`,
              },
            }
          : {}),
      });
      return;
    }
    if (item.type === "mcpToolCall" && id) {
      const failed =
        item.status === "failed" ||
        (item.error !== null && item.error !== undefined);
      const server = string(item.server);
      const tool = string(item.tool, "mcp");
      this.openTools.delete(id);
      this.writer.append({
        type: "tool_call",
        id,
        status: failed ? "failed" : "completed",
        name: server ? `${server}/${tool}` : tool,
        ...(item.result !== undefined && item.result !== null
          ? { output: item.result }
          : {}),
        ...(failed
          ? { error: { message: failureMessage(item.error, `${tool} failed`) } }
          : {}),
      });
      return;
    }
    if (item.type === "fileChange" && id) {
      const failed = item.status === "failed";
      this.openTools.delete(id);
      this.writer.append({
        type: "tool_call",
        id,
        status: failed ? "failed" : "completed",
        name: "file_change",
        output: { changes: array(item.changes || item.patch) },
        ...(failed ? { error: { message: "File change failed" } } : {}),
      });
      return;
    }
    if (item.type === "error") {
      const message = failureMessage(item.message, "Codex item failed");
      this.writer.append({ type: "error", message, fatal: false });
    }
  }

  private usage(params: JsonRecord): void {
    const usage = record(record(params.tokenUsage).last);
    this.writer.append({
      type: "usage",
      scope: "incremental",
      inputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cachedInputTokens: Number(usage.cachedInputTokens) || 0,
      cacheWriteInputTokens: Number(usage.cacheWriteInputTokens) || 0,
      reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0,
    });
  }

  private plan(params: JsonRecord): void {
    const turnId = string(params.turnId, "codex-turn");
    this.writer.append({
      type: "plan",
      id: `${turnId}-plan`,
      entries: array(params.plan).map((entry, index) => {
        const value = record(entry);
        return {
          id: string(value.id, `${turnId}-plan-${index + 1}`),
          content: string(value.step, string(value.content)),
          status: planStatus(value.status),
        };
      }),
    });
  }

  private interactionRequested(message: RpcMessage): void {
    const params = record(message.params);
    const id = interactionId(message);
    const itemId = string(params.itemId);
    if (itemId || message.id !== undefined) this.interactions.add(id);
    this.writer.append({
      type: "interaction",
      id,
      status: "requested",
      questions: array(params.questions).map((question, index) => {
        const value = record(question);
        return {
          id: string(value.id, `question-${index + 1}`),
          header: string(value.header, "Question"),
          question: string(value.question),
          options: array(value.options).map((option) => {
            const entry = record(option);
            return {
              label: string(entry.label),
              description: string(entry.description),
            };
          }),
          allowOther: Boolean(value.isOther ?? value.allowOther),
          secret: Boolean(value.isSecret ?? value.secret),
        };
      }),
    });
  }

  private interactionResolved(params: JsonRecord): void {
    const requestId = String(params.requestId ?? "");
    if (!requestId) return;
    this.writer.append({
      type: "interaction",
      id: requestId,
      status: "answered",
    });
    this.interactions.delete(requestId);
  }

  private error(message: RpcMessage): void {
    const params = record(message.params);
    const error = params.error ?? message.error ?? params.message;
    const text = failureMessage(error, "Codex error");
    const fatal = params.willRetry === false;
    this.writer.append({ type: "error", message: text, fatal });
    if (fatal) {
      this.lastStatus = "failed";
      this.lastStopReason = "provider_error";
      this.lastError = text;
    }
  }

  private turnCompleted(params: JsonRecord): void {
    const turn = record(params.turn);
    this.lastStatus = terminalStatus(turn.status);
    this.lastStopReason = string(turn.status, "end_turn");
    this.lastError = failureMessage(turn.error, "Codex turn failed");
    if (this.lastStatus !== "failed") this.lastError = "";
  }
}
