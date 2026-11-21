import { sendProtocol } from './daemon';
import { object, type JsonObject } from './rpc';

export type PiRequest = { id: string } & (
  | { type: 'get_state' }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'prompt' | 'steer'; message: string }
  | { type: 'abort' }
);

export function sendPi(input: string, request: PiRequest): void { sendProtocol(input, request); }

export function decodePiResponse(message: JsonObject, id: string): JsonObject | undefined {
  if (message.type !== 'response' || message.id !== id) return undefined;
  if (message.success !== true) throw new Error(String(message.error ?? 'Pi request failed'));
  if (message.data !== undefined) object(message.data);
  return message;
}
