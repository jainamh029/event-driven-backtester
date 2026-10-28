// A line-for-line JavaScript port of src/evbt (the Python engine), so the dashboard can re-run
// backtests in the browser. Same architecture: components only talk through one EventQueue.
// scripts/check_js_parity.mjs asserts this port reproduces the Python results.

export const FIELDS = ["open", "high", "low", "close", "volume"];

/* ------------------------------------------------------------------ events */
export const T = { MARKET: "MARKET", BAR_CLOSE: "BAR_CLOSE", SIGNAL: "SIGNAL", ORDER: "ORDER", FILL: "FILL" };

export function describe(e) {
  const f = (x) => x.toFixed(2);
  switch (e.type) {
    case T.MARKET:
      return `MARKET     ${Object.entries(e.bars).map(([s, b]) => `${s} open=${f(b.open)}`).join(", ")}`;
    case T.BAR_CLOSE:
      return `BAR_CLOSE  ${Object.entries(e.bars).map(([s, b]) => `${s} close=${f(b.close)}`).join(", ")}`;
    case T.SIGNAL:
      return `SIGNAL     ${e.symbol} target_weight=${f(e.targetWeight)}${e.reason ? `  (${e.reason})` : ""}`;
    case T.ORDER:
      return `ORDER      #${e.orderId} ${e.side} ${e.quantity} ${e.symbol} @ next open`;
    case T.FILL:
      return `FILL       #${e.orderId} ${e.side} ${e.quantity} ${e.symbol} @ ${f(e.price)} (open ${f(e.refPrice)}, commission ${f(e.commission)})`;
  }
}

export class EventQueue {
  constructor() { this.q = []; this.h = 0; }
  put(e) { this.q.push(e); }
  get() { return this.q[this.h++]; }
  empty() {
    if (this.h >= this.q.length) { this.q.length = 0; this.h = 0; return true; }
    return false;
  }
}

/* ------------------------------------------------------------------ data */
export function parseCsv(text) {
  const lines = text.trim().split("\n");
  const n = lines.length - 1;
  const dates = new Array(n);
  const cols = FIELDS.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const p = lines[i + 1].split(",");
    dates[i] = p[0].slice(0, 10);
    for (let j = 0; j < FIELDS.length; j++) cols[j][i] = +p[j + 1];
  }
  return { dates, cols };
}

/** The only way a strategy sees prices: history up to and including the current bar. */
export class DataHandler {
  constructor(frames, { start = null, end = null } = {}) {
    const syms = Object.keys(frames);
    const maps = Object.fromEntries(syms.map((s) => [s, new Map(frames[s].dates.map((d, i) => [d, i]))]));
    // inner join on dates, optionally clipped to [start, end]
    this.dates = frames[syms[0]].dates.filter(
      (d) => (!start || d >= start) && (!end || d <= end) && syms.every((s) => maps[s].has(d))
    );
    this.values = {};
    for (const s of syms) {
      this.values[s] = FIELDS.map((_, j) => Float64Array.from(this.dates, (d) => frames[s].cols[j][maps[s].get(d)]));
    }
    this.cursor = -1;
  }
  get symbols() { return Object.keys(this.values); }
  get nSeen() { return this.cursor + 1; }
  get now() { return this.dates[this.cursor]; }
  advance() {
    if (this.cursor + 1 >= this.dates.length) return null;
    this.cursor++;
    const bars = {};
    for (const s of this.symbols) {
      const v = this.values[s];
      bars[s] = { open: v[0][this.cursor], high: v[1][this.cursor], low: v[2][this.cursor], close: v[3][this.cursor], volume: v[4][this.cursor] };
    }
    return [this.dates[this.cursor], bars];
  }
  history(symbol, n = null, field = "close") {
    const col = this.values[symbol][FIELDS.indexOf(field)];
    const stop = this.cursor + 1;
    return col.slice(n == null ? 0 : Math.max(0, stop - n), stop); // typed-array slice = a copy
  }
}

/* ------------------------------------------------------------------ strategies */
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };

