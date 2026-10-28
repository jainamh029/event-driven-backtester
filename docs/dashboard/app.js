import {
  Backtest, BuyAndHold, CostModel, DataHandler, RSIMeanReversion, SameDaySign, SMACrossover, T,
  TrendFilterPortfolio, describe, drawdownSeries, monthlyReturns, parseCsv, computeMetrics,
} from "./engine.js";
import { annualReturns, cumulativeCosts, dailyReturns, dayStats, exposure, histogram, rollingSharpe } from "./analytics.js";

const SYMBOLS = ["SPY", "TLT", "GLD"];
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(d) + "%");
const num = (x, d = 2) => (x == null || !isFinite(x) ? "n/a" : (x < 0 ? "−" : "") + Math.abs(x).toFixed(d));
const usd = (x) => (x < 0 ? "−$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const compactUsd = (v) => (v >= 1e6 ? "$" + +(v / 1e6).toFixed(1) + "M" : v >= 1e3 ? "$" + +(v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k" : "$" + Math.round(v));
const signCls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/* ------------------------------------------------------------ strategy catalogue */
const STRATS = {
  hold: { label: "Buy & hold", multi: false, params: [], make: (s, [a]) => new BuyAndHold(a), name: (s, [a]) => `Buy & hold ${a}` },
  sma: {
    label: "SMA crossover", multi: false,
    params: [
      { k: "fast", label: "Fast window (bars)", min: 5, max: 100, step: 1, def: 50 },
      { k: "slow", label: "Slow window (bars)", min: 20, max: 300, step: 5, def: 200 },
    ],
    make: (s, [a]) => new SMACrossover(a, s.p.fast ?? 50, s.p.slow ?? 200),
    name: (s, [a]) => `SMA ${s.p.fast ?? 50}/${s.p.slow ?? 200} crossover on ${a}`,
    validate: (s) => ((s.p.fast ?? 50) >= (s.p.slow ?? 200) ? "Fast window must be shorter than the slow window." : ""),
  },
  rsi2: {
    label: "RSI dip-buying (mean reversion)", multi: false,
    params: [
      { k: "period", label: "RSI period", min: 2, max: 10, step: 1, def: 2 },
      { k: "entry", label: "Buy when RSI below", min: 2, max: 40, step: 1, def: 10 },
      { k: "trend", label: "Uptrend filter (SMA bars)", min: 50, max: 300, step: 10, def: 200 },
      { k: "exit", label: "Exit above SMA (bars)", min: 2, max: 20, step: 1, def: 5 },
    ],
    make: (s, [a]) => new RSIMeanReversion(a, s.p.period ?? 2, s.p.entry ?? 10, s.p.trend ?? 200, s.p.exit ?? 5),
    name: (s, [a]) => `RSI(${s.p.period ?? 2}) dip-buying on ${a}`,
  },
  trend: {
    label: "Trend-filter portfolio", multi: true,
    params: [{ k: "window", label: "Trend window (SMA bars)", min: 20, max: 300, step: 10, def: 200 }],
    make: (s, syms) => new TrendFilterPortfolio(syms, s.p.window ?? 200),
    name: (s, syms) => `${s.p.window ?? 200}-day trend filter on ${syms.join(" + ")}`,
    validate: (s) => (s.assets.length ? "" : "Pick at least one asset."),
  },
  sameday: {
    label: "Same-day sign (look-ahead demo)", multi: false, params: [],
    make: (s, [a]) => new SameDaySign(a),
    name: (s, [a]) => `"Long if today closed up" on ${a}`,
  },
};

const DEFAULTS = () => ({ strategy: "sma", asset: "SPY", assets: [...SYMBOLS], bench: "auto", start: "", end: "", cash: 100000, slip: 5, cps: 0.005, minc: 1, log: true, p: {} });
const PRESETS = [
  ["SMA 50/200", { strategy: "sma", asset: "SPY" }],
  ["RSI(2) dips", { strategy: "rsi2", asset: "SPY" }],
  ["3-asset trend", { strategy: "trend" }],
  ["2008 crisis", { strategy: "sma", asset: "SPY", p: { fast: 20, slow: 100 }, start: "2007-06-01", end: "2009-12-31" }],
  ["RSI(2), costly fills", { strategy: "rsi2", asset: "SPY", slip: 25 }],
  ["Look-ahead demo", { strategy: "sameday", asset: "SPY" }],
];

let state = DEFAULTS();
const frames = {};
let last = null;

/* ------------------------------------------------------------ theme */
const root = document.documentElement;
try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch {}
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
$("theme").onclick = () => {
  root.dataset.theme = isDark() ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  if (last) drawCharts();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (last) drawCharts(); });

