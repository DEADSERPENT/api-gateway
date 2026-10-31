// Usage: node scripts/analyze-failure.mjs <k6.ndjson> <plan.json> <breaker-before.json> <breaker-after.json>
// plan.json: { seed, trial, planned_restore_delay_ms, cooldown_ms, arrival_interval_ms }
// breaker-*.json: output of scripts/breaker-counts.mjs taken before and after the trial.
// Prints the per-trial recovery record as JSON.
import { readFileSync } from 'node:fs';
import { analyzeFailure } from './lib/failure-analysis.mjs';

const [, , ndjson, planFile, beforeFile, afterFile] = process.argv;
if (!afterFile) throw new Error('usage: analyze-failure.mjs <k6.ndjson> <plan.json> <before.json> <after.json>');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const plan = read(planFile);
const before = read(beforeFile);
const after = read(afterFile);
const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0);

const analysis = analyzeFailure(readFileSync(ndjson, 'utf8').split('\n'), {
  plannedRestoreDelayMs: plan.planned_restore_delay_ms,
  cooldownMs: plan.cooldown_ms,
  arrivalIntervalMs: plan.arrival_interval_ms,
  transitions: { OPEN: delta('OPEN'), HALF_OPEN: delta('HALF_OPEN'), CLOSED: delta('CLOSED') },
});
console.log(JSON.stringify({ seed: plan.seed, trial: plan.trial, ...analysis }, null, 2));
