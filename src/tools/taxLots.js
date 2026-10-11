import { RULES } from "../lib/regs.js";
import { daysBetween, addDays, toIsoDate } from "../lib/calendar.js";
import { need, num, arr, DISCLAIMER } from "../lib/validate.js";
import { round } from "../lib/math.js";

const DEFAULT_RATES = { short_term: 0.37, long_term: 0.2 };
const METHODS = ["fifo", "lifo", "hifo", "min_tax"];

function normLots(lots, symbol) {
  return lots
    .filter((l) => !symbol || String(l.symbol || symbol).toUpperCase() === symbol)
    .map((l, i) => ({
      lot_id: l.lot_id ?? `lot${i + 1}`,
      quantity: num(l.quantity, `lots[${i}].quantity`, { positive: true }),
      cost_basis_per_share: num(l.cost_basis_per_share, `lots[${i}].cost_basis_per_share`, { min: 0 }),
      acquired_date: String(need(l, "acquired_date")),
    }));
}

const isLongTerm = (acq, sale) => daysBetween(acq, sale) > RULES.holding_period.long_term_after_days;

function pick(lots, qty, price, date, method, rates) {
  const scored = lots.map((l) => {
    const lt = isLongTerm(l.acquired_date, date);
    const gainPerShare = price - l.cost_basis_per_share;
    return { ...l, lt, gainPerShare, taxPerShare: gainPerShare * (lt ? rates.long_term : rates.short_term) };
  });
  const order = {
    fifo: (a, b) => a.acquired_date.localeCompare(b.acquired_date),
    lifo: (a, b) => b.acquired_date.localeCompare(a.acquired_date),
    hifo: (a, b) => b.cost_basis_per_share - a.cost_basis_per_share,
    min_tax: (a, b) => a.taxPerShare - b.taxPerShare,
  }[method];
  scored.sort(order);
  let left = qty;
  const used = [];
  for (const l of scored) {
    if (left <= 0) break;
    const q = Math.min(l.quantity, left);
    left -= q;
    used.push({
      lot_id: l.lot_id, quantity: q, acquired_date: l.acquired_date, cost_basis_per_share: l.cost_basis_per_share,
      term: l.lt ? "long" : "short", gain: round(q * l.gainPerShare, 2), est_tax: round(q * l.taxPerShare, 2),
    });
  }
  if (left > 1e-9) throw new Error(`Only ${qty - left} shares available in lots; cannot sell ${qty}.`);
  const st = used.filter((u) => u.term === "short").reduce((a, u) => a + u.gain, 0);
  const lt = used.filter((u) => u.term === "long").reduce((a, u) => a + u.gain, 0);
  return { method, lots: used, short_term_gain: round(st, 2), long_term_gain: round(lt, 2), est_tax: round(used.reduce((a, u) => a + u.est_tax, 0), 2) };
}

function washSaleFindings(symbol, saleDate, realizedLoss, recent) {
  if (realizedLoss >= 0) return null;
  const hits = (recent || []).filter((t) => String(t.symbol || symbol).toUpperCase() === symbol && t.side === "buy" && Math.abs(daysBetween(t.date, saleDate)) <= RULES.wash_sale.window_days);
  return {
    loss: round(realizedLoss, 2),
    replacement_buys_in_window: hits,
    likely_wash_sale: hits.length > 0,
    avoid_buying_until: addDays(saleDate, RULES.wash_sale.window_days + 1),
    note: hits.length
      ? "Purchases within 30 days of this loss sale make some or all of the loss nondeductible now; it shifts into the replacement shares' basis. Lots bought in the window and being sold now do not count as replacements."
      : "No replacement purchase seen in the 30 days before. Do not buy a substantially identical security through the date shown, including in IRAs or by automatic reinvestment.",
    rule: RULES.wash_sale.source,
  };
}

