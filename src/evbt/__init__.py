"""evbt: a small event-driven backtester."""
from .data import DataHandler
from .engine import Backtest, BacktestResult
from .events import (
    Bar,
    BarCloseEvent,
    EventQueue,
    EventType,
    FillEvent,
    MarketEvent,
    OrderEvent,
    Side,
    SignalEvent,
)
from .execution import CostModel, SimulatedExecution
from .portfolio import Portfolio
from .strategy import (
    BuyAndHold,
    RSIMeanReversion,
    SameDaySign,
    SMACrossover,
    Strategy,
    TrendFilterPortfolio,
)

__all__ = [
    "Backtest", "BacktestResult", "Bar", "BarCloseEvent", "BuyAndHold", "CostModel", "DataHandler",
    "EventQueue", "EventType", "FillEvent", "MarketEvent", "OrderEvent", "Portfolio", "RSIMeanReversion",
    "SameDaySign", "SMACrossover", "Side", "SignalEvent", "SimulatedExecution", "Strategy",
    "TrendFilterPortfolio",
]
__version__ = "0.1.0"
