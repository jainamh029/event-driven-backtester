"""Performance statistics from an equity curve and a trade log."""
from __future__ import annotations

from typing import Dict, Optional

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def max_drawdown_series(equity: pd.Series) -> pd.Series:
    return equity / equity.cummax() - 1.0


def compute_metrics(
    equity: pd.Series, trades: Optional[pd.DataFrame] = None, periods: int = TRADING_DAYS
) -> Dict[str, float]:
    """Risk-free rate is taken as 0. `equity` must be a datetime-indexed series."""
    rets = equity.pct_change().dropna()
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    total = equity.iloc[-1] / equity.iloc[0] - 1.0
    cagr = (1.0 + total) ** (1.0 / years) - 1.0 if total > -1 else -1.0
    std = rets.std(ddof=1)
    downside = np.sqrt(np.mean(np.minimum(rets.to_numpy(), 0.0) ** 2))
    max_dd = float(max_drawdown_series(equity).min())

    out = {
        "total_return": float(total),
        "cagr": float(cagr),
        "volatility": float(std * np.sqrt(periods)),
        "sharpe": float(rets.mean() / std * np.sqrt(periods)) if std > 0 else 0.0,
        "sortino": float(rets.mean() / downside * np.sqrt(periods)) if downside > 0 else 0.0,
        "max_drawdown": max_dd,
        "calmar": float(cagr / abs(max_dd)) if max_dd < 0 else 0.0,
    }
    if trades is not None:
        n = len(trades)
        wins = trades.loc[trades["pnl"] > 0, "pnl"].sum() if n else 0.0
        losses = -trades.loc[trades["pnl"] < 0, "pnl"].sum() if n else 0.0
        out.update(
            {
                "trades": int(n),
                "win_rate": float((trades["pnl"] > 0).mean()) if n else 0.0,
                "avg_trade_return": float(trades["return"].mean()) if n else 0.0,
                "profit_factor": float(wins / losses) if losses > 0 else (float("inf") if wins > 0 else 0.0),
            }
        )
    return out
