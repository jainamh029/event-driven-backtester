import numpy as np
import pandas as pd
import pytest


def make_frame(closes, opens=None, start="2020-01-01") -> pd.DataFrame:
    closes = np.asarray(closes, dtype=float)
    opens = closes if opens is None else np.asarray(opens, dtype=float)
    idx = pd.bdate_range(start, periods=len(closes))
    return pd.DataFrame(
        {
            "open": opens,
            "high": np.maximum(opens, closes) * 1.01,
            "low": np.minimum(opens, closes) * 0.99,
            "close": closes,
            "volume": 1_000_000.0,
        },
        index=idx,
    )


@pytest.fixture
def random_walk():
    rng = np.random.default_rng(7)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, 600)))
    open_ = close * (1 + rng.normal(0, 0.003, 600))
    return make_frame(close, open_)