/* ------------------------------------------------------------ URL hash <-> state */
let lastHash = "";
function writeHash() {
  const q = new URLSearchParams(), d = DEFAULTS();
  const put = (k, v, dv) => { if (String(v) !== String(dv)) q.set(k, v); };
  put("s", state.strategy, d.strategy); put("a", state.asset, d.asset); put("as", state.assets.join(","), d.assets.join(","));
  put("b", state.bench, d.bench); put("from", state.start, d.start); put("to", state.end, d.end);
  put("cash", state.cash, d.cash); put("slip", state.slip, d.slip); put("cps", state.cps, d.cps); put("minc", state.minc, d.minc);
  put("log", state.log ? 1 : 0, 1);
  for (const [k, v] of Object.entries(state.p)) q.set("p." + k, v);
  history.replaceState(null, "", q.toString() ? "#" + q : location.pathname + location.search);
  lastHash = location.hash;
}
addEventListener("hashchange", () => {
  if (location.hash === lastHash || !Object.keys(frames).length) return;
  state = readHash(); syncControls(); run();
});
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1)), s = DEFAULTS(), g = (k) => q.get(k);
  if (g("s") && STRATS[g("s")]) s.strategy = g("s");
  if (SYMBOLS.includes(g("a"))) s.asset = g("a");
  if (g("as") != null) s.assets = g("as").split(",").filter((x) => SYMBOLS.includes(x));
  if (g("b")) s.bench = g("b");
  s.start = g("from") ?? ""; s.end = g("to") ?? "";
  for (const k of ["cash", "slip", "cps", "minc"]) if (g(k) != null && isFinite(+g(k))) s[k] = +g(k);
  if (g("log") != null) s.log = g("log") === "1";
  for (const [k, v] of q) if (k.startsWith("p.") && isFinite(+v)) s.p[k.slice(2)] = +v;
  return s;
}

/* ------------------------------------------------------------ controls */
let timer = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { writeHash(); run(); }, 30); }

function buildControls() {
  $("presets").innerHTML = PRESETS.map(([n], i) => `<button class="btn" data-i="${i}">${n}</button>`).join("");
  $("presets").onclick = (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return;
    state = { ...DEFAULTS(), ...PRESETS[i][1], p: { ...(PRESETS[i][1].p ?? {}) } };
    syncControls(); schedule();
  };
  $("strategy").innerHTML = Object.entries(STRATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("strategy").onchange = (e) => { state.strategy = e.target.value; state.p = {}; syncControls(); schedule(); };
  $("bench").innerHTML = `<option value="auto">Same as asset (SPY for portfolios)</option>` + SYMBOLS.map((s) => `<option value="${s}">${s}</option>`).join("") + `<option value="none">None</option>`;
  $("bench").onchange = (e) => { state.bench = e.target.value; schedule(); };
  for (const k of ["start", "end"]) $(k).onchange = (e) => { state[k] = e.target.value; schedule(); };
  for (const k of ["cash", "slip", "cps", "minc"]) $(k).oninput = (e) => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) { state[k] = v; schedule(); } };
  $("reset").onclick = () => { state = DEFAULTS(); syncControls(); schedule(); };
  $("copy").onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); $("copy").textContent = "Copied"; } catch { $("copy").textContent = "Copy the address bar"; }
    setTimeout(() => ($("copy").textContent = "Copy link"), 1600);
  };
}

function syncControls() {
  const def = STRATS[state.strategy];
  $("strategy").value = state.strategy; $("bench").value = state.bench;
  $("start").value = state.start; $("end").value = state.end;
  for (const k of ["cash", "slip", "cps", "minc"]) $(k).value = state[k];

  $("params").innerHTML = def.params.map((p) => {
    const v = state.p[p.k] ?? p.def;
    return `<div class="slider"><div class="top2"><label for="p-${p.k}">${p.label}</label><output id="o-${p.k}">${v}</output></div><input type="range" id="p-${p.k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></div>`;
  }).join("");
  for (const p of def.params) $("p-" + p.k).oninput = (e) => { state.p[p.k] = +e.target.value; $("o-" + p.k).textContent = e.target.value; schedule(); };

  if (def.multi) {
    $("universe").innerHTML = `<div class="checks">` + SYMBOLS.map((s) => `<label><input type="checkbox" value="${s}" ${state.assets.includes(s) ? "checked" : ""}>${s}</label>`).join("") + `</div><p class="hint">Each selected asset gets an equal share while it closes above its SMA.</p>`;
    $("universe").onchange = () => { state.assets = [...$("universe").querySelectorAll("input:checked")].map((i) => i.value); schedule(); };
  } else {
    $("universe").innerHTML = `<div class="checks">` + SYMBOLS.map((s) => `<label><input type="radio" name="asset" value="${s}" ${state.asset === s ? "checked" : ""}>${s}</label>`).join("") + `</div>`;
    $("universe").onchange = (e) => { state.asset = e.target.value; schedule(); };
  }
}

