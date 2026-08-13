/**
 * Deterministic PRNG for fixtures.
 *
 * Fixtures must be reproducible: the design is validated against them, tests
 * assert the §1 baselines against them, and a fixture that shuffles between
 * renders would make the Scan Strip look alive when it is not.
 */

/** mulberry32 — small, fast, good enough for shaped test data. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, so a date key or store id can seed a stream. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length];
}

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function intBetween(rng: () => number, lo: number, hi: number): number {
  return Math.floor(between(rng, lo, hi + 1));
}

/** Box–Muller, clamped — for latency and value distributions with a tail. */
export function gaussian(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
