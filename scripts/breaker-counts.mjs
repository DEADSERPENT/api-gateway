// Usage: curl -s <gateway>/metrics | node scripts/breaker-counts.mjs [service=service-b]
// Prints the breaker transition counters for one service as JSON: { OPEN, HALF_OPEN, CLOSED }.
import { readFileSync } from 'node:fs';

const service = process.argv[2] ?? 'service-b';
const counts = { OPEN: 0, HALF_OPEN: 0, CLOSED: 0 };
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const m = /^gateway_breaker_transitions_total\{service="([^"]+)",to="([A-Z_]+)"\} (\d+)/.exec(line);
  if (m && m[1] === service && m[2] in counts) counts[m[2]] = Number(m[3]);
}
console.log(JSON.stringify(counts));