export class Strategy {
  constructor() { this.queue = null; this.data = null; this.targets = {}; }
  bind(queue, data) { this.queue = queue; this.data = data; }
  onBarClose(ev) { this.onBar(ev.timestamp); }
  target(symbol, weight, reason = "") {
    weight = Math.min(Math.max(weight, 0), 1);
    if ((this.targets[symbol] ?? 0) === weight) return;
    this.targets[symbol] = weight;
    this.queue.put({ type: T.SIGNAL, timestamp: this.data.now, symbol, targetWeight: weight, reason });
  }
}

export class BuyAndHold extends Strategy {
  constructor(symbol) { super(); this.symbol = symbol; }
  onBar() { this.target(this.symbol, 1, "buy & hold"); }
}

export class SMACrossover extends Strategy {
  constructor(symbol, fast = 50, slow = 200) {
    super();
    if (fast >= slow) throw new Error("fast must be < slow");
    Object.assign(this, { symbol, fast, slow });
  }
  onBar() {
    if (this.data.nSeen < this.slow) return;
    const c = this.data.history(this.symbol, this.slow);
    this.target(this.symbol, mean(c.slice(-this.fast)) > mean(c) ? 1 : 0, `SMA${this.fast} vs SMA${this.slow}`);
  }
}

export class RSIMeanReversion extends Strategy {
  constructor(symbol, rsiPeriod = 2, entry = 10, trend = 200, exitMa = 5) {
    super();
    Object.assign(this, { symbol, rsiPeriod, entry, trend, exitMa });
  }
  static rsi(c) {
    let gain = 0, loss = 0;
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) gain += d; else if (d < 0) loss -= d; }
    return gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
  }
  onBar() {
    if (this.data.nSeen < this.trend) return;
    const c = this.data.history(this.symbol, this.trend);
    const last = c[c.length - 1];
    if ((this.targets[this.symbol] ?? 0) === 0) {
      if (last > mean(c) && RSIMeanReversion.rsi(c.slice(-(this.rsiPeriod + 1))) < this.entry) this.target(this.symbol, 1, "RSI dip in uptrend");
    } else if (last > mean(c.slice(-this.exitMa))) {
      this.target(this.symbol, 0, "close above short MA");
    }
  }
}

export class TrendFilterPortfolio extends Strategy {
  constructor(symbols, window = 200) { super(); Object.assign(this, { symbols: [...symbols], window }); }
  onBar() {
    if (this.data.nSeen < this.window) return;
    const w = 1 / this.symbols.length;
    for (const s of this.symbols) {
      const c = this.data.history(s, this.window);
      this.target(s, c[c.length - 1] > mean(c) ? w : 0, `close vs SMA${this.window}`);
    }
  }
}

export class SameDaySign extends Strategy {
  constructor(symbol) { super(); this.symbol = symbol; }
  onBar() {
    if (this.data.nSeen < 2) return;
    const c = this.data.history(this.symbol, 2);
    this.target(this.symbol, c[1] > c[0] ? 1 : 0, "today closed up");
  }
}

/* ------------------------------------------------------------------ execution */
export class CostModel {
  constructor(slippageBps = 5, commissionPerShare = 0.005, minCommission = 1) { Object.assign(this, { slippageBps, commissionPerShare, minCommission }); }
  commission(q) { return q <= 0 ? 0 : Math.max(this.minCommission, this.commissionPerShare * q); }
}

/** Orders wait here until the *next* MARKET event, then fill at that bar's open. */
export class SimulatedExecution {
  constructor(queue, costs = new CostModel()) { this.queue = queue; this.costs = costs; this.pending = []; }
  onOrder(o) { this.pending.push(o); }
  onMarket(ev) {
    const batch = [...this.pending].sort((a, b) => (a.side !== "SELL") - (b.side !== "SELL")); // sells first (stable)
    this.pending = [];
    for (const o of batch) this.fill(o, ev);
  }
  fill(o, ev) {
    const ref = ev.bars[o.symbol].open;
    const sign = o.side === "BUY" ? 1 : -1;
    const price = ref * (1 + (sign * this.costs.slippageBps) / 1e4);
    let qty = o.quantity;
    if (o.side === "BUY" && o.maxNotional != null) {
      const perShare = price + this.costs.commissionPerShare;
      qty = Math.min(qty, Math.max(0, Math.floor((o.maxNotional - this.costs.minCommission) / perShare)));
    }
    this.queue.put({
      type: T.FILL, timestamp: ev.timestamp, orderId: o.orderId, symbol: o.symbol, side: o.side, quantity: qty,
      refPrice: ref, price, commission: this.costs.commission(qty), slippageCost: Math.abs(price - ref) * qty,
    });
  }
}

