/**
 * The live line: transparent probability estimates for the Odds questions, computed from what the
 * chain shows right now. Not a market price — a model, labelled as such wherever it appears.
 *
 * Graduation ("will the curve fill before the deadline?") treats net SOL flow into the curve as
 * Brownian motion with drift μ (SOL/min, fading as momentum decays) and volatility σ (SOL/√min),
 * and asks for the first-passage probability of the SOL still needed. Price questions ("above X
 * at the deadline?") use a lognormal price with a volatility read from the live price path.
 */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erfc; |error| < 1.5e-7). */
export function normCdf(x: number): number {
  if (x < -38) return 0;
  if (x > 38) return 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = y * Math.exp(-z * z);
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** log Φ(x) that stays finite deep in the left tail (Mills ratio asymptotic). */
function logNormCdf(x: number): number {
  if (x > -8) return Math.log(Math.max(normCdf(x), 1e-300));
  const x2 = x * x;
  return -x2 / 2 - Math.log(-x) - 0.5 * Math.log(2 * Math.PI) + Math.log(1 - 1 / x2 + 3 / (x2 * x2));
}

/** P(a Brownian motion with drift mu and volatility sigma reaches level a > 0 within time t). */
export function firstPassage(a: number, mu: number, sigma: number, t: number): number {
  if (a <= 0) return 1;
  if (t <= 0 || sigma <= 0) return 0;
  const s = sigma * Math.sqrt(t);
  const first = normCdf((mu * t - a) / s);
  // exp(2·mu·a/σ²)·Φ((−a − mu·t)/s), combined in log space so a strong drift can't overflow
  const logSecond = (2 * mu * a) / (sigma * sigma) + logNormCdf((-a - mu * t) / s);
  const second = logSecond > 0 ? 1 : Math.exp(logSecond);
  return Math.min(1, Math.max(0, first + second));
}

export interface FlowEstimate {
  /** net SOL into the curve per minute, smoothed */
  mu: number;
  /** volatility of net flow, SOL per √minute */
  sigma: number;
  /** minutes of flow observed (weights the estimate against the prior) */
  minutes: number;
}

/** Prior for a token we know little about: ~1.5% chance a fresh token fills 85 SOL within an hour. */
export const FLOW_PRIOR: FlowEstimate = { mu: 0, sigma: 4.5, minutes: 0 };
/** Momentum fades: the drift's effect decays with this time constant (minutes). */
const MOMENTUM_MINUTES = 8;

/**
 * Probability the curve fills before the deadline.
 * remainingSol: SOL still needed; minutesLeft: until the question closes.
 */
export function graduationProbability(remainingSol: number, flow: FlowEstimate, minutesLeft: number): number {
  if (remainingSol <= 0) return 1;
  if (minutesLeft <= 0) return 0;
  const w = Math.min(1, flow.minutes / 3); // trust observed flow after ~3 minutes of watching
  const sigma = Math.max(1.2, w * flow.sigma + (1 - w) * FLOW_PRIOR.sigma);
  // average drift over the window once momentum decays: mu · (h/t)(1 − e^(−t/h))
  const h = MOMENTUM_MINUTES;
  const decay = (h / minutesLeft) * (1 - Math.exp(-minutesLeft / h));
  const mu = flow.mu * decay;
  const p = firstPassage(remainingSol, mu, sigma, minutesLeft);
  return clampProb(p);
}

/**
 * Probability a price ends above a strike. The log of the price moves as a Brownian motion with a
 * median drift (per hour; graduates typically drift lower) and a volatility (per √hour), so the odds
 * answer to where the price is now: about 40% at the strike an hour out, more above it, less below.
 */
export function aboveProbability(priceRatio: number, hoursLeft: number, sigmaPerSqrtHour: number, logDriftPerHour = PRICE_PRIOR.logDrift): number {
  if (!(priceRatio > 0)) return 0.5;
  if (hoursLeft <= 0) return priceRatio >= 1 ? 0.995 : 0.005;
  const s = Math.max(0.25, sigmaPerSqrtHour) * Math.sqrt(hoursLeft);
  const z = (Math.log(priceRatio) + logDriftPerHour * hoursLeft) / s;
  return clampProb(normCdf(z));
}

/** Price prior for graduated tokens: median log drift −0.25/h (about −22% an hour), volatility 1.0/√h. */
export const PRICE_PRIOR = { logDrift: -0.25, sigma: 1.0, minSigma: 0.5, maxSigma: 2.5 } as const;

/**
 * Volatility for a price question: realized volatility from trade-by-trade samples runs high (each
 * trade's jump counts in full), so it's blended half-and-half with the prior and kept within bounds.
 */
export function priceSigma(realized: number | null): number {
  if (realized === null) return PRICE_PRIOR.sigma;
  return Math.min(PRICE_PRIOR.maxSigma, Math.max(PRICE_PRIOR.minSigma, 0.5 * realized + 0.5 * PRICE_PRIOR.sigma));
}

export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.995, Math.max(0.005, p));
}

