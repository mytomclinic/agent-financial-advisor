// Small numeric helpers: descriptive stats and the normal distribution.

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

export function variance(xs, sample = true) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - (sample ? 1 : 0));
}

export const stdev = (xs, sample = true) => Math.sqrt(variance(xs, sample));

export function skewness(xs) {
  const n = xs.length;
  const s = stdev(xs, false);
  if (n < 3 || s === 0) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => ((x - m) / s) ** 3)) / n;
}

// Plain (non-excess) kurtosis; a normal distribution gives 3.
export function kurtosis(xs) {
  const n = xs.length;
  const s = stdev(xs, false);
  if (n < 4 || s === 0) return 3;
  const m = mean(xs);
  return sum(xs.map((x) => ((x - m) / s) ** 4)) / n;
}

export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function maxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  let peakIdx = 0;
  let troughIdx = 0;
  let curPeakIdx = 0;
  returns.forEach((r, i) => {
    equity *= 1 + r;
    if (equity > peak) {
      peak = equity;
      curPeakIdx = i;
    }
    const dd = (peak - equity) / peak;
    if (dd > mdd) {
      mdd = dd;
      peakIdx = curPeakIdx;
      troughIdx = i;
    }
  });
  return { max_drawdown: mdd, peak_index: peakIdx, trough_index: troughIdx, final_growth: equity };
}

// Abramowitz-Stegun style erf approximation (max error ~1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// Acklam's inverse normal CDF approximation.
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const round = (x, dp = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : x);
