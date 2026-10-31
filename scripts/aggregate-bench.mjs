// Usage: node scripts/aggregate-bench.mjs <run-dir>
// Reads the per-trial files written by scripts/bench.sh and prints a Markdown report:
// median with min-max range across trials. INVALID-* (stalled) files are excluded.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayMax, measuredStats, warmupStats } from './lib/baseline-stats.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: aggregate-bench.mjs <run-dir>');
const files = readdirSync(dir).filter((f) => !f.startsWith('INVALID-'));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (xs, digits = 1) => {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return 'n/a';
  const f = (x) => x.toFixed(digits);
  return `${f(median(v))} (${f(Math.min(...v))}-${f(Math.max(...v))})`;
};
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};
const readJson = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const cfg = existsSync(join(dir, 'run-config.json')) ? readJson('run-config.json') : null;
const measureSeconds = cfg?.baseline.measure_s ?? 30;
const warmupSeconds = cfg?.baseline.warmup_s ?? 0;

/** { "baseline-1gw-100vu": [file, ...] } keyed by name without the `.tN` trial suffix. */
const groups = {};
for (const f of files) {
  const m = /^(.+)\.t(\d+)\.summary\.json$/.exec(f);
  if (m) (groups[m[1]] ??= []).push(f);
}

const out = [];
out.push(`# Results (${dir})`, '', 'Each cell is **median (min-max)** across trials.', '');
if (cfg) {
  out.push(
    `Run config: ${cfg.trials} trials; baseline ${warmupSeconds} s warm-up + ${measureSeconds} s measured; ` +
      `failure seed ${cfg.failure.seed}, restore delay ${cfg.failure.restore_delay_min_ms}-` +
      `${cfg.failure.restore_delay_min_ms + cfg.failure.restore_delay_span_ms} ms after the fault, ` +
      `breaker cooldown ${cfg.failure.breaker_cooldown_ms} ms.`,
    '',
  );
}

// ---------- baseline
const baseNames = Object.keys(groups).filter((n) => n.startsWith('baseline-')).sort();
if (baseNames.length) {
  const per = Object.fromEntries(
    baseNames.map((n) => [n, groups[n].map((f) => readJson(f).metrics)]),
  );
  const stats = Object.fromEntries(
    baseNames.map((n) => [n, per[n].map((m) => measuredStats(m, { measureSeconds }))]),
  );
  const legacy = baseNames.some((n) => stats[n].some((s) => s.source === 'whole-run'));
  out.push(
    legacy
      ? '## Proxy baseline (whole-run figures: this run has no warm-up separation)'
      : `## Proxy baseline (measured phase only: ${measureSeconds} s after a ${warmupSeconds} s warm-up; warm-up requests excluded)`,
    '',
  );
  out.push('| Configuration | n | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | failed |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const name of baseNames) {
    const s = stats[name];
    const col = (k) => s.map((x) => x[k]);
    out.push(
      `| ${name} | ${s.length} | ${fmt(col('throughput'), 0)} | ${fmt(col('p50'))} | ${fmt(col('p95'))} | ` +
        `${fmt(col('p99'))} | ${fmt(col('max'), 0)} | ${col('failed').reduce((a, b) => a + b, 0)} |`,
    );
  }
  out.push('');

  const gw = {};
  for (const name of baseNames.filter((n) => n.includes('2gw'))) {
    for (const m of per[name]) for (const [k, v] of Object.entries(gatewayMax(m))) (gw[k] ??= []).push(v);
  }
  if (Object.keys(gw).length) {
    out.push('Measured-phase max latency per replica in the two-gateway runs (ms, per trial):', '');
    for (const [k, v] of Object.entries(gw)) out.push(`- ${k}: ${v.map((x) => x.toFixed(0)).join(', ')}`);
    out.push('');
  }

  const warm = baseNames.map((n) => [n, per[n].map(warmupStats).filter(Boolean)]).filter(([, w]) => w.length);
  if (warm.length) {
    out.push(`### Cold-start record (the ${warmupSeconds} s warm-up phase, kept separate; not part of the figures above)`, '');
    out.push('| Configuration | n | requests | p99 (ms) | max (ms) | failed |', '|---|---:|---:|---:|---:|---:|');
    for (const [name, w] of warm) {
      const col = (k) => w.map((x) => x[k]);
      out.push(
        `| ${name} | ${w.length} | ${fmt(col('requests'), 0)} | ${fmt(col('p99'))} | ${fmt(col('max'), 0)} | ` +
          `${col('failed').reduce((a, b) => a + b, 0)} |`,
      );
    }
    out.push('');
  }

  // Slow-request log lines, split by phase.
  const slow = [];
  for (const f of files.filter((x) => /^baseline-.*\.txt$/.test(x))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const m = /SLOW (?:phase=(\S+) )?gw=(\S+) total=(\d+)ms/.exec(line);
      if (m) slow.push({ phase: m[1] ?? 'whole-run', gw: m[2] });
    }
  }
  const countPhase = (p) => slow.filter((s) => s.phase === p).length;
  out.push(
    legacy
      ? `Requests over 500 ms (whole run): **${slow.length}**`
      : `Requests over 500 ms: **${countPhase('measured')}** in the measured phase, ` +
          `**${countPhase('warmup')}** during warm-up` +
          (countPhase('warmup') ? ` (${[...new Set(slow.filter((s) => s.phase === 'warmup').map((s) => s.gw))].join(', ')})` : ''),
    '',
  );
}

