import type { CarapaRunEventV1 } from './run-v1';

export const TOOL_CALL_CORRECTION =
  'Tool protocol correction: your last response contained tool-call markup as ordinary answer text. ' +
  'That text did not execute a tool. Continue the original request in this same session using the actual available tools and structured JSON arguments ' +
  '(booleans true/false, numbers without quotes). Do not print tool-call markup or claim an action succeeded without a tool result. ' +
  'Keep all earlier tool results and completed work; do not repeat actions that already ran. ' +
  'If the required tool is unavailable, explain the limitation instead of inventing a call.';

/** Recognize attempted calls, never interpret their arguments or execute them. */
export function hasToolCallText(text: string): boolean {
  let fence: { marker: string; length: number } | undefined;
  const unquoted = text.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    // Quoted documentation and indented code are data, not attempted calls.
    if (fence || /^(?: {0,3}>| {4}|\t)/.test(line)) return '';
    return line;
  }).join('\n');
  return /(?:^|\n) {0,3}<tool_call>\s*(?:<function\s*=\s*[^>\s]+>|\{\s*"(?:name|function)"\s*:|[\w.:-]+>)/i.test(unquoted) ||
    /(?:^|\n) {0,3}<function\s*=\s*[^>\s]+>\s*<parameter\s*=/i.test(unquoted) ||
    /(?:^|\n) {0,3}<tool_use>\s*<name>[^<]+<\/name>/i.test(unquoted);
}

export const TOOL_CALL_CORRECTION_NOTICE =
  'The model wrote a tool call as text, so that call was not executed. Asking it to correct the call automatically.';
export const TOOL_CALL_CORRECTION_FAILURE =
  'The model still returned tool-call text after one automatic correction. Those text-only calls were not executed. Check the provider tool-call configuration or choose another model.';

/** One correction budget per run, shared by every transport. */
export class ToolCallCorrection {
  private attempts = 0;

  next(): string {
    if (this.attempts >= 1) throw new Error(TOOL_CALL_CORRECTION_FAILURE);
    this.attempts++;
    return TOOL_CALL_CORRECTION;
  }
}

/** Observe normalized assistant output only; never interpret or execute markup.
 * Only an explicit correction settles text; unrelated tools cannot prove a printed call ran.
 * Keep offsets across corrections so final snapshots cannot resurrect old calls.
 */
export class ToolCallRecovery extends ToolCallCorrection {
  private readonly messages = new Map<string, { text: string; settled: number }>();

  private suppressed = false;

  /** Run `fn` while its emitted events are ignored (subagent output is not the parent's response). */
  suppress(fn: () => void): void {
    const previous = this.suppressed;
    this.suppressed = true;
    try { fn(); } finally { this.suppressed = previous; }
  }

  consume(event: CarapaRunEventV1): void {
    if (this.suppressed) return;
    if ((event.type === 'message' || event.type === 'message_delta') && event.role === 'assistant') {
      const previous = this.messages.get(event.id) ?? { text: '', settled: 0 };
      const text = event.type === 'message_delta' ? previous.text + event.delta : event.content;
      this.messages.set(event.id, { text, settled: Math.min(previous.settled, text.length) });
    }
  }

  needed(): boolean {
    return [...this.messages.values()].some(({ text, settled }) => hasToolCallText(text.slice(settled)));
  }

  override next(): string {
    const prompt = super.next();
    this.settle();
    return prompt;
  }

  /** Mark what was observed so far as handled, without spending the correction budget. */
  settle(): void {
    for (const message of this.messages.values()) message.settled = message.text.length;
  }
}
