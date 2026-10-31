// Rate-limit accuracy: one identity sends a constant arrival rate, split across all
// gateway replicas. With bucket capacity B and refill r, a correct limiter can admit at
// most B + r * T requests over T seconds (plus the final partial token).
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const gateways = (__ENV.GATEWAYS || 'http://gateway-1:3000,http://gateway-2:3000').split(',');
const allowed = new Counter('rl_allowed');
const limited = new Counter('rl_limited');
const other = new Counter('rl_other');

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 100),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const base = gateways[__ITER % gateways.length];
  const res = http.get(`${base}/api/v1/service-a/ping`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
  });
  if (res.status === 200) allowed.add(1);
  else if (res.status === 429) limited.add(1);
  else other.add(1);
}
