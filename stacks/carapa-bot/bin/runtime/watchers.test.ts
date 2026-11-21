import { describe, expect, test } from 'bun:test';
import { shouldStopOnApiError } from './watchers';

const toolResult = (text: string) =>
  JSON.stringify({ type: 'item.completed', item: { aggregated_output: text } });

describe('shouldStopOnApiError', () => {
  test('tool output quoting API Error 500 does not stop the run', () => {
    expect(shouldStopOnApiError(toolResult('logs/old.log: API Error: 500 Internal server error'), '')).toBe(false);
  });

  test('stderr API Error 500 stops the run', () => {
    expect(shouldStopOnApiError('', 'API Error: 500 Internal server error')).toBe(true);
  });

  test('retryable errors win over fatal ones', () => {
    expect(shouldStopOnApiError('', 'API Error: 529 overloaded')).toBe(false);
    expect(shouldStopOnApiError('{"api_error_status":529}', 'API Error: 500')).toBe(false);
  });

  test('raw top-level JSON errors stop the run', () => {
    expect(shouldStopOnApiError('{"type":"result","api_error_status":401}', '')).toBe(true);
    expect(shouldStopOnApiError('{"error":"unknown"}', '')).toBe(true);
  });

  test('escaped error_status inside tool output is ignored', () => {
    expect(shouldStopOnApiError(toolResult('{"error_status":500}'), '')).toBe(false);
  });

  test('529 text in tool output does not disable stderr detection', () => {
    expect(shouldStopOnApiError(toolResult('API Error: 529'), 'API Error: 500')).toBe(true);
  });
});
