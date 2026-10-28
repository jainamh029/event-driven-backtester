import numpy as np
import pandas as pd
import pytest

from conftest import make_frame
from evbt import Backtest, RSIMeanReversion, SMACrossover, TrendFilterPortfolio
from evbt.metrics import compute_metrics, max_drawdown_series


def test_metrics_on_a_known_curve():
    idx = pd.bdate_range("2020-01-01", periods=5)
    eq = pd.Series([100, 110, 99, 99, 121], index=idx, dtype=float)
    dd = max_drawdown_series(eq)
    assert dd.min() == pytest.approx(-0.10)
    m = compute_metrics(eq)
    assert m["total_return"] == pytest.approx(0.21)
    assert m["max_drawdown"] == pytest.approx(-0.10)


def test_flat_curve_has_zero_risk_stats():
    eq = pd.Series(100.0, index=pd.bdate_range("2020-01-01", periods=10))
    m = compute_metrics(eq)
    assert m["sharpe"] == 0 and m["max_drawdown"] == 0 and m["total_return"] == 0


def test_sma_crossover_rejects_bad_params():
    with pytest.raises(ValueError):
        SMACrossover("X", 50, 20)


def test_sma_goes_long_in_uptrend_and_stays_flat_in_downtrend():
    up = make_frame(np.linspace(100, 200, 120))
    down = make_frame(np.linspace(200, 100, 120))
    assert Backtest({"X": up}, SMACrossover("X", 5, 20)).run().fills["side"].tolist() == ["BUY"]
    assert Backtest({"X": down}, SMACrossover("X", 5, 20)).run().fills.empty


def test_rsi_helper():
    assert RSIMeanReversion.rsi(np.array([10, 9, 8.0])) == 0
    assert RSIMeanReversion.rsi(np.array([8, 9, 10.0])) == 100
    assert RSIMeanReversion.rsi(np.array([5, 5, 5.0])) == 50


def test_trend_portfolio_never_exceeds_full_investment(random_walk):
    frames = {s: random_walk * (1 + 0.1 * i) for i, s in enumerate("ABC")}
    res = Backtest(frames, TrendFilterPortfolio(list("ABC"), window=30), initial_cash=100_000).run()
    invested = res.equity["positions_value"] / res.equity["equity"]
    assert invested.max() <= 1.0 + 1e-9 and res.equity["cash"].min() >= 0
