"""Run every experiment on the committed data and render docs/index.html (+ docs/results.json).

    python scripts/build_report.py
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from evbt import (
    Backtest, BuyAndHold, CostModel, RSIMeanReversion, SameDaySign, SMACrossover, TrendFilterPortfolio,
)
from evbt.datasets import load_universe
from evbt.metrics import max_drawdown_series
from evbt.research import sweep_sma
from evbt.vectorized import (
    equity_from_positions, same_day_sign_positions, sma_crossover_positions,
)

ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ["SPY", "TLT", "GLD"]
SPLIT = "2016-01-01"
STEP = 5  # chart every 5th bar so the page stays light


def sample(series: pd.Series) -> list:
    idx = list(range(0, len(series), STEP))
    if idx[-1] != len(series) - 1:
        idx.append(len(series) - 1)
    return [round(float(v), 4) for v in series.iloc[idx]]


def clean(m: dict) -> dict:
    return {k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in m.items()}


def main() -> None:
    frames = load_universe(SYMBOLS)
    spy = frames["SPY"]
    close = spy["close"]

    # ---- 1. the strategies ----------------------------------------------------------------
    runs = {
        "hold": ("Buy & hold SPY", BuyAndHold("SPY")),
        "sma": ("SMA 50/200 crossover (SPY)", SMACrossover("SPY", 50, 200)),
        "rsi2": ("RSI(2) dip-buying in uptrend (SPY)", RSIMeanReversion("SPY")),
        "trend": ("200-day trend filter, SPY+TLT+GLD", TrendFilterPortfolio(SYMBOLS, 200)),
    }
    results = {}
    for key, (label, strat) in runs.items():
        results[key] = Backtest(frames, strat, trace=(key == "sma")).run()
        print(f"{key:6s} {results[key].metrics['cagr']:+.1%} CAGR, sharpe {results[key].metrics['sharpe']:.2f}")

    dates = [d.strftime("%Y-%m-%d") for d in results["hold"].equity.index[::STEP]]
    if dates[-1] != results["hold"].equity.index[-1].strftime("%Y-%m-%d"):
        dates.append(results["hold"].equity.index[-1].strftime("%Y-%m-%d"))

    strategies = []
    for key, (label, _) in runs.items():
        r = results[key]
        strategies.append(
            {
                "key": key,
                "label": label,
                "metrics": clean(r.metrics),
                "costs": r.total_costs,
                "fills": len(r.fills),
                "equity": sample(r.equity["equity"]),
                "drawdown": sample(max_drawdown_series(r.equity["equity"])),
            }
        )

    # ---- 2. look-ahead demo: vectorized vs event-driven ----------------------------------------
    aligned_close = results["hold"].equity.index
    c = close.loc[aligned_close]
    pos_sign = same_day_sign_positions(c)
    pos_sma = sma_crossover_positions(c, 50, 200)
    engine_sign = Backtest(frames, SameDaySign("SPY")).run()
    lookahead = {
        "curves": [
            {"key": "naive", "label": "Vectorized, no lag (look-ahead bug)",
             "equity": equity_from_positions(c, pos_sign, lag=0)},
            {"key": "lagged", "label": "Vectorized, signal lagged 1 bar (free of costs)",
             "equity": equity_from_positions(c, pos_sign, lag=1)},
            {"key": "engine", "label": "Event-driven (fills at next open, with costs)",
             "equity": engine_sign.equity["equity"]},
        ],
        "sma": [
            {"label": "Vectorized SMA 50/200, no lag", "equity": equity_from_positions(c, pos_sma, lag=0)},
            {"label": "Vectorized SMA 50/200, lagged 1 bar", "equity": equity_from_positions(c, pos_sma, lag=1)},
            {"label": "Event-driven SMA 50/200", "equity": results["sma"].equity["equity"]},
        ],
    }
    from evbt.metrics import compute_metrics

    la_out = {"dates": dates, "curves": [], "sma": []}
    for item in lookahead["curves"]:
        la_out["curves"].append({"key": item["key"], "label": item["label"],
                                 "metrics": clean(compute_metrics(item["equity"])), "equity": sample(item["equity"])})
    for item in lookahead["sma"]:
        la_out["sma"].append({"label": item["label"], "metrics": clean(compute_metrics(item["equity"]))})

    # ---- 3. parameter sweep, in-sample vs out-of-sample --------------------------------------------
    fasts, slows = [10, 20, 30, 50, 75], [100, 150, 200, 250, 300]
    sweep = sweep_sma({"SPY": spy}, "SPY", fasts, slows, SPLIT)
    best = sweep.loc[sweep["is_sharpe"].idxmax()]
    sweep_out = {
        "split": SPLIT, "fasts": fasts, "slows": slows,
        "cells": [{k: (float(v) if k not in ("fast", "slow") else int(v)) for k, v in row.items()}
                  for row in sweep.to_dict("records")],
        "best_is": {"fast": int(best["fast"]), "slow": int(best["slow"]),
                    "is_sharpe": float(best["is_sharpe"]), "oos_sharpe": float(best["oos_sharpe"])},
        "oos_median": float(sweep["oos_sharpe"].median()),
        "oos_best": float(sweep["oos_sharpe"].max()),
        "hold_is": results["hold"].window_metrics(end=pd.Timestamp(SPLIT) - pd.Timedelta(days=1))["sharpe"],
        "hold_oos": results["hold"].window_metrics(start=SPLIT)["sharpe"],
    }

    # ---- 4. cost sensitivity ---------------------------------------------------------------------
    cost_rows = []
    for key, label, make in [
        ("sma", "SMA 50/200", lambda: SMACrossover("SPY", 50, 200)),
        ("rsi2", "RSI(2) dip-buying", lambda: RSIMeanReversion("SPY")),
    ]:
        for bps in (0, 5, 10, 25):
            costs = CostModel(slippage_bps=bps, commission_per_share=0.0 if bps == 0 else 0.005,
                              min_commission=0.0 if bps == 0 else 1.0)
            r = Backtest({"SPY": spy}, make(), costs=costs).run()
            cost_rows.append({"strategy": label, "bps": bps, "cagr": r.metrics["cagr"], "sharpe": r.metrics["sharpe"],
                              "trades": r.metrics["trades"], "costs": r.total_costs})

    # ---- 5. a real slice of the event stream, around the first signal -------------------------------
    trace = results["sma"].trace
    first = next(i for i, e in enumerate(trace) if e.type.value == "SIGNAL")
    window = trace[first - 2 : first + 6]
    fills = results["sma"].fills.tail(8).copy()
    fills["timestamp"] = fills["timestamp"].dt.strftime("%Y-%m-%d")

    payload = {
        "generated": date.today().isoformat(),
        "data": {"symbols": SYMBOLS, "start": dates[0], "end": dates[-1], "bars": len(results["hold"].equity)},
        "costs": {"slippage_bps": 5, "commission_per_share": 0.005, "min_commission": 1.0, "initial_cash": 100000},
        "event_counts": {k: results[k].event_counts for k in results},
        "dates": dates,
        "strategies": strategies,
        "lookahead": la_out,
        "sweep": sweep_out,
        "cost_sensitivity": cost_rows,
        "trace": [str(e) for e in window],
        "last_fills": fills.round(4).to_dict("records"),
    }

    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "results.json").write_text(json.dumps(payload, indent=1))
    html = (ROOT / "site" / "template.html").read_text().replace("__DATA__", json.dumps(payload, separators=(",", ":")))
    (ROOT / "docs" / "index.html").write_text(html)
    (ROOT / "docs" / ".nojekyll").write_text("")
    print(f"wrote docs/index.html ({len(html) / 1024:.0f} KB)")
    print("best IS combo:", sweep_out["best_is"], "| OOS median", round(sweep_out["oos_median"], 2))
    for c_ in la_out["curves"]:
        print(c_["label"], round(c_["metrics"]["total_return"], 2), round(c_["metrics"]["sharpe"], 2))


if __name__ == "__main__":
    main()
