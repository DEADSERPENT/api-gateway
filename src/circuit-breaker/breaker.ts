export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerOptions {
  /** Qualifying failures within `windowMs` that open the breaker. */
  failureThreshold: number;
  /** Rolling window over which failures are counted. */
  windowMs: number;
  /** How long to stay OPEN before admitting probes. */
  cooldownMs: number;
  /** Concurrent probe requests allowed while HALF_OPEN. */
  halfOpenMaxProbes: number;
  now?: () => number;
  onTransition?: (from: BreakerState, to: BreakerState) => void;
}

/** Permit for one admitted request. Exactly one outcome is recorded; later calls are no-ops. */
export interface Ticket {
  success(): void;
  failure(): void;
  /** Release the permit without counting an outcome (e.g. the client went away). */
  ignore(): void;
}

/**
 * In-memory circuit breaker. State is local to this process (each gateway replica has
 * its own breaker); only the rate limiter shares state through Redis.
 */
export class CircuitBreaker {
  private current: BreakerState = 'CLOSED';
  private failures: number[] = [];
  private openedAt = 0;
  private probesInFlight = 0;
  /** Bumped on every transition so outcomes from earlier states can be recognised. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
      throw new RangeError('failureThreshold must be an integer >= 1');
    }
    if (!(opts.windowMs > 0)) throw new RangeError('windowMs must be > 0');
    if (!(opts.cooldownMs >= 0)) throw new RangeError('cooldownMs must be >= 0');
    if (!Number.isInteger(opts.halfOpenMaxProbes) || opts.halfOpenMaxProbes < 1) {
      throw new RangeError('halfOpenMaxProbes must be an integer >= 1');
    }
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    this.maybeHalfOpen();
    return this.current;
  }

  /** Milliseconds until a probe will be admitted; 0 unless OPEN. */
  retryAfterMs(): number {
    this.maybeHalfOpen();
    if (this.current !== 'OPEN') return 0;
    return Math.max(0, this.openedAt + this.opts.cooldownMs - this.now());
  }

  /** Returns a ticket if the request may go upstream, or null to fail fast. */
  tryAcquire(): Ticket | null {
    this.maybeHalfOpen();
    if (this.current === 'OPEN') return null;
    const isProbe = this.current === 'HALF_OPEN';
    if (isProbe) {
      if (this.probesInFlight >= this.opts.halfOpenMaxProbes) return null;
      this.probesInFlight++;
    }
    return this.makeTicket(this.generation, isProbe);
  }

  private makeTicket(generation: number, isProbe: boolean): Ticket {
    let settled = false;
    const settle = (outcome: 'success' | 'failure' | 'ignore') => {
      if (settled) return;
      settled = true;
      // Outcomes from a previous state must not steer the current one.
      if (generation !== this.generation) return;
      if (isProbe) this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (outcome === 'ignore') return;
      if (isProbe) {
        if (outcome === 'success') this.transition('CLOSED');
        else this.transition('OPEN');
      } else if (outcome === 'failure') {
        this.recordFailure();
      }
    };
    return {
      success: () => settle('success'),
      failure: () => settle('failure'),
      ignore: () => settle('ignore'),
    };
  }

  private recordFailure(): void {
    const t = this.now();
    this.failures.push(t);
    this.failures = this.failures.filter((f) => t - f < this.opts.windowMs);
    if (this.failures.length >= this.opts.failureThreshold) this.transition('OPEN');
  }

  private maybeHalfOpen(): void {
    if (this.current === 'OPEN' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.transition('HALF_OPEN');
    }
  }

  private transition(to: BreakerState): void {
    const from = this.current;
    if (from === to) return;
    this.current = to;
    this.generation++;
    this.probesInFlight = 0;
    if (to === 'OPEN') this.openedAt = this.now();
    if (to === 'CLOSED') this.failures = [];
    this.opts.onTransition?.(from, to);
  }
}
