// Checks that the dashboard's JavaScript engine reproduces the Python engine's results
// (docs/results.json is written by scripts/build_report.py).  Usage: node scripts/check_js_parity.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Backtest, BuyAndHold, DataHandler, RSIMeanReversion, SameDaySign, SMACrossover, TrendFilterPortfolio, parseCsv,
} from "../docs/dashboard/engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(readFileSync(join(root, "docs/results.json"), "utf8"));
const SYMBOLS = expected.data.symbols;
const frames = Object.fromEntries(SYMBOLS.map((s) => [s, parseCsv(readFileSync(join(root, `docs/data/${s}.csv`), "utf8"))]));

const make = {
  hold: () => new BuyAndHold("SPY"),
  sma: () => new SMACrossover("SPY", 50, 200),
  rsi2: () => new RSIMeanReversion("SPY"),
  trend: () => new TrendFilterPortfolio(SYMBOLS, 200),
};

let failed = 0;
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
function check(label, js, py, tol) {
  const ok = close(js, py, tol);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(14)} js=${js}  py=${py}`);
}

for (const s of expected.strategies) {
  const res = new Backtest(new DataHandler(frames), make[s.key]()).run();
  console.log(s.label);
  check("total return", res.metrics.totalReturn, s.metrics.total_return);
  check("CAGR", res.metrics.cagr, s.metrics.cagr);
  check("Sharpe", res.metrics.sharpe, s.metrics.sharpe);
  check("max drawdown", res.metrics.maxDrawdown, s.metrics.max_drawdown);
  check("round trips", res.metrics.trades, s.metrics.trades, 0);
  check("fills", res.fills.length, s.fills, 0);
  check("costs paid", res.totalCosts, s.costs);
}

// the look-ahead demo strategy too: JS engine must also refuse to profit from "today's" close
const sd = new Backtest(new DataHandler(frames), new SameDaySign("SPY")).run();
const pyEngine = expected.lookahead.curves.find((c) => c.key === "engine").metrics;
console.log("Same-day sign (engine)");
check("total return", sd.metrics.totalReturn, pyEngine.total_return);
check("Sharpe", sd.metrics.sharpe, pyEngine.sharpe);

if (failed) { console.error(`\n${failed} parity check(s) failed`); process.exit(1); }
console.log("\nJS engine matches the Python engine.");
