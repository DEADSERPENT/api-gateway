export interface FailureAnalysis {
  plan: { planned_restore_delay_ms: number; cooldown_ms: number; arrival_interval_ms: number };
  timestamps: {
    fault_at_ms: number;
    restore_at_ms: number;
    actual_restore_delay_ms: number;
    restore_delay_error_ms: number;
    restore_within_client_window: boolean | null;
    first_circuit_open_at_ms: number | null;
    first_ok_after_restore_at_ms: number | null;
  };
  requests_total: number;
  before_fault: { n: number; ok_pct: number };
  during_failure: {
    n: number;
    upstream_500: number;
    circuit_open: number;
    other: number;
    open_circuit_latency_ms: { p50: number | null; p95: number | null; p99: number | null };
  };
  time_to_open_ms: number | null;
  recovery: {
    recovered: boolean;
    recovery_ms: number | null;
    circuit_open_rejections_after_restore: number;
    other_before_recovery: number;
    requests_after_recovery: number;
    stayed_recovered: boolean;
    last_failed_probe_at_ms: number | null;
    phase_since_last_failed_probe_ms: number | null;
    predicted_recovery_ms: number | null;
    prediction_error_ms: number | null;
  };
  breaker_transitions: { OPEN: number; HALF_OPEN: number; CLOSED: number };
  recovery_confirmed: boolean;
}

export function analyzeFailure(
  lines: string[],
  opts: {
    plannedRestoreDelayMs: number;
    cooldownMs: number;
    arrivalIntervalMs: number;
    transitions: { OPEN: number; HALF_OPEN: number; CLOSED: number };
  },
): FailureAnalysis;
