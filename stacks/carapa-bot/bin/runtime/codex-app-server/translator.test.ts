import { describe, expect, test } from 'bun:test';
import { isCapacityFailure, isMeaningfulTurnMessage } from './translator';

describe('Codex app-server message classification', () => {
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
