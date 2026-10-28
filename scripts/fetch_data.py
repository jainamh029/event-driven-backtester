"""Download daily bars from Yahoo Finance into data/*.csv.  Usage: python scripts/fetch_data.py [SYMBOL ...]"""
import sys
from datetime import date

from evbt.datasets import DATA_DIR, download

SYMBOLS = sys.argv[1:] or ["SPY", "TLT", "GLD"]
END = date.today().isoformat()  # end is exclusive, so today's possibly unfinished bar is left out

DATA_DIR.mkdir(exist_ok=True)
for sym in SYMBOLS:
    df = download(sym, start="2005-01-01", end=END)
    df.to_csv(DATA_DIR / f"{sym}.csv", float_format="%.6g")
    print(f"{sym}: {len(df)} bars, {df.index[0]:%Y-%m-%d} -> {df.index[-1]:%Y-%m-%d}")
