import { test } from "node:test";
import assert from "node:assert/strict";
import { optionsRiskCheck } from "../src/tools/optionsRisk.js";
import { EXAMPLES } from "../src/tools/examples.js";

const run = (o) => optionsRiskCheck.handler(o);
const find = (r, name) => r.checks.filter((c) => c.check === name);

test("covered call plus put credit spread: requirement is the spread width", () => {
  const r = run(EXAMPLES.options_risk_check);
  assert.equal(r.decision, "approve");
  assert.equal(r.margin_requirement_usd, 2000);
  assert.equal(r.max_loss_usd, 1720);
  assert.equal(r.required_options_level, 3);
  assert.deepEqual(r.structures.map((s) => s.kind), ["covered_call", "spread"]);
});

test("naked call uses the FINRA 4210 formula and is unlimited risk", () => {
  const r = run({ account: { type: "margin", equity: 100000, options_level: 4 }, underlying: { symbol: "XYZ", price: 100 }, legs: [{ type: "call", side: "short", strike: 110, expiry: "2026-12-18", quantity: 1, premium: 2 }], as_of: "2026-10-19" });
  // max(2 + 20 - 10, 2 + 10) = 12 per share
  assert.equal(r.margin_requirement_usd, 1200);
  assert.equal(r.max_loss_usd, "unlimited");
  assert.equal(r.required_options_level, 4);
  assert.equal(find(r, "max_loss")[0].status, "warn");
});

test("cash account: puts without cash become naked and are rejected", () => {
  const legs = [{ type: "put", side: "short", strike: 50, expiry: "2026-12-18", quantity: 1, premium: 1 }];
  const secured = run({ account: { type: "cash", equity: 10000, cash: 5000 }, underlying: { symbol: "XYZ", price: 55 }, legs, as_of: "2026-10-19" });
  assert.equal(secured.structures[0].kind, "cash_secured_put");
  assert.equal(find(secured, "cash_account_options")[0].status, "pass");
  const naked = run({ account: { type: "cash", equity: 10000, cash: 1000 }, underlying: { symbol: "XYZ", price: 55 }, legs, as_of: "2026-10-19" });
  assert.equal(naked.decision, "reject");
  assert.equal(find(naked, "cash_account_options")[0].status, "fail");
});

test("dividend early assignment, pin risk, auto-exercise and Greeks", () => {
  const r = run({
    account: { type: "margin", equity: 20000, shares_held: 100, options_level: 4 },
    underlying: { symbol: "XYZ", price: 100.4, ex_dividend_date: "2026-11-19", dividend: 0.8 },
    legs: [
      { type: "call", side: "short", strike: 90, expiry: "2026-11-20", quantity: 1, premium: 10.6, delta: 0.95, gamma: 0.01, theta: -0.02, vega: 0.03 },
      { type: "put", side: "short", strike: 100, expiry: "2026-10-20", quantity: 1, premium: 0.4, delta: -0.45, gamma: 0.2, theta: -0.3, vega: 0.02 },
      { type: "call", side: "long", strike: 300, expiry: "2026-10-20", quantity: 1, premium: 0.01, delta: 0, gamma: 0, theta: 0, vega: 0 },
    ],
    as_of: "2026-10-19",
  });
  assert.equal(find(r, "early_assignment_dividend").length, 1);
  assert.equal(find(r, "pin_risk").length, 1);
  assert.equal(r.greeks.delta_shares, -50);
  assert.equal(r.decision, "approve_with_warnings");
});

test("expiring ITM long call the account can't pay for is rejected", () => {
  const r = run({ account: { type: "margin", equity: 2000 }, underlying: { symbol: "XYZ", price: 100 }, legs: [{ type: "call", side: "long", strike: 90, expiry: "2026-10-19", quantity: 1, premium: 10 }], as_of: "2026-10-19" });
  assert.equal(find(r, "auto_exercise")[0].status, "fail");
});

test("rejects expired legs and fractional contracts", () => {
  const base = { account: { type: "margin", equity: 1000 }, underlying: { symbol: "X", price: 10 }, as_of: "2026-10-19" };
  assert.throws(() => run({ ...base, legs: [{ type: "call", side: "long", strike: 10, expiry: "2026-10-01", quantity: 1 }] }), /expired/);
  assert.throws(() => run({ ...base, legs: [{ type: "call", side: "long", strike: 10, expiry: "2026-11-01", quantity: 1.5 }] }), /whole number/);
});
