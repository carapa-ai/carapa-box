import { expect, test } from 'bun:test';
import { fetchAccountModels } from './provider-models.js';

const respond = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

test('Codex and Claude lists drop hidden helpers and keep the limits each provider reports', async () => {
  const codex = await fetchAccountModels('codex', {}, respond({ models: [
    { slug: 'gpt-6-luna', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
      default_reasoning_level: 'medium', input_modalities: ['text', 'image'], minimal_client_version: '0.155.0' },
    { slug: 'codex-auto-review', visibility: 'hide' }] }));
  expect('models' in codex && codex.models).toEqual([{ id: 'gpt-6-luna', contextSize: 272000, reasoning: ['low', 'max'],
    defaultReasoning: 'medium', inputs: ['text', 'image'], minClientVersion: '0.155.0' }]);
  const claude = await fetchAccountModels('anthropic', {}, respond({ data: [
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000 }] }));
  expect('models' in claude && claude.models).toEqual([{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextSize: 1000000, maxOutputTokens: 128000 }]);
});

test('Antigravity hides helper models and calls only native backends', async () => {
  let called = '';
  const request = (async (url: string) => { called = url; return new Response(JSON.stringify({ models: {
    'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576, supportsImages: true },
    'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite' },
    'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)' },
    'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)' },
    'gemini-3.8-flash-tiered': { maxTokens: 1048576 },
    chat_20706: { displayName: 'helper' }, internal: { displayName: 'x', isInternal: true } } })); }) as unknown as typeof fetch;
  const result = await fetchAccountModels('antigravity', {}, request, { project_id: 'p', relayEndpoint: 'daily-cloudcode-pa.googleapis.com' });
  expect('models' in result && result.models).toEqual([
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', contextSize: 1048576, inputs: ['text', 'image'] },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' }]);
  expect(called).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
  const stored = await fetchAccountModels('antigravity', {}, request, { project_id: 'p', relayEndpoint: 'evil.example' });
  expect('error' in stored).toBe(true);
});
