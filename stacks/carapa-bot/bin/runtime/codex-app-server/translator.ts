import type { RpcMessage } from './types';
import { record, string } from './types';

export function isCapacityFailure(message: RpcMessage): boolean {
  let marker = '';
  try {
    marker = JSON.stringify(message).toLowerCase();
  } catch {
    marker = String(message).toLowerCase();
  }
  return /selected model is at capacity|model.{0,40}at capacity|serveroverloaded|server[_ -]?overloaded/.test(
    marker,
  );
}

export function isMeaningfulTurnMessage(message: RpcMessage): boolean {
  const params = record(message.params);
  const itemType = string(record(params.item).type);
  return (
    message.method === 'item/agentMessage/delta' ||
    message.method === 'item/plan/delta' ||
    (message.method === 'item/started' &&
      ['mcpToolCall', 'commandExecution', 'fileChange'].includes(itemType)) ||
    (message.method === 'item/completed' &&
      ['agentMessage', 'plan', 'mcpToolCall', 'commandExecution', 'fileChange'].includes(itemType))
  );
}

/** Visible turn output: the messages that count as the run's first output. */
export function isOutputMessage(message: RpcMessage): boolean {
  const params = record(message.params);
  const itemType = string(record(params.item).type);
  if (message.method === 'error') return true;
  if (message.method === 'item/agentMessage/delta') return Boolean(params.delta);
  if (message.method === 'item/started') return ['mcpToolCall', 'commandExecution'].includes(itemType);
  return (
    message.method === 'item/completed' &&
    ['mcpToolCall', 'agentMessage', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'error'].includes(itemType)
  );
}
