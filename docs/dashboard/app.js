import {
  Backtest, BuyAndHold, CostModel, DataHandler, RSIMeanReversion, SameDaySign, SMACrossover, T,
  TrendFilterPortfolio, describe, drawdownSeries, monthlyReturns, parseCsv,
} from "./engine.js";

const SYMBOLS = ["SPY", "TLT", "GLD"];
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x * 100).toFixed(d) + "%");
const num = (x, d = 2) => (x == null || !isFinite(x) ? "n/a" : x.toFixed(d));
const usd = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const signCls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");

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
    name: (s, syms) => `${s.p.window ?? 200}-day trend filter on ${syms.join("+")}`,
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
let frames = {};
let last = null; // most recent run, for the inspector and theme changes

/* ------------------------------------------------------------ URL hash <-> state */
function writeHash() {
  const q = new URLSearchParams();
  const d = DEFAULTS();
  const put = (k, v, dv) => { if (String(v) !== String(dv)) q.set(k, v); };
  put("s", state.strategy, d.strategy); put("a", state.asset, d.asset); put("as", state.assets.join(","), d.assets.join(","));
  put("b", state.bench, d.bench); put("from", state.start, d.start); put("to", state.end, d.end);
  put("cash", state.cash, d.cash); put("slip", state.slip, d.slip); put("cps", state.cps, d.cps); put("minc", state.minc, d.minc);
  put("log", state.log ? 1 : 0, 1);
  for (const [k, v] of Object.entries(state.p)) q.set("p." + k, v);
  history.replaceState(null, "", q.toString() ? "#" + q : location.pathname + location.search);
  lastHash = location.hash;
}
let lastHash = "";
addEventListener("hashchange", () => {
  if (location.hash === lastHash || !Object.keys(frames).length) return; // our own write, or data not loaded
  state = readHash(); syncControls(); run();
});
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const s = DEFAULTS();
  const g = (k) => q.get(k);
  if (g("s") && STRATS[g("s")]) s.strategy = g("s");
  if (SYMBOLS.includes(g("a"))) s.asset = g("a");
  if (g("as") != null) s.assets = g("as").split(",").filter((x) => SYMBOLS.includes(x));
  if (g("b")) s.bench = g("b");
  s.start = g("from") ?? ""; s.end = g("to") ?? "";
  for (const [k, key] of [["cash", "cash"], ["slip", "slip"], ["cps", "cps"], ["minc", "minc"]]) if (g(k) != null && isFinite(+g(k))) s[key] = +g(k);
  if (g("log") != null) s.log = g("log") === "1";
  for (const [k, v] of q) if (k.startsWith("p.") && isFinite(+v)) s.p[k.slice(2)] = +v;
  return s;
}

/* ------------------------------------------------------------ controls */
let timer = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { writeHash(); run(); }, 30); }

function buildControls() {
  $("presets").innerHTML = PRESETS.map(([n], i) => `<button data-i="${i}">${n}</button>`).join("");
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

  for (const [id, key] of [["start", "start"], ["end", "end"]]) $(id).onchange = (e) => { state[key] = e.target.value; schedule(); };
  for (const [id, key] of [["cash", "cash"], ["slip", "slip"], ["cps", "cps"], ["minc", "minc"]]) {
    $(id).oninput = (e) => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) { state[key] = v; schedule(); } };
  }
  $("log").onchange = (e) => { state.log = e.target.checked; applyScale(); writeHash(); };
  $("reset").onclick = () => { state = DEFAULTS(); syncControls(); schedule(); };
  $("copy").onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); $("copy").textContent = "Copied!"; } catch { $("copy").textContent = "Copy the address bar"; }
    setTimeout(() => ($("copy").textContent = "Copy link"), 1600);
  };
}

