import { describe, expect, test } from 'bun:test';
import { shouldStopOnApiError } from './watchers';

describe('shouldStopOnApiError', () => {
  test('stderr API Error 500 stops the run', () => {
    expect(shouldStopOnApiError('API Error: 500 Internal server error')).toBe(true);
  });

  test('retryable errors win over fatal ones', () => {
    expect(shouldStopOnApiError('API Error: 529 overloaded')).toBe(false);
    expect(shouldStopOnApiError('API Error: 500\nAPI Error: 529 overloaded')).toBe(false);
  });
});
