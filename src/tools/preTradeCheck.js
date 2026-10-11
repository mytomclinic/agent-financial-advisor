import { RULES, RULES_VERSION, defaultDayTradeRegime } from "../lib/regs.js";
import { sessionAt, daysBetween, toIsoDate } from "../lib/calendar.js";
import { need, num, oneOf, DISCLAIMER } from "../lib/validate.js";
import { round } from "../lib/math.js";

const DEFAULT_POLICY = {
  max_position_pct: 0.2,
  max_order_risk_pct: 0.02,
  max_adv_pct: 0.05,
  max_spread_pct: 0.01,
  max_gross_leverage: 2,
  max_limit_deviation_pct: 0.1,
  allow_short: true,
  allow_extended_hours: false,
  require_stop: false,
};

export const preTradeCheck = {
  name: "pre_trade_check",
  title: "Pre-trade compliance and risk check",
  price_usd: 0.005,
  description:
    "Run an order past a compliance officer and risk manager before sending it to the broker. Checks buying power, " +
    "cash-account settlement violations, FINRA intraday margin (post-PDT) or legacy PDT limits, Reg SHO short-sale rules, " +
    "wash-sale exposure, position concentration, per-trade risk versus stop, liquidity, spread, fat-finger prices, " +
    "leverage and market hours. Returns approve / approve_with_warnings / reject with reasons and a resized quantity when useful.",
  inputSchema: {
    type: "object",
    required: ["account", "order"],
    properties: {
      account: {
        type: "object",
        description: "Account state before the order.",
        required: ["type", "equity"],
        properties: {
          type: { enum: ["cash", "margin"] },
          equity: { type: "number", description: "Net liquidation value (USD)." },
          cash: { type: "number" },
          settled_cash: { type: "number", description: "Cash accounts: settled funds available." },
          buying_power: { type: "number", description: "Broker-reported buying power, if known." },
          day_trade_regime: { enum: ["intraday_margin", "legacy_pdt"], description: "Defaults by date; brokers may phase in until 2027-10-20." },
          day_trades_last_5_days: { type: "integer" },
          positions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" }, quantity: { type: "number", description: "Negative for short." },
                market_price: { type: "number" }, avg_cost: { type: "number" }, opened_today: { type: "boolean" },
                sector: { type: "string" },
              },
            },
          },
          recent_sales: {
            type: "array",
            description: "Sales in the last 30 days, for wash-sale checks.",
            items: { type: "object", properties: { symbol: { type: "string" }, date: { type: "string" }, realized_pnl: { type: "number" }, quantity: { type: "number" } } },
          },
        },
      },
      order: {
        type: "object",
        required: ["symbol", "side", "quantity"],
        properties: {
          symbol: { type: "string" },
          side: { enum: ["buy", "sell", "sell_short", "buy_to_cover"] },
          quantity: { type: "number" },
          order_type: { enum: ["market", "limit", "stop", "stop_limit"] },
          limit_price: { type: "number" },
          stop_loss_price: { type: "number", description: "Planned protective stop, used for risk-per-trade." },
          locate_confirmed: { type: "boolean" },
          timestamp: { type: "string", description: "ISO time the order will be sent; defaults to now." },
        },
      },
      market: {
        type: "object",
        properties: {
          last_price: { type: "number" }, prev_close: { type: "number" }, bid: { type: "number" }, ask: { type: "number" },
          avg_daily_volume: { type: "number" }, halted: { type: "boolean" },
        },
      },
      policy: { type: "object", description: "Override risk limits. Defaults: " + JSON.stringify(DEFAULT_POLICY) },
    },
  },
  handler(input) {
    const account = need(input, "account");
    const order = need(input, "order");
    const market = input.market || {};
    const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
    const checks = [];
    const add = (id, status, message, rule) => checks.push({ id, status, message, ...(rule ? { rule } : {}) });

    const type = oneOf(account.type, "account.type", ["cash", "margin"]);
    const equity = num(account.equity, "account.equity", { positive: true });
    const symbol = String(need(order, "symbol")).toUpperCase();
    const side = oneOf(order.side, "order.side", ["buy", "sell", "sell_short", "buy_to_cover"]);
    const qty = num(order.quantity, "order.quantity", { positive: true });
    const orderType = order.order_type || (order.limit_price ? "limit" : "market");
    const positions = account.positions || [];
    const held = positions.find((p) => String(p.symbol).toUpperCase() === symbol);
    const heldQty = held ? Number(held.quantity) : 0;
    const price = Number(order.limit_price || market.last_price || market.ask || held?.market_price);
    if (!Number.isFinite(price) || price <= 0) {
      add("price_known", "fail", "No usable price: pass order.limit_price or market.last_price.");
      return finish();
    }
    const notional = qty * price;
    const when = order.timestamp ? new Date(order.timestamp) : new Date();
    const today = toIsoDate(when);
    const opening = side === "buy" || side === "sell_short";

    // Trading halt and market hours
    if (market.halted) add("halt", "fail", `${symbol} is halted; orders will not execute.`);
    const sess = sessionAt(when);
    if (sess.session === "regular") add("market_hours", "pass", "Regular trading session.");
    else if (sess.session === "closed") add("market_hours", orderType === "market" ? "warn" : "pass", `Market closed (${sess.reason}); ${orderType === "market" ? "a market order will queue for the next open at an unknown price." : "order will rest until the next session."}`);
    else add("market_hours", policy.allow_extended_hours && orderType !== "market" ? "pass" : "warn", `Order falls in ${sess.session.replace("_", "-")} trading: thinner liquidity, wider spreads, limit orders only at most brokers.`);

    // Selling more than held / covering more than short
    if (side === "sell") {
      if (heldQty <= 0) add("position_exists", "fail", `No long ${symbol} position to sell; this would open a short. Use side=sell_short if intended.`);
      else if (qty > heldQty) add("position_exists", "fail", `Selling ${qty} but only ${heldQty} held; the excess would open an unintended short.`, null);
      else add("position_exists", "pass", `Selling ${qty} of ${heldQty} held.`);
    }
    if (side === "buy_to_cover") {
      if (heldQty >= 0) add("position_exists", "fail", `No short ${symbol} position to cover.`);
      else if (qty > -heldQty) add("position_exists", "warn", `Covering ${qty} but short only ${-heldQty}; the excess opens a long.`);
    }

    // Buying power and cash-account settlement
    const longValue = positions.reduce((a, p) => a + Math.max(0, Number(p.quantity) * Number(p.market_price || 0)), 0);
    const shortValue = positions.reduce((a, p) => a + Math.max(0, -Number(p.quantity) * Number(p.market_price || 0)), 0);
    if (opening) {
      if (type === "cash") {
        if (side === "sell_short") add("short_sale_account", "fail", "Short selling requires a margin account.", RULES.short_sale.source);
        const settled = account.settled_cash ?? account.cash ?? account.buying_power;
        const cash = account.cash ?? settled;
        if (settled == null) add("buying_power", "warn", "Cash balance not provided; cannot confirm funds.");
        else if (notional <= settled) add("buying_power", "pass", `Cost $${round(notional, 2)} within settled cash $${round(settled, 2)}.`);
        else if (notional <= cash) add("good_faith", "warn", `Purchase uses unsettled funds ($${round(notional - settled, 2)}). Selling these shares before those funds settle (${RULES.settlement.cycle}) is a good-faith violation.`, RULES.cash_account.source);
        else add("buying_power", "fail", `Cost $${round(notional, 2)} exceeds cash $${round(cash, 2)}.`);
      } else {
        const im = RULES.reg_t.initial_margin;
        const bp = account.buying_power ?? Math.max(0, (equity - im * (longValue + shortValue)) / im);
        if (notional <= bp) add("buying_power", "pass", `Cost $${round(notional, 2)} within buying power $${round(bp, 2)}.`, RULES.reg_t.source);
        else add("buying_power", "fail", `Cost $${round(notional, 2)} exceeds buying power $${round(bp, 2)} (Reg T 50% initial margin).`, RULES.reg_t.source);
      }
    }

    // Leverage after the trade
    const signed = side === "buy" || side === "buy_to_cover" ? qty : -qty;
    const newQty = heldQty + signed;
    const grossAfter = longValue + shortValue - Math.abs(heldQty) * price + Math.abs(newQty) * price;
    const lev = grossAfter / equity;
    if (lev > policy.max_gross_leverage) add("leverage", "fail", `Gross exposure after trade ${round(lev, 2)}x equity exceeds limit ${policy.max_gross_leverage}x.`);
    else add("leverage", "pass", `Gross exposure after trade ${round(lev, 2)}x equity.`);

    // Concentration
    const posValueAfter = Math.abs(newQty) * price;
    const posPct = posValueAfter / equity;
    let suggestedQty = null;
    if (opening && posPct > policy.max_position_pct) {
      const maxQty = Math.max(0, Math.floor((policy.max_position_pct * equity) / price - Math.abs(heldQty)));
      suggestedQty = maxQty;
      add("concentration", posPct > 2 * policy.max_position_pct ? "fail" : "warn", `${symbol} would be ${round(posPct * 100, 1)}% of equity (limit ${policy.max_position_pct * 100}%). Max additional quantity: ${maxQty}.`);
    } else add("concentration", "pass", `${symbol} would be ${round(posPct * 100, 1)}% of equity.`);

    // Risk per trade versus stop
    if (opening) {
      if (order.stop_loss_price != null) {
        const stop = num(order.stop_loss_price, "order.stop_loss_price", { positive: true });
        const perShare = side === "buy" ? price - stop : stop - price;
        if (perShare <= 0) add("stop_placement", "fail", `Stop $${stop} is on the wrong side of entry $${price} for a ${side}.`);
        else {
          const risk = perShare * qty;
          const riskPct = risk / equity;
          const maxQty = Math.floor((policy.max_order_risk_pct * equity) / perShare);
          if (riskPct > policy.max_order_risk_pct) {
            suggestedQty = suggestedQty == null ? maxQty : Math.min(suggestedQty, maxQty);
            add("risk_per_trade", riskPct > 2 * policy.max_order_risk_pct ? "fail" : "warn", `Risk to stop $${round(risk, 2)} = ${round(riskPct * 100, 2)}% of equity (limit ${policy.max_order_risk_pct * 100}%). Quantity for limit: ${maxQty}.`);
          } else add("risk_per_trade", "pass", `Risk to stop $${round(risk, 2)} = ${round(riskPct * 100, 2)}% of equity.`);
        }
      } else add("risk_per_trade", policy.require_stop ? "fail" : "warn", "No stop_loss_price given; loss on this position is unbounded by plan.");
    }

    // Liquidity, spread, fat finger
    if (market.avg_daily_volume) {
      const advPct = qty / market.avg_daily_volume;
      add("liquidity", advPct > policy.max_adv_pct ? "warn" : "pass", `Order is ${round(advPct * 100, 2)}% of average daily volume${advPct > policy.max_adv_pct ? `; expect market impact (limit ${policy.max_adv_pct * 100}%). Consider slicing.` : "."}`);
    }
    if (market.bid && market.ask) {
      const spread = (market.ask - market.bid) / ((market.ask + market.bid) / 2);
      if (spread > policy.max_spread_pct && orderType === "market") add("spread", "warn", `Spread ${round(spread * 100, 2)}% is wide for a market order; use a limit order.`);
      else add("spread", "pass", `Spread ${round(spread * 100, 2)}%.`);
    }
    if (order.limit_price && market.last_price) {
      const dev = Math.abs(order.limit_price - market.last_price) / market.last_price;
      if (dev > policy.max_limit_deviation_pct) add("fat_finger", "warn", `Limit $${order.limit_price} is ${round(dev * 100, 1)}% from last $${market.last_price}. Check for a typo.`);
    }

    // Short-sale rules
    if (side === "sell_short") {
      if (!policy.allow_short) add("short_policy", "fail", "Policy disallows short selling.");
      if (order.locate_confirmed !== true) add("locate", "warn", "Locate not confirmed. Reg SHO Rule 203 requires borrow to be located before shorting.", RULES.short_sale.source);
      if (market.prev_close && market.last_price && market.last_price <= market.prev_close * (1 - RULES.short_sale.circuit_breaker_drop)) {
        add("ssr", orderType === "market" ? "fail" : "warn", `${symbol} is down ${round((1 - market.last_price / market.prev_close) * 100, 1)}% from the prior close; the Rule 201 circuit breaker is likely active. Shorts must be priced above the national best bid.`, RULES.short_sale.source);
      }
    }

    // Day trading
    if (type === "margin") {
      const regime = account.day_trade_regime || defaultDayTradeRegime(today);
      const closesToday = (side === "sell" || side === "buy_to_cover") && held?.opened_today;
      if (regime === "legacy_pdt") {
        const count = Number(account.day_trades_last_5_days || 0) + (closesToday ? 1 : 0);
        if (equity < RULES.legacy_pdt.min_equity && count >= RULES.legacy_pdt.day_trade_threshold) {
          add("day_trading", "fail", `This would be day trade #${count} in 5 business days with equity under $25,000; the broker will flag the account as a pattern day trader and restrict it.`, RULES.legacy_pdt.source);
        } else if (closesToday) add("day_trading", "pass", `Day trade #${count} in 5 business days.`, RULES.legacy_pdt.source);
      } else {
        // Intraday margin: estimate deficit after an IML-reducing transaction.
        if (opening) {
          const longAfter = longValue - Math.max(0, heldQty) * price + Math.max(0, newQty) * price;
          const shortAfter = shortValue - Math.max(0, -heldQty) * price + Math.max(0, -newQty) * price;
          const reqAfter = RULES.reg_t.maintenance_long * longAfter + RULES.reg_t.maintenance_short * shortAfter;
          const deficit = Math.max(0, reqAfter - equity);
          if (deficit > 0) {
            const deMin = Math.min(RULES.intraday_margin.de_minimis.pct_of_equity * equity, RULES.intraday_margin.de_minimis.dollars);
            add("intraday_margin", deficit > deMin ? "warn" : "pass", `Estimated intraday margin deficit $${round(deficit, 2)}. It must be met promptly; repeated late satisfaction past the 5th business day brings a 90-day restriction on new shorts and debit balances.`, RULES.intraday_margin.source);
          } else add("intraday_margin", "pass", "No intraday margin deficit expected. (The $25,000 PDT minimum no longer applies under the intraday standard; confirm your broker has adopted it.)", RULES.intraday_margin.source);
        }
      }
    }

    // Wash sales
    if (side === "buy" || side === "buy_to_cover") {
      const losses = (account.recent_sales || []).filter((s) => String(s.symbol).toUpperCase() === symbol && Number(s.realized_pnl) < 0 && s.date && Math.abs(daysBetween(s.date, today)) <= RULES.wash_sale.window_days);
      if (losses.length) {
        const disallowed = losses.reduce((a, s) => a - Number(s.realized_pnl), 0);
        add("wash_sale", "warn", `Buying ${symbol} within 30 days of selling it at a loss: up to $${round(disallowed, 2)} of loss may be disallowed and added to the new shares' basis.`, RULES.wash_sale.source);
      }
    }
    if (side === "sell" && held?.avg_cost && price < held.avg_cost) {
      add("wash_sale_window", "pass", `Realizing a loss on ${symbol}. Avoid buying it (or a substantially identical security) for 30 days to keep the loss deductible.`, RULES.wash_sale.source);
    }

    return finish();

    function finish() {
      const fails = checks.filter((c) => c.status === "fail").length;
      const warns = checks.filter((c) => c.status === "warn").length;
      const decision = fails ? "reject" : warns ? "approve_with_warnings" : "approve";
      return {
        decision,
        summary: `${decision.toUpperCase()}: ${fails} failed, ${warns} warning(s), ${checks.length - fails - warns} passed.`,
        ...(suggestedQty != null && suggestedQty < qty ? { suggested_quantity: suggestedQty } : {}),
        checks,
        rules_version: RULES_VERSION,
        disclaimer: DISCLAIMER,
      };
    }
  },
};
