// Reads a k6 --summary-export "metrics" object for the baseline scenario.
//
// load/baseline.js tags every request with phase=warmup|measured and declares sub-metrics
// for each, so the summary carries the two phases separately. Reported benchmark figures
// use ONLY the measured phase; warm-up is exposed separately as the cold-start record.

/** Parse a sub-metric key like `http_req_duration{phase:measured,gw:gateway-2}`. */
function parseKey(key) {
  const m = /^([^{]+)\{(.+)\}$/.exec(key);
  if (!m) return null;
  const tags = {};
  for (const part of m[2].split(',')) {
    const i = part.indexOf(':');
    tags[part.slice(0, i)] = part.slice(i + 1);
  }
  return { metric: m[1], tags };
}

/** Find the sub-metric `metric` whose tags are exactly `want` (any order). */
function find(metrics, metric, want) {
  for (const [key, value] of Object.entries(metrics)) {
    const p = parseKey(key);
    if (!p || p.metric !== metric) continue;
    const names = Object.keys(p.tags);
    if (names.length === Object.keys(want).length && names.every((n) => p.tags[n] === want[n])) return value;
  }
  return undefined;
}

function latency(d) {
  return { p50: d.med, p95: d['p(95)'], p99: d['p(99)'], max: d.max };
}

/** Measured-phase statistics. `measureSeconds` is the configured measured window. */
export function measuredStats(metrics, { measureSeconds }) {
  const dur = find(metrics, 'http_req_duration', { phase: 'measured' });
  if (!dur) {
    // Legacy runs without phase tags: report the whole run and say so.
    return {
      source: 'whole-run',
      requests: metrics.http_reqs.count,
      throughput: metrics.http_reqs.rate,
      failed: metrics.http_req_failed?.passes ?? 0,
      ...latency(metrics.http_req_duration),
    };
  }
  const reqs = find(metrics, 'http_reqs', { phase: 'measured' });
  const failed = find(metrics, 'http_req_failed', { phase: 'measured' });
  return {
    source: 'measured',
    requests: reqs?.count ?? 0,
    // Count / window: k6's own `rate` for a sub-metric is divided by the WHOLE run length.
    throughput: (reqs?.count ?? 0) / measureSeconds,
    failed: failed?.passes ?? 0,
    ...latency(dur),
  };
}

/** Warm-up (cold-start) statistics, or null when the run had no warm-up phase. */
export function warmupStats(metrics) {
  const dur = find(metrics, 'http_req_duration', { phase: 'warmup' });
  if (!dur) return null;
  const reqs = find(metrics, 'http_reqs', { phase: 'warmup' });
  const failed = find(metrics, 'http_req_failed', { phase: 'warmup' });
  return { requests: reqs?.count ?? 0, failed: failed?.passes ?? 0, ...latency(dur) };
}

/** Measured-phase maximum latency per gateway replica: { 'gateway-1': ms, ... }. */
export function gatewayMax(metrics) {
  const out = {};
  for (const [key, value] of Object.entries(metrics)) {
    const p = parseKey(key);
    if (p?.metric === 'http_req_duration' && p.tags.phase === 'measured' && p.tags.gw) {
      out[p.tags.gw] = value.max;
    }
  }
  return out;
}
