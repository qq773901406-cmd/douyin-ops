// The WinExe owner assigns this new process to its JobObject before sending
// this signal. Do not import the supervisor or create children before then.
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, terminal: false });
const granted = await new Promise(resolve => {
  input.once('line', line => { resolve(line === 'start'); input.close(); });
  input.once('close', () => resolve(false));
});
if (!granted) process.exit(3);
await import('./background-supervisor.mjs');
