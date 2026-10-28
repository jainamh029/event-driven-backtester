"""The key property: results up to bar k cannot depend on any bar after k."""
import numpy as np
import pandas as pd
import pytest

from evbt import Backtest, RSIMeanReversion, SameDaySign, SMACrossover
from evbt.vectorized import equity_from_positions, same_day_sign_positions

STRATEGIES = {
    "sma": lambda: SMACrossover("X", 5, 20),
    "rsi2": lambda: RSIMeanReversion("X", trend=30),
    "same_day": lambda: SameDaySign("X"),
}


@pytest.mark.parametrize("name", STRATEGIES)
def test_truncating_the_future_does_not_change_the_past(random_walk, name):
    cut = 400
    full = Backtest({"X": random_walk}, STRATEGIES[name]()).run()
    part = Backtest({"X": random_walk.iloc[:cut]}, STRATEGIES[name]()).run()

    # Every equity point except the very last bar of the short run is identical. (The last bar's
    # *orders* have nowhere to fill in the short run, but its mark-to-market still agrees.)
    pd.testing.assert_series_equal(full.equity["equity"].iloc[:cut], part.equity["equity"], check_freq=False)

    early = full.fills[full.fills["timestamp"] <= random_walk.index[cut - 1]].reset_index(drop=True)
    pd.testing.assert_frame_equal(early, part.fills.reset_index(drop=True))


def test_perturbing_future_prices_leaves_past_untouched(random_walk):
    k = 300
    tampered = random_walk.copy()
    tampered.iloc[k + 1 :, :4] *= 3.0  # wildly different future
    a = Backtest({"X": random_walk}, SMACrossover("X", 5, 20)).run()
    b = Backtest({"X": tampered}, SMACrossover("X", 5, 20)).run()
    pd.testing.assert_series_equal(a.equity["equity"].iloc[: k + 1], b.equity["equity"].iloc[: k + 1])


def test_vectorized_lag0_is_look_ahead_and_engine_is_not(random_walk):
    close = random_walk["close"]
    pos = same_day_sign_positions(close)
    cheating = equity_from_positions(close, pos, lag=0)
    honest = equity_from_positions(close, pos, lag=1)
    engine = Backtest({"X": random_walk}, SameDaySign("X")).run().equity["equity"]

    assert cheating.iloc[-1] > 10 * honest.iloc[-1]  # "too good to be true"
    assert engine.iloc[-1] < 3 * engine.iloc[0]  # the engine can't be fooled that way
    assert engine.iloc[-1] < cheating.iloc[-1] / 10
