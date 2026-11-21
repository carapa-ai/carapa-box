import { JsonRpcClient, object, type JsonObject, type RpcMethod } from './rpc';
import { sendProtocolLine } from './daemon';
import { readJournal, decodeObject, type JournalCursor } from './journal';
import { isAlive } from '../processes';

interface SessionInput extends JsonObject { cwd: string; mcpServers: unknown[] }
export interface AcpMethods {
  initialize: RpcMethod<{ protocolVersion: number; clientCapabilities: JsonObject; clientInfo: { name: string; version: string } }, JsonObject>;
  authenticate: RpcMethod<{ methodId: string }, JsonObject>;
  'session/new': RpcMethod<SessionInput, JsonObject>;
  'session/load': RpcMethod<SessionInput & { sessionId: string }, JsonObject>;
  'session/resume': RpcMethod<SessionInput & { sessionId: string }, JsonObject>;
  'session/set_config_option': RpcMethod<{ sessionId: string; configId: string; value: string | boolean }, JsonObject>;
  'session/set_model': RpcMethod<{ sessionId: string; modelId: string }, JsonObject>;
  'session/set_mode': RpcMethod<{ sessionId: string; modeId: string }, JsonObject>;
}

export type AcpRequest = {
  [K in keyof AcpMethods]: { method: K; params: AcpMethods[K]['params']; optional?: boolean }
}[keyof AcpMethods];

export class AcpRpcClient extends JsonRpcClient<AcpMethods> {
  constructor(writeLine: (line: string) => void) {
    super(writeLine, (method, value) => {
      const result = object(value);
      if (method === 'session/new' && (typeof result.sessionId !== 'string' || !result.sessionId)) throw new Error('ACP session/new returned no session id');
      return result;
    }, 20_000);
  }
}

/** Workers consume journals while the supervisor keeps pipes alive between workers. */
export async function requestAcp<K extends keyof AcpMethods>(
  state: { daemonPid: number; fifo: string; output: string; cursor: JournalCursor },
  method: K, params: AcpMethods[K]['params'], onMessage: (message: JsonObject) => void,
): Promise<{ result: JsonObject }> {
  const client = new AcpRpcClient(line => sendProtocolLine(state.fifo, line));
  let settled = false;
  const outcome = client.send(method, params).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    while (!settled) {
      for (const line of readJournal(state.output, state.cursor)) {
        const message = decodeObject(line);
        if (!message) continue;
        if (!client.handleResponse(message)) onMessage(message);
      }
      if (!isAlive(state.daemonPid)) client.rejectAll(new Error('ACP supervisor exited while awaiting response'));
      await Bun.sleep(10);
    }
    const response = await outcome;
    if ('error' in response) throw response.error;
    return { result: response.value };
  } finally { client.rejectAll(new Error('ACP request closed')); }
}
