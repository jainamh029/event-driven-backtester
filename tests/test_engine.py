import numpy as np
import pandas as pd
import pytest

from conftest import make_frame
from evbt import Backtest, BuyAndHold, CostModel, Strategy, EventType, Side

FREE = CostModel(slippage_bps=0.0, commission_per_share=0.0, min_commission=0.0)


class BuyAtBar(Strategy):
    """Signals a full long at the close of bar index `when` (0-based)."""

    def __init__(self, symbol, when):
        super().__init__()
        self.symbol, self.when = symbol, when

    def on_bar(self, ts):
        if self.data.n_seen - 1 == self.when:
            self.target(self.symbol, 1.0)


def test_order_fills_at_next_open_not_signal_bar_close():
    closes = [100, 100, 100, 100, 100, 100]
    opens = [100, 100, 100, 150, 100, 100]  # bar 3 opens at 150
    frame = make_frame(closes, opens)
    res = Backtest({"X": frame}, BuyAtBar("X", 2), costs=FREE, trace=True).run()

    assert len(res.fills) == 1
    fill = res.fills.iloc[0]
    assert fill["timestamp"] == frame.index[3]  # next bar, not the signal bar
    assert fill["fill_price"] == 150  # next open, not the 100 close the signal saw
    kinds = [e.type for e in res.trace if e.timestamp == frame.index[2]]
    assert EventType.SIGNAL in kinds and EventType.ORDER in kinds and EventType.FILL not in kinds


def test_slippage_and_commission_arithmetic():
    frame = make_frame([100] * 6)
    costs = CostModel(slippage_bps=10.0, commission_per_share=0.01, min_commission=1.0)
    res = Backtest({"X": frame}, BuyAtBar("X", 1), initial_cash=10_000, costs=costs).run()
    fill = res.fills.iloc[0]
    assert fill["fill_price"] == pytest.approx(100.1)  # 10 bps worse than the open
    qty = fill["quantity"]
    assert fill["commission"] == pytest.approx(max(1.0, 0.01 * qty))
    assert fill["slippage_cost"] == pytest.approx(0.1 * qty)
    spent = 10_000 - res.equity["cash"].iloc[-1]
    assert spent == pytest.approx(100.1 * qty + fill["commission"])


def test_sell_slippage_is_adverse_too():
    class RoundTrip(Strategy):
        def on_bar(self, ts):
            i = self.data.n_seen - 1
            if i == 1:
                self.target("X", 1.0)
            if i == 3:
                self.target("X", 0.0)

    frame = make_frame([100] * 8)
    res = Backtest({"X": frame}, RoundTrip(), costs=CostModel(10.0, 0.0, 0.0)).run()
    buy, sell = res.fills.iloc[0], res.fills.iloc[1]
    assert buy["fill_price"] > 100 > sell["fill_price"]
    assert len(res.trades) == 1 and res.trades.iloc[0]["pnl"] < 0  # pure friction loses money


def test_cash_never_negative_even_when_open_gaps_up():
    closes = [100] * 5 + [100] * 5
    opens = [100] * 3 + [130] + [100] * 6  # 30% overnight gap right after the signal
    frame = make_frame(closes, opens)
    res = Backtest({"X": frame}, BuyAtBar("X", 2), initial_cash=100_000).run()
    assert res.equity["cash"].min() >= 0
    assert res.fills.iloc[0]["quantity"] < 100_000 // 100  # fewer shares than planned


def test_unaffordable_buy_is_cancelled_cleanly():
    frame = make_frame([100] * 2 + [10_000_000] * 4)
    res = Backtest({"X": frame}, BuyAtBar("X", 1), initial_cash=1_000).run()
    assert res.fills.empty and res.equity["equity"].iloc[-1] == pytest.approx(1_000)


def test_buy_and_hold_matches_the_underlying_when_frictionless(random_walk):
    res = Backtest({"X": random_walk}, BuyAndHold("X"), costs=FREE, initial_cash=1_000_000).run()
    first_fill_bar = 1  # signal at close of bar 0, fill at open of bar 1
    expected = random_walk["close"].iloc[-1] / random_walk["open"].iloc[first_fill_bar]
    achieved = res.equity["equity"].iloc[-1] / res.equity["equity"].iloc[first_fill_bar - 1]
    assert achieved == pytest.approx(expected, rel=1e-3)


def test_multi_asset_weights_respect_equity():
    class Half(Strategy):
        def on_bar(self, ts):
            for s in ("A", "B"):
                self.target(s, 0.5)

    frames = {"A": make_frame([10] * 5), "B": make_frame([20] * 5)}
    res = Backtest(frames, Half(), costs=FREE, initial_cash=10_000).run()
    assert res.equity["cash"].iloc[-1] >= 0
    assert res.equity["positions_value"].iloc[-1] == pytest.approx(10_000, rel=0.01)


def test_event_counts_reflect_the_flow():
    frame = make_frame([100] * 6)
    res = Backtest({"X": frame}, BuyAtBar("X", 1), costs=FREE).run()
    assert res.event_counts["MARKET"] == res.event_counts["BAR_CLOSE"] == 6
    assert res.event_counts["SIGNAL"] == res.event_counts["ORDER"] == res.event_counts["FILL"] == 1
