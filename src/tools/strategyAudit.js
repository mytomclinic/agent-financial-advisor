import { DISCLAIMER } from "../lib/validate.js";
import { mean, stdev, skewness, kurtosis, normCdf, normInv, round, sum } from "../lib/math.js";
import { riskMetrics } from "./portfolioReview.js";

const EULER = 0.5772156649;

// Probabilistic Sharpe Ratio (Bailey & Lopez de Prado, 2012). sr and benchmark are per-period.
export function psr(sr, benchmark, n, skew, kurt) {
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / denom);
}

// Expected maximum Sharpe among `trials` unskilled strategies (Deflated Sharpe Ratio, 2014).
export function expectedMaxSharpe(trials, srVariance) {
  if (trials <= 1) return 0;
  return Math.sqrt(srVariance) * ((1 - EULER) * normInv(1 - 1 / trials) + EULER * normInv(1 - 1 / (trials * Math.E)));
}

export const strategyAudit = {
  name: "strategy_audit",
  title: "Strategy audit and overfitting check",
  price_usd: 0.1,
  description:
    "An independent performance auditor for a trading strategy or backtest. From a trade list and/or periodic returns it computes " +
    "win rate, expectancy, profit factor, streaks, Sharpe/Sortino/drawdown, and tests whether the edge is real: t-stat, " +
    "Probabilistic Sharpe Ratio and the Deflated Sharpe Ratio that corrects for how many variants you tried. Returns a verdict and red flags.",
  inputSchema: {
    type: "object",
    properties: {
      trades: { type: "array", items: { type: "object", properties: { pnl: { type: "number" }, return_pct: { type: "number" } } }, description: "Closed trades." },
      returns: { type: "array", items: { type: "number" }, description: "Periodic strategy returns as decimals." },
      periods_per_year: { type: "number", default: 252 },
      n_trials: { type: "integer", description: "How many strategy/parameter variants were tested before picking this one. Default 1.", default: 1 },
      trial_sharpe_variance: { type: "number", description: "Variance of per-period Sharpe across trials, if known." },
      starting_equity: { type: "number", description: "For risk-of-ruin and drawdown in dollars from trades." },
    },
  },
  handler(input) {
    const out = { red_flags: [], disclaimer: DISCLAIMER };
    const trades = Array.isArray(input.trades) ? input.trades : [];
    const returns = Array.isArray(input.returns) ? input.returns.map(Number) : [];
    if (!trades.length && returns.length < 2) throw new Error("Provide trades (with pnl) or at least 2 periodic returns.");

    if (trades.length) {
      const pnl = trades.map((t) => Number(t.pnl ?? t.return_pct));
      const wins = pnl.filter((p) => p > 0);
      const losses = pnl.filter((p) => p < 0);
      const grossWin = sum(wins);
      const grossLoss = -sum(losses);
      let streak = 0;
      let maxStreak = 0;
      pnl.forEach((p) => { streak = p < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); });
      const sorted = [...pnl].sort((a, b) => b - a);
      const total = sum(pnl);
      const top5Share = total > 0 ? sum(sorted.slice(0, Math.max(1, Math.ceil(pnl.length * 0.05)))) / total : null;
      const sd = stdev(pnl);
      const tstat = sd ? (mean(pnl) / sd) * Math.sqrt(pnl.length) : null;
      out.trade_stats = {
        trades: pnl.length,
        win_rate: round(wins.length / pnl.length),
        avg_win: round(mean(wins)),
        avg_loss: round(-mean(losses)),
        payoff_ratio: losses.length ? round(mean(wins) / -mean(losses), 3) : null,
        expectancy_per_trade: round(mean(pnl)),
        profit_factor: grossLoss ? round(grossWin / grossLoss, 3) : null,
        total_pnl: round(total, 2),
        max_consecutive_losses: maxStreak,
        t_stat: tstat != null ? round(tstat, 3) : null,
        top_5pct_trades_share_of_profit: top5Share != null ? round(top5Share, 3) : null,
      };
      if (pnl.length < 30) out.red_flags.push(`Only ${pnl.length} trades; too few to separate skill from luck.`);
      if (tstat != null && tstat < 2) out.red_flags.push(`Mean trade t-stat ${round(tstat, 2)} is below 2; the edge is not statistically significant.`);
      if (top5Share != null && top5Share > 0.5) out.red_flags.push("Over half the profit comes from the top 5% of trades; results hinge on a few outliers.");
      if (grossLoss && grossWin / grossLoss < 1.1) out.red_flags.push("Profit factor under 1.1 leaves little room for slippage and fees.");
    }

    if (returns.length >= 2) {
      const ppy = input.periods_per_year || 252;
      const m = riskMetrics(returns, ppy);
      const sr = stdev(returns) ? mean(returns) / stdev(returns) : 0;
      const sk = skewness(returns);
      const ku = kurtosis(returns);
      const n = returns.length;
      const trials = Math.max(1, input.n_trials || 1);
      const srVar = input.trial_sharpe_variance ?? (1 - sk * sr + ((ku - 1) / 4) * sr * sr) / (n - 1);
      const sr0 = expectedMaxSharpe(trials, srVar);
      const p = psr(sr, 0, n, sk, ku);
      const dsr = psr(sr, sr0, n, sk, ku);
      out.return_stats = {
        ...m,
        skew: round(sk, 3),
        kurtosis: round(ku, 3),
        probabilistic_sharpe_ratio: round(p, 4),
        deflated_sharpe_ratio: round(dsr, 4),
        sharpe_hurdle_annualized: round(sr0 * Math.sqrt(ppy), 3),
        n_trials: trials,
      };
      if (dsr < 0.95) out.red_flags.push(`Deflated Sharpe Ratio ${round(dsr, 3)} is below 0.95: after accounting for ${trials} trial(s), the Sharpe is not convincingly above what luck would produce.`);
      if (n < ppy) out.red_flags.push("Less than one year of returns; regime coverage is thin.");
      if (sk < -1) out.red_flags.push(`Strong negative skew (${round(sk, 2)}): steady gains with rare large losses, typical of short-volatility exposure.`);
      if (m.max_drawdown > 0.3) out.red_flags.push(`Max drawdown ${round(m.max_drawdown * 100, 1)}% would breach most allocators' tolerance.`);
    }

    const serious = out.red_flags.length;
    out.verdict = serious === 0 ? "robust" : serious <= 2 ? "promising_but_unproven" : "not_deployable";
    out.recommendations = [
      ...(input.n_trials ? [] : ["Report n_trials (variants tested). Without it the Deflated Sharpe assumes this was the only idea tried and will be too generous."]),
      "Validate out of sample (walk-forward or a held-out period) before adding capital.",
      "Model commissions, spread and slippage explicitly; small edges disappear first.",
    ];
    return out;
  },
};
