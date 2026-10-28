"""Loading OHLCV bars: committed CSV snapshots, or a fresh download from Yahoo Finance."""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, Optional

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


def download(symbol: str, start: str = "2005-01-01", end: Optional[str] = None) -> pd.DataFrame:
    """Daily OHLCV from Yahoo Finance via yfinance (dividend/split adjusted: open, high, low and close alike)."""
    import yfinance as yf  # imported lazily so the engine has no network dependency

    df = yf.download(symbol, start=start, end=end, auto_adjust=True, progress=False, multi_level_index=False)
    if df.empty:
        raise RuntimeError(f"no data returned for {symbol}")
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df.index = pd.to_datetime(df.index).tz_localize(None)
    df.index.name = "date"
    return df.dropna()


def load_csv(symbol: str, data_dir: Path = DATA_DIR) -> pd.DataFrame:
    return pd.read_csv(Path(data_dir) / f"{symbol}.csv", index_col="date", parse_dates=True)


def load_universe(symbols: Iterable[str], data_dir: Path = DATA_DIR) -> Dict[str, pd.DataFrame]:
    return {s: load_csv(s, data_dir) for s in symbols}