/* ------------------------------------------------------------ run */
function run() {
  const def = STRATS[state.strategy];
  const msg = def.validate?.(state) ?? "";
  $("err").textContent = msg;
  if (msg) return;

  const syms = def.multi ? state.assets : [state.asset];
  const benchSym = state.bench === "auto" ? (def.multi ? "SPY" : state.asset) : state.bench;
  const needed = [...new Set([...syms, ...(benchSym === "none" ? [] : [benchSym])])];
  const subset = Object.fromEntries(needed.map((s) => [s, frames[s]]));
  const clip = { start: state.start || null, end: state.end || null };
  const opts = { initialCash: state.cash, costs: new CostModel(state.slip, state.cps, state.minc) };

  const t0 = performance.now();
  const data = new DataHandler(subset, clip);
  if (data.dates.length < 30) { $("err").textContent = "Fewer than 30 bars in this window; widen the date range."; return; }
  let res;
  try { res = new Backtest(data, def.make(state, syms), opts).run(); } catch (e) { $("err").textContent = e.message; return; }
  const showBench = benchSym !== "none" && !(state.strategy === "hold" && syms.length === 1 && syms[0] === benchSym);
  const bench = showBench ? new Backtest(new DataHandler(subset, clip), new BuyAndHold(benchSym), opts).run() : null;
  last = { res, bench, benchSym, name: def.name(state, syms), ms: performance.now() - t0, sel: 0 };
  render();
}

/* ------------------------------------------------------------ rendering */
function vsChip(s, b, fmt, higherBetter = true) {
  if (b == null || !isFinite(b)) return `<span class="vs">no benchmark</span>`;
  const d = s - b;
  if (Math.abs(d) < 1e-9) return `<span class="vs">= ${last.benchSym}</span>`;
  const good = d > 0 === higherBetter;
  return `<span class="vs ${d > 0 ? "up" : "down"}" style="${good ? "" : ""}" aria-label="${d > 0 ? "higher" : "lower"} than ${last.benchSym} by ${fmt(Math.abs(d))}">${fmt(Math.abs(d))} vs ${last.benchSym}</span>`;
}

function render() {
  const { res, bench, benchSym, name, ms } = last;
  const n = res.dates.length, events = Object.values(res.counts).reduce((a, b) => a + b, 0);
  $("loading").hidden = true; $("out").hidden = false;
  $("title").textContent = name;
  $("meta").innerHTML = [`${res.dates[0]} → ${res.dates[n - 1]}`, `${n.toLocaleString("en-US")} bars`, `${events.toLocaleString("en-US")} events`, `${Math.max(1, Math.round(ms))} ms`, `${usd(state.cash)} start`].map((c) => `<span class="chip">${c}</span>`).join("");

  const m = res.metrics, b = bench?.metrics, pts = (x) => (x * 100).toFixed(1) + " pts";
  const kpi = (label, val, chip, sub, cls = "") => `<div class="card kpi"><span class="l">${label}</span><b class="${cls}">${val}</b>${chip}<small>${sub}</small></div>`;
  $("kpis").innerHTML = [
    kpi("Final value", usd(res.equity[n - 1]), vsChip(m.totalReturn, b?.totalReturn, pts), `${pct(m.totalReturn, 0)} total return`, signCls(m.totalReturn)),
    kpi("CAGR", pct(m.cagr), vsChip(m.cagr, b?.cagr, pts), `${pct(m.volatility)} volatility`, signCls(m.cagr)),
    kpi("Sharpe", num(m.sharpe), vsChip(m.sharpe, b?.sharpe, (x) => x.toFixed(2)), `Sortino ${num(m.sortino)}`, signCls(m.sharpe)),
    kpi("Max drawdown", pct(m.maxDrawdown), vsChip(m.maxDrawdown, b?.maxDrawdown, pts), `Calmar ${num(m.calmar)}`, "neg"),
    kpi("Round trips", m.trades.toLocaleString("en-US"), `<span class="vs">${m.trades ? pct(m.winRate, 0) + " win rate" : "none closed"}</span>`, m.trades ? `profit factor ${num(m.profitFactor)}` : "&nbsp;"),
    kpi("Costs paid", usd(res.totalCosts), `<span class="vs">${(res.totalCosts / state.cash * 100).toFixed(1)}% of start cash</span>`, `${res.fills.length.toLocaleString("en-US")} fills`),
  ].join("");

  $("foot").textContent = `Event counts: ${Object.entries(res.counts).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(" · ")}. Long-only, no leverage, daily bars, dividend-adjusted prices, orders fill at the next open. Educational, not investment advice.`;

  renderTearsheet();
  drawCharts();
  renderMonthly(res);
  renderTrades(res);
  setupInspector(res);
}