/* ------------------------------------------------------------------ portfolio */
export class Portfolio {
  constructor(queue, initialCash = 100000, costBufferBps = 50) {
    this.queue = queue;
    this.initialCash = initialCash;
    this.cash = initialCash;
    this.buffer = costBufferBps / 1e4;
    this.positions = {};
    this.lastPrices = {};
    this.pending = new Map(); // orderId -> {symbol, signed, reserve}
    this.reserved = 0;
    this.nextId = 1;
    this.lots = {};
    this.rows = [];
    this.fills = [];
    this.trades = [];
  }
  marketValue() { let v = 0; for (const s in this.positions) v += this.positions[s] * this.lastPrices[s]; return v; }
  equity() { return this.cash + this.marketValue(); }

  onBarClose(ev) {
    for (const s in ev.bars) this.lastPrices[s] = ev.bars[s].close;
    this.rows.push({ date: ev.timestamp, equity: this.equity(), cash: this.cash, positionsValue: this.marketValue(), shares: { ...this.positions } });
  }

  onSignal(sig) {
    const sym = sig.symbol, price = this.lastPrices[sym];
    const targetQty = Math.floor((sig.targetWeight * this.equity()) / price);
    let inFlight = 0;
    for (const p of this.pending.values()) if (p.symbol === sym) inFlight += p.signed;
    const delta = targetQty - ((this.positions[sym] ?? 0) + inFlight);
    if (delta === 0) return;

    let side, signed, maxNotional = null, reserve = 0, qty;
    if (delta > 0) {
      const unit = price * (1 + this.buffer);
      qty = Math.min(delta, Math.floor((this.cash - this.reserved) / unit));
      if (qty <= 0) return;
      reserve = qty * unit;
      this.reserved += reserve;
      side = "BUY"; signed = qty; maxNotional = reserve;
    } else {
      qty = -delta; side = "SELL"; signed = -qty;
    }
    const orderId = this.nextId++;
    this.pending.set(orderId, { symbol: sym, signed, reserve });
    this.queue.put({ type: T.ORDER, timestamp: sig.timestamp, orderId, symbol: sym, side, quantity: qty, maxNotional });
  }

  onFill(f) {
    const p = this.pending.get(f.orderId);
    if (p) { this.reserved -= p.reserve; this.pending.delete(f.orderId); }
    if (f.quantity === 0) return;
    const gross = f.price * f.quantity, sym = f.symbol;
    this.fills.push({ date: f.timestamp, orderId: f.orderId, symbol: sym, side: f.side, quantity: f.quantity, refPrice: f.refPrice, fillPrice: f.price, commission: f.commission, slippageCost: f.slippageCost });

    if (f.side === "BUY") {
      const outlay = gross + f.commission;
      this.cash -= outlay;
      this.positions[sym] = (this.positions[sym] ?? 0) + f.quantity;
      const lot = (this.lots[sym] ??= { entry: f.timestamp, qty: 0, spent: 0, received: 0 });
      lot.qty += f.quantity;
      lot.spent += outlay;
    } else {
      const proceeds = gross - f.commission;
      this.cash += proceeds;
      this.positions[sym] -= f.quantity;
      const lot = this.lots[sym];
      lot.qty -= f.quantity;
      lot.received += proceeds;
      if (lot.qty === 0) {
        const pnl = lot.received - lot.spent;
        this.trades.push({ symbol: sym, entry: lot.entry, exit: f.timestamp, pnl, ret: pnl / lot.spent });
        delete this.lots[sym];
        delete this.positions[sym];
      }
    }
  }
}

