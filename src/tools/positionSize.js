import { need, num, oneOf, DISCLAIMER } from "../lib/validate.js";
import { round } from "../lib/math.js";

export const positionSize = {
  name: "position_size",
  title: "Position sizing",
  price_usd: 0.005,
  description:
    "Size a position the way a risk manager would: fixed-fractional risk to a stop, volatility targeting (ATR or annualized vol), " +
    "or fractional Kelly from your edge statistics. Applies a max-position cap and round lots, and explains the binding constraint.",
  inputSchema: {
    type: "object",
    required: ["equity", "entry_price", "method"],
    properties: {
      equity: { type: "number" },
      entry_price: { type: "number" },
      method: { enum: ["fixed_fractional", "volatility", "kelly"] },
      side: { enum: ["long", "short"], default: "long" },
      stop_price: { type: "number", description: "fixed_fractional: protective stop." },
      risk_pct: { type: "number", description: "fixed_fractional: fraction of equity to risk, default 0.01." },
      atr: { type: "number", description: "volatility: average true range in price units." },
      atr_multiple: { type: "number", description: "volatility: stop distance in ATRs, default 2." },
      annual_vol: { type: "number", description: "volatility: annualized volatility of the asset (e.g. 0.35)." },
      target_annual_vol_contribution: { type: "number", description: "volatility: target vol contribution as fraction of equity, default 0.02." },
      win_rate: { type: "number", description: "kelly: probability of a win (0-1)." },
      avg_win: { type: "number", description: "kelly: average win (any unit, same as avg_loss)." },
      avg_loss: { type: "number", description: "kelly: average loss as a positive number." },
      kelly_fraction: { type: "number", description: "kelly: fraction of full Kelly to use, default 0.25." },
      max_position_pct: { type: "number", description: "Cap on position value / equity, default 0.2." },
      lot_size: { type: "integer", description: "Round down to this multiple, default 1." },
      allow_fractional: { type: "boolean" },
    },
  },
  handler(input) {
    const equity = num(need(input, "equity"), "equity", { positive: true });
    const entry = num(need(input, "entry_price"), "entry_price", { positive: true });
    const method = oneOf(input.method, "method", ["fixed_fractional", "volatility", "kelly"]);
    const cap = input.max_position_pct ?? 0.2;
    const lot = input.lot_size || 1;
    const notes = [];
    let rawQty;
    let riskPerShare = null;

    if (method === "fixed_fractional") {
      const stop = num(need(input, "stop_price"), "stop_price", { positive: true });
      const riskPct = input.risk_pct ?? 0.01;
      riskPerShare = Math.abs(entry - stop);
      if (riskPerShare === 0) throw new Error("stop_price equals entry_price");
      if ((input.side || "long") === "long" && stop > entry) notes.push("Stop is above entry for a long; check the side.");
      rawQty = (equity * riskPct) / riskPerShare;
      notes.push(`Risking ${riskPct * 100}% of equity ($${round(equity * riskPct, 2)}) over $${round(riskPerShare, 4)} per share to the stop.`);
    } else if (method === "volatility") {
      if (input.atr) {
        const mult = input.atr_multiple ?? 2;
        const riskPct = input.risk_pct ?? 0.01;
        riskPerShare = input.atr * mult;
        rawQty = (equity * riskPct) / riskPerShare;
        notes.push(`ATR stop of ${mult} x ${input.atr} = $${round(riskPerShare, 4)} per share; risking ${riskPct * 100}% of equity.`);
      } else {
        const vol = num(need(input, "annual_vol"), "annual_vol", { positive: true });
        const target = input.target_annual_vol_contribution ?? 0.02;
        rawQty = (equity * target) / vol / entry;
        notes.push(`Position value sized so it adds ${target * 100}% annualized volatility to equity at ${vol * 100}% asset vol.`);
      }
    } else {
      const p = num(need(input, "win_rate"), "win_rate");
      const w = num(need(input, "avg_win"), "avg_win", { positive: true });
      const l = num(need(input, "avg_loss"), "avg_loss", { positive: true });
      const b = w / l;
      const full = p - (1 - p) / b;
      const frac = input.kelly_fraction ?? 0.25;
      if (full <= 0) {
        return { quantity: 0, notional: 0, binding_constraint: "no_edge", kelly_full: round(full), notes: ["Kelly is zero or negative: these statistics show no edge, so do not take the trade."], disclaimer: DISCLAIMER };
      }
      const pct = Math.min(full * frac, 1);
      rawQty = (equity * pct) / entry;
      notes.push(`Full Kelly ${round(full * 100, 2)}% of equity; using ${frac} Kelly = ${round(pct * 100, 2)}%. Fractional Kelly limits drawdowns from estimation error.`);
    }

    let binding = method;
    const capQty = (equity * cap) / entry;
    if (rawQty > capQty) {
      rawQty = capQty;
      binding = "max_position_pct";
      notes.push(`Capped at ${cap * 100}% of equity.`);
    }
    const qty = input.allow_fractional ? round(rawQty, 6) : Math.floor(rawQty / lot) * lot;
    if (!input.allow_fractional && qty === 0 && rawQty > 0) notes.push("Size rounds to zero; the account is too small for this risk budget at this price.");
    return {
      quantity: qty,
      notional: round(qty * entry, 2),
      position_pct_of_equity: round((qty * entry) / equity, 4),
      dollar_risk_to_stop: riskPerShare ? round(qty * riskPerShare, 2) : null,
      binding_constraint: binding,
      notes,
      disclaimer: DISCLAIMER,
    };
  },
};