/** What a practice YES or NO share costs at the line: probability plus half the spread. */
export function linePrice(p: number, side: "YES" | "NO", spread = 0.04): number {
  const base = side === "YES" ? p : 1 - p;
  return Math.min(0.99, Math.max(0.01, base + spread / 2));
}

/** What a share sells back for at the line: probability minus half the spread. */
export function bidPrice(p: number, side: "YES" | "NO", spread = 0.04): number {
  const base = side === "YES" ? p : 1 - p;
  return Math.min(0.99, Math.max(0, base - spread / 2));
}

/**
 * Exponentially weighted flow estimator: feed (timestamp ms, realSol) observations as the curve
 * changes; it keeps a smoothed rate and the variance of increments per unit time.
 */
export class FlowTracker {
  private lastT = 0;
  private lastSol = 0;
  private rate = 0;
  private varRate = 0;
  private observed = 0;
  private started = false;

  constructor(private readonly halfLifeMinutes = 2) {}

  observe(tMs: number, realSol: number): void {
    if (!this.started) {
      this.started = true;
      this.lastT = tMs;
      this.lastSol = realSol;
      return;
    }
    const dtMin = (tMs - this.lastT) / 60_000;
    if (dtMin <= 0) {
      this.lastSol = realSol;
      return;
    }
    const d = realSol - this.lastSol;
    const alpha = 1 - Math.pow(0.5, dtMin / this.halfLifeMinutes);
    const instRate = d / dtMin;
    this.rate += alpha * (instRate - this.rate);
    // variance of flow per minute: increments² / dt estimates σ²
    const inst = (d * d) / dtMin;
    this.varRate += alpha * (inst - this.varRate);
    this.observed += dtMin;
    this.lastT = tMs;
    this.lastSol = realSol;
  }

  /** Decay the rate when nothing has happened for a while (no updates means no flow). */
  estimate(nowMs: number): FlowEstimate {
    if (!this.started) return FLOW_PRIOR;
    const idleMin = Math.max(0, (nowMs - this.lastT) / 60_000);
    const fade = Math.pow(0.5, idleMin / this.halfLifeMinutes);
    return { mu: this.rate * fade, sigma: Math.sqrt(Math.max(0, this.varRate)) * Math.max(0.35, fade), minutes: this.observed + idleMin };
  }

  seed(muPerMin: number, sigma: number, minutes: number): void {
    this.rate = muPerMin;
    this.varRate = sigma * sigma;
    this.observed = minutes;
  }
}

/** Realized volatility of log price, per √hour, from (t ms, price) samples; null with too little data. */
export function realizedVolPerSqrtHour(samples: Array<readonly [number, number]>): number | null {
  if (samples.length < 6) return null;
  let sum = 0;
  let hours = 0;
  for (let i = 1; i < samples.length; i++) {
    const [t0, p0] = samples[i - 1]!;
    const [t1, p1] = samples[i]!;
    if (!(p0 > 0 && p1 > 0) || t1 <= t0) continue;
    const r = Math.log(p1 / p0);
    sum += r * r;
    hours += (t1 - t0) / 3_600_000;
  }
  if (hours < 1 / 60) return null;
  return Math.sqrt(sum / hours);
}
