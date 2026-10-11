import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_MAP } from "../src/tools/index.js";
import { sessionAt, addBusinessDays } from "../src/lib/calendar.js";
import { normInv, normCdf } from "../src/lib/math.js";

const run = (name, input) => TOOL_MAP[name].handler(input);
const MON_NOON_ET = "2026-10-12T16:00:00Z"; // Monday 12:00 New York

test("calendar: sessions and business days", () => {
  assert.equal(sessionAt(new Date(MON_NOON_ET)).session, "regular");
  assert.equal(sessionAt(new Date("2026-10-11T16:00:00Z")).session, "closed"); // Sunday
  assert.equal(sessionAt(new Date("2026-11-26T16:00:00Z")).session, "closed"); // Thanksgiving
  assert.equal(sessionAt(new Date("2026-10-12T12:00:00Z")).session, "pre_market");
  assert.equal(addBusinessDays("2026-11-25", 1), "2026-11-27");
});

test("math: normal distribution round-trips", () => {
  for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-5);
});

test("pre_trade_check approves a clean order", () => {
  const r = run("pre_trade_check", {
    account: { type: "margin", equity: 100000, positions: [] },
    order: { symbol: "AAPL", side: "buy", quantity: 50, limit_price: 200, stop_loss_price: 190, timestamp: MON_NOON_ET },
    market: { last_price: 200, bid: 199.98, ask: 200.02, avg_daily_volume: 5e7 },
  });
  assert.equal(r.decision, "approve", JSON.stringify(r.checks));
});

test("pre_trade_check rejects oversize, unintended short and cash-account short", () => {
  const big = run("pre_trade_check", {
    account: { type: "margin", equity: 10000 },
    order: { symbol: "TSLA", side: "buy", quantity: 100, limit_price: 250, timestamp: MON_NOON_ET },
  });
  assert.equal(big.decision, "reject");
  assert.ok(big.suggested_quantity < 100);
  const sell = run("pre_trade_check", {
    account: { type: "margin", equity: 10000, positions: [{ symbol: "XYZ", quantity: 10, market_price: 10 }] },
    order: { symbol: "XYZ", side: "sell", quantity: 20, limit_price: 10, timestamp: MON_NOON_ET },
  });
  assert.ok(sell.checks.find((c) => c.id === "position_exists").status === "fail");
  const cashShort = run("pre_trade_check", {
    account: { type: "cash", equity: 10000, cash: 10000 },
    order: { symbol: "XYZ", side: "sell_short", quantity: 1, limit_price: 10, timestamp: MON_NOON_ET },
  });
  assert.equal(cashShort.decision, "reject");
});

test("pre_trade_check: post-June-2026 there is no $25k PDT block; legacy regime still enforced when set", () => {
  const base = {
    account: { type: "margin", equity: 8000, day_trades_last_5_days: 3, positions: [{ symbol: "AMD", quantity: 10, market_price: 150, opened_today: true }] },
    order: { symbol: "AMD", side: "sell", quantity: 10, limit_price: 150, timestamp: MON_NOON_ET },
  };
  assert.notEqual(run("pre_trade_check", base).checks.find((c) => c.id === "day_trading")?.status, "fail");
  const legacy = structuredClone(base);
  legacy.account.day_trade_regime = "legacy_pdt";
  assert.equal(run("pre_trade_check", legacy).checks.find((c) => c.id === "day_trading").status, "fail");
});

test("pre_trade_check flags wash sale and good-faith risk", () => {
  const r = run("pre_trade_check", {
    account: { type: "cash", equity: 5000, cash: 5000, settled_cash: 1000, recent_sales: [{ symbol: "NVDA", date: "2026-10-01", realized_pnl: -300 }] },
    order: { symbol: "NVDA", side: "buy", quantity: 10, limit_price: 180, stop_loss_price: 175, timestamp: MON_NOON_ET },
  });
  const ids = r.checks.filter((c) => c.status === "warn").map((c) => c.id);
  assert.ok(ids.includes("wash_sale") && ids.includes("good_faith"), ids.join());
});

test("position_size methods", () => {
  const ff = run("position_size", { equity: 50000, entry_price: 100, stop_price: 95, method: "fixed_fractional", risk_pct: 0.01 });
  assert.equal(ff.quantity, 100);
  const capped = run("position_size", { equity: 50000, entry_price: 100, stop_price: 99.9, method: "fixed_fractional" });
  assert.equal(capped.binding_constraint, "max_position_pct");
  const noEdge = run("position_size", { equity: 50000, entry_price: 100, method: "kelly", win_rate: 0.4, avg_win: 1, avg_loss: 1 });
  assert.equal(noEdge.quantity, 0);
});

test("tax_lot_plan picks the cheapest lots and flags wash sales", () => {
  const r = run("tax_lot_plan", {
    symbol: "MSFT",
    lots: [
      { lot_id: "a", quantity: 10, cost_basis_per_share: 200, acquired_date: "2024-01-10" },
      { lot_id: "b", quantity: 10, cost_basis_per_share: 450, acquired_date: "2026-09-01" },
    ],
    sell: { quantity: 10, price: 420, date: "2026-10-12" },
    recent_transactions: [{ symbol: "MSFT", side: "buy", date: "2026-10-05", quantity: 5 }],
  });
  assert.equal(r.recommended.lots[0].lot_id, "b");
  assert.ok(r.savings_vs_fifo > 0);
  assert.equal(r.wash_sale.likely_wash_sale, true);
  const h = run("tax_lot_plan", { mode: "harvest", as_of: "2026-10-12", prices: { QQQ: 400 }, lots: [{ symbol: "QQQ", quantity: 10, cost_basis_per_share: 500, acquired_date: "2026-03-01" }] });
  assert.equal(h.opportunities.length, 1);
  assert.equal(h.opportunities[0].est_tax_savings, 370);
});

test("portfolio_review finds concentration and drift", () => {
  const rets = Array.from({ length: 300 }, (_, i) => Math.sin(i) * 0.01 + 0.0004);
  const r = run("portfolio_review", {
    holdings: [
      { symbol: "NVDA", value: 60000, sector: "Tech", asset_class: "equity" },
      { symbol: "AGG", value: 30000, asset_class: "bonds" },
    ],
    cash: 10000,
    targets: { equity: 0.6, bonds: 0.35, cash: 0.05 },
    returns: rets,
  });
  assert.equal(r.grade, "needs_attention");
  assert.ok(r.risk.sharpe > 0);
  assert.equal(r.rebalance.basis, "asset_class");
});

test("strategy_audit deflates an overfit backtest", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const returns = Array.from({ length: 500 }, () => 0.0006 + rnd() * 0.03);
  const once = run("strategy_audit", { returns, n_trials: 1 });
  const many = run("strategy_audit", { returns, n_trials: 1000 });
  assert.ok(many.return_stats.deflated_sharpe_ratio < once.return_stats.deflated_sharpe_ratio);
  const t = run("strategy_audit", { trades: [{ pnl: 100 }, { pnl: -50 }, { pnl: 30 }] });
  assert.ok(t.red_flags.length > 0);
});

test("suitability_check blocks leveraged ETFs for a conservative retiree", () => {
  const r = run("suitability_check", {
    client: { client_ref: "c1", age: 72, horizon_years: 5, risk_tolerance: "conservative", liquidity_need_pct: 0.1, experience: "limited" },
    allocation: { equity: 0.7, bonds: 0.25, cash: 0.05 },
    products: ["leveraged_etf"],
  });
  assert.equal(r.result, "not_suitable");
  assert.match(r.memo.sha256, /^[0-9a-f]{64}$/);
});