function syncControls() {
  const def = STRATS[state.strategy];
  $("strategy").value = state.strategy;
  $("bench").value = state.bench;
  $("start").value = state.start; $("end").value = state.end;
  for (const k of ["cash", "slip", "cps", "minc"]) $(k).value = state[k];
  $("log").checked = state.log;

  $("params").innerHTML = def.params.map((p) => {
    const v = state.p[p.k] ?? p.def;
    return `<div class="slider"><label class="f" for="p-${p.k}">${p.label}</label><div class="top"><span></span><output id="o-${p.k}">${v}</output></div><input type="range" id="p-${p.k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></div>`;
  }).join("");
  for (const p of def.params) {
    $("p-" + p.k).oninput = (e) => { state.p[p.k] = +e.target.value; $("o-" + p.k).textContent = e.target.value; schedule(); };
  }

  if (def.multi) {
    $("universe").innerHTML = `<div class="checks">` + SYMBOLS.map((s) => `<label><input type="checkbox" value="${s}" ${state.assets.includes(s) ? "checked" : ""}>${s}</label>`).join("") + `</div><p class="hint">Each selected asset gets an equal share while it is above its SMA.</p>`;
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
  const ms = performance.now() - t0;

  last = { res, bench, benchSym, name: def.name(state, syms), ms, sel: 0 };
  render();
}

/* ------------------------------------------------------------ rendering */
function render() {
  const { res, bench, benchSym, name, ms } = last;
  const n = res.dates.length;
  const events = Object.values(res.counts).reduce((a, b) => a + b, 0);
  $("loading").hidden = true; $("out").hidden = false;
  $("summary").textContent = `${name} · ${res.dates[0]} → ${res.dates[n - 1]} · ${n.toLocaleString("en-US")} bars · ${events.toLocaleString("en-US")} events processed in ${Math.round(last.ms)} ms`;

  const m = res.metrics, b = bench?.metrics;
  const sub = (f) => (b ? `${benchSym} buy &amp; hold: ${f(b)}` : "&nbsp;");
  const kp = (label, val, subHtml, cls = "") => `<div class="kpi"><span>${label}</span><b class="${cls}">${val}</b><small>${subHtml}</small></div>`;
  const final = res.equity[n - 1];
  $("kpis").innerHTML = [
    kp("Final value", usd(final), `${pct(m.totalReturn, 0)} total` + (b ? ` · ${benchSym}: ${pct(b.totalReturn, 0)}` : ""), signCls(m.totalReturn)),
    kp("CAGR", pct(m.cagr), sub((x) => pct(x.cagr)), signCls(m.cagr)),
    kp("Volatility", pct(m.volatility), sub((x) => pct(x.volatility))),
    kp("Sharpe", num(m.sharpe), sub((x) => num(x.sharpe)), signCls(m.sharpe)),
    kp("Sortino", num(m.sortino), sub((x) => num(x.sortino))),
    kp("Max drawdown", pct(m.maxDrawdown), sub((x) => pct(x.maxDrawdown)), "neg"),
    kp("Round trips", m.trades, m.trades ? `${pct(m.winRate, 0)} win rate · PF ${num(m.profitFactor)}` : "no closed trades"),
    kp("Costs paid", usd(res.totalCosts), `${(res.totalCosts / state.cash * 100).toFixed(1)}% of starting cash · ${res.fills.length} fills`),
  ].join("");

  $("lg-strat").textContent = "Strategy";
  $("lg-bench-wrap").hidden = !bench;
  $("lg-bench").textContent = bench ? `${benchSym} buy & hold` : "";
  $("foot").textContent = `Event counts: ${Object.entries(res.counts).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(" · ")}. Long-only, no leverage, daily bars, dividend-adjusted prices, fills at the next open. Educational, not investment advice.`;

  drawCharts();
  renderMonthly(res);
  renderTrades(res);
  setupInspector(res);
}

const MAXPTS = 1100;
function decimate(arr, B, mode = "last") {
  const out = [];
  for (let i = 0; i < arr.length; i += B) {
    const chunk = arr.slice(i, i + B);
    out.push(mode === "min" ? Math.min(...chunk) : chunk[chunk.length - 1]);
  }
  return out;
}
const decLabels = (dates, B) => { const out = []; for (let i = 0; i < dates.length; i += B) out.push(dates[Math.min(i + B - 1, dates.length - 1)]); return out; };

const charts = {};
const selLine = {
  id: "selLine",
  afterDatasetsDraw(chart) {
    const i = chart.$sel;
    if (i == null) return;
    const x = chart.scales.x.getPixelForValue(i), { top, bottom } = chart.chartArea;
    const c = chart.ctx;
    c.save(); c.strokeStyle = css("--accent"); c.globalAlpha = 0.7; c.setLineDash([4, 3]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.restore();
  },
};

function chartOpts(yFmt, extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${yFmt(c.parsed.y)}` } } },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 8, color: css("--muted"), callback() { const l = this.getLabelForValue(arguments[0]); return charts.longSpan ? l.slice(0, 4) : l.slice(0, 7); } } },
      y: { grid: { color: css("--grid") }, ticks: { color: css("--muted"), callback: (v) => yFmt(v) }, ...extra },
    },
  };
}
const compactUsd = (v) => (v >= 1e6 ? "$" + +(v / 1e6).toFixed(1) + "M" : v >= 1e3 ? "$" + Math.round(v / 1e3) + "k" : "$" + Math.round(v));

function ensureCharts() {
  if (charts.eq) return;
  const mk = (id, yFmt, extra) => new Chart($(id), { type: "line", data: { labels: [], datasets: [] }, options: chartOpts(yFmt, extra), plugins: [selLine] });
  charts.eq = mk("eq", compactUsd);
  charts.eq.options.scales.y.ticks.callback = function (v) {
    if (this.chart.options.scales.y.type === "logarithmic" && ![1, 2, 5].includes(Math.round(v / 10 ** Math.floor(Math.log10(v))))) return "";
    return compactUsd(v);
  };
  charts.dd = mk("dd", (v) => pct(v, 0));
  charts.ex = mk("ex", (v) => pct(v, 0), { min: 0, max: 1 });
}
const ds = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, tension: 0, ...extra });

function drawCharts() {
  ensureCharts();
  const { res, bench } = last;
  const B = Math.max(1, Math.ceil(res.dates.length / MAXPTS));
  const labels = decLabels(res.dates, B);
  charts.longSpan = (Date.parse(res.dates.at(-1)) - Date.parse(res.dates[0])) / 864e5 > 3 * 365;
  const strat = css("--c-strat"), bc = css("--c-bench");

  charts.eq.data = { labels, datasets: [ds("Strategy", decimate(res.equity, B), strat), ...(bench ? [ds(`${last.benchSym} buy & hold`, decimate(bench.equity, B), bc)] : [])] };
  const ddS = drawdownSeries(res.equity);
  charts.dd.data = { labels, datasets: [ds("Strategy", decimate(ddS, B, "min"), strat, { fill: true, backgroundColor: strat + "33" }), ...(bench ? [ds(`${last.benchSym} buy & hold`, decimate(drawdownSeries(bench.equity), B, "min"), bc, { borderWidth: 1.2 })] : [])] };
  charts.ex.data = { labels, datasets: [ds("Exposure", decimate(res.rows.map((r) => (r.equity ? r.positionsValue / r.equity : 0)), B), css("--c-expo"), { fill: true, backgroundColor: css("--c-expo") + "33", stepped: true })] };
  charts.B = B;
  applyScale();
  markSelected();
}
function applyScale() {
  if (!charts.eq) return;
  charts.eq.options.scales.y.type = state.log ? "logarithmic" : "linear";
  for (const k of ["eq", "dd", "ex"]) charts[k].update();
}
function markSelected() {
  if (!last) return;
  for (const k of ["eq", "dd", "ex"]) { charts[k].$sel = Math.floor(last.sel / charts.B); charts[k].update("none"); }
}

function renderMonthly(res) {
  const mr = monthlyReturns(res.dates, res.equity);
  const years = Object.keys(mr).map(Number).sort((a, b) => a - b);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cell = (r) => {
    if (r == null) return "<td></td>";
    const a = Math.min(Math.abs(r) / 0.1, 1) * 0.6 + 0.05;
    return `<td style="background:${r >= 0 ? `rgba(12,166,120,${a})` : `rgba(232,89,12,${a})`}">${(r * 100).toFixed(1)}</td>`;
  };
  $("monthly").innerHTML = `<table><tr><th>Year</th>${mon.map((m) => `<th>${m}</th>`).join("")}<th>Year</th></tr>` +
    years.map((y) => {
      const tot = Object.values(mr[y]).reduce((a, r) => a * (1 + r), 1) - 1;
      return `<tr><td>${y}</td>${mon.map((_, i) => cell(mr[y][i])).join("")}<td class="${signCls(tot)}"><b>${(tot * 100).toFixed(1)}</b></td></tr>`;
    }).join("") + `</table>`;
}

function renderTrades(res) {
  const t = res.trades;
  $("trade-note").textContent = t.length > 300 ? `latest 300 of ${t.length}` : `${t.length} closed`;
  if (!t.length) { $("trades").innerHTML = `<tr><td style="text-align:left">No closed trades in this window${res.fills.length ? " (a position is still open)" : ""}.</td></tr>`; return; }
  $("trades").innerHTML = `<tr><th>Asset</th><th>Entry</th><th>Exit</th><th>Days</th><th>Return</th><th>P&amp;L</th></tr>` +
    t.slice(-300).reverse().map((x) => `<tr><td>${x.symbol}</td><td>${x.entry}</td><td>${x.exit}</td><td>${Math.round((Date.parse(x.exit) - Date.parse(x.entry)) / 864e5)}</td><td class="${signCls(x.ret)}">${pct(x.ret)}</td><td class="${signCls(x.pnl)}">${usd(x.pnl)}</td></tr>`).join("");
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
  const { res, sel } = last;
  $("bar").value = sel;
  const row = res.rows[sel];
  const held = Object.entries(row.shares).map(([s, q]) => `${s} ${q.toLocaleString("en-US")} sh`).join(", ") || "flat";
  $("state").innerHTML = `<span>bar <b>${sel + 1}</b> / ${res.dates.length}</span><span>date <b>${row.date}</b></span><span>equity <b>${usd(row.equity)}</b></span><span>cash <b>${usd(row.cash)}</b></span><span>holding <b>${held}</b></span>`;
  $("events").innerHTML = byBar[sel].map((e) => `<span class="ev-${e.type}">${describe(e).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("\n");
  markSelected();
}
$("bar").oninput = (e) => { last.sel = +e.target.value; showBar(); };
$("prevSig").onclick = () => { const p = [...sigBars].reverse().find((i) => i < last.sel); if (p != null) { last.sel = p; showBar(); } };
$("nextSig").onclick = () => { const p = sigBars.find((i) => i > last.sel); if (p != null) { last.sel = p; showBar(); } };

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (charts.eq) { for (const k of ["eq", "dd", "ex"]) { const c = charts[k]; c.options.scales.x.ticks.color = c.options.scales.y.ticks.color = css("--muted"); c.options.scales.y.grid.color = css("--grid"); } drawCharts(); } });

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
})();
