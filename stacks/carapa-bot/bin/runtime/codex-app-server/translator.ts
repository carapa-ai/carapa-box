import type { CodexRunnerArgs, JsonRecord, RpcMessage } from './types';
import { array, record, string } from './types';
import { planDisplayText, type PlanRenderer } from './plans';

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

export function translateMessage(
  args: CodexRunnerArgs,
  message: RpcMessage,
  renderPlan: PlanRenderer = (_id, text) => planDisplayText(args, text),
): JsonRecord | null {
  const params = record(message.params);
  const item = record(params.item);
  if (message.method === 'turn/started') return { type: 'turn.started' };
  if (message.method === 'item/agentMessage/delta' && params.delta) {
    return {
      type: 'item.updated',
      item: {
        id: params.itemId,
        type: 'agent_message',
        delta: String(params.delta),
      },
    };
  }
  if (message.method === 'item/started' && item.type === 'mcpToolCall') {
    return {
      type: 'item.started',
      item: {
        id: item.id,
        type: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
      },
    };
  }
  if (message.method === 'item/started' && item.type === 'commandExecution') {
    return {
      type: 'item.started',
      item: { id: item.id, type: 'command_execution', command: item.command || '' },
    };
  }
  if (message.method === 'item/completed') return completedItem(item, renderPlan);
  if (message.method === 'thread/tokenUsage/updated') {
    const usage = record(record(params.tokenUsage).last);
    return {
      type: 'turn.usage',
      usage: {
        input_tokens: usage.inputTokens || 0,
        cached_input_tokens: usage.cachedInputTokens || 0,
        cache_write_input_tokens: usage.cacheWriteInputTokens || 0,
        output_tokens: usage.outputTokens || 0,
        reasoning_output_tokens: usage.reasoningOutputTokens || 0,
      },
    };
  }
  if (message.method === 'error') {
    const error = record(params.error || message.error);
    return {
      type: 'item.completed',
      item: {
        type: 'error',
        message: error.message || params.message || 'error',
        ...(params.willRetry !== undefined ? { will_retry: Boolean(params.willRetry) } : {}),
        ...(error.codexErrorInfo !== undefined
          ? { codex_error_info: error.codexErrorInfo }
          : {}),
        ...(error.additionalDetails
          ? { additional_details: String(error.additionalDetails) }
          : {}),
      },
    };
  }
  return null;
}

function completedItem(item: JsonRecord, renderPlan: PlanRenderer): JsonRecord | null {
  if (item.type === 'mcpToolCall') {
    return {
      type: 'item.completed',
      item: {
        id: item.id,
        type: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
        ...(item.durationMs !== undefined ? { duration_ms: item.durationMs } : {}),
      },
    };
  }
  if (item.type === 'agentMessage') {
    return {
      type: 'item.completed',
      item: { id: item.id, type: 'agent_message', text: item.text || '' },
    };
  }
  if (item.type === 'plan') {
    const text = string(item.text);
    return {
      type: 'item.completed',
      item: { id: item.id, type: 'agent_message', text: renderPlan(string(item.id), text) },
    };
  }
  if (item.type === 'reasoning') {
    return {
      type: 'item.completed',
      item: { id: item.id, type: 'reasoning', text: item.text || '' },
    };
  }
  if (item.type === 'commandExecution') {
    return {
      type: 'item.completed',
      item: {
        id: item.id,
        type: 'command_execution',
        command: item.command || '',
        exit_code: item.exitCode ?? item.exit_code,
      },
    };
  }
  if (item.type === 'fileChange') {
    return {
      type: 'item.completed',
      item: {
        id: item.id,
        type: 'file_change',
        changes: array(item.changes || item.patch).map((change) => {
          const value = record(change);
          return {
            path: value.path || value.file || '?',
            kind: value.kind || value.type || 'update',
          };
        }),
      },
    };
  }
  if (item.type === 'error') {
    return {
      type: 'item.completed',
      item: { id: item.id, type: 'error', message: item.message || 'error' },
    };
  }
  return null;
}
