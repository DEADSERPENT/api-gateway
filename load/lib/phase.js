// Shared by the k6 scenario (which bundles it) and the unit tests (plain Node).
// A request is tagged by the instant it is issued: before the warm-up ends it is "warmup",
// from that instant on it is "measured".
export function phaseAt(elapsedMs, warmupMs) {
  return elapsedMs < warmupMs ? 'warmup' : 'measured';
}
