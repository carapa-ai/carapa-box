import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpBackground, AcpBackgroundState } from '../acp/contracts';
import { atomicWrite } from '../files';

// Antigravity starts sub-agents without waiting for them, and when one reports back it
// runs a new turn of the main agent by itself. ACP stays silent meanwhile: the main
// agent's own turns are replayed, and billed, at the start of the next prompt (everything
// before its `user_message_chunk`), and sub-agents are never reported at all. The live
// record is the CLI's step logs, one JSON object per line, under
// <profile>/antigravity-cli/brain/<conversation>/.system_generated/. The format is
// private to the CLI; anything unreadable is ignored, which leaves the run as it was
// before this file existed.

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

interface LogState {
  /** Bytes of complete lines already read. */
  offset: number;
  /** Highest step_index read; for a sub-agent, its tokens are already billed. */
  step: number;
  /** The last step is not a final answer: a model call or a tool is still pending. */
  working: boolean;
  startedAt: number;
}

function readSteps(path: string, state: LogState): Json[] {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    // A rewritten log is read again from the start; step_index keeps it from being billed twice.
    if (size < state.offset) state.offset = 0;
    if (size === state.offset) return [];
    const buffer = Buffer.alloc(size - state.offset);
    const read = readSync(fd, buffer, 0, buffer.length, state.offset);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (end < 0) return [];
    state.offset += end + 1;
    const steps: Json[] = [];
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      let step: Json;
      try { step = record(JSON.parse(line)); } catch { continue; }
      if (typeof step.step_index !== 'number' || step.type === 'CHECKPOINT') continue;
      state.working = !(step.type === 'PLANNER_RESPONSE' && !(Array.isArray(step.tool_calls) && step.tool_calls.length));
      const created = Date.parse(String(step.created_at));
      if (!state.startedAt && Number.isFinite(created)) state.startedAt = created;
      if (step.step_index <= state.step) continue;
      state.step = step.step_index;
      steps.push(step);
    }
    return steps;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function toolTitle(name: string, args: Json): string {
  if (typeof args.CommandLine === 'string' && args.CommandLine) return args.CommandLine;
  if (typeof args.Path === 'string' && args.Path) return `File ${args.Path}`;
  return `Run ${name}`;
}

export class AntigravityBackground implements AcpBackground {
  private readonly brain: string;
  private readonly statePath: string;
  private readonly parent: LogState = { offset: 0, step: -1, working: false, startedAt: 0 };
  /** Sub-agent logs outlive a run, so their read positions are kept with the session. */
  private readonly agents: Record<string, LogState> = {};
  private readonly changedAt = new Map<string, number>();
  private readonly openTools: string[] = [];
  /** Main-agent messages and tool calls already shown from the log, which the next prompt replays. */
  private shown = { texts: 0, tools: 0 };
  private replayOver = false;

  constructor(profileDir: string, private readonly sessionId: string, sessionDir: string, private readonly idleLimitMs: number) {
    this.brain = join(profileDir, 'antigravity-cli', 'brain');
    this.statePath = join(sessionDir, 'antigravity-subagents.json');
    // Earlier turns of a long conversation are never needed; start at the end of the log.
    try { this.parent.offset = statSync(join(this.logs(sessionId), 'logs', 'transcript_full.jsonl')).size; } catch { /* No log yet. */ }
    try {
      const state = record(JSON.parse(readFileSync(this.statePath, 'utf8')));
      this.shown = { texts: count(record(state.shown).texts), tools: count(record(state.shown).tools) };
      for (const [id, saved] of Object.entries(record(state.agents))) {
        const value = record(saved);
        this.agents[id] = { offset: count(value.offset), step: typeof value.step === 'number' ? value.step : -1, working: value.working === true, startedAt: count(value.startedAt) };
      }
    } catch { /* First run of this session. */ }
  }

  private save(): void {
    try { atomicWrite(this.statePath, JSON.stringify({ shown: this.shown, agents: this.agents })); } catch { /* Positions only. */ }
  }

  /** True for a message of the running prompt that only repeats what `poll` already showed. */
  replayed(message: Json): boolean {
    if (this.replayOver) return false;
    const update = record(record(message.params).update);
    if (update.sessionUpdate === 'user_message_chunk') {
      this.replayOver = true;
      if (this.shown.texts || this.shown.tools) {
        this.shown = { texts: 0, tools: 0 };
        this.save();
      }
      return false;
    }
    const kind = update.sessionUpdate === 'agent_message_chunk' ? 'texts' : update.sessionUpdate === 'tool_call' ? 'tools' : null;
    if (!kind || !this.shown[kind]) return false;
    this.shown[kind]--;
    return true;
  }

  private logs(id: string): string {
    return join(this.brain, id, '.system_generated');
  }

