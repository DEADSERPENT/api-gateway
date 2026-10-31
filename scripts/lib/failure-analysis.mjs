// Turns the NDJSON that k6 writes for load/downstream-failure.js into a recovery record.
//
// Inputs from the k6 run:
//   fault_at_ms / restore_at_ms  Gauges whose VALUE is the epoch-ms instant the mock service
//                                reported switching mode (authoritative: same VM clock as k6).
//   chaos_event                  Counter stamped by k6 around each admin call, used only to
//                                sanity-check that the service timestamp is plausible.
//   req_ms                       Trend per gateway request: value = duration (ms), tags
//                                outcome (ok | circuit_open | upstream_500 | other) and status.
//                                A sample's `time` is when the request completed.

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * @param {string[]} lines raw NDJSON lines from `k6 --out json`
 * @param {{plannedRestoreDelayMs:number, cooldownMs:number, arrivalIntervalMs:number,
 *          transitions:{OPEN:number,HALF_OPEN:number,CLOSED:number}}} opts
 */
export function analyzeFailure(lines, opts) {
  let faultAt = null;
  let restoreAt = null;
  const clientEvents = {};
  const reqs = [];
  for (const raw of lines) {
    if (!raw) continue;
    const o = JSON.parse(raw);
    if (o.type !== 'Point') continue;
    const t = Date.parse(o.data.time);
    const tags = o.data.tags ?? {};
    if (o.metric === 'fault_at_ms') faultAt = o.data.value;
    else if (o.metric === 'restore_at_ms') restoreAt = o.data.value;
    else if (o.metric === 'chaos_event') clientEvents[tags.event] = t;
    else if (o.metric === 'req_ms' && tags.outcome) {
      reqs.push({ end: t, ms: o.data.value, outcome: tags.outcome });
    }
  }
  if (faultAt === null) throw new Error('fault_at_ms not found in k6 output');
  if (restoreAt === null) throw new Error('restore_at_ms not found in k6 output');
  reqs.sort((a, b) => a.end - b.end);

  const before = reqs.filter((r) => r.end < faultAt);
  const during = reqs.filter((r) => r.end >= faultAt && r.end < restoreAt);
  const count = (xs, outcome) => xs.filter((r) => r.outcome === outcome).length;
  const openDuring = during.filter((r) => r.outcome === 'circuit_open');
  const firstOpen = openDuring[0];

  // Recovery = first genuine success (a 200 from the upstream) after the restore. An
  // open-circuit 503 means the breaker is still rejecting, so it never counts.
  const afterRestore = reqs.filter((r) => r.end >= restoreAt);
  const firstOk = afterRestore.find((r) => r.outcome === 'ok');
  const beforeFirstOk = firstOk ? afterRestore.filter((r) => r.end < firstOk.end) : afterRestore;
  const afterRecovery = firstOk ? afterRestore.filter((r) => r.end > firstOk.end) : [];
  const stayedRecovered = firstOk ? afterRecovery.every((r) => r.outcome === 'ok') : false;

  // Model check: the breaker restarts its cooldown at each failed probe, so the next probe is
  // admitted `cooldown` after the last upstream failure before the restore.
  const lastFailedProbe = [...during].reverse().find((r) => r.outcome === 'upstream_500');
  const recoveryMs = firstOk ? firstOk.end - restoreAt : null;
  const predicted = lastFailedProbe
    ? Math.max(0, lastFailedProbe.end + opts.cooldownMs - restoreAt)
    : null;

  const ack = clientEvents.restore_ack;
  const sent = clientEvents.restore_sent;
  const withinWindow =
    ack !== undefined && sent !== undefined ? restoreAt >= sent - 50 && restoreAt <= ack + 50 : null;

  const recovered = firstOk !== undefined;
  return {
    plan: {
      planned_restore_delay_ms: opts.plannedRestoreDelayMs,
      cooldown_ms: opts.cooldownMs,
      arrival_interval_ms: opts.arrivalIntervalMs,
    },
    timestamps: {
      fault_at_ms: faultAt,
      restore_at_ms: restoreAt,
      actual_restore_delay_ms: restoreAt - faultAt,
      restore_delay_error_ms: restoreAt - faultAt - opts.plannedRestoreDelayMs,
      restore_within_client_window: withinWindow,
      first_circuit_open_at_ms: firstOpen ? firstOpen.end : null,
      first_ok_after_restore_at_ms: firstOk ? firstOk.end : null,
    },
    requests_total: reqs.length,
    before_fault: {
      n: before.length,
      ok_pct: +((100 * count(before, 'ok')) / Math.max(1, before.length)).toFixed(1),
    },
    during_failure: {
      n: during.length,
      upstream_500: count(during, 'upstream_500'),
      circuit_open: openDuring.length,
      other: during.length - count(during, 'upstream_500') - openDuring.length,
      open_circuit_latency_ms: {
        p50: round2(pct(openDuring.map((r) => r.ms), 50)),
        p95: round2(pct(openDuring.map((r) => r.ms), 95)),
        p99: round2(pct(openDuring.map((r) => r.ms), 99)),
      },
    },
    time_to_open_ms: firstOpen ? firstOpen.end - faultAt : null,
    recovery: {
      recovered,
      recovery_ms: recoveryMs,
      circuit_open_rejections_after_restore: count(beforeFirstOk, 'circuit_open'),
      other_before_recovery: beforeFirstOk.length - count(beforeFirstOk, 'circuit_open'),
      requests_after_recovery: afterRecovery.length,
      stayed_recovered: stayedRecovered,
      last_failed_probe_at_ms: lastFailedProbe ? lastFailedProbe.end : null,
      phase_since_last_failed_probe_ms: lastFailedProbe ? restoreAt - lastFailedProbe.end : null,
      predicted_recovery_ms: predicted,
      prediction_error_ms: predicted !== null && recoveryMs !== null ? recoveryMs - predicted : null,
    },
    breaker_transitions: opts.transitions,
    // A real recovery: the breaker closed, the first success came after the restore, and
    // every later request also succeeded (it did not merely flap or stay open).
    recovery_confirmed: recovered && stayedRecovered && (opts.transitions?.CLOSED ?? 0) >= 1,
  };
}
