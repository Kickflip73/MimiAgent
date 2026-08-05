import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.argv[2] || 'recover';
const logFile = process.argv[3];
if (logFile) appendFileSync(logFile, `spawn:${process.pid}\n`);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

write({
  type: 'status',
  inbound: 'unavailable',
  outbound: 'unavailable',
  freshForMs: 60_000,
  reasonCode: 'fixture_unavailable',
});

let healthChecks = 0;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message?.type !== 'action') return;
  if (message.action !== 'health_check') {
    write({ type: 'action_result', id: message.id, ok: false, error: 'unsupported action' });
    return;
  }
  healthChecks += 1;
  if (logFile) appendFileSync(logFile, `health:${process.pid}:${healthChecks}\n`);
  const ready = mode === 'recover';
  write({
    type: 'status',
    inbound: ready ? 'ready' : 'unavailable',
    outbound: ready ? 'ready' : 'unavailable',
    freshForMs: 60_000,
    ...(ready ? {} : { reasonCode: 'fixture_unavailable' }),
  });
  write({
    type: 'action_result',
    id: message.id,
    ok: true,
    result: { ready, healthChecks },
  });
});
