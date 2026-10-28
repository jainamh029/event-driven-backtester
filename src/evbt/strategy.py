"""Strategy base class and the built-in strategies."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Dict, Optional, Sequence

import numpy as np
import pandas as pd

from .data import DataHandler
from .events import BarCloseEvent, EventQueue, SignalEvent


class Strategy(ABC):
    """Subclass and implement `on_bar`. Call `self.target(symbol, weight)` to express intent.

    `on_bar` runs at the close of bar t and may use bars up to and including t.
    Orders it triggers are filled at the open of bar t+1, never earlier.
    """

    def __init__(self) -> None:
        self._queue: Optional[EventQueue] = None
        self.data: Optional[DataHandler] = None
        self._targets: Dict[str, float] = {}

    def bind(self, queue: EventQueue, data: DataHandler) -> None:
        self._queue = queue
        self.data = data

    def on_bar_close(self, event: BarCloseEvent) -> None:
        self.on_bar(event.timestamp)

    @abstractmethod
    def on_bar(self, timestamp: pd.Timestamp) -> None: ...

    def target(self, symbol: str, weight: float, reason: str = "") -> None:
        """Request a target weight. Only emits a SIGNAL when the target changes."""
        weight = float(min(max(weight, 0.0), 1.0))
        if self._targets.get(symbol, 0.0) == weight:
            return
        self._targets[symbol] = weight
        assert self._queue is not None and self.data is not None
        self._queue.put(SignalEvent(self.data.now, symbol, weight, reason))


class BuyAndHold(Strategy):
    def __init__(self, symbol: str) -> None:
        super().__init__()
        self.symbol = symbol

    def on_bar(self, timestamp: pd.Timestamp) -> None:
        self.target(self.symbol, 1.0, "buy & hold")


class SMACrossover(Strategy):
    """Long when the fast SMA is above the slow SMA, otherwise flat."""

    def __init__(self, symbol: str, fast: int = 50, slow: int = 200) -> None:
        super().__init__()
        if fast >= slow:
            raise ValueError("fast must be < slow")
        self.symbol, self.fast, self.slow = symbol, fast, slow

    def on_bar(self, timestamp: pd.Timestamp) -> None:
        if self.data.n_seen < self.slow:
            return
        closes = self.data.history(self.symbol, self.slow)
        fast_ma, slow_ma = closes[-self.fast :].mean(), closes.mean()
        self.target(self.symbol, 1.0 if fast_ma > slow_ma else 0.0, f"SMA{self.fast} vs SMA{self.slow}")


class RSIMeanReversion(Strategy):
    """Connors-style RSI(2): buy short-term dips inside an uptrend, sell the bounce."""

    def __init__(
        self, symbol: str, rsi_period: int = 2, entry: float = 10.0, trend: int = 200, exit_ma: int = 5
    ) -> None:
        super().__init__()
        self.symbol, self.rsi_period, self.entry = symbol, rsi_period, entry
        self.trend, self.exit_ma = trend, exit_ma

    @staticmethod
    def rsi(closes: np.ndarray) -> float:
        diffs = np.diff(closes)
        gain, loss = diffs[diffs > 0].sum(), -diffs[diffs < 0].sum()
        if gain + loss == 0:
            return 50.0
        return 100.0 * gain / (gain + loss)

    def on_bar(self, timestamp: pd.Timestamp) -> None:
        if self.data.n_seen < self.trend:
            return
        closes = self.data.history(self.symbol, self.trend)
        last = closes[-1]
        if self._targets.get(self.symbol, 0.0) == 0.0:
            if last > closes.mean() and self.rsi(closes[-(self.rsi_period + 1) :]) < self.entry:
                self.target(self.symbol, 1.0, "RSI dip in uptrend")
        elif last > closes[-self.exit_ma :].mean():
            self.target(self.symbol, 0.0, "close above short MA")


class TrendFilterPortfolio(Strategy):
    """Each asset is held (at 1/N of equity) only while it closes above its own SMA."""

    def __init__(self, symbols: Sequence[str], window: int = 200) -> None:
        super().__init__()
        self.symbols, self.window = list(symbols), window

    def on_bar(self, timestamp: pd.Timestamp) -> None:
        if self.data.n_seen < self.window:
            return
        w = 1.0 / len(self.symbols)
        for sym in self.symbols:
            closes = self.data.history(sym, self.window)
            self.target(sym, w if closes[-1] > closes.mean() else 0.0, f"close vs SMA{self.window}")


class SameDaySign(Strategy):
    """Go long if *today* closed up. Looks like a money machine in a vectorized backtest
    that forgets to lag the signal; here the order only fills at tomorrow's open, so the
    edge disappears. Exists purely to demonstrate look-ahead bias."""

    def __init__(self, symbol: str) -> None:
        super().__init__()
        self.symbol = symbol

    def on_bar(self, timestamp: pd.Timestamp) -> None:
        if self.data.n_seen < 2:
            return
        c = self.data.history(self.symbol, 2)
        self.target(self.symbol, 1.0 if c[-1] > c[-2] else 0.0, "today closed up")
