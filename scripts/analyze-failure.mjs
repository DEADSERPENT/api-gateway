// Usage: node scripts/analyze-failure.mjs <k6-output.ndjson>
// Derives fail-fast latency and recovery time from k6's per-request JSON output.
import { readFileSync } from 'node:fs';

const [, , file] = process.argv;
let failMs = NaN;
let restoreMs = NaN;
const pts = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  if (o.type !== 'Point') continue;
  if (o.metric === 'chaos_event') {
    if (o.data.tags.event === 'fail') failMs = Date.parse(o.data.time);
    if (o.data.tags.event === 'restore') restoreMs = Date.parse(o.data.time);
  } else if (o.metric === 'http_req_duration' && o.data.tags.scenario === 'traffic') {
    pts.push({ t: Date.parse(o.data.time), ms: o.data.value, status: Number(o.data.tags.status) });
  }
}
if (Number.isNaN(failMs) || Number.isNaN(restoreMs)) throw new Error('chaos events not found');
pts.sort((a, b) => a.t - b.t);
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const fmt = (n) => (n === null ? 'n/a' : n.toFixed(2));

const during = pts.filter((p) => p.t >= failMs && p.t < restoreMs);
const failed500 = during.filter((p) => p.status === 500);
const failFast = during.filter((p) => p.status === 503);
const firstOpen = failFast[0];
const afterRestore = pts.filter((p) => p.t >= restoreMs);
const firstOk = afterRestore.find((p) => p.status === 200);
const before = pts.filter((p) => p.t < failMs);

const report = {
  requests_total: pts.length,
  before_failure: { n: before.length, ok_pct: +(100 * before.filter((p) => p.status === 200).length / Math.max(1, before.length)).toFixed(1) },
  during_failure: {
    n: during.length,
    upstream_500_passed_through: failed500.length,
    fast_503_circuit_open: failFast.length,
    other: during.length - failed500.length - failFast.length,
    open_circuit_latency_ms: { p50: fmt(pct(failFast.map((p) => p.ms), 50)), p95: fmt(pct(failFast.map((p) => p.ms), 95)), p99: fmt(pct(failFast.map((p) => p.ms), 99)) },
    time_to_open_ms: firstOpen ? Math.round(firstOpen.t - failMs) : null,
  },
  recovery: {
    first_200_after_restore_ms: firstOk ? Math.round(firstOk.t - restoreMs) : null,
    ok_pct_after_first_200: firstOk ? +(100 * afterRestore.filter((p) => p.t >= firstOk.t && p.status === 200).length / Math.max(1, afterRestore.filter((p) => p.t >= firstOk.t).length)).toFixed(1) : null,
  },
};
console.log(JSON.stringify(report, null, 2));
