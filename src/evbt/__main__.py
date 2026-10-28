"""python -m evbt --strategy sma --symbol SPY"""
from __future__ import annotations

import argparse

from . import Backtest, BuyAndHold, CostModel, RSIMeanReversion, SMACrossover, TrendFilterPortfolio
from .datasets import load_universe


def main() -> None:
    ap = argparse.ArgumentParser(prog="evbt", description="Run an event-driven backtest on bundled data.")
    ap.add_argument("--strategy", choices=["hold", "sma", "rsi2", "trend"], default="sma")
    ap.add_argument("--symbol", default="SPY")
    ap.add_argument("--fast", type=int, default=50)
    ap.add_argument("--slow", type=int, default=200)
    ap.add_argument("--slippage-bps", type=float, default=5.0)
    ap.add_argument("--start", default=None, help="first date to include, e.g. 2010-01-01")
    args = ap.parse_args()

    symbols = ["SPY", "TLT", "GLD"] if args.strategy == "trend" else [args.symbol]
    frames = load_universe(symbols)
    if args.start:
        frames = {s: df.loc[args.start :] for s, df in frames.items()}
    strategy = {
        "hold": lambda: BuyAndHold(args.symbol),
        "sma": lambda: SMACrossover(args.symbol, args.fast, args.slow),
        "rsi2": lambda: RSIMeanReversion(args.symbol),
        "trend": lambda: TrendFilterPortfolio(symbols),
    }[args.strategy]()

    result = Backtest(frames, strategy, costs=CostModel(slippage_bps=args.slippage_bps)).run()
    m = result.metrics
    print(f"{args.strategy} on {', '.join(symbols)}: {result.equity.index[0]:%Y-%m-%d} -> {result.equity.index[-1]:%Y-%m-%d}")
    print(f"  total return {m['total_return']:+.1%}   CAGR {m['cagr']:+.1%}   vol {m['volatility']:.1%}")
    print(f"  Sharpe {m['sharpe']:.2f}   Sortino {m['sortino']:.2f}   max drawdown {m['max_drawdown']:.1%}")
    print(f"  trades {m['trades']}   win rate {m['win_rate']:.0%}   costs paid ${result.total_costs:,.0f}")
    print(f"  events processed: {result.event_counts}")


if __name__ == "__main__":
    main()