function renderTearsheet() {
  const { res, bench } = last;
  const ds = dayStats(res.equity, res.dates), bs = bench ? dayStats(bench.equity, bench.dates) : null;
  const inMarket = (r) => r.filter((x) => x.positionsValue / x.equity > 0.01).length / r.length;
  const m = res.metrics, b = bench?.metrics, dash = "–";
  const days = res.trades.length ? res.trades.reduce((a, t) => a + (Date.parse(t.exit) - Date.parse(t.entry)) / 864e5, 0) / res.trades.length : null;
  const rows = [
    ["Total return", pct(m.totalReturn), b && pct(b.totalReturn)],
    ["CAGR", pct(m.cagr), b && pct(b.cagr)],
    ["Annualised volatility", pct(m.volatility), b && pct(b.volatility)],
    ["Sharpe ratio", num(m.sharpe), b && num(b.sharpe)],
    ["Sortino ratio", num(m.sortino), b && num(b.sortino)],
    ["Calmar ratio", num(m.calmar), b && num(b.calmar)],
    ["Max drawdown", pct(m.maxDrawdown), b && pct(b.maxDrawdown)],
    ["Best day", `${pct(ds.best, 2)} <span style="color:var(--faint)">${ds.bestDate}</span>`, bs && `${pct(bs.best, 2)} <span style="color:var(--faint)">${bs.bestDate}</span>`],
    ["Worst day", `${pct(ds.worst, 2)} <span style="color:var(--faint)">${ds.worstDate}</span>`, bs && `${pct(bs.worst, 2)} <span style="color:var(--faint)">${bs.worstDate}</span>`],
    ["Skew of daily returns", num(ds.skew), bs && num(bs.skew)],
    ["Time in market", pct(inMarket(res.rows), 0), bench && pct(inMarket(bench.rows), 0)],
    ["Round trips / win rate", m.trades ? `${m.trades} / ${pct(m.winRate, 0)}` : dash, bench && dash],
    ["Avg trade / holding period", m.trades ? `${pct(m.avgTradeReturn, 2)} / ${Math.round(days)} d` : dash, bench && dash],
    ["Costs paid", `${usd(res.totalCosts)} (${res.fills.length} fills)`, bench && `${usd(bench.totalCosts)} (${bench.fills.length} fills)`],
  ];
  $("tear").innerHTML = `<thead><tr><th>Metric</th><th>Strategy</th>${bench ? `<th>${last.benchSym} buy &amp; hold</th>` : ""}</tr></thead><tbody>` +
    rows.map(([k, s, bb]) => `<tr><td>${k}</td><td>${s}</td>${bench ? `<td>${bb ?? dash}</td>` : ""}</tr>`).join("") + "</tbody>";
}

/* ---- charts ------------------------------------------------------------------------------ */
const MAXPTS = 1000;
const charts = {};
const TIME = ["eq", "dd", "rs", "ex", "co"];

