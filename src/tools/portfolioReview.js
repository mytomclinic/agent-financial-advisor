import { need, arr, DISCLAIMER } from "../lib/validate.js";
import { mean, stdev, quantile, maxDrawdown, round, sum } from "../lib/math.js";

export function riskMetrics(returns, periodsPerYear = 252, rf = 0) {
  const rfp = rf / periodsPerYear;
  const ex = returns.map((r) => r - rfp);
  const sd = stdev(returns);
  const down = returns.filter((r) => r < rfp).map((r) => r - rfp);
  const dsd = down.length ? Math.sqrt(sum(down.map((d) => d * d)) / returns.length) : 0;
  const mdd = maxDrawdown(returns);
  const years = returns.length / periodsPerYear;
  const cagr = years > 0 ? mdd.final_growth ** (1 / years) - 1 : 0;
  const var95 = -quantile(returns, 0.05);
  const tail = returns.filter((r) => r <= -var95);
  return {
    periods: returns.length,
    annual_return_cagr: round(cagr),
    annual_volatility: round(sd * Math.sqrt(periodsPerYear)),
    sharpe: sd ? round((mean(ex) / sd) * Math.sqrt(periodsPerYear), 3) : null,
    sortino: dsd ? round((mean(ex) / dsd) * Math.sqrt(periodsPerYear), 3) : null,
    max_drawdown: round(mdd.max_drawdown),
    calmar: mdd.max_drawdown ? round(cagr / mdd.max_drawdown, 3) : null,
    var_95_one_period: round(var95),
    cvar_95_one_period: tail.length ? round(-mean(tail)) : round(var95),
  };
}

function beta(r, b) {
  const n = Math.min(r.length, b.length);
  const rr = r.slice(-n);
  const bb = b.slice(-n);
  const mr = mean(rr);
  const mb = mean(bb);
  let cov = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (rr[i] - mr) * (bb[i] - mb);
    vb += (bb[i] - mb) ** 2;
  }
  return vb ? cov / vb : null;
}

