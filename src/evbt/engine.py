"""The event loop that wires data, strategy, portfolio and execution together."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional

import pandas as pd

from .data import DataHandler
from .events import BarCloseEvent, Event, EventQueue, EventType, MarketEvent
from .execution import CostModel, SimulatedExecution
from .metrics import compute_metrics
from .portfolio import Portfolio
from .strategy import Strategy


@dataclass
class BacktestResult:
    equity: pd.DataFrame  # index: timestamp; columns: equity, cash, positions_value
    fills: pd.DataFrame
    trades: pd.DataFrame
    event_counts: Dict[str, int]
    metrics: Dict[str, float]
    trace: List[Event] = field(default_factory=list)

    @property
    def total_costs(self) -> float:
        if self.fills.empty:
            return 0.0
        return float(self.fills["commission"].sum() + self.fills["slippage_cost"].sum())

    def window_metrics(self, start=None, end=None) -> Dict[str, float]:
        """Metrics over a slice of the equity curve (the strategy still saw earlier history)."""
        eq = self.equity["equity"].loc[start:end]
        return compute_metrics(eq)


class Backtest:
    def __init__(
        self,
        frames: Mapping[str, pd.DataFrame],
        strategy: Strategy,
        initial_cash: float = 100_000.0,
        costs: Optional[CostModel] = None,
        trace: bool = False,
    ) -> None:
        self.queue = EventQueue()
        self.data = DataHandler(frames)
        self.strategy = strategy
        self.portfolio = Portfolio(self.queue, initial_cash)
        self.execution = SimulatedExecution(self.queue, costs)
        self.strategy.bind(self.queue, self.data)
        self._trace: Optional[List[Event]] = [] if trace else None
        self._counts: Counter = Counter()

        # Handler order matters only within one event type: mark to market, then decide.
        self._handlers: Dict[EventType, List[Callable]] = {
            EventType.MARKET: [self.execution.on_market],
            EventType.BAR_CLOSE: [self.portfolio.on_bar_close, self.strategy.on_bar_close],
            EventType.SIGNAL: [self.portfolio.on_signal],
            EventType.ORDER: [self.execution.on_order],
            EventType.FILL: [self.portfolio.on_fill],
        }

    def _drain(self) -> None:
        while not self.queue.empty():
            event = self.queue.get()
            self._counts[event.type.value] += 1
            if self._trace is not None:
                self._trace.append(event)
            for handler in self._handlers[event.type]:
                handler(event)

    def run(self) -> BacktestResult:
        while (step := self.data.advance()) is not None:
            ts, bars = step
            self.queue.put(MarketEvent(ts, bars))  # bar opens: yesterday's orders fill
            self._drain()
            self.queue.put(BarCloseEvent(ts, bars))  # bar closes: mark, decide, size, order
            self._drain()

        p = self.portfolio
        equity = pd.DataFrame(p.equity_rows).set_index("timestamp")
        fills = pd.DataFrame(
            p.fill_rows,
            columns=["timestamp", "order_id", "symbol", "side", "quantity", "ref_price",
                     "fill_price", "commission", "slippage_cost"],
        )
        trades = pd.DataFrame(p.trade_rows, columns=["symbol", "entry", "exit", "pnl", "return"])
        return BacktestResult(
            equity=equity,
            fills=fills,
            trades=trades,
            event_counts=dict(self._counts),
            metrics=compute_metrics(equity["equity"], trades),
            trace=self._trace or [],
        )
