// Seeded, stratified schedule of "restore the downstream this long after the fault" delays.
//
// The breaker probes every `cooldown` ms, so recovery time depends on where the restore
// lands inside that cycle. `spanMs` should equal the cooldown: the delays then cover one full
// cycle. Trial i of n gets a delay inside slice i of [minMs, minMs + spanMs) (so the trials
// cannot cluster), and the slices are shuffled so trial number does not correlate with phase.

/** mulberry32: small, fast, deterministic 32-bit PRNG returning floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function restoreDelays(seed, trials, { minMs, spanMs }) {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('trials must be an integer >= 1');
  if (!(spanMs > 0) || !(minMs >= 0)) throw new RangeError('range must have minMs >= 0 and spanMs > 0');
  const rand = mulberry32(seed);
  const delays = Array.from({ length: trials }, (_, i) =>
    minMs + Math.floor(((i + rand()) / trials) * spanMs),
  );
  for (let i = delays.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [delays[i], delays[j]] = [delays[j], delays[i]];
  }
  return delays;
}
