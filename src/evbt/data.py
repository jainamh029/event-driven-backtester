"""DataHandler: the only way a strategy can see prices.

It owns the full dataset but exposes it one bar at a time. `history()` slices
up to and including the current cursor, so there is simply no method that
returns a future row. (tests/test_causality.py also proves the engine's output
never depends on bars after the current one.)
"""
from __future__ import annotations

from functools import reduce
from typing import Dict, List, Mapping, Optional, Tuple

import numpy as np
import pandas as pd

from .events import Bar

FIELDS = ["open", "high", "low", "close", "volume"]
_COL = {name: i for i, name in enumerate(FIELDS)}


class DataHandler:
    def __init__(self, frames: Mapping[str, pd.DataFrame]) -> None:
        if not frames:
            raise ValueError("need at least one symbol")
        cleaned: Dict[str, pd.DataFrame] = {}
        for sym, df in frames.items():
            df = df.rename(columns=str.lower)
            missing = [c for c in FIELDS if c not in df.columns]
            if missing:
                raise ValueError(f"{sym}: missing columns {missing}")
            df = df[FIELDS].sort_index()
            df = df[~df.index.duplicated(keep="first")].dropna()
            cleaned[sym] = df

        # Inner-join on dates so every bar carries every symbol.
        index = reduce(lambda a, b: a.intersection(b), (d.index for d in cleaned.values()))
        if len(index) == 0:
            raise ValueError("symbols share no common dates")
        self._index = index.sort_values()

        self._values: Dict[str, np.ndarray] = {}
        for sym, df in cleaned.items():
            arr = df.loc[self._index].to_numpy(dtype=float)
            arr.setflags(write=False)
            self._values[sym] = arr
        self._cursor = -1

    # -- engine side -----------------------------------------------------
    def advance(self) -> Optional[Tuple[pd.Timestamp, Dict[str, Bar]]]:
        """Move to the next bar. Returns None when the data is exhausted."""
        if self._cursor + 1 >= len(self._index):
            return None
        self._cursor += 1
        bars = {s: Bar(*v[self._cursor]) for s, v in self._values.items()}
        return self._index[self._cursor], bars

    def __len__(self) -> int:
        return len(self._index)

    @property
    def index(self) -> pd.DatetimeIndex:
        return self._index

    # -- strategy side (history only) ---------------------------------------
    @property
    def symbols(self) -> List[str]:
        return list(self._values)

    @property
    def n_seen(self) -> int:
        """Number of bars revealed so far (including the current one)."""
        return self._cursor + 1

    @property
    def now(self) -> pd.Timestamp:
        self._require_started()
        return self._index[self._cursor]

    def history(self, symbol: str, n: Optional[int] = None, field: str = "close") -> np.ndarray:
        """Last `n` values of `field` up to the current bar, oldest first (a copy)."""
        self._require_started()
        col = self._values[symbol][: self._cursor + 1, _COL[field]]
        if n is not None:
            col = col[-n:]
        return col.copy()

    def frame(self, symbol: str, n: Optional[int] = None) -> pd.DataFrame:
        """OHLCV DataFrame up to the current bar (a copy)."""
        self._require_started()
        stop = self._cursor + 1
        start = 0 if n is None else max(0, stop - n)
        return pd.DataFrame(
            self._values[symbol][start:stop], index=self._index[start:stop], columns=FIELDS
        )

    def latest(self, symbol: str) -> Bar:
        self._require_started()
        return Bar(*self._values[symbol][self._cursor])

    def _require_started(self) -> None:
        if self._cursor < 0:
            raise RuntimeError("no bar has been revealed yet")
