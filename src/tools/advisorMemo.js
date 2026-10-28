import { RULES_VERSION } from "../lib/regs.js";
import { ValidationError, DISCLAIMER } from "../lib/validate.js";
import { preTradeCheck } from "./preTradeCheck.js";
import { positionSize } from "./positionSize.js";
import { taxLotPlan } from "./taxLots.js";
import { optionsRiskCheck } from "./optionsRisk.js";
import { portfolioReview } from "./portfolioReview.js";

// Each section of the request runs one deterministic tool; Claude then writes the memo.
const SECTIONS = { trade: preTradeCheck, sizing: positionSize, tax_lots: taxLotPlan, options: optionsRiskCheck, portfolio: portfolioReview };
const ORDER = ["proceed", "proceed_with_changes", "do_not_proceed"];
const MAX_CONTEXT = 2000;

// The strictest recommendation the rule checks allow; the memo may be stricter, never looser.
function baseline(analysis) {
  let level = 0;
  const raise = (l) => { level = Math.max(level, l); };
  for (const r of Object.values(analysis)) {
    if (r.decision === "reject") raise(2);
    else if (r.decision === "approve_with_warnings") raise(1);
    if (r.suggested_quantity != null) raise(1);
    if (r.binding_constraint === "no_edge") raise(2);
    if (r.grade === "needs_attention" || r.grade === "fair") raise(1);
    if (r.savings_vs_fifo > 0 || r.wash_sale?.length || r.lots_turning_long_term_soon?.length) raise(1);
  }
  return ORDER[level];
}

export const advisorMemo = {
  name: "advisor_memo",
  title: "Advisor memo (written by Claude)",
  price_usd: 0.1,
  paid_only: true,
  description:
    "Send a planned trade, options position or portfolio and get a written decision memo: proceed, proceed with changes, or do not proceed, " +
    "with the risks, the exact changes to make, the rules that apply and a dated note for your audit file. Runs pre_trade_check, " +
    "position_size, tax_lot_plan, options_risk_check and portfolio_review on whichever sections you send, then Claude writes the memo; " +
    "it never overrides a failed check. Paid only (credits or x402); free and trial calls don't cover it.",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", description: `Optional: your plan and thesis in plain words (up to ${MAX_CONTEXT} characters).` },
      trade: { type: "object", description: "A pre_trade_check request: {account, order, market?, policy?}." },
      sizing: { type: "object", description: "A position_size request." },
      tax_lots: { type: "object", description: "A tax_lot_plan request, for a planned sale." },
      options: { type: "object", description: "An options_risk_check request." },
      portfolio: { type: "object", description: "A portfolio_review request." },
    },
  },
  handler(input) {
    const sections = Object.keys(SECTIONS).filter((k) => input?.[k] != null);
    if (!sections.length) throw new ValidationError(`Send at least one of: ${Object.keys(SECTIONS).join(", ")}.`);
    if (input.context != null && (typeof input.context !== "string" || input.context.length > MAX_CONTEXT)) throw new ValidationError(`context must be a string of at most ${MAX_CONTEXT} characters`);
    const analysis = {};
    for (const k of sections) {
      try {
        analysis[k] = SECTIONS[k].handler(input[k]);
      } catch (e) {
        throw new ValidationError(`${k}: ${e.message}`);
      }
    }
    return { analysis, baseline_recommendation: baseline(analysis) };
  },
  // Runs after billing has authorized the call. Throws if the memo can't be written.
  async compose(result, input, ctx) {
    const plan = { context: input.context || null, ...Object.fromEntries(Object.keys(result.analysis).map((k) => [k, input[k]])) };
    const { memo, model } = await ctx.memoWriter.write({ analysis: result.analysis, plan });
    const floor = ORDER.indexOf(result.baseline_recommendation);
    if (!(ORDER.indexOf(memo.recommendation) >= floor)) memo.recommendation = result.baseline_recommendation;
    return {
      recommendation: memo.recommendation,
      memo,
      analysis: result.analysis,
      written_by: model,
      rules_version: RULES_VERSION,
      as_of: new Date().toISOString(),
      disclaimer: DISCLAIMER,
    };
  },
};
