import { expect, test } from 'bun:test';
import { availableModels } from './models';

// Shapes recorded from grok-acp (initialize + session/new), antigravity-acp and muse-acp replies.
test('model lists are read from each harness reply format', () => {
  expect(availableModels(
    { protocolVersion: 1, _meta: { modelState: { availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: {
      totalContextTokens: 256000, reasoningEfforts: [{ value: 'xhigh', default: false }, { value: 'high', default: true }] } }] } } },
    { sessionId: 's', models: { availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } }))
    .toEqual([{ id: 'grok-4.7', name: 'Grok 4.7', contextSize: 256000, reasoning: ['xhigh', 'high'], defaultReasoning: 'high' }]);
  expect(availableModels({
    models: { currentModelId: 'gemini-3.7-flash-high', availableModels: [{ modelId: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' }] },
    configOptions: [{ id: 'model', options: [{ value: 'gemini-3.7-flash-high' }, { value: 'gemini-3.7-flash-low' }] }, { id: 'mode', options: [{ value: 'yolo' }] }],
  })).toEqual([{ id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' }, { id: 'gemini-3.7-flash-low' }]);
  expect(availableModels({ sessionId: 's', configOptions: [{ id: 'model', category: 'model', options: [{ value: 'muse-spark-1.3', name: 'Muse Spark 1.3' }] }] }))
    .toEqual([{ id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }]);
  expect(availableModels({ sessionId: 's' })).toEqual([]);
});
