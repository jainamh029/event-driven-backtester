// Derived series for the dashboard charts. Pure functions over the engine's output.

export const dailyReturns = (eq) => eq.slice(1).map((v, i) => v / eq[i] - 1);

/** Rolling annualised Sharpe over `win` bars; null until a full window exists (or when it is flat). */
export function rollingSharpe(eq, win = 252, periods = 252) {
  const r = dailyReturns(eq), out = new Array(eq.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < r.length; i++) {
    s += r[i]; s2 += r[i] * r[i];
    if (i >= win) { s -= r[i - win]; s2 -= r[i - win] ** 2; }
    if (i >= win - 1) {
      const m = s / win, v = (s2 - win * m * m) / (win - 1);
      out[i + 1] = v > 1e-14 ? (m / Math.sqrt(v)) * Math.sqrt(periods) : null;
    }
  }
  return out;
}

/** Calendar-year returns from year-end equity (the first year is measured from the first bar). */
export function annualReturns(dates, eq) {
  const ends = new Map();
  dates.forEach((d, i) => ends.set(d.slice(0, 4), { v: eq[i], d }));
  const years = [], values = [];
  let prev = eq[0];
  for (const [y, { v, d }] of ends) {
    years.push(d.slice(5, 7) < "12" && y === dates.at(-1).slice(0, 4) ? `${y} YTD` : y);
    values.push(v / prev - 1);
    prev = v;
  }
  return { years, values };
}

/** Histogram of non-flat daily returns as % of days, clipped to [lo, hi]. */
export function histogram(rets, lo = -0.05, hi = 0.05, bins = 40) {
  const w = (hi - lo) / bins, counts = new Array(bins).fill(0);
  let n = 0;
  for (const r of rets) {
    if (Math.abs(r) < 1e-12) continue; // days spent in cash
    n++;
    counts[Math.min(bins - 1, Math.max(0, Math.floor((r - lo) / w)))]++;
  }
  return { centers: counts.map((_, i) => lo + (i + 0.5) * w), density: counts.map((c) => (n ? (100 * c) / n : 0)), n, width: w };
}

/** Skewness of a sample (Fisher-Pearson). */
export function skew(rets) {
  const n = rets.length;
  if (n < 3) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const m2 = rets.reduce((a, r) => a + (r - m) ** 2, 0) / n, m3 = rets.reduce((a, r) => a + (r - m) ** 3, 0) / n;
  return m2 > 0 ? m3 / m2 ** 1.5 : 0;
}

/** Cumulative commission + slippage paid, per bar. */
export function cumulativeCosts(dates, fills) {
  const idx = new Map(dates.map((d, i) => [d, i])), per = new Array(dates.length).fill(0);
  for (const f of fills) per[idx.get(f.date)] += f.commission + f.slippageCost;
  let c = 0;
  return per.map((x) => (c += x));
}

export function exposure(rows) { return rows.map((r) => (r.equity ? r.positionsValue / r.equity : 0)); }

export function dayStats(eq, dates) {
  const r = dailyReturns(eq);
  let best = -Infinity, worst = Infinity, bi = 0, wi = 0;
  r.forEach((x, i) => { if (x > best) { best = x; bi = i + 1; } if (x < worst) { worst = x; wi = i + 1; } });
  return { best, worst, bestDate: dates[bi], worstDate: dates[wi], skew: skew(r) };
}
