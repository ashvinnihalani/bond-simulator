/**
 * Deterministic random-number management.
 *
 * Every stochastic module in the simulator draws from its own named substream,
 * derived from the global seed. This keeps runs reproducible and, crucially,
 * lets a module be switched off (e.g. buybacks) without perturbing the draws
 * any other module sees, so "off" runs are bit-identical to earlier phases.
 */

/** 64-bit-ish string hash (FNV-1a over UTF-16 code units, folded to 32 bits). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** SplitMix32 used to expand a seed into xoshiro state. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** xoshiro128** — fast, well-distributed 32-bit generator. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    // xoshiro must not start from the all-zero state.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5), 7), 9)) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  uniform(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform in [lo, hi). */
  uniformRange(lo: number, hi: number): number {
    return lo + (hi - lo) * this.uniform();
  }

  /** Standard normal via Marsaglia polar method (caches the spare). */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u: number, v: number, s: number;
    do {
      u = 2 * this.uniform() - 1;
      v = 2 * this.uniform() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spareNormal = v * m;
    return u * m;
  }

  /** Normal with mean and standard deviation. */
  gaussian(mean: number, sd: number): number {
    return mean + sd * this.normal();
  }

  /** Bernoulli trial with probability p. */
  bernoulli(p: number): boolean {
    return this.uniform() < p;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.uniform() * n);
  }

  /** Log-normal such that the median is `median` and log-sd is `sigma`. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Draw an index from a discrete distribution given unnormalised weights. */
  categorical(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.uniform() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Vector of correlated standard normals given a Cholesky factor (lower-tri, row-major). */
  correlatedNormals(chol: number[][]): number[] {
    const n = chol.length;
    const z = new Array<number>(n);
    for (let i = 0; i < n; i++) z[i] = this.normal();
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += chol[i][j] * z[j];
      out[i] = acc;
    }
    return out;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Manages named substreams under one global seed. `stream("auction")` always
 * returns the same generator for the same name within a run, and that
 * generator's sequence depends only on (seed, name).
 */
export class RngManager {
  private readonly streams = new Map<string, Rng>();

  constructor(public readonly seed: number) {}

  stream(name: string): Rng {
    let r = this.streams.get(name);
    if (!r) {
      r = new Rng((hashString(name) ^ Math.imul(this.seed >>> 0, 0x9e3779b1)) >>> 0);
      this.streams.set(name, r);
    }
    return r;
  }
}

/** Cholesky decomposition of a symmetric positive-definite matrix. */
export function cholesky(a: number[][]): number[][] {
  const n = a.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) throw new Error(`Matrix is not positive definite at row ${i}`);
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}
