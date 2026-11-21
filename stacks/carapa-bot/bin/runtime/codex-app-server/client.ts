import { JsonRpcClient, object, type JsonObject, type RpcMethod } from '../protocol/rpc';

type ThreadConfig = JsonObject & { approvalPolicy: string; sandbox: string };
export interface CodexMethods {
  initialize: RpcMethod<{ clientInfo: { name: string; version: string }; capabilities?: { experimentalApi: boolean } }, JsonObject>;
  'thread/start': RpcMethod<ThreadConfig & { cwd: string }, JsonObject>;
  'thread/resume': RpcMethod<ThreadConfig & { threadId: string }, JsonObject>;
  'turn/start': RpcMethod<JsonObject & { threadId: string; input: Array<{ type: 'text'; text: string }> }, JsonObject>;
  'turn/steer': RpcMethod<{ threadId: string; expectedTurnId: string; clientUserMessageId: unknown; input: Array<{ type: 'text'; text: string }> }, JsonObject>;
  'turn/interrupt': RpcMethod<{ threadId: string; turnId: string }, JsonObject>;
}

export class CodexRpcClient extends JsonRpcClient<CodexMethods> {
  /** `onResult` runs when the response is read, before any event queued behind it. */
  constructor(writeLine: (line: string) => void, onResult?: (method: keyof CodexMethods, result: JsonObject) => void) {
    super(writeLine, (method, value) => {
      const result = object(value);
      onResult?.(method, result);
      return result;
    }, 30_000, false);
  }
}
