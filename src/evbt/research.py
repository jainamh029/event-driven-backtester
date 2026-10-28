"""Parameter sweeps with an explicit in-sample / out-of-sample split."""
from __future__ import annotations

from typing import Mapping, Sequence

import pandas as pd

from .engine import Backtest
from .execution import CostModel
from .strategy import SMACrossover


def sweep_sma(
    frames: Mapping[str, pd.DataFrame],
    symbol: str,
    fasts: Sequence[int],
    slows: Sequence[int],
    split: str,
    costs: CostModel | None = None,
) -> pd.DataFrame:
    """Run every (fast, slow) pair once over the full history and score each window separately.

    The strategy only ever sees the past, so scoring the equity curve before/after `split`
    is a fair in-sample vs out-of-sample comparison: parameters get picked on the former
    and judged on the latter.
    """
    rows = []
    for fast in fasts:
        for slow in slows:
            if fast >= slow:
                continue
            result = Backtest(frames, SMACrossover(symbol, fast, slow), costs=costs).run()
            ins = result.window_metrics(end=pd.Timestamp(split) - pd.Timedelta(days=1))
            oos = result.window_metrics(start=split)
            rows.append(
                {
                    "fast": fast,
                    "slow": slow,
                    "is_sharpe": ins["sharpe"],
                    "oos_sharpe": oos["sharpe"],
                    "is_cagr": ins["cagr"],
                    "oos_cagr": oos["cagr"],
                }
            )
    return pd.DataFrame(rows)
