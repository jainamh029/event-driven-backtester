"""Portfolio: turns signals into sized orders and books fills. Long-only, no leverage."""
from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Dict, List, Tuple

import pandas as pd

from .events import BarCloseEvent, EventQueue, FillEvent, OrderEvent, Side, SignalEvent


@dataclass
class _Lot:
    entry_ts: pd.Timestamp
    qty: int = 0
    cost: float = 0.0  # cost basis of shares still held, commission included
    spent: float = 0.0  # everything paid into this trade
    received: float = 0.0  # net proceeds out of this trade


class Portfolio:
    def __init__(
        self,
        queue: EventQueue,
        initial_cash: float = 100_000.0,
        cost_buffer_bps: float = 50.0,
    ) -> None:
        self._queue = queue
        self.initial_cash = initial_cash
        self.cash = initial_cash
        self.cost_buffer = cost_buffer_bps / 1e4  # headroom for slippage + commission when sizing buys
        self.positions: Dict[str, int] = {}
        self.last_prices: Dict[str, float] = {}
        self._pending: Dict[int, Tuple[str, int, float]] = {}  # order_id -> (symbol, signed qty, reserved cash)
        self._reserved = 0.0
        self._ids = itertools.count(1)
        self._lots: Dict[str, _Lot] = {}
        self.equity_rows: List[dict] = []
        self.fill_rows: List[dict] = []
        self.trade_rows: List[dict] = []

    # -- accounting ------------------------------------------------------
    def market_value(self) -> float:
        return sum(q * self.last_prices[s] for s, q in self.positions.items())

    def equity(self) -> float:
        return self.cash + self.market_value()

    # -- event handlers ------------------------------------------------------
    def on_bar_close(self, event: BarCloseEvent) -> None:
        for sym, bar in event.bars.items():
            self.last_prices[sym] = bar.close
        self.equity_rows.append(
            {
                "timestamp": event.timestamp,
                "equity": self.equity(),
                "cash": self.cash,
                "positions_value": self.market_value(),
            }
        )

    def on_signal(self, signal: SignalEvent) -> None:
        sym = signal.symbol
        price = self.last_prices[sym]
        target_qty = int(signal.target_weight * self.equity() // price)
        in_flight = sum(q for s, q, _ in self._pending.values() if s == sym)
        delta = target_qty - (self.positions.get(sym, 0) + in_flight)
        if delta == 0:
            return

        if delta > 0:
            # Only spend cash we actually have (minus what other open buys have claimed).
            unit = price * (1 + self.cost_buffer)
            qty = min(delta, int((self.cash - self._reserved) // unit))
            if qty <= 0:
                return
            reserve = qty * unit
            self._reserved += reserve
            side, signed, max_notional = Side.BUY, qty, reserve
        else:
            qty = -delta
            side, signed, max_notional, reserve = Side.SELL, -qty, None, 0.0

        order_id = next(self._ids)
        self._pending[order_id] = (sym, signed, reserve)
        self._queue.put(OrderEvent(signal.timestamp, order_id, sym, side, qty, max_notional))

    def on_fill(self, fill: FillEvent) -> None:
        _, _, reserve = self._pending.pop(fill.order_id, (fill.symbol, 0, 0.0))
        self._reserved -= reserve
        if fill.quantity == 0:
            return

        gross = fill.price * fill.quantity
        sym = fill.symbol
        self.fill_rows.append(
            {
                "timestamp": fill.timestamp,
                "order_id": fill.order_id,
                "symbol": sym,
                "side": fill.side.value,
                "quantity": fill.quantity,
                "ref_price": fill.ref_price,
                "fill_price": fill.price,
                "commission": fill.commission,
                "slippage_cost": fill.slippage_cost,
            }
        )

        if fill.side is Side.BUY:
            outlay = gross + fill.commission
            self.cash -= outlay
            self.positions[sym] = self.positions.get(sym, 0) + fill.quantity
            lot = self._lots.setdefault(sym, _Lot(entry_ts=fill.timestamp))
            lot.qty += fill.quantity
            lot.cost += outlay
            lot.spent += outlay
        else:
            proceeds = gross - fill.commission
            self.cash += proceeds
            self.positions[sym] -= fill.quantity
            lot = self._lots[sym]
            lot.cost -= lot.cost * fill.quantity / lot.qty  # average-cost basis
            lot.qty -= fill.quantity
            lot.received += proceeds
            if lot.qty == 0:
                pnl = lot.received - lot.spent
                self.trade_rows.append(
                    {
                        "symbol": sym,
                        "entry": lot.entry_ts,
                        "exit": fill.timestamp,
                        "pnl": pnl,
                        "return": pnl / lot.spent,
                    }
                )
                del self._lots[sym]
                del self.positions[sym]