// ---------- rate limit
const rlNames = Object.keys(groups).filter((n) => n.startsWith('ratelimit-')).sort();
if (rlNames.length) {
  out.push('## Rate-limit accuracy (capacity 100, refill 10/s, 100 req/s for 20 s; max possible 300)', '');
  out.push('| Configuration | n | Admitted (median, min-max) | Rejected | Other | Admitted per trial | p95 (ms) |');
  out.push('|---|---:|---:|---:|---:|---|---:|');
  for (const name of rlNames) {
    const ms = groups[name].map((f) => readJson(f).metrics);
    const c = (k) => ms.map((m) => m[k]?.count ?? 0);
    out.push(
      `| ${name} | ${ms.length} | ${fmt(c('rl_allowed'), 0)} | ${fmt(c('rl_limited'), 0)} | ` +
        `${fmt(c('rl_other'), 0)} | ${c('rl_allowed').join(', ')} | ${fmt(ms.map((m) => m.http_req_duration['p(95)']), 2)} |`,
    );
  }
  out.push('');
}

// ---------- failure / recovery
const failFiles = files.filter((f) => /^failure\.t\d+\.analysis\.json$/.test(f)).sort();
if (failFiles.length) {
  const a = failFiles.map(readJson);
  out.push(`## Downstream failure and recovery (${a.length} trials; ${cfg?.failure.rate_rps ?? 20} req/s; breaker cooldown ${a[0].plan.cooldown_ms} ms)`, '');
  out.push(
    'Restore delays were drawn from a seeded, stratified schedule (one trial per slice of one probe cycle). ' +
      'Timestamps are the instants the mock service reported switching mode; recovery is measured from the ' +
      'restore to the first genuine `200` (an open-circuit `503` never counts).',
    '',
  );
  out.push(
    '| Trial | Planned restore delay (ms) | Actual (ms) | Restore to last failed probe (ms) | Recovery (ms) | Model prediction (ms) | Error (ms) | Open-circuit 503s before recovery | Breaker OPEN / HALF_OPEN / CLOSED | Confirmed |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---|:---:|',
  );
  for (const x of a) {
    const t = x.breaker_transitions;
    out.push(
      `| ${x.trial} | ${x.plan.planned_restore_delay_ms} | ${x.timestamps.actual_restore_delay_ms} | ` +
        `${x.recovery.phase_since_last_failed_probe_ms} | ${x.recovery.recovery_ms} | ${x.recovery.predicted_recovery_ms} | ` +
        `${x.recovery.prediction_error_ms} | ${x.recovery.circuit_open_rejections_after_restore} | ` +
        `${t.OPEN} / ${t.HALF_OPEN} / ${t.CLOSED} | ${x.recovery_confirmed ? 'yes' : '**NO**'} |`,
    );
  }
  out.push('');
  const rec = a.map((x) => x.recovery.recovery_ms).filter((v) => v !== null);
  const phase = a.map((x) => x.recovery.phase_since_last_failed_probe_ms);
  const r = a.every((x) => x.recovery.recovery_ms !== null && x.recovery.phase_since_last_failed_probe_ms !== null)
    ? pearson(phase, a.map((x) => x.recovery.recovery_ms))
    : null;
  out.push('| Summary | median (min-max) |', '|---|---:|');
  out.push(`| Recovery after restore (ms) | ${fmt(rec, 0)} |`);
  out.push(`| Fault injected to breaker open (ms) | ${fmt(a.map((x) => x.time_to_open_ms), 0)} |`);
  out.push(`| Open-circuit latency p99 (ms) | ${fmt(a.map((x) => x.during_failure.open_circuit_latency_ms.p99), 2)} |`);
  out.push(`| Fast open-circuit 503s during the failure | ${fmt(a.map((x) => x.during_failure.circuit_open), 0)} |`);
  out.push(`| Upstream 500s passed through | ${fmt(a.map((x) => x.during_failure.upstream_500), 0)} |`);
  out.push(`| Restore delay error: actual minus planned (ms) | ${fmt(a.map((x) => x.timestamps.restore_delay_error_ms), 0)} |`);
  out.push(`| Model prediction error (ms) | ${fmt(a.map((x) => x.recovery.prediction_error_ms), 0)} |`);
  out.push('');
  out.push(
    `Confirmed recoveries (breaker closed, first success after restore, no relapse): **${a.filter((x) => x.recovery_confirmed).length} of ${a.length}**. ` +
      `Service timestamp inside the client's send/ack window: **${a.filter((x) => x.timestamps.restore_within_client_window).length} of ${a.length}**.`,
  );
  if (r !== null) {
    out.push(
      '',
      `Correlation between the restore's position in the probe cycle and recovery time: Pearson r = **${r.toFixed(3)}** ` +
        `(n = ${a.length}). Recovery spans ${Math.min(...rec)}-${Math.max(...rec)} ms, so it ` +
        `${Math.max(...rec) - Math.min(...rec) > 500 ? 'does vary with restore timing' : 'barely varies with restore timing'}.`,
    );
  }
  out.push('');
}

