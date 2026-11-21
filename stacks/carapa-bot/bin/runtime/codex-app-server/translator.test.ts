import { describe, expect, test } from 'bun:test';
import type { CodexRunnerArgs, RpcMessage } from './types';
import {
  isCapacityFailure,
  isMeaningfulTurnMessage,
  translateMessage,
} from './translator';

const args: CodexRunnerArgs = {
  sessionId: '',
  model: '',
  fallbackModel: '',
  reasoningEffort: '',
  fallbackReasoningEffort: '',
  chatMode: '',
  systemPrompt: '',
  env: {},
};

const translate = (message: RpcMessage) => translateMessage(args, message);

describe('Codex app-server translation', () => {
  test('normalizes tool, command, file, and error events', () => {
    expect(
      translate({
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            server: 'board',
            tool: 'tasks_list',
            arguments: { status: 'todo' },
            result: { tasks: [] },
            status: 'completed',
            durationMs: 12,
          },
        },
      }),
    ).toEqual({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'board',
        tool: 'tasks_list',
        arguments: { status: 'todo' },
        result: { tasks: [] },
        error: undefined,
        status: 'completed',
        duration_ms: 12,
      },
    });
    expect(
      translate({
        method: 'item/completed',
        params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', exitCode: 0 } },
      }),
    ).toEqual({
      type: 'item.completed',
      item: { id: 'cmd-1', type: 'command_execution', command: 'pwd', exit_code: 0 },
    });
    expect(
      translate({
        method: 'item/completed',
        params: {
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ file: 'src/a.ts', type: 'create' }],
          },
        },
      }),
    ).toEqual({
      type: 'item.completed',
      item: {
        id: 'file-1',
        type: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'create' }],
      },
    });
    expect(
      translate({
        method: 'error',
        params: {
          error: { message: 'retrying', codexErrorInfo: 'capacity', additionalDetails: 'later' },
          willRetry: true,
        },
      }),
    ).toEqual({
      type: 'item.completed',
      item: {
        type: 'error',
        message: 'retrying',
        will_retry: true,
        codex_error_info: 'capacity',
        additional_details: 'later',
      },
    });
  });

  test('distinguishes capacity failures from meaningful turn output', () => {
    expect(
      isCapacityFailure({ method: 'error', params: { message: 'Selected model is at capacity' } }),
    ).toBe(true);
    expect(isMeaningfulTurnMessage({
      method: 'item/plan/delta', params: { itemId: 'plan-1', delta: '# Plan' },
    })).toBe(true);
    expect(isMeaningfulTurnMessage({
      method: 'item/completed', params: { item: { type: 'plan', text: '# Plan' } },
    })).toBe(true);
    expect(
      isMeaningfulTurnMessage({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: 'done' } },
      }),
    ).toBe(true);
    expect(
      isMeaningfulTurnMessage({ method: 'item/completed', params: { item: { type: 'reasoning' } } }),
    ).toBe(false);
  });
});
