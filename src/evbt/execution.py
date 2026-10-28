"""Simulated broker: market orders fill at the next bar's open, with slippage and commission."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List

from .events import EventQueue, FillEvent, MarketEvent, OrderEvent, Side


@dataclass(frozen=True)
class CostModel:
    slippage_bps: float = 5.0  # adverse move applied to every fill, in basis points
    commission_per_share: float = 0.005
    min_commission: float = 1.0

    def commission(self, quantity: int) -> float:
        if quantity <= 0:
            return 0.0
        return max(self.min_commission, self.commission_per_share * quantity)


class SimulatedExecution:
    """Orders arrive at bar close and wait. They fill when the *next* MARKET event arrives."""

    def __init__(self, queue: EventQueue, costs: CostModel | None = None) -> None:
        self._queue = queue
        self.costs = costs or CostModel()
        self._pending: List[OrderEvent] = []

    def on_order(self, order: OrderEvent) -> None:
        self._pending.append(order)

    def on_market(self, event: MarketEvent) -> None:
        # Sells first so a rotation frees up risk before new buys, as a broker's router would.
        batch = sorted(self._pending, key=lambda o: o.side is not Side.SELL)
        self._pending = []
        for order in batch:
            self._fill(order, event)

    def _fill(self, order: OrderEvent, event: MarketEvent) -> None:
        ref = event.bars[order.symbol].open
        sign = 1 if order.side is Side.BUY else -1
        price = ref * (1 + sign * self.costs.slippage_bps / 1e4)
        qty = order.quantity
        if order.side is Side.BUY and order.max_notional is not None:
            # Gapped up past the budget? Buy fewer shares rather than borrow.
            per_share = price + self.costs.commission_per_share
            qty = min(qty, max(0, math.floor((order.max_notional - self.costs.min_commission) / per_share)))
        self._queue.put(
            FillEvent(
                timestamp=event.timestamp,
                order_id=order.order_id,
                symbol=order.symbol,
                side=order.side,
                quantity=qty,
                ref_price=ref,
                price=price,
                commission=self.costs.commission(qty),
                slippage_cost=abs(price - ref) * qty,
            )
        )
