import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const transcript = process.env.TEST_PROTOCOL_TRANSCRIPT!;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
let sessionId = `native-agy-${process.pid}`;
// Like the real CLI: storage follows --gemini-dir, never GEMINI_HOME.
const conversations = join(process.argv[process.argv.indexOf('--gemini-dir') + 1], 'antigravity-cli', 'conversations');
mkdirSync(conversations, { recursive: true });
let promptId: unknown;
// The model the session runs on: the CLI default until set_config_option changes it.
let currentModel = 'gemini-default';
appendFileSync(transcript, JSON.stringify({ startup: true, pid: process.pid,
  argv: process.argv.slice(2), googleKeyPresent: !!process.env.GOOGLE_API_KEY,
  googleProjectPresent: !!process.env.GOOGLE_CLOUD_PROJECT,
  hasGeminiKey: !!process.env.GEMINI_API_KEY, geminiHome: process.env.GEMINI_HOME,
  dummyGeminiKey: process.env.GEMINI_API_KEY === 'carapa-relay-placeholder',
  endpoint: process.env.GOOGLE_GEMINI_BASE_URL, noProxy: process.env.NO_PROXY }) + '\n');
const update = (value: unknown) => send({ method: 'session/update', params: { sessionId, update: value } });
function complete() {
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'ok' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished' } });
  update({ sessionUpdate: 'usage_update', inputTokens: 10, outputTokens: 2 });
  send({ id: promptId, result: { stopReason: 'end_turn' } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(transcript, JSON.stringify(request) + '\n');
  if (request.id === 'permission-1' && request.result) { complete(); continue; }
  switch (request.method) {
    case 'initialize': send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } }); break;
    case 'authenticate': send({ id: request.id, result: {} }); break;
    case 'session/new':
      writeFileSync(join(conversations, `${sessionId}.db`), sessionId);
      send({ id: request.id, result: { sessionId, models: { currentModelId: currentModel, availableModels: [] } } }); break;
    case 'session/resume':
      if (!existsSync(join(conversations, `${request.params.sessionId}.db`))) send({ id: request.id, error: { code: -32000, message: 'Session not found in the current GEMINI_HOME' } });
      else { sessionId = request.params.sessionId; send({ id: request.id, result: {} }); }
      break;
    case 'session/set_config_option':
      if (request.params.configId === 'model') currentModel = request.params.value;
      send({ id: request.id, result: { configOptions: [] } }); break;
    case 'session/prompt': {
      promptId = request.id;
      const text = request.params.prompt[0].text;
      if (text === 'hold') break;
      if (text === 'provider-error') {
        // The real CLI (1.5.9) streams this error as assistant text, then resolves successfully.
        for (const chunk of ['\n⚠ agent executor ', 'error: generating and executing: Error 404, Message: Requested entity was not found., Status: NOT_FOUND, Details: []\n']) {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
        }
        send({ id: promptId, result: { stopReason: 'end_turn' } });
        break;
      }
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read', rawInput: { path: 'file' } });
      send({ id: 'permission-1', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: text === 'question' ? 'interaction_1' : 'tool-1' },
        options: [{ kind: 'allow_always', optionId: 'persistent' }, { kind: 'allow_once', optionId: 'native-once-opaque' }],
      } });
      break;
    }
    case 'session/cancel': send({ id: promptId, result: { stopReason: 'cancelled' } }); break;
    default: send({ id: request.id, error: { code: -32601, message: 'Unknown method' } });
  }
}
