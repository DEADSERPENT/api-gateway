// Proxy performance, healthy upstream, generous quota (so the limiter never rejects).
// Run via scripts/bench.sh; GATEWAYS is a comma-separated list of base URLs.
//
// One continuous run of WARMUP_S + MEASURE_S seconds with the SAME virtual users, so the
// connections opened during warm-up are the ones used while measuring. Each request is
// tagged phase=warmup|measured by the instant it is issued. Sub-metrics are declared for both
// phases (thresholds that always pass), so the summary reports them separately and the
// reported figures can use the measured phase only. Warm-up is kept as the cold-start record.
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { phaseAt } from './lib/phase.js';

const gateways = (__ENV.GATEWAYS || 'http://gateway-1:3000').split(',');
const vus = Number(__ENV.VUS || 20);
const warmupS = Number(__ENV.WARMUP_S ?? 10);
const measureS = Number(__ENV.MEASURE_S ?? 30);
const SLOW_MS = Number(__ENV.SLOW_MS || 500);
const gwName = (base) => base.replace(/^https?:\/\//, '').split(':')[0];

const subMetrics = {};
for (const phase of ['warmup', 'measured']) {
  subMetrics[`http_req_duration{phase:${phase}}`] = ['max>=0'];
  subMetrics[`http_reqs{phase:${phase}}`] = ['count>=0'];
  subMetrics[`http_req_failed{phase:${phase}}`] = ['rate>=0'];
  for (const g of gateways) subMetrics[`http_req_duration{phase:${phase},gw:${gwName(g)}}`] = ['max>=0'];
}

export const options = {
  scenarios: {
    steady: { executor: 'constant-vus', vus, duration: `${warmupS + measureS}s` },
  },
  thresholds: subMetrics,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const elapsedMs = exec.instance.currentTestRunDuration;
  const phase = phaseAt(elapsedMs, warmupS * 1000);
  const base = gateways[__ITER % gateways.length];
  const gw = gwName(base);
  const res = http.get(`${base}/api/v1/service-a/ping`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
    tags: { gw, phase },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
  if (res.timings.duration > SLOW_MS) {
    console.log(
      `SLOW phase=${phase} gw=${gw} total=${res.timings.duration.toFixed(0)}ms ` +
        `waiting=${res.timings.waiting.toFixed(0)}ms connecting=${res.timings.connecting.toFixed(0)}ms ` +
        `t=${(elapsedMs / 1000).toFixed(1)}s`,
    );
  }
}