export const taxLotPlan = {
  name: "tax_lot_plan",
  title: "Tax lot selection and wash-sale check",
  price_usd: 0.02,
  description:
    "Act as the tax advisor for a sale: compares FIFO, LIFO, HIFO and minimum-tax lot selection, splits short- and long-term gains, " +
    "estimates tax, flags wash sales, and notes lots about to turn long-term. With mode=harvest it scans positions for tax-loss harvesting.",
  inputSchema: {
    type: "object",
    required: ["lots"],
    properties: {
      mode: { enum: ["sell", "harvest"], default: "sell" },
      symbol: { type: "string" },
      lots: { type: "array", items: { type: "object", properties: { lot_id: { type: "string" }, symbol: { type: "string" }, quantity: { type: "number" }, cost_basis_per_share: { type: "number" }, acquired_date: { type: "string" } } } },
      sell: { type: "object", properties: { quantity: { type: "number" }, price: { type: "number" }, date: { type: "string" } }, description: "mode=sell" },
      prices: { type: "object", description: "mode=harvest: {SYMBOL: current price}" },
      as_of: { type: "string", description: "mode=harvest: date, default today" },
      recent_transactions: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, side: { enum: ["buy", "sell"] }, date: { type: "string" }, quantity: { type: "number" } } } },
      tax_rates: { type: "object", properties: { short_term: { type: "number" }, long_term: { type: "number" } } },
      min_harvest_loss: { type: "number", description: "mode=harvest: ignore losses smaller than this (USD), default 100." },
    },
  },
  handler(input) {
    const rates = { ...DEFAULT_RATES, ...(input.tax_rates || {}) };
    arr(input.lots, "lots", { minLength: 1 });

    if (input.mode === "harvest") {
      const prices = need(input, "prices");
      const asOf = input.as_of || toIsoDate(new Date());
      const minLoss = input.min_harvest_loss ?? 100;
      const out = [];
      input.lots.forEach((l, i) => {
        const sym = String(need(l, "symbol")).toUpperCase();
        const px = prices[sym];
        if (px == null) return;
        const [lot] = normLots([l]);
        const pnl = (px - lot.cost_basis_per_share) * lot.quantity;
        if (pnl >= -minLoss) return;
        const lt = isLongTerm(lot.acquired_date, asOf);
        const recentBuy = (input.recent_transactions || []).find((t) => String(t.symbol).toUpperCase() === sym && t.side === "buy" && daysBetween(t.date, asOf) <= 30 && daysBetween(t.date, asOf) >= 0 && t.date !== lot.acquired_date);
        out.push({
          symbol: sym, lot_id: lot.lot_id, quantity: lot.quantity, unrealized_loss: round(pnl, 2), term: lt ? "long" : "short",
          est_tax_savings: round(-pnl * (lt ? rates.long_term : rates.short_term), 2),
          wash_sale_risk: recentBuy ? `Bought ${sym} on ${recentBuy.date}; harvesting now may be a wash sale.` : null,
          repurchase_after: addDays(asOf, 31),
        });
      });
      out.sort((a, b) => b.est_tax_savings - a.est_tax_savings);
      return {
        as_of: asOf,
        opportunities: out,
        total_est_tax_savings: round(out.filter((o) => !o.wash_sale_risk).reduce((a, o) => a + o.est_tax_savings, 0), 2),
        notes: [
          "Savings assume losses offset gains taxed at the given rates; net capital losses beyond gains offset only $3,000 of ordinary income a year (26 U.S.C. 1211).",
          "To keep market exposure, rotate into a similar but not substantially identical fund for 31 days.",
        ],
        disclaimer: DISCLAIMER,
      };
    }

    const symbol = input.symbol ? String(input.symbol).toUpperCase() : null;
    const sell = need(input, "sell");
    const qty = num(need(sell, "quantity"), "sell.quantity", { positive: true });
    const price = num(need(sell, "price"), "sell.price", { positive: true });
    const date = sell.date || toIsoDate(new Date());
    const lots = normLots(input.lots, symbol);
    const comparisons = METHODS.map((m) => pick(lots, qty, price, date, m, rates));
    const best = comparisons.reduce((a, b) => (b.est_tax < a.est_tax ? b : a));
    const fifo = comparisons.find((c) => c.method === "fifo");
    const realized = best.short_term_gain + best.long_term_gain;
    const soon = lots
      .filter((l) => !isLongTerm(l.acquired_date, date) && price > l.cost_basis_per_share)
      .map((l) => ({ lot_id: l.lot_id, long_term_on: addDays(l.acquired_date, RULES.holding_period.long_term_after_days + 1), days_away: RULES.holding_period.long_term_after_days + 1 - daysBetween(l.acquired_date, date) }))
      .filter((x) => x.days_away <= 60);
    return {
      recommended: best,
      savings_vs_fifo: round(fifo.est_tax - best.est_tax, 2),
      comparisons: comparisons.map(({ method, short_term_gain, long_term_gain, est_tax }) => ({ method, short_term_gain, long_term_gain, est_tax })),
      wash_sale: washSaleFindings(symbol || "", date, realized, input.recent_transactions),
      lots_turning_long_term_soon: soon,
      notes: [
        "Use specific identification with your broker and confirm lot IDs in writing by settlement to get the recommended lots.",
        ...(soon.length ? ["Some gaining lots become long-term within 60 days; waiting would cut their tax rate."] : []),
      ],
      tax_rates_used: rates,
      disclaimer: DISCLAIMER,
    };
  },
};
