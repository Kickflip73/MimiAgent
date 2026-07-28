let input = '';

if (process.argv.includes('--unavailable')) {
  process.stdout.write(`${JSON.stringify({
    type: 'status',
    inbound: 'unavailable',
    outbound: 'unavailable',
  })}\n`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({
      type: 'action_result',
      id: message.id,
      ok: true,
      result: {
        action: message.action,
        target: message.target,
        payload: message.payload,
      },
    })}\n`);
  }
});