// ---------- CPU / memory
const statFiles = files.filter((f) => f.endsWith('.stats.txt'));
if (statFiles.length) {
  const toMiB = (v, unit) => v * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 }[unit] ?? 1);
  const byGroup = {};
  for (const f of statFiles) {
    const g = f.replace(/\.t\d+\.stats\.txt$/, '');
    const perContainer = {};
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const m = /^(\S+) ([\d.]+)% ([\d.]+)(KiB|MiB|GiB)/.exec(line);
      if (!m) continue;
      const name = m[1];
      let cls;
      if (name.startsWith('api-gateway-gateway')) cls = name.replace(/^api-gateway-|-1$/g, '');
      else if (name === 'api-gateway-redis-1') cls = 'redis';
      else if (name.startsWith('api-gateway-service')) cls = name.replace(/^api-gateway-|-1$/g, '');
      else if (/^[a-z]+_[a-z]+$/.test(name)) cls = 'k6 (load generator)'; // docker's random names
      else continue; // unrelated containers on the same Docker VM
      (perContainer[cls] ??= []).push({ cpu: +m[2], mem: toMiB(+m[3], m[4]) });
    }
    for (const [cls, samples] of Object.entries(perContainer)) {
      const slot = ((byGroup[g] ??= {})[cls] ??= { mean: [], max: [], mem: [] });
      slot.mean.push(samples.reduce((s, x) => s + x.cpu, 0) / samples.length);
      slot.max.push(Math.max(...samples.map((x) => x.cpu)));
      slot.mem.push(Math.max(...samples.map((x) => x.mem)));
    }
  }
  out.push('## CPU and memory (docker stats, sampled about every 1-2 s over the whole run, including warm-up)', '');
  out.push('CPU is a percentage of one core (it can exceed 100). Per-trial values are reduced to a mean and a peak, then summarised across trials.', '');
  out.push('| Run | Container | mean CPU % | peak CPU % | peak memory (MiB) |', '|---|---|---:|---:|---:|');
  for (const g of Object.keys(byGroup).sort()) {
    for (const [cls, s] of Object.entries(byGroup[g]).sort()) {
      out.push(`| ${g} | ${cls} | ${fmt(s.mean, 0)} | ${fmt(s.max, 0)} | ${fmt(s.mem, 0)} |`);
    }
  }
  out.push('');
}

const invalid = readdirSync(dir).filter((f) => f.startsWith('INVALID-') && f.endsWith('.txt'));
out.push(`Discarded stalled attempts: ${invalid.length}${invalid.length ? ` (${invalid.join(', ')})` : ''}`);
console.log(out.join('\n'));
