// Breaker behaviour while service-b is failed and then restored at a configured delay.
//
// k6 injects the fault and the restore itself. The mock service replies with the instant it
// switched mode (`changedAtMs`); that is recorded as the authoritative fault/restore
// timestamp. k6 and the services run in one Docker VM, so they share a clock, unlike the host.
// Each request is classified by outcome so a genuine success (`ok`) can be told apart from a
// request the open circuit rejected (`circuit_open`), which never counts as recovery.
// Per-request data is analysed by scripts/lib/failure-analysis.mjs.
import http from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { sleep } from 'k6';

const gateway = __ENV.GATEWAY || 'http://gateway-1:3000';
const serviceB = __ENV.SERVICE_B_ADMIN || 'http://service-b:4002';
const failAfterS = Number(__ENV.FAIL_AFTER_S || 10);
const failForMs = Number(__ENV.FAIL_FOR_MS || 15000); // restore this long after the fault

const chaosEvent = new Counter('chaos_event'); // k6-clock stamps around each admin call
const faultAt = new Gauge('fault_at_ms'); // value = service-reported epoch ms
const restoreAt = new Gauge('restore_at_ms'); // value = service-reported epoch ms
const reqMs = new Trend('req_ms', true); // tagged with outcome and status

export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-arrival-rate',
      exec: 'traffic',
      rate: Number(__ENV.RATE || 20),
      timeUnit: '1s',
      duration: __ENV.DURATION || '40s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    chaos: { executor: 'per-vu-iterations', exec: 'chaos', vus: 1, iterations: 1 },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function traffic() {
  const res = http.get(`${gateway}/api/v1/service-b/ping`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
  });
  let outcome = 'other';
  if (res.status === 200) outcome = 'ok';
  else if (res.status === 500) outcome = 'upstream_500';
  else if (res.status === 503) {
    try {
      if (res.json('error.code') === 'CIRCUIT_OPEN') outcome = 'circuit_open';
    } catch (_) {
      // not JSON: leave as "other"
    }
  }
  reqMs.add(res.timings.duration, { outcome, status: String(res.status) });
}

function setMode(mode, name) {
  chaosEvent.add(1, { event: `${name}_sent` });
  const res = http.post(`${serviceB}/admin/mode`, JSON.stringify({ mode }), {
    headers: { 'Content-Type': 'application/json' },
  });
  chaosEvent.add(1, { event: `${name}_ack` });
  return res.json('changedAtMs');
}

export function chaos() {
  sleep(failAfterS);
  faultAt.add(setMode('fail', 'fail'), { event: 'fail' });
  sleep(failForMs / 1000);
  restoreAt.add(setMode('ok', 'restore'), { event: 'restore' });
}
