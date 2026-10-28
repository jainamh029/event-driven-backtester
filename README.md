# Event-Driven Backtester

A small Python backtester where **every component talks through one event queue**: a new price arrives, the strategy emits a signal, an order goes out, and it fills with slippage and commission. It's much closer to how live trading works than looping over a spreadsheet of prices, and it stops a strategy from accidentally using future data.

**Live report:** https://jainamh029.github.io/event-driven-backtester/  
**Interactive dashboard:** https://jainamh029.github.io/event-driven-backtester/dashboard/ (pick a strategy, parameters, costs and date range; the backtest re-runs in your browser)

```
            ┌────────────────────── EventQueue ──────────────────────┐
DataHandler ─ MARKET ─────────────────────────────▶ Execution  (fills yesterday's orders at today's OPEN)
            ─ BAR_CLOSE ─▶ Portfolio (mark to market) ─▶ Strategy
                                                         │ SIGNAL
                                    Portfolio (sizing) ◀─┘
                                         │ ORDER ──▶ Execution (held until the NEXT bar opens)
                                         ◀── FILL ───┘
```

## The one rule

Decide at the **close** of bar *t*, trade at the **open** of bar *t+1*.

| Event | When | Who reacts |
|---|---|---|
| `MARKET` | bar *t* opens | `SimulatedExecution` fills pending orders at `open(t)` ± slippage, minus commission |
| `BAR_CLOSE` | bar *t* closes | `Portfolio` marks to market, then the `Strategy` runs on bars `≤ t` |
| `SIGNAL` | strategy intent (target weight) | `Portfolio` sizes it into whole shares |
| `ORDER` | market order, with a buying-power cap | `SimulatedExecution` queues it for the next open |
| `FILL` | execution report | `Portfolio` updates cash, positions, trade log |

`DataHandler` owns all the data but only has methods that return rows **up to the current bar** (`history`, `frame`, `latest`). There is no method that can return the future.

### It's tested, not just claimed

`tests/test_causality.py` checks the property directly: for several strategies, truncating the data after bar *k*, or replacing every later price with garbage, leaves every result up to *k* unchanged. Another test shows that a "go long if today closed up" rule looks like a money machine in a vectorized backtest with one missing `shift(1)` (Sharpe ≈ 8.7 on the bundled SPY data, see the report) while the same rule in this engine earns nothing.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

python -m evbt --strategy sma --symbol SPY       # one backtest on the bundled data
python -m evbt --strategy trend                  # SPY + TLT + GLD trend filter
pytest                                           # unit + causality tests
python scripts/build_report.py                   # rebuild docs/index.html
python scripts/fetch_data.py                     # refresh data/*.csv from Yahoo Finance
```

Write your own strategy by implementing `on_bar` and calling `self.target(symbol, weight)`:

```python
from evbt import Backtest, Strategy
from evbt.datasets import load_universe

class Breakout(Strategy):
    def __init__(self, symbol, n=55):
        super().__init__()
        self.symbol, self.n = symbol, n

    def on_bar(self, timestamp):                      # runs at the close of bar t
        if self.data.n_seen <= self.n:
            return
        closes = self.data.history(self.symbol, self.n + 1)   # bars up to and including t
        self.target(self.symbol, 1.0 if closes[-1] > closes[:-1].max() else 0.0)

result = Backtest(load_universe(["SPY"]), Breakout("SPY")).run()
print(result.metrics["sharpe"], result.total_costs)
```

`result` also carries `equity`, `fills`, `trades`, `event_counts`, and (with `trace=True`) the full event stream.

## What's inside

```
docs/dashboard/   interactive dashboard: engine.js (JS port of evbt), app.js, index.html
src/evbt/
  events.py      event types + EventQueue
  data.py        DataHandler (history only, aligned multi-symbol)
  strategy.py    Strategy base + BuyAndHold, SMACrossover, RSIMeanReversion, TrendFilterPortfolio, SameDaySign
  portfolio.py   sizing, cash reservation, fills, closed-trade log
  execution.py   SimulatedExecution + CostModel (slippage bps, per-share commission, minimum)
  engine.py      Backtest: the loop that wires it all together
  metrics.py     CAGR, vol, Sharpe, Sortino, drawdown, Calmar, win rate, profit factor
  vectorized.py  deliberately simple vectorized backtest, for the look-ahead comparison
  research.py    SMA parameter sweep with in-sample / out-of-sample scoring
