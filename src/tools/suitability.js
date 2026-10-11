import { createHash } from "node:crypto";
import { RULES, RULES_VERSION } from "../lib/regs.js";
import { need, DISCLAIMER } from "../lib/validate.js";
import { round, sum } from "../lib/math.js";

// Equity bands by risk tolerance, adjusted for horizon. Conservative house view, documented in the memo.
const BANDS = {
  conservative: [0.1, 0.4],
  moderate: [0.35, 0.7],
  aggressive: [0.6, 1.0],
};

const COMPLEX = {
  leveraged_etf: "Leveraged and inverse ETFs reset daily and decay over longer holds (FINRA Regulatory Notice 09-31).",
  options: "Options need options-level approval and suit only investors who understand them.",
  crypto: "Crypto assets are highly volatile and lack SIPC protection.",
  penny_stock: "Penny stocks carry heightened fraud and liquidity risk (SEC Rules 15g-1 to 15g-9).",
  private_placement: "Private placements are illiquid and generally limited to accredited investors.",
};

function riskBucket(rt) {
  if (typeof rt === "number") return rt <= 3 ? "conservative" : rt <= 7 ? "moderate" : "aggressive";
  const s = String(rt).toLowerCase();
  if (s.startsWith("cons") || s === "low") return "conservative";
  if (s.startsWith("agg") || s === "high") return "aggressive";
  return "moderate";
}

export const suitabilityCheck = {
  name: "suitability_check",
  title: "Best-interest suitability review",
  price_usd: 0.03,
  description:
    "The compliance review a robo-advisor or advisory agent should run before recommending a portfolio to a person: compares the " +
    "proposal with the client's age, horizon, risk tolerance, liquidity needs and experience under Reg BI / fiduciary standards, " +
    "flags complex products, and returns a timestamped, hashed suitability memo for the audit file.",
  inputSchema: {
    type: "object",
    required: ["client", "allocation"],
    properties: {
      client: {
        type: "object",
        properties: {
          client_ref: { type: "string", description: "Your internal id; do not send names or account numbers." },
          age: { type: "number" }, horizon_years: { type: "number" },
          risk_tolerance: { description: "conservative | moderate | aggressive, or 1-10" },
          liquidity_need_pct: { type: "number", description: "Share of assets needed within 12 months." },
          experience: { enum: ["none", "limited", "good", "extensive"] },
          objectives: { type: "array", items: { type: "string" } },
          net_worth: { type: "number" }, annual_income: { type: "number" },
        },
      },
      allocation: { type: "object", description: "Weights by asset class: equity, bonds, cash, alternatives, crypto... summing to 1." },
      products: { type: "array", items: { enum: Object.keys(COMPLEX) }, description: "Complex products included." },
      max_single_position_pct: { type: "number" },
      annual_fee_pct: { type: "number", description: "All-in annual cost (advisory + fund expenses)." },
    },
  },
  handler(input) {
    const c = need(input, "client");
    const alloc = need(input, "allocation");
    const issues = [];
    const add = (severity, text) => issues.push({ severity, text });
    const total = sum(Object.values(alloc).map(Number));
    if (Math.abs(total - 1) > 0.02) add("high", `Allocation weights sum to ${round(total, 3)}, not 1.`);

    const bucket = riskBucket(c.risk_tolerance ?? "moderate");
    let [lo, hi] = BANDS[bucket];
    const horizon = Number(c.horizon_years ?? 10);
    if (horizon < 3) { hi = Math.min(hi, 0.3); lo = Math.min(lo, 0.1); }
    else if (horizon < 7) hi = Math.min(hi, 0.7);
    if (c.age >= 70) hi = Math.min(hi, 0.6);
    const growth = Number(alloc.equity || 0) + Number(alloc.alternatives || 0) + Number(alloc.crypto || 0);
    if (growth > hi + 1e-9) add("high", `Growth assets ${round(growth * 100, 1)}% exceed the ${round(hi * 100)}% ceiling for a ${bucket} client with a ${horizon}-year horizon.`);
    if (growth < lo - 1e-9) add("medium", `Growth assets ${round(growth * 100, 1)}% are below the ${round(lo * 100)}% floor; the plan may not meet return objectives.`);

    const liquid = Number(alloc.cash || 0) + Number(alloc.bonds || 0) * 0.9;
    if (c.liquidity_need_pct != null && liquid < c.liquidity_need_pct) add("high", `Liquid assets ~${round(liquid * 100, 1)}% fall short of the ${c.liquidity_need_pct * 100}% needed within a year.`);

    for (const p of input.products || []) {
      const sev = bucket === "conservative" || ["none", "limited"].includes(c.experience) ? "high" : "medium";
      add(sev, `${p.replace("_", " ")}: ${COMPLEX[p] || "Complex product."}${sev === "high" ? " Not suitable for this client's profile without documented justification." : " Document why it fits."}`);
    }
    if (Number(alloc.crypto || 0) > 0.05) add(bucket === "aggressive" ? "low" : "medium", `Crypto at ${round(alloc.crypto * 100, 1)}% is above a 5% sleeve.`);
    if (input.max_single_position_pct > 0.1) add("medium", `A single position at ${round(input.max_single_position_pct * 100, 1)}% concentrates idiosyncratic risk.`);
    if (input.annual_fee_pct > 0.01) add("medium", `All-in cost ${round(input.annual_fee_pct * 100, 2)}% a year is high; Reg BI's care obligation requires considering cost and reasonably available alternatives.`);
    if (!c.age || !c.horizon_years || c.risk_tolerance == null) add("high", "Investment profile incomplete (age, horizon and risk tolerance are required to document a best-interest basis).");

    const high = issues.filter((i) => i.severity === "high").length;
    const result = high ? "not_suitable" : issues.some((i) => i.severity === "medium") ? "suitable_with_conditions" : "suitable";
    const memo = {
      reviewed_at: new Date().toISOString(),
      client_ref: c.client_ref || null,
      profile_bucket: bucket,
      equity_band: [round(lo, 2), round(hi, 2)],
      allocation: alloc,
      result,
      issues,
      standard: RULES.reg_bi.source,
      rules_version: RULES_VERSION,
    };
    memo.sha256 = createHash("sha256").update(JSON.stringify(memo)).digest("hex");
    return { result, issues, memo, disclaimer: DISCLAIMER };
  },
};