function bucketSize(n) { return Math.max(1, Math.ceil(n / MAXPTS)); }
function dec(arr, B, mode = "last") {
  const out = [];
  for (let i = 0; i < arr.length; i += B) {
    const c = arr.slice(i, i + B).filter((x) => x != null);
    out.push(!c.length ? null : mode === "min" ? Math.min(...c) : c[c.length - 1]);
  }
  return out;
}
const decLabels = (dates, B) => { const o = []; for (let i = 0; i < dates.length; i += B) o.push(dates[Math.min(i + B - 1, dates.length - 1)]); return o; };
const alpha = (hex, a) => { // theme tokens are #rrggbb; canvas needs a plain rgba() string
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** Hover hairline (synced across time charts) + selected-bar marker from the event inspector. */
const guides = {
  id: "guides",
  afterDatasetsDraw(chart) {
    if (!TIME.includes(chart.$key)) return;
    const { top, bottom } = chart.chartArea, c = chart.ctx, x = chart.scales.x;
    const own = chart.tooltip?.getActiveElements?.()[0]?.index;
    const hov = own ?? chart.$hover;
    const line = (i, color, dash, a) => {
      if (i == null || i < 0) return;
      const px = x.getPixelForValue(i);
      c.save(); c.strokeStyle = color; c.globalAlpha = a; c.setLineDash(dash); c.lineWidth = 1;
      c.beginPath(); c.moveTo(px, top); c.lineTo(px, bottom); c.stroke(); c.restore();
    };
    line(chart.$sel, css("--strat"), [4, 3], 0.8);
    line(hov, css("--muted"), [], 0.6);
  },
};

/** Shaded bands where the strategy is invested. */
const bands = {
  id: "bands",
  beforeDatasetsDraw(chart, _a, opt) {
    if (!opt.on) return;
    const { top, bottom } = chart.chartArea, c = chart.ctx, x = chart.scales.x;
    c.save(); c.fillStyle = alpha(css("--strat"), 0.07);
    let start = null;
    opt.on.forEach((v, i) => {
      if (v && start == null) start = i;
      if ((!v || i === opt.on.length - 1) && start != null) {
        const end = v && i === opt.on.length - 1 ? i : i - 1;
        const x0 = x.getPixelForValue(start), x1 = x.getPixelForValue(end);
        c.fillRect(x0, top, Math.max(1.5, x1 - x0), bottom - top);
        start = null;
      }
    });
    c.restore();
  },
};

/** Direct labels at the right edge of each line, nudged apart so they never overlap. */
const endLabels = {
  id: "endLabels",
  afterDatasetsDraw(chart, _a, opt) {
    if (!opt.on) return;
    const c = chart.ctx, { right } = chart.chartArea;
    const items = chart.data.datasets.filter((d) => d._end).map((d) => {
      const i = d.data.length - 1;
      return { d, y: chart.scales.y.getPixelForValue(d.data[i]), text: d._end(d.data[i]) };
    }).sort((a, b) => a.y - b.y);
    for (let k = 1; k < items.length; k++) if (items[k].y - items[k - 1].y < 15) items[k].y = items[k - 1].y + 15;
    c.save(); c.font = `600 11px ${css("--mono")}`; c.textBaseline = "middle";
    for (const it of items) {
      const color = it.d.borderColor, w = c.measureText(it.text).width + 12;
      c.fillStyle = color; c.beginPath(); c.roundRect(right + 6, it.y - 9, w, 18, 5); c.fill();
      c.fillStyle = "#fff"; c.fillText(it.text, right + 12, it.y + 0.5);
    }
    c.restore();
  },
};

/** Labels the deepest drawdown on the first dataset. */
const troughLabel = {
  id: "troughLabel",
  afterDatasetsDraw(chart, _a, opt) {
    if (!opt.on) return;
    const d = chart.data.datasets[0].data;
    let mi = 0; d.forEach((v, i) => { if (v != null && v < d[mi]) mi = i; });
    const x = chart.scales.x.getPixelForValue(mi), y = chart.scales.y.getPixelForValue(d[mi]), c = chart.ctx;
    c.save(); c.fillStyle = css("--neg"); c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.fill();
    c.font = `600 11px ${css("--mono")}`; c.textBaseline = "bottom";
    const text = pct(d[mi]), w = c.measureText(text).width;
    c.textAlign = x + w + 14 > chart.chartArea.right ? "right" : "left";
    c.fillText(text, x + (c.textAlign === "left" ? 8 : -8), y - 6);
    c.restore();
  },
};

function theme() {
  return { text: css("--muted"), grid: css("--grid"), line: css("--line"), card: css("--card"), fg: css("--text"), mono: css("--mono"), sans: css("--sans") };
}

function baseOptions(th, yFmt, { pad = {}, y = {}, x = {}, tipTitle } = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    layout: { padding: { top: 6, right: 6, ...pad } },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: th.card, titleColor: th.fg, bodyColor: th.text, borderColor: th.line, borderWidth: 1, padding: 10, cornerRadius: 8,
        titleFont: { family: th.mono, size: 11, weight: "600" }, bodyFont: { family: th.mono, size: 11 }, boxPadding: 4, caretSize: 0,
        filter: (i) => !i.dataset._hide,
        callbacks: { title: (it) => (tipTitle ? tipTitle(it) : it[0].label), label: (c) => ` ${c.dataset.label}: ${yFmt(c.parsed.y)}` },
      },
      guides: {}, bands: {}, endLabels: {}, troughLabel: {},
    },
    scales: {
      x: { grid: { display: false }, border: { color: th.line }, ticks: { color: th.text, font: { family: th.mono, size: 11 }, maxRotation: 0, autoSkipPadding: 28, maxTicksLimit: 9, callback(v) { const l = this.getLabelForValue(v); return charts.longSpan ? l.slice(0, 4) : l.slice(0, 7); } }, ...x },
      y: { grid: { color: (c) => (c.tick.value === 0 ? th.line : th.grid) }, border: { display: false }, ticks: { color: th.text, font: { family: th.mono, size: 11 }, callback: (v) => yFmt(v), maxTicksLimit: 6 }, ...y },
    },
  };
}

