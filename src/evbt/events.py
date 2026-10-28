"""Event types and the central queue.

Every component talks to every other component *only* by putting events on one
queue. Nothing calls anything else directly, which is what makes the data flow
easy to audit for look-ahead.

Per bar the flow is::

    MARKET     bar t opens   -> execution fills yesterday's orders at open(t)
    BAR_CLOSE  bar t closes  -> portfolio marks to market, strategy decides
    SIGNAL     strategy      -> portfolio sizes the position
    ORDER      portfolio     -> execution holds it until the *next* bar opens
    FILL       execution     -> portfolio books cash, shares and costs
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import ClassVar, Deque, Mapping, NamedTuple, Optional

import pandas as pd


class EventType(str, Enum):
    MARKET = "MARKET"
    BAR_CLOSE = "BAR_CLOSE"
    SIGNAL = "SIGNAL"
    ORDER = "ORDER"
    FILL = "FILL"


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Bar(NamedTuple):
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class Event:
    timestamp: pd.Timestamp
    type: ClassVar[EventType]


@dataclass(frozen=True)
class MarketEvent(Event):
    """A new bar has started trading. Only its open is actionable."""

    bars: Mapping[str, Bar]
    type: ClassVar[EventType] = EventType.MARKET

    def __str__(self) -> str:
        opens = ", ".join(f"{s} open={b.open:.2f}" for s, b in self.bars.items())
        return f"MARKET     {self.timestamp:%Y-%m-%d}  {opens}"


@dataclass(frozen=True)
class BarCloseEvent(Event):
    """The bar has closed; its full OHLCV is now known."""

    bars: Mapping[str, Bar]
    type: ClassVar[EventType] = EventType.BAR_CLOSE

    def __str__(self) -> str:
        closes = ", ".join(f"{s} close={b.close:.2f}" for s, b in self.bars.items())
        return f"BAR_CLOSE  {self.timestamp:%Y-%m-%d}  {closes}"


@dataclass(frozen=True)
class SignalEvent(Event):
    """Strategy intent: hold `target_weight` (0..1 of equity) in `symbol`."""

    symbol: str
    target_weight: float
    reason: str = ""
    type: ClassVar[EventType] = EventType.SIGNAL

    def __str__(self) -> str:
        return f"SIGNAL     {self.timestamp:%Y-%m-%d}  {self.symbol} target_weight={self.target_weight:.2f}"


@dataclass(frozen=True)
class OrderEvent(Event):
    """Market order. `max_notional` caps what a BUY may spend (buying power)."""

    order_id: int
    symbol: str
    side: Side
    quantity: int
    max_notional: Optional[float] = None
    type: ClassVar[EventType] = EventType.ORDER

    def __str__(self) -> str:
        return f"ORDER      {self.timestamp:%Y-%m-%d}  #{self.order_id} {self.side.value} {self.quantity} {self.symbol} @ next open"


@dataclass(frozen=True)
class FillEvent(Event):
    """Execution report. quantity may be < the order (capped) or 0 (cancelled)."""

    order_id: int
    symbol: str
    side: Side
    quantity: int
    ref_price: float  # the raw open the order was filled against
    price: float  # after slippage
    commission: float
    slippage_cost: float
    type: ClassVar[EventType] = EventType.FILL

    def __str__(self) -> str:
        return (
            f"FILL       {self.timestamp:%Y-%m-%d}  #{self.order_id} {self.side.value} {self.quantity} {self.symbol} "
            f"@ {self.price:.2f} (open {self.ref_price:.2f}, commission {self.commission:.2f})"
        )


class EventQueue:
    """FIFO queue shared by every component."""

    def __init__(self) -> None:
        self._q: Deque[Event] = deque()

    def put(self, event: Event) -> None:
        self._q.append(event)

    def get(self) -> Event:
        return self._q.popleft()

    def empty(self) -> bool:
        return not self._q

    def __len__(self) -> int:
        return len(self._q)
