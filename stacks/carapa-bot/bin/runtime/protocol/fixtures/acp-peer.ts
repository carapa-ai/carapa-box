import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const transcript = process.env.TEST_PROTOCOL_TRANSCRIPT!;
let sessionId = `session-${process.pid}`;
let pending: { id: string | number } | undefined;
function send(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(transcript, `${JSON.stringify({ pid: process.pid, ...request })}\n`);
  switch (request.method) {
    case 'initialize': send({ id: request.id, result: { protocolVersion: 1 } }); break;
    case 'session/new': send({ id: request.id, result: { sessionId } }); break;
    case 'session/resume':
    case 'session/load': sessionId = request.params.sessionId; send({ id: request.id, result: {} }); break;
    case 'session/prompt':
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
      if (request.params.prompt[0].text === 'hold') pending = request;
      else send({ id: request.id, result: { stopReason: 'end_turn' } });
      break;
    case 'session/cancel':
      if (pending) { send({ id: pending.id, result: { stopReason: 'cancelled' } }); pending = undefined; }
      break;
    default: send({ id: request.id, result: {} });
  }
}
