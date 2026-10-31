// Breaker behaviour while service-b is failed and then restored.
// k6 itself injects the fault and stamps the events, so request times and fault times
// come from one clock (the host and the Docker VM clocks can differ by many ms).
// Per-request data is read from k6's JSON output by scripts/analyze-failure.mjs.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { sleep } from 'k6';

const gateway = __ENV.GATEWAY || 'http://gateway-1:3000';
const serviceB = __ENV.SERVICE_B_ADMIN || 'http://service-b:4002';
const failAfter = Number(__ENV.FAIL_AFTER_S || 10);
const failFor = Number(__ENV.FAIL_FOR_S || 15);
const chaosEvent = new Counter('chaos_event');

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
  http.get(`${gateway}/api/v1/service-b/ping`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
  });
}

const setMode = (mode) =>
  http.post(`${serviceB}/admin/mode`, JSON.stringify({ mode }), {
    headers: { 'Content-Type': 'application/json' },
  });

export function chaos() {
  sleep(failAfter);
  setMode('fail');
  chaosEvent.add(1, { event: 'fail' });
  sleep(failFor);
  setMode('ok');
  chaosEvent.add(1, { event: 'restore' });
}
