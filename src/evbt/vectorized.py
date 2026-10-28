"""Vectorized backtests, here only to contrast with the event-driven engine.

Signals are computed for the whole series at once. That is fast, and it is also
exactly where look-ahead sneaks in: forget one `.shift(1)` and the strategy
trades on information it could not have had.
"""
from __future__ import annotations

import pandas as pd


def sma_crossover_positions(close: pd.Series, fast: int, slow: int) -> pd.Series:
    return (close.rolling(fast).mean() > close.rolling(slow).mean()).astype(float)


def same_day_sign_positions(close: pd.Series) -> pd.Series:
    return (close.pct_change() > 0).astype(float)


def equity_from_positions(
    close: pd.Series, positions: pd.Series, lag: int, cost_bps: float = 0.0, initial: float = 100_000.0
) -> pd.Series:
    """Close-to-close P&L of a 0/1 position series.

    lag=1 is correct: the position decided at close t earns the return of day t+1.
    lag=0 is the classic bug: the position decided at close t also earns day t's return,
    i.e. you traded at a close you only learned about once it had printed.
    """
    rets = close.pct_change().fillna(0.0)
    held = positions.shift(lag).fillna(0.0)
    turnover = held.diff().abs().fillna(held.abs())
    strat = held * rets - turnover * cost_bps / 1e4
    return initial * (1.0 + strat).cumprod()
