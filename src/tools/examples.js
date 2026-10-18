// One realistic request per paid tool. Used to advertise each endpoint in the
// x402 Bazaar discovery catalog (and handy as documentation).
export const EXAMPLES = {
  pre_trade_check: {
    account: { type: "margin", equity: 100000, positions: [] },
    order: { symbol: "AAPL", side: "buy", quantity: 50, limit_price: 200, stop_loss_price: 190 },
    market: { last_price: 200, bid: 199.98, ask: 200.02, avg_daily_volume: 50000000 },
  },
  position_size: { equity: 50000, entry_price: 100, stop_price: 95, method: "fixed_fractional", risk_pct: 0.01 },
  tax_lot_plan: {
    symbol: "MSFT",
    lots: [
      { lot_id: "a", quantity: 10, cost_basis_per_share: 200, acquired_date: "2024-01-10" },
      { lot_id: "b", quantity: 10, cost_basis_per_share: 450, acquired_date: "2026-09-01" },
    ],
    sell: { quantity: 10, price: 420, date: "2026-10-12" },
  },
  portfolio_review: {
    holdings: [
      { symbol: "NVDA", value: 60000, sector: "Tech", asset_class: "equity" },
      { symbol: "AGG", value: 30000, asset_class: "bonds" },
    ],
    cash: 10000,
    targets: { equity: 0.6, bonds: 0.35, cash: 0.05 },
  },
  strategy_audit: { trades: [{ pnl: 120 }, { pnl: -60 }, { pnl: 45 }, { pnl: -30 }, { pnl: 90 }], n_trials: 20 },
  suitability_check: {
    client: { client_ref: "c1", age: 72, horizon_years: 5, risk_tolerance: "conservative", liquidity_need_pct: 0.1, experience: "limited" },
    allocation: { equity: 0.7, bonds: 0.25, cash: 0.05 },
    products: ["leveraged_etf"],
  },

  options_risk_check: {
    account: { type: "margin", equity: 50000, options_level: 3, shares_held: 100 },
    underlying: { symbol: "AAPL", price: 200 },
    legs: [
      { type: "call", side: "short", strike: 210, expiry: "2026-11-20", quantity: 1, premium: 3.1 },
      { type: "put", side: "short", strike: 190, expiry: "2026-11-20", quantity: 2, premium: 2.6 },
      { type: "put", side: "long", strike: 180, expiry: "2026-11-20", quantity: 2, premium: 1.2 },
    ],
    as_of: "2026-10-19",
  },
};