export const portfolioReview = {
  name: "portfolio_review",
  title: "Portfolio review",
  price_usd: 0.05,
  description:
    "A periodic advisor review of a portfolio: weights, concentration (HHI and effective number of holdings), sector and asset-class " +
    "exposure, drift from targets with the trades to rebalance, and, given return history, volatility, Sharpe, Sortino, drawdown, " +
    "VaR/CVaR and beta. Ends with prioritized findings.",
  inputSchema: {
    type: "object",
    required: ["holdings"],
    properties: {
      holdings: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, value: { type: "number" }, quantity: { type: "number" }, price: { type: "number" }, sector: { type: "string" }, asset_class: { type: "string" } } } },
      cash: { type: "number" },
      targets: { type: "object", description: "Target weights by symbol or asset_class, summing to 1." },
      rebalance_band: { type: "number", description: "Absolute drift that triggers a rebalance, default 0.05." },
      returns: { type: "array", items: { type: "number" }, description: "Periodic portfolio returns as decimals." },
      benchmark_returns: { type: "array", items: { type: "number" } },
      periods_per_year: { type: "number", default: 252 },
      risk_free_rate: { type: "number", default: 0 },
      limits: { type: "object", properties: { max_single_weight: { type: "number" }, max_sector_weight: { type: "number" }, max_drawdown: { type: "number" } } },
    },
  },
  handler(input) {
    arr(need(input, "holdings"), "holdings", { minLength: 1 });
    const limits = { max_single_weight: 0.15, max_sector_weight: 0.35, max_drawdown: 0.25, ...(input.limits || {}) };
    const hs = input.holdings.map((h) => ({ ...h, value: Number(h.value ?? Number(h.quantity) * Number(h.price)) }));
    if (hs.some((h) => !Number.isFinite(h.value))) throw new Error("Each holding needs value, or quantity and price.");
    const cash = Number(input.cash || 0);
    const total = sum(hs.map((h) => h.value)) + cash;
    const weights = hs.map((h) => ({ symbol: h.symbol, value: round(h.value, 2), weight: round(h.value / total), sector: h.sector || null, asset_class: h.asset_class || null })).sort((a, b) => b.weight - a.weight);
    if (cash) weights.push({ symbol: "CASH", value: round(cash, 2), weight: round(cash / total), asset_class: "cash" });
    const hhi = sum(weights.map((w) => w.weight ** 2));
    const groupBy = (k) => {
      const g = {};
      weights.forEach((w) => { if (w[k]) g[w[k]] = round((g[w[k]] || 0) + w.weight); });
      return g;
    };
    const sectors = groupBy("sector");
    const classes = groupBy("asset_class");
    const findings = [];
    weights.filter((w) => w.symbol !== "CASH" && w.weight > limits.max_single_weight).forEach((w) => findings.push({ severity: "high", issue: `${w.symbol} is ${round(w.weight * 100, 1)}% of the portfolio (limit ${limits.max_single_weight * 100}%).` }));
    Object.entries(sectors).filter(([, v]) => v > limits.max_sector_weight).forEach(([s, v]) => findings.push({ severity: "medium", issue: `${s} sector is ${round(v * 100, 1)}% (limit ${limits.max_sector_weight * 100}%).` }));
    if (1 / hhi < 8 && weights.length > 1) findings.push({ severity: "medium", issue: `Effective number of holdings is ${round(1 / hhi, 1)}; the portfolio behaves like a concentrated book.` });

    let rebalance = null;
    if (input.targets) {
      const band = input.rebalance_band ?? 0.05;
      const byClass = Object.keys(input.targets).some((k) => classes[k] !== undefined);
      const current = byClass ? classes : Object.fromEntries(weights.map((w) => [w.symbol, w.weight]));
      const rows = Object.entries(input.targets).map(([k, t]) => {
        const cur = current[k] || 0;
        return { key: k, target: t, current: round(cur), drift: round(cur - t), trade_value: round((t - cur) * total, 2) };
      });
      const breach = rows.filter((r) => Math.abs(r.drift) > band);
      rebalance = { basis: byClass ? "asset_class" : "symbol", band, needed: breach.length > 0, rows };
      if (breach.length) findings.push({ severity: "medium", issue: `${breach.length} target(s) drifted beyond the ${band * 100}% band; see rebalance.rows for trade values.` });
    }

    let risk = null;
    if (Array.isArray(input.returns) && input.returns.length >= 20) {
      risk = riskMetrics(input.returns, input.periods_per_year || 252, input.risk_free_rate || 0);
      if (input.benchmark_returns?.length) {
        risk.beta = round(beta(input.returns, input.benchmark_returns), 3);
        const bm = riskMetrics(input.benchmark_returns, input.periods_per_year || 252, input.risk_free_rate || 0);
        risk.benchmark = { annual_return_cagr: bm.annual_return_cagr, sharpe: bm.sharpe, max_drawdown: bm.max_drawdown };
        if (risk.sharpe != null && bm.sharpe != null && risk.sharpe < bm.sharpe) findings.push({ severity: "low", issue: `Risk-adjusted return (Sharpe ${risk.sharpe}) trails the benchmark (${bm.sharpe}).` });
      }
      if (risk.max_drawdown > limits.max_drawdown) findings.push({ severity: "high", issue: `Max drawdown ${round(risk.max_drawdown * 100, 1)}% exceeds the ${limits.max_drawdown * 100}% limit.` });
    } else if (input.returns) findings.push({ severity: "info", issue: "Fewer than 20 return observations; risk metrics skipped." });

    const rank = { high: 0, medium: 1, low: 2, info: 3 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return {
      total_value: round(total, 2),
      holdings: weights,
      concentration: { hhi: round(hhi), effective_holdings: round(1 / hhi, 2), top_5_weight: round(sum(weights.slice(0, 5).map((w) => w.weight))) },
      sector_weights: sectors,
      asset_class_weights: classes,
      rebalance,
      risk,
      findings,
      grade: findings.some((f) => f.severity === "high") ? "needs_attention" : findings.some((f) => f.severity === "medium") ? "fair" : "good",
      disclaimer: DISCLAIMER,
    };
  },
};