scripts/         fetch_data.py, build_report.py, check_js_parity.mjs (JS engine vs Python results)
site/template.html → docs/index.html   (the GitHub Pages report)
```

## Results on the bundled data

SPY / TLT / GLD daily bars, 2005-01-03 → 2026-10-27, $100k start, long-only, 5 bps slippage per fill, $0.005/share commission ($1 min):

| Strategy | CAGR | Sharpe | Max DD | Round trips | Costs paid |
|---|---:|---:|---:|---:|---:|
| Buy & hold SPY | 10.8% | 0.64 | -55.0% | 0 | $56 |
| SMA 50/200 crossover (SPY) | 8.6% | 0.68 | -33.6% | 10 | $2,522 |
| RSI(2) dip-buying in uptrend (SPY) | 3.9% | 0.51 | -18.0% | 456 | $70,936 |
| 200-day trend filter, SPY+TLT+GLD | 5.9% | 0.74 | -15.5% | 262 | $17,890 |

These are what the engine reports on this data, not recommendations. RSI(2) is the instructive one: 6.2% CAGR with no costs, 3.9% at 5 bps, −4.4% at 25 bps. The [report](https://jainamh029.github.io/event-driven-backtester/) has the charts, the look-ahead demo and the parameter sweep.

## The dashboard

`docs/dashboard/` is a static page (no server, no build step) that re-runs the backtest on every control change: strategy and its parameters, asset universe, benchmark, date window, starting cash, slippage and commission. It shows KPIs against a buy & hold benchmark and a tearsheet, plus an equity curve with entry/exit markers and in-market shading, drawdown, rolling 1-year Sharpe, calendar-year returns, a daily-return histogram, exposure and cumulative-cost charts (hovering one chart marks the same bar on the others), monthly returns, closed trades, light/dark themes, and an **event inspector** that steps through the real `MARKET → BAR_CLOSE → SIGNAL → ORDER → FILL` stream bar by bar. Settings live in the URL hash, so any view can be shared by link.

The engine in `docs/dashboard/engine.js` is a line-for-line port of `src/evbt` (same queue, same handlers, same timing rule). To keep the two honest, `node scripts/check_js_parity.mjs` re-runs every report strategy in JavaScript and compares it to the Python results (same fills, same costs, same metrics); CI runs it on every push. To preview locally: `python -m http.server -d docs` and open `/dashboard/`.

## Design choices and limits

- **Daily bars, market orders only.** Fills use the next open; no intrabar logic, no limit/stop orders, no partial fills beyond the buying-power cap.
- **Long-only, no leverage.** Target weights are clipped to 0–1. A BUY may only spend cash on hand, and cash claimed by an open buy is reserved. Sells free cash for the *next* bar's orders, which is conservative.
- **Adjusted prices.** Yahoo's dividend/split-adjusted OHLC is used consistently, so dividends are implicitly reinvested and absolute price levels in the fills are not what the tape showed.
- **Multi-symbol data is inner-joined on dates**, so every bar contains every symbol.
- **Costs are simple.** A flat slippage in bps and an IBKR-style per-share commission; no spread model, market impact, borrow costs or taxes.
- Strategies receive the `DataHandler` object; Python can't stop a determined user from reaching into its private attributes, which is why the causality tests exist.

## Resources this project follows

- [`sandtable`](https://pypi.org/project/sandtable/) and [`alphalens-core`](https://pypi.org/project/alphalens-core/): mature event-driven backtesting libraries. This repo is a from-scratch, readable version of the same architecture.
- Yves Hilpisch, [*Python for Finance*](https://www.oreilly.com/library/view/python-for-finance/9781492024323/) (O'Reilly), Part IV.
- Data: Yahoo Finance via [`yfinance`](https://pypi.org/project/yfinance/); [Polygon.io](https://polygon.io) for intraday/tick data (not wired in here).

## License

MIT. Educational code, not investment advice.