  /** Sub-agents of `id` and of their own sub-agents, with the role the agent gave them. */
  private discover(id: string, found: Map<string, { description: string; killed: boolean }>): void {
    let names: string[];
    try { names = readdirSync(join(this.logs(id), 'subagents')); } catch { return; }
    for (const name of names.filter(value => value.endsWith('.json'))) {
      let entry: Json;
      try { entry = record(JSON.parse(readFileSync(join(this.logs(id), 'subagents', name), 'utf8'))); } catch { continue; }
      const child = typeof entry.conversationId === 'string' ? entry.conversationId : '';
      if (!/^[A-Za-z0-9-]+$/.test(child) || found.has(child)) continue;
      const descriptor = record(entry.subagentDescriptor);
      found.set(child, {
        description: String(descriptor.role || descriptor.typeName || 'Sub-agent'),
        killed: entry.state === 'SUBAGENT_STATE_KILLED',
      });
      this.discover(child, found);
    }
  }

  poll(promptReturned: boolean): AcpBackgroundState {
    const now = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };
    const bill = (step: Json) => {
      usage.inputTokens += count(step.input_tokens);
      usage.outputTokens += count(step.output_tokens);
      usage.cachedReadTokens += count(step.cache_read_tokens);
    };
    const updates: Json[] = [];
    const update = (value: Json) => updates.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.sessionId, update: value } });
    const closeTools = () => {
      for (const id of this.openTools.splice(0)) update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
    };

    const parentSteps = readSteps(join(this.logs(this.sessionId), 'logs', 'transcript_full.jsonl'), this.parent);
    if (parentSteps.length) this.changedAt.set(this.sessionId, now);
    // A sub-agent stopped by an error (e.g. a 429 quota) writes nothing more; only the parent hears of it.
    const failed = new Set<string>();
    for (const step of parentSteps) {
      if (step.type !== 'SYSTEM_MESSAGE' || typeof step.content !== 'string') continue;
      for (const match of step.content.matchAll(/The subagent [^\n]*? with id "([A-Za-z0-9-]+)" encountered an error and has either stopped or failed to start/g)) {
        failed.add(match[1]);
      }
    }
    let saved = false;
    if (promptReturned) {
      // Everything up to here was reported by the prompt that just returned.
      this.parent.working = false;
      this.openTools.length = 0;
      this.replayOver = false;
      saved = this.shown.texts + this.shown.tools > 0;
      this.shown = { texts: 0, tools: 0 };
    } else {
      for (const step of parentSteps) {
        if (step.type === 'PLANNER_RESPONSE') {
          closeTools();
          if (typeof step.content === 'string' && step.content) {
            this.shown.texts++;
            saved = true;
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${step.content}` } });
          }
          (Array.isArray(step.tool_calls) ? step.tool_calls : []).forEach((value, index) => {
            const call = record(value);
            const id = `antigravity-step-${step.step_index}-${index}`;
            this.openTools.push(id);
            this.shown.tools++;
            saved = true;
            update({ sessionUpdate: 'tool_call', toolCallId: id, title: toolTitle(String(call.name || 'tool'), record(call.args)), rawInput: record(call.args) });
          });
        } else if (step.type === 'GENERIC' && this.openTools.length) {
          const output = typeof step.content === 'string' ? step.content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '') : '';
          update({ sessionUpdate: 'tool_call_update', toolCallId: this.openTools.shift()!, status: step.status === 'ERROR' ? 'failed' : 'completed', rawOutput: output });
        }
      }
    }

    const found = new Map<string, { description: string; killed: boolean }>();
    this.discover(this.sessionId, found);
    const tasks: AcpBackgroundState['tasks'] = [];
    for (const [id, agent] of found) {
      const known = id in this.agents;
      const state = this.agents[id] ??= { offset: 0, step: -1, working: true, startedAt: 0 };
      const before = state.offset;
      for (const step of readSteps(join(this.logs(id), 'logs', 'transcript.jsonl'), state)) bill(step);
      if (!known || state.offset !== before) {
        saved = true;
        this.changedAt.set(id, now);
      }
      if (failed.has(id) && state.working) {
        state.working = false;
        saved = true;
      }
      if (!this.changedAt.has(id)) this.changedAt.set(id, now);
      // A sub-agent that stopped writing mid-step is treated as gone, not waited on forever.
      // It is also saved as not working: the idle clock is not kept, so a later run would wait the limit again.
      if (state.working && !agent.killed && now - this.changedAt.get(id)! >= this.idleLimitMs) {
        state.working = false;
        saved = true;
      }
      if (state.working && !agent.killed) {
        tasks.push({ id, description: agent.description, startedAt: state.startedAt || now });
      }
    }
    if (saved) this.save();
    const parentBusy = this.parent.working && now - (this.changedAt.get(this.sessionId) ?? now) < this.idleLimitMs;
    if (!parentBusy && !tasks.length) closeTools();
    const billed = usage.inputTokens + usage.outputTokens + usage.cachedReadTokens;
    return {
      tasks,
      busy: parentBusy || tasks.length > 0,
      updates,
      // Sub-agents only. Shaped like ACP PromptResponse.usage, where Antigravity's input excludes cache reads.
      ...(billed ? { usage: { ...usage, totalTokens: billed } } : {}),
    };
  }
}
