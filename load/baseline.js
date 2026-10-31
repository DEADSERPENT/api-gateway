// Proxy performance, healthy upstream, generous quota (so the limiter never rejects).
// Run via scripts/bench.sh; GATEWAYS is a comma-separated list of base URLs.
import http from 'k6/http';
import { check } from 'k6';

const gateways = (__ENV.GATEWAYS || 'http://gateway-1:3000').split(',');
const vus = Number(__ENV.VUS || 20);

export const options = {
  scenarios: {
    steady: { executor: 'constant-vus', vus, duration: __ENV.DURATION || '30s' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const base = gateways[__ITER % gateways.length];
  const res = http.get(`${base}/api/v1/service-a/ping`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
}
