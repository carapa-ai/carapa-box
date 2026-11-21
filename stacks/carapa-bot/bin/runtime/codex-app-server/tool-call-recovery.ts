import type { JsonRecord, RpcMessage } from './types';
import { array, record, string } from './types';

import { hasToolCallText } from '../tool-call-recovery';

/** Track all assistant output in this turn, even after subsequent tool actions. */
export class ToolCallRecovery {
  private readonly messages = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly completed = new Set<string>();

  consume(message: RpcMessage): void {
    const params = record(message.params);
    if (message.method === 'item/agentMessage/delta') {
      const id = string(params.itemId);
      this.seen.add(id);
      this.messages.set(id, (this.messages.get(id) || '') + string(params.delta));
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      this.item(record(params.item));
      if (message.method === 'item/completed') this.completed.add(string(record(params.item).id));
    } else if (message.method === 'turn/completed') {
      // Some providers supply only the final snapshot. Preserve completed
      // streamed messages while filling in missing or partial items.
      for (const value of array(record(params.turn).items)) {
        const item = record(value);
        const id = string(item.id);
        if (!this.seen.has(id) || (this.messages.has(id) && !this.completed.has(id))) this.item(item);
      }
    }
  }

  private item(item: JsonRecord): void {
    const id = string(item.id);
    this.seen.add(id);
    if (item.type === 'agentMessage') {
      if (typeof item.text === 'string') this.messages.set(id, item.text);
    }
  }

  needed(): boolean {
    return [...this.messages.values()].some(hasToolCallText);
  }
}
