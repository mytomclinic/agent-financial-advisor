"""Check every Alpaca order with Agent Financial Advisor before sending it.

    pip install alpaca-py requests
    export APCA_API_KEY_ID=... APCA_API_SECRET_KEY=...   # paper keys are fine
    export AFA_API_KEY=...   # optional: free key from POST /v1/keys (25 free calls a day)
    python alpaca_pre_trade_guard.py AAPL buy 10 --stop 190
"""
import argparse
import os

import requests
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.requests import MarketOrderRequest

AFA = os.environ.get("AFA_URL", "https://agent-financial-advisor.agent-financial-advisor.workers.dev")


def afa_check(trading, symbol, side, qty, stop=None, last_price=None):
    acct = trading.get_account()
    positions = [
        {"symbol": p.symbol, "quantity": float(p.qty), "market_price": float(p.current_price), "avg_cost": float(p.avg_entry_price)}
        for p in trading.get_all_positions()
    ]
    body = {
        "account": {
            "type": "margin" if float(acct.multiplier) > 1 else "cash",
            "equity": float(acct.equity),
            "cash": float(acct.cash),
            "buying_power": float(acct.buying_power),
            "positions": positions,
        },
        "order": {"symbol": symbol, "side": side, "quantity": qty, "order_type": "market", **({"stop_loss_price": stop} if stop else {})},
        **({"market": {"last_price": last_price}} if last_price else {}),
    }
    headers = {"authorization": f"Bearer {os.environ['AFA_API_KEY']}"} if os.environ.get("AFA_API_KEY") else {}
    r = requests.post(f"{AFA}/v1/tools/pre_trade_check", json=body, headers=headers, timeout=10)
    if r.status_code == 402:
        raise SystemExit("Free calls used up: get a free key (POST /v1/keys), buy credits, or pay per call with x402.")
    r.raise_for_status()
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("side", choices=["buy", "sell"])
    ap.add_argument("qty", type=float)
    ap.add_argument("--stop", type=float)
    ap.add_argument("--live", action="store_true", help="use the live account instead of paper")
    a = ap.parse_args()

    trading = TradingClient(os.environ["APCA_API_KEY_ID"], os.environ["APCA_API_SECRET_KEY"], paper=not a.live)
    result = afa_check(trading, a.symbol.upper(), a.side, a.qty, a.stop)
    print(result["summary"])
    for c in result["checks"]:
        if c["status"] != "pass":
            print(f"  {c['status']}: {c['check']}: {c['detail']}")

    if result["decision"] == "reject":
        raise SystemExit("Order blocked by pre-trade check.")
    qty = result.get("suggested_quantity", a.qty)
    order = trading.submit_order(MarketOrderRequest(symbol=a.symbol.upper(), qty=qty, side=OrderSide(a.side), time_in_force=TimeInForce.DAY))
    print("submitted", order.id, "qty", qty)


if __name__ == "__main__":
    main()
