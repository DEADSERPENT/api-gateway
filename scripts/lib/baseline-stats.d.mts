type Metrics = Record<string, Record<string, number>>;

export interface PhaseStats {
  requests: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface MeasuredStats extends PhaseStats {
  /** `measured` = phase-tagged run; `whole-run` = legacy run with no warm-up separation. */
  source: 'measured' | 'whole-run';
  throughput: number;
}

export function measuredStats(metrics: Metrics, opts: { measureSeconds: number }): MeasuredStats;
export function warmupStats(metrics: Metrics): PhaseStats | null;
export function gatewayMax(metrics: Metrics): Record<string, number>;