function mkChart(key, config) {
  charts[key]?.destroy();
  const ch = new Chart($(key), { ...config, plugins: [guides, bands, endLabels, troughLabel] });
  ch.$key = key;
  charts[key] = ch;
  return ch;
}
const line = (label, data, color, extra = {}) => ({ type: "line", label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color, tension: 0, spanGaps: false, ...extra });

function legendHtml(items) {
  return items.map(([kind, color, text]) => `<span>${kind === "tri-up" ? '<i class="sw-tri up"></i>' : kind === "tri-dn" ? '<i class="sw-tri dn"></i>' : `<i class="sw-${kind}" style="${kind === "box" ? "background" : "border-color"}:${color}"></i>`}${text}</span>`).join("");
}

function drawCharts() {
  const { res, bench, benchSym } = last, th = theme();
  const n = res.dates.length, B = bucketSize(n), labels = decLabels(res.dates, B);
  charts.longSpan = (Date.parse(res.dates[n - 1]) - Date.parse(res.dates[0])) / 864e5 > 3 * 365;
  charts.B = B;
  const S = css("--strat"), G = css("--bench"), benchName = `${benchSym} buy & hold`;
  const expo = exposure(res.rows);
  const dayTitle = (it) => it[0].label;

  /* equity, with entry/exit markers and in-market bands */
  const eqS = dec(res.equity, B);
  const marks = (side) => {
    const arr = new Array(labels.length).fill(null);
    for (const f of res.fills) {
      if (f.side !== side) continue;
      const bar = res.dates.indexOf(f.date), k = Math.floor(bar / B);
      arr[k] = eqS[k];
    }
    return arr;
  };
  const showMarks = res.fills.length <= 300;
  const eqSets = [
    line(state.strategyLabel ?? "Strategy", eqS, S, { _end: compactUsd, order: 2 }),
    ...(bench ? [line(benchName, dec(bench.equity, B), G, { borderDash: [6, 4], borderWidth: 1.6, _end: compactUsd, order: 3 })] : []),
    ...(showMarks ? [
      { type: "line", label: "Entry", data: marks("BUY"), showLine: false, pointStyle: "triangle", pointRadius: 6.5, pointHoverRadius: 7, backgroundColor: css("--pos"), borderColor: th.card, borderWidth: 1.5, _hide: true, order: 1 },
      { type: "line", label: "Exit", data: marks("SELL"), showLine: false, pointStyle: "triangle", rotation: 180, pointRadius: 6.5, pointHoverRadius: 7, backgroundColor: css("--neg"), borderColor: th.card, borderWidth: 1.5, _hide: true, order: 1 },
    ] : []),
  ];
  const eqOpt = baseOptions(th, compactUsd, { pad: { right: 78 }, y: { type: state.log ? "logarithmic" : "linear" }, tipTitle: dayTitle });
  eqOpt.scales.y.ticks.callback = function (v) {
    if (this.chart.options.scales.y.type === "logarithmic" && ![1, 2, 3, 5].includes(Math.round(v / 10 ** Math.floor(Math.log10(v))))) return "";
    return compactUsd(v);
  };
  eqOpt.plugins.bands = { on: dec(expo, B).map((v) => v > 0.01) };
  eqOpt.plugins.endLabels = { on: true };
  mkChart("eq", { type: "line", data: { labels, datasets: eqSets }, options: eqOpt });
  $("lg-eq").innerHTML = legendHtml([["line", S, "Strategy"], ...(bench ? [["dash", G, benchName]] : []), ...(showMarks ? [["tri-up", "", "Entry"], ["tri-dn", "", "Exit"]] : []), ["box", alpha(S, 0.18), "In market"],
    ]) + `<label class="toggle"><input type="checkbox" id="log" ${state.log ? "checked" : ""}>Log scale</label>`;
  $("log").onchange = (e) => { state.log = e.target.checked; writeHash(); drawCharts(); };

  /* drawdown */
  const ddOpt = baseOptions(th, (v) => pct(v, 0), { tipTitle: dayTitle });
  ddOpt.plugins.troughLabel = { on: true };
  mkChart("dd", { type: "line", data: { labels, datasets: [
    line("Strategy", dec(drawdownSeries(res.equity), B, "min"), S, { fill: "origin", backgroundColor: alpha(S, 0.16), borderWidth: 1.6 }),
    ...(bench ? [line(benchName, dec(drawdownSeries(bench.equity), B, "min"), G, { borderDash: [6, 4], borderWidth: 1.3 })] : []),
  ] }, options: ddOpt });

  /* rolling sharpe */
  const rsOpt = baseOptions(th, (v) => num(v, 1), { tipTitle: dayTitle });
  mkChart("rs", { type: "line", data: { labels, datasets: [
    line("Strategy", dec(rollingSharpe(res.equity), B), S, { borderWidth: 1.8 }),
    ...(bench ? [line(benchName, dec(rollingSharpe(bench.equity), B), G, { borderDash: [6, 4], borderWidth: 1.4 })] : []),
  ] }, options: rsOpt });

  /* calendar-year returns */
  const ar = annualReturns(res.dates, res.equity), br = bench ? annualReturns(bench.dates, bench.equity) : null;
  const anOpt = baseOptions(th, (v) => pct(v, 0), { x: { ticks: { color: th.text, font: { family: th.mono, size: 11 }, maxRotation: 60, autoSkip: true, callback(v) { return this.getLabelForValue(v).replace(" YTD", "*"); } } } });
  anOpt.layout.padding.right = 6;
  mkChart("an", { type: "bar", data: { labels: ar.years, datasets: [
    { label: "Strategy", data: ar.values, backgroundColor: S, borderRadius: 3, maxBarThickness: 18 },
    ...(br ? [{ label: benchName, data: br.values, backgroundColor: alpha(G, 0.55), borderColor: G, borderWidth: 1, borderRadius: 3, maxBarThickness: 18 }] : []),
  ] }, options: anOpt });

  /* daily-return histogram (flat days excluded) */
  const hs = histogram(dailyReturns(res.equity)), hb = bench ? histogram(dailyReturns(bench.equity)) : null;
  const hiOpt = baseOptions(th, (v) => v.toFixed(1) + "%", {
    x: { ticks: { color: th.text, font: { family: th.mono, size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback(v) { return pct(hs.centers[v], 0); } } },
    tipTitle: (it) => `${pct(hs.centers[it[0].dataIndex] - hs.width / 2, 2)} to ${pct(hs.centers[it[0].dataIndex] + hs.width / 2, 2)}`,
  });
  mkChart("hi", { type: "bar", data: { labels: hs.centers.map((c) => pct(c, 2)), datasets: [
    { label: "Strategy", data: hs.density, backgroundColor: alpha(S, 0.85), borderRadius: 2, categoryPercentage: 1, barPercentage: 0.92, order: 2 },
    ...(hb ? [{ type: "line", label: benchName, data: hb.density, borderColor: G, borderDash: [5, 3], borderWidth: 1.6, pointRadius: 0, tension: 0.35, order: 1 }] : []),
  ] }, options: hiOpt });
  $("hi-note").textContent = `Share of ${hs.n.toLocaleString("en-US")} invested days per return bucket; days spent in cash are excluded. Tails are clipped at ±5%.`;

  /* exposure and cumulative costs */
  mkChart("ex", { type: "line", data: { labels, datasets: [line("Exposure", dec(expo, B), css("--expo"), { fill: "origin", backgroundColor: alpha(css("--expo"), 0.2), stepped: true, borderWidth: 1.5 })] },
    options: baseOptions(th, (v) => pct(v, 0), { y: { min: 0, max: 1 }, tipTitle: dayTitle }) });
  mkChart("co", { type: "line", data: { labels, datasets: [line("Costs", dec(cumulativeCosts(res.dates, res.fills), B), css("--cost"), { fill: "origin", backgroundColor: alpha(css("--cost"), 0.18), stepped: true, borderWidth: 1.5 })] },
    options: baseOptions(th, usd, { y: { min: 0 }, tipTitle: dayTitle }) });

  /* legends for the paired charts */
  const pair = legendHtml([["line", S, "Strategy"], ...(bench ? [["dash", G, benchName]] : [])]);
  for (const id of ["dd", "rs", "an", "hi"]) {
    const ph = $("h-" + id).closest(".ph");
    let lg = ph.querySelector(".legend");
    if (!lg) { lg = document.createElement("div"); lg.className = "legend"; ph.append(lg); }
    lg.innerHTML = id === "an" || id === "hi" ? legendHtml([["box", S, "Strategy"], ...(bench ? [["box", alpha(G, 0.55), benchName]] : [])]) : pair;
  }

  linkCrosshair();
  markSelected();
}

/** Hovering one time-series chart draws a hairline at the same bar on the others. */
function linkCrosshair() {
  const list = TIME.map((k) => charts[k]);
  for (const c of list) {
    c.canvas.onmousemove = (e) => {
      const r = c.canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(c.data.labels.length - 1, Math.round(c.scales.x.getValueForPixel(e.clientX - r.left))));
      for (const o of list) if (o !== c) { o.$hover = i; o.draw(); }
    };
    c.canvas.onmouseleave = () => { for (const o of list) if (o.$hover != null) { o.$hover = null; o.draw(); } };
  }
}
function markSelected() {
  if (!last || !charts.eq) return;
  for (const k of TIME) { charts[k].$sel = Math.floor(last.sel / charts.B); charts[k].draw(); }
}

