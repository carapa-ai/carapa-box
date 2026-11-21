import { randomUUID } from 'node:crypto';

export type RpcId = number | string;
export type JsonObject = Record<string, unknown>;
export interface RpcMessage extends JsonObject {
  id?: RpcId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: unknown;
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a protocol object');
  return value as JsonObject;
}

export interface RpcMethod<P = unknown, R = unknown> { params: P; result: R }
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** IDs belong to this connection, so old journal responses cannot settle new requests. */
export class JsonRpcClient<Methods extends { [K in keyof Methods]: RpcMethod }> {
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly prefix = randomUUID();
  private nextId = 0;

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly decode: <K extends keyof Methods>(method: K, value: unknown) => Methods[K]['result'],
    private readonly timeoutMs = 30_000,
    private readonly includeVersion = true,
  ) {}

  send<K extends keyof Methods & string>(method: K, params: Methods[K]['params']): Promise<Methods[K]['result']> {
    const id = `${this.prefix}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          try { resolve(this.decode(method, value)); } catch (error) { reject(error); }
        }, reject, timer,
      });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: JsonObject): void { this.write({ method, params }); }
  respond(id: RpcId, result: JsonObject): void { this.write({ id, result }); }

  handleResponse(message: RpcMessage): boolean {
    // A server request may use the same ID as an outstanding client request.
    if (message.method !== undefined || message.id === undefined ||
        (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined && message.error !== null) {
      const error = message.error;
      const detail = typeof error === 'object' && 'message' in error ? String(error.message) : JSON.stringify(error);
      pending.reject(new Error(detail));
    } else pending.resolve(message.result);
    return true;
  }

  rejectAll(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(normalized);
    }
    this.pending.clear();
  }

  private write(value: JsonObject): void { this.writeLine(`${JSON.stringify(this.includeVersion ? { jsonrpc: '2.0', ...value } : value)}\n`); }
}
