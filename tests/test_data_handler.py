import numpy as np
import pytest

from conftest import make_frame
from evbt import DataHandler


def test_history_never_includes_future_bars():
    frame = make_frame(np.arange(1, 11))
    dh = DataHandler({"X": frame})
    for k in range(10):
        dh.advance()
        hist = dh.history("X")
        assert len(hist) == k + 1
        assert hist[-1] == k + 1  # the current bar is the last thing visible


def test_history_window_and_copy_semantics():
    dh = DataHandler({"X": make_frame(np.arange(1, 11))})
    for _ in range(6):
        dh.advance()
    h = dh.history("X", 3)
    assert list(h) == [4, 5, 6]
    h[:] = -1  # mutating the returned array must not corrupt the handler
    assert list(dh.history("X", 3)) == [4, 5, 6]


def test_no_access_before_first_bar():
    dh = DataHandler({"X": make_frame([1, 2, 3])})
    with pytest.raises(RuntimeError):
        dh.history("X")


def test_symbols_are_aligned_on_common_dates():
    a = make_frame(np.arange(1, 11))
    b = make_frame(np.arange(1, 11)).iloc[3:]
    dh = DataHandler({"A": a, "B": b})
    assert len(dh) == 7
    ts, bars = dh.advance()
    assert ts == b.index[0] and set(bars) == {"A", "B"}


def test_exhaustion_and_validation():
    dh = DataHandler({"X": make_frame([1, 2])})
    assert dh.advance() is not None and dh.advance() is not None and dh.advance() is None
    with pytest.raises(ValueError):
        DataHandler({"X": make_frame([1, 2]).drop(columns="volume")})
    with pytest.raises(ValueError):
        DataHandler({"A": make_frame([1, 2]), "B": make_frame([1, 2], start="2030-01-01")})