function renderMonthly(res) {
  const mr = monthlyReturns(res.dates, res.equity);
  const years = Object.keys(mr).map(Number).sort((a, b) => a - b);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cell = (r) => {
    if (r == null) return "<td></td>";
    const a = Math.round(Math.min(Math.abs(r) / 0.1, 1) * 55 + 6);
    return `<td style="background:color-mix(in srgb, var(${r >= 0 ? "--pos" : "--neg"}) ${a}%, transparent)">${num(r * 100, 1)}</td>`;
  };
  $("monthly").innerHTML = `<table><thead><tr><th>Year</th>${mon.map((m) => `<th>${m}</th>`).join("")}<th>Year</th></tr></thead><tbody>` +
    years.map((y) => {
      const tot = Object.values(mr[y]).reduce((a, r) => a * (1 + r), 1) - 1;
      return `<tr><td>${y}</td>${mon.map((_, i) => cell(mr[y][i])).join("")}<td class="${signCls(tot)}"><b>${num(tot * 100, 1)}</b></td></tr>`;
    }).join("") + `</tbody></table>`;
}

function renderTrades(res) {
  const t = res.trades;
  $("trade-note").textContent = t.length > 300 ? `Latest 300 of ${t.length} closed trades.` : `${t.length} closed trade${t.length === 1 ? "" : "s"}.`;
  if (!t.length) { $("trades").innerHTML = `<tbody><tr><td>No closed trades in this window${res.fills.length ? " (a position is still open)" : ""}.</td></tr></tbody>`; return; }
  $("trades").innerHTML = `<thead><tr><th>Asset</th><th>Entry</th><th>Exit</th><th>Days</th><th>Return</th><th>P&amp;L</th></tr></thead><tbody>` +
    t.slice(-300).reverse().map((x) => `<tr><td>${x.symbol}</td><td>${x.entry}</td><td>${x.exit}</td><td>${Math.round((Date.parse(x.exit) - Date.parse(x.entry)) / 864e5)}</td><td class="${signCls(x.ret)}">${pct(x.ret)}</td><td class="${signCls(x.pnl)}">${usd(x.pnl)}</td></tr>`).join("") + "</tbody>";
}

