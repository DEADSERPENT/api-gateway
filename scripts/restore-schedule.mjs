// Usage: node scripts/restore-schedule.mjs <seed> <trials> [minMs=15000] [spanMs=3000]
// Prints the restore delays (ms after the fault), one per line, for a benchmark run.
import { restoreDelays } from './lib/schedule.mjs';

const [, , seed, trials, minMs = '15000', spanMs = '3000'] = process.argv;
if (seed === undefined || trials === undefined) throw new Error('usage: restore-schedule.mjs <seed> <trials> [minMs] [spanMs]');
console.log(restoreDelays(Number(seed), Number(trials), { minMs: Number(minMs), spanMs: Number(spanMs) }).join('\n'));