/* ------------------------------------------------------------------ metrics */
export function drawdownSeries(eq) {
  let peak = -Infinity;
  return eq.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
}

export function computeMetrics(dates, eq, trades = null, periods = 252) {
  const n = eq.length;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(eq[i] / eq[i - 1] - 1);
  const m = rets.length ? mean(rets) : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1)) : 0;
  const downside = rets.length ? Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / rets.length) : 0;
  const years = Math.max((Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 86400000 / 365.25, 1e-9);
  const total = eq[n - 1] / eq[0] - 1;
  const cagr = total > -1 ? (1 + total) ** (1 / years) - 1 : -1;
  const maxDd = Math.min(...drawdownSeries(eq));
  const out = {
    totalReturn: total, cagr, volatility: std * Math.sqrt(periods),
    sharpe: std > 0 ? (m / std) * Math.sqrt(periods) : 0,
    sortino: downside > 0 ? (m / downside) * Math.sqrt(periods) : 0,
    maxDrawdown: maxDd, calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : 0,
  };
  if (trades) {
    const k = trades.length;
    const wins = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const losses = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
    Object.assign(out, {
      trades: k,
      winRate: k ? trades.filter((t) => t.pnl > 0).length / k : 0,
      avgTradeReturn: k ? mean(trades.map((t) => t.ret)) : 0,
      profitFactor: losses > 0 ? wins / losses : wins > 0 ? Infinity : 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ engine */
export class Backtest {
  constructor(data, strategy, { initialCash = 100000, costs = new CostModel() } = {}) {
    this.queue = new EventQueue();
    this.data = data;
    this.strategy = strategy;
    this.portfolio = new Portfolio(this.queue, initialCash);
    this.execution = new SimulatedExecution(this.queue, costs);
    this.strategy.bind(this.queue, data);
    this.counts = {};
    this.trace = []; // [{bar, event}], for the dashboard's event inspector
    this.handlers = {
      [T.MARKET]: [(e) => this.execution.onMarket(e)],
      [T.BAR_CLOSE]: [(e) => this.portfolio.onBarClose(e), (e) => this.strategy.onBarClose(e)],
      [T.SIGNAL]: [(e) => this.portfolio.onSignal(e)],
      [T.ORDER]: [(e) => this.execution.onOrder(e)],
      [T.FILL]: [(e) => this.portfolio.onFill(e)],
    };
  }
  drain() {
    while (!this.queue.empty()) {
      const e = this.queue.get();
      this.counts[e.type] = (this.counts[e.type] ?? 0) + 1;
      this.trace.push({ bar: this.data.cursor, event: e });
      for (const h of this.handlers[e.type]) h(e);
    }
  }
  run() {
    let step;
    while ((step = this.data.advance()) !== null) {
      const [ts, bars] = step;
      this.queue.put({ type: T.MARKET, timestamp: ts, bars }); // bar opens: yesterday's orders fill
      this.drain();
      this.queue.put({ type: T.BAR_CLOSE, timestamp: ts, bars }); // bar closes: mark, decide, size, order
      this.drain();
    }
    const p = this.portfolio;
    const dates = p.rows.map((r) => r.date), equity = p.rows.map((r) => r.equity);
    return {
      dates, equity, rows: p.rows, fills: p.fills, trades: p.trades, counts: this.counts, trace: this.trace,
      metrics: computeMetrics(dates, equity, p.trades),
      totalCosts: p.fills.reduce((a, f) => a + f.commission + f.slippageCost, 0),
    };
  }
}

/* ------------------------------------------------------------------ helpers for the UI */
/** Month-by-month returns keyed [year][month 0-11], from month-end equity. */
export function monthlyReturns(dates, eq) {
  const ends = new Map(); // "YYYY-MM" -> last equity of that month
  dates.forEach((d, i) => ends.set(d.slice(0, 7), eq[i]));
  const out = {};
  let prev = eq[0];
  for (const [ym, v] of ends) {
    const [y, m] = ym.split("-").map(Number);
    (out[y] ??= {})[m - 1] = v / prev - 1;
    prev = v;
  }
  return out;
}