/* ------------------------------------------------------------ event inspector */
let byBar = [], sigBars = [];
function setupInspector(res) {
  byBar = res.dates.map(() => []);
  for (const { bar, event } of res.trace) byBar[bar].push(event);
  sigBars = byBar.map((evs, i) => (evs.some((e) => e.type === T.SIGNAL) ? i : -1)).filter((i) => i >= 0);
  $("bar").max = res.dates.length - 1;
  last.sel = sigBars[0] ?? 0;
  showBar();
}
function showBar() {
  const { res, sel } = last, row = res.rows[sel];
  $("bar").value = sel;
  const held = Object.entries(row.shares).map(([s, q]) => `${s} ${q.toLocaleString("en-US")} sh`).join(", ") || "flat";
  $("state").innerHTML = `<span>bar <b>${sel + 1}</b> / ${res.dates.length}</span><span>date <b>${row.date}</b></span><span>equity <b>${usd(row.equity)}</b></span><span>cash <b>${usd(row.cash)}</b></span><span>holding <b>${held}</b></span>`;
  $("events").innerHTML = byBar[sel].map((e) => `<span class="ev-${e.type}">${esc(describe(e))}</span>`).join("\n");
  markSelected();
}
$("bar").oninput = (e) => { last.sel = +e.target.value; showBar(); };
$("prevSig").onclick = () => { const p = [...sigBars].reverse().find((i) => i < last.sel); if (p != null) { last.sel = p; showBar(); } };
$("nextSig").onclick = () => { const p = sigBars.find((i) => i > last.sel); if (p != null) { last.sel = p; showBar(); } };

/* ------------------------------------------------------------ boot */
(async function boot() {
  buildControls();
  try {
    const texts = await Promise.all(SYMBOLS.map((s) => fetch(`../data/${s}.csv`).then((r) => { if (!r.ok) throw new Error(`${s}.csv: HTTP ${r.status}`); return r.text(); })));
    SYMBOLS.forEach((s, i) => (frames[s] = parseCsv(texts[i])));
  } catch (e) {
    $("loading").textContent = "Could not load price data (" + e.message + "). If you opened this file directly, serve the docs/ folder over HTTP instead.";
    return;
  }
  const dates = frames.SPY.dates;
  for (const id of ["start", "end"]) { $(id).min = dates[0]; $(id).max = dates.at(-1); }
  state = readHash();
  syncControls();
  run();
  document.fonts?.ready.then(() => last && drawCharts()); // redraw once web fonts are in (canvas text metrics)
})();
