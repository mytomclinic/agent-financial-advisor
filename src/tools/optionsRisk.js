import { RULES, RULES_VERSION } from "../lib/regs.js";
import { daysBetween, isTradingDay, addDays, newYorkParts } from "../lib/calendar.js";
import { need, num, arr, oneOf, ValidationError, DISCLAIMER } from "../lib/validate.js";
import { round } from "../lib/math.js";

const DEFAULT_POLICY = { pin_band_pct: 0.01, max_requirement_pct_of_equity: 0.5, max_delta_dollars_pct_of_equity: 1, assignment_dte: 5, low_extrinsic: 0.05 };

// Typical broker approval levels; brokers differ, so we return the structure as well as the level.
const LEVELS = { covered_call: 1, cash_secured_put: 1, long: 2, spread: 3, naked: 4 };

function tradingDaysUntil(from, to) {
  let n = 0;
  for (let d = from; d < to; ) { d = addDays(d, 1); if (isTradingDay(d)) n += 1; }
  return n;
}

export const optionsRiskCheck = {
  name: "options_risk_check",
  title: "Options risk and margin check",
  price_usd: 0.01,
  description:
    "Check an options book (existing or proposed legs) the way a broker's options desk would: covered, cash-secured, spread or " +
    "naked; margin requirement under FINRA Rule 4210; cash-account limits; required approval level; early-assignment risk around " +
    "ex-dividend dates; pin risk; auto-exercise of expiring in-the-money longs and the capital it needs; max loss; and net Greeks. " +
    "Returns approve / approve_with_warnings / reject with reasons.",
  inputSchema: {
    type: "object",
    required: ["account", "underlying", "legs"],
    properties: {
      account: {
        type: "object",
        required: ["type", "equity"],
        properties: {
          type: { enum: ["cash", "margin"] },
          equity: { type: "number" },
          cash: { type: "number", description: "Settled cash; cash accounts need it for cash-secured puts." },
          buying_power: { type: "number", description: "Broker-reported option or stock buying power, if known." },
          options_level: { type: "integer", description: "Approved level at the broker (typical scale 1 to 4)." },
          shares_held: { type: "number", description: "Shares of the underlying held long (covers short calls)." },
        },
      },
      underlying: {
        type: "object",
        required: ["symbol", "price"],
        properties: {
          symbol: { type: "string" },
          price: { type: "number" },
          ex_dividend_date: { type: "string", description: "Next ex-dividend date (YYYY-MM-DD)." },
          dividend: { type: "number", description: "Dividend per share for that date." },
        },
      },
      legs: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "side", "strike", "expiry", "quantity"],
          properties: {
            type: { enum: ["call", "put"] },
            side: { enum: ["long", "short"] },
            strike: { type: "number" },
            expiry: { type: "string", description: "YYYY-MM-DD" },
            quantity: { type: "integer", description: "Contracts, positive." },
            premium: { type: "number", description: "Current option price per share." },
            multiplier: { type: "number", description: "Default 100." },
            delta: { type: "number", description: "Per share, long-option sign convention." },
            gamma: { type: "number" },
            theta: { type: "number", description: "Per share per day." },
            vega: { type: "number" },
          },
        },
      },
      as_of: { type: "string", description: "Date of the check (YYYY-MM-DD); defaults to today in New York." },
      policy: { type: "object", description: "Overrides: pin_band_pct, max_requirement_pct_of_equity, max_delta_dollars_pct_of_equity, assignment_dte, low_extrinsic." },
    },
  },
  handler(input) {
    const account = need(input, "account");
    const acctType = oneOf(account.type, "account.type", ["cash", "margin"]);
    const equity = num(need(input, "account.equity"), "account.equity", { positive: true });
    const symbol = String(need(input, "underlying.symbol")).toUpperCase();
    const S = num(need(input, "underlying.price"), "underlying.price", { positive: true });
    const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
    const asOf = input.as_of || newYorkParts(new Date()).date;
    const legs = arr(need(input, "legs"), "legs", { minLength: 1 }).map((l, i) => {
      const leg = {
        i,
        type: oneOf(l.type, `legs[${i}].type`, ["call", "put"]),
        side: oneOf(l.side, `legs[${i}].side`, ["long", "short"]),
        strike: num(l.strike, `legs[${i}].strike`, { positive: true }),
        expiry: String(need(l, "expiry")),
        qty: num(l.quantity, `legs[${i}].quantity`, { positive: true }),
        premium: l.premium == null ? null : num(l.premium, `legs[${i}].premium`, { min: 0 }),
        mult: l.multiplier ? num(l.multiplier, `legs[${i}].multiplier`, { positive: true }) : 100,
        greeks: l,
      };
      if (!Number.isInteger(leg.qty)) throw new ValidationError(`legs[${i}].quantity must be a whole number of contracts`);
      leg.dte = daysBetween(asOf, leg.expiry);
      if (leg.dte < 0) throw new ValidationError(`legs[${i}] expired on ${leg.expiry}`);
      leg.intrinsic = Math.max(0, leg.type === "call" ? S - leg.strike : leg.strike - S);
      leg.extrinsic = leg.premium == null ? null : Math.max(0, leg.premium - leg.intrinsic);
      leg.label = `${leg.side} ${leg.qty} ${symbol} ${leg.expiry} ${leg.strike} ${leg.type}${leg.qty > 1 ? "s" : ""}`;
      return leg;
    });

    const checks = [];
    const notes = [];
    const add = (check, status, detail, source) => checks.push({ check, status, detail, ...(source ? { source } : {}) });
    if (legs.some((l) => l.premium == null)) notes.push("Some legs have no premium, so option values count as $0 in margin and max-loss figures.");

    // Pair each short leg with cover: shares, long options (same type, expiring no earlier), or cash.
    const longLeft = new Map(legs.filter((l) => l.side === "long").map((l) => [l.i, l.qty]));
    let sharesLeft = Math.max(0, Number(account.shares_held) || 0);
    const structures = [];
    for (const sh of legs.filter((l) => l.side === "short").sort((a, b) => a.expiry.localeCompare(b.expiry))) {
      let left = sh.qty;
      if (sh.type === "call" && sharesLeft >= sh.mult) {
        const n = Math.min(left, Math.floor(sharesLeft / sh.mult));
        sharesLeft -= n * sh.mult;
        left -= n;
        structures.push({ kind: "covered_call", short: sh, qty: n });
      }
      const candidates = legs
        .filter((l) => l.side === "long" && l.type === sh.type && l.expiry >= sh.expiry && longLeft.get(l.i) > 0 && l.mult === sh.mult)
        // Tightest cover first: nearest strike on the protective side, then the rest.
        .sort((a, b) => Math.abs(a.strike - sh.strike) - Math.abs(b.strike - sh.strike));
      for (const lg of candidates) {
        if (!left) break;
        const n = Math.min(left, longLeft.get(lg.i));
        longLeft.set(lg.i, longLeft.get(lg.i) - n);
        left -= n;
        structures.push({ kind: "spread", short: sh, long: lg, qty: n });
      }
      if (left) structures.push({ kind: sh.type === "put" ? "short_put" : "naked_call", short: sh, qty: left });
    }
    for (const l of legs.filter((x) => x.side === "long")) {
      if (longLeft.get(l.i) > 0) structures.push({ kind: "long", long: l, qty: longLeft.get(l.i) });
    }

    // Short puts are cash-secured if the cash covers them, otherwise naked.
    let cashLeft = Number(account.cash) || 0;
    let requirement = 0;
    let maxLoss = 0;
    let unlimited = false;
    let requiredLevel = 0;
    const val = (l) => (l.premium || 0) * l.mult;
    for (const st of structures) {
      if (st.kind === "covered_call") {
        st.requirement = 0;
        requiredLevel = Math.max(requiredLevel, LEVELS.covered_call);
      } else if (st.kind === "long") {
        st.requirement = val(st.long) * st.qty;
        st.max_loss = st.requirement;
        requiredLevel = Math.max(requiredLevel, LEVELS.long);
      } else if (st.kind === "spread") {
        const { short: s, long: l } = st;
        const width = s.type === "call" ? l.strike - s.strike : s.strike - l.strike;
        const net = (val(s) - val(l)) * st.qty; // >0 credit, <0 debit
        st.requirement = Math.max(0, width) * s.mult * st.qty;
        st.max_loss = s.expiry === l.expiry ? Math.max(0, Math.max(0, width) * s.mult * st.qty - net) : null;
        if (st.max_loss == null) notes.push(`Calendar or diagonal spread on the ${s.strike} ${s.type}: max loss depends on the long leg's value at the short's expiry.`);
        requiredLevel = Math.max(requiredLevel, LEVELS.spread);
      } else {
        const s = st.short;
        const otm = s.type === "call" ? Math.max(0, s.strike - S) : Math.max(0, S - s.strike);
        const perShare = Math.max((s.premium || 0) + RULES.options_margin.naked_pct * S - otm, (s.premium || 0) + RULES.options_margin.naked_min_pct * (s.type === "call" ? S : s.strike));
        const exercise = s.strike * s.mult * st.qty;
        if (st.kind === "short_put" && cashLeft >= exercise) {
          cashLeft -= exercise;
          st.kind = "cash_secured_put";
          st.requirement = exercise - val(s) * st.qty;
          requiredLevel = Math.max(requiredLevel, LEVELS.cash_secured_put);
        } else {
          if (st.kind === "short_put") st.kind = "naked_put";
          st.requirement = perShare * s.mult * st.qty;
          requiredLevel = Math.max(requiredLevel, LEVELS.naked);
        }
        if (s.type === "call") unlimited = true;
        else st.max_loss = Math.max(0, s.strike - (s.premium || 0)) * s.mult * st.qty;
      }
      requirement += st.requirement;
      if (st.max_loss != null) maxLoss += st.max_loss;
    }

    // Account type and approval level
    const kinds = new Set(structures.map((s) => s.kind));
    if (acctType === "cash" && (kinds.has("spread") || kinds.has("naked_call") || kinds.has("naked_put"))) {
      add("cash_account_options", "fail", "A cash account can only buy options or write covered calls and cash-secured puts. Spreads and uncovered writes need a margin account.", RULES.options_cash_account.source);
    } else {
      add("cash_account_options", "pass", acctType === "cash" ? "Only long, covered or cash-secured positions." : "Margin account.", RULES.options_cash_account.source);
    }
    if (account.options_level != null) {
      if (Number(account.options_level) < requiredLevel) add("options_level", "fail", `This book needs options approval level ${requiredLevel} on the typical 1 to 4 scale; the account has ${account.options_level}.`);
      else add("options_level", "pass", `Needs level ${requiredLevel}; account has ${account.options_level}.`);
    } else {
      add("options_level", "warn", `This book needs options approval level ${requiredLevel} on the typical scale (1 covered/cash-secured, 2 long, 3 spreads, 4 uncovered). Confirm the broker's level.`);
    }

    // Margin requirement vs capacity
    const capacity = account.buying_power != null ? Number(account.buying_power) : acctType === "margin" ? equity : Number(account.cash) || 0;
    if (requirement > capacity) add("margin_requirement", "fail", `Requirement $${round(requirement, 2)} exceeds ${account.buying_power != null ? "buying power" : acctType === "margin" ? "equity" : "cash"} of $${round(capacity, 2)}.`, RULES.options_margin.source);
    else if (requirement > policy.max_requirement_pct_of_equity * equity) add("margin_requirement", "warn", `Requirement $${round(requirement, 2)} is ${round((requirement / equity) * 100, 1)}% of equity, above the ${policy.max_requirement_pct_of_equity * 100}% policy limit.`, RULES.options_margin.source);
    else add("margin_requirement", "pass", `Requirement $${round(requirement, 2)} (${round((requirement / equity) * 100, 1)}% of equity).`, RULES.options_margin.source);

    if (unlimited) add("max_loss", "warn", "Uncovered short call: loss is unlimited if the stock rises.", RULES.options_margin.source);
    else if (maxLoss > equity) add("max_loss", "fail", `Max loss $${round(maxLoss, 2)} exceeds account equity.`);
    else add("max_loss", "pass", `Max loss about $${round(maxLoss, 2)} (${round((maxLoss / equity) * 100, 1)}% of equity).`);

    // Early assignment, pin risk, expiration exercise
    const exDate = input.underlying.ex_dividend_date;
    const div = Number(input.underlying.dividend) || 0;
    for (const s of legs.filter((l) => l.side === "short")) {
      const exercise = s.strike * s.mult * s.qty;
      if (s.type === "call" && s.intrinsic > 0 && exDate && exDate >= asOf && exDate <= s.expiry && div > 0 && (s.extrinsic == null || s.extrinsic < div)) {
        add("early_assignment_dividend", "warn", `Short ${s.strike} call is in the money with ${s.extrinsic == null ? "unknown" : `$${round(s.extrinsic, 2)}`} time value, less than the $${div} dividend going ex on ${exDate}. Expect assignment the day before; close or roll it if you don't want to deliver ${s.qty * s.mult} shares and owe the dividend.`, RULES.options_exercise.source);
      }
      if (s.intrinsic > 0 && s.dte <= policy.assignment_dte && (s.extrinsic == null || s.extrinsic <= policy.low_extrinsic)) {
        const outcome = s.type === "put" ? `buy ${s.qty * s.mult} shares for $${round(exercise, 2)}` : `deliver ${s.qty * s.mult} shares`;
        const covered = s.type === "put" ? exercise <= capacity : (Number(account.shares_held) || 0) >= s.qty * s.mult;
        add("assignment_risk", covered ? "warn" : "fail", `Short ${s.strike} ${s.type} is in the money ${s.dte} day(s) from expiry with little time value; assignment is likely and would ${outcome}${covered ? "." : ", which the account can't cover."}`, RULES.options_exercise.source);
      }
      if (tradingDaysUntil(asOf, s.expiry) <= 1 && Math.abs(S - s.strike) / S <= policy.pin_band_pct) {
        add("pin_risk", "warn", `Short ${s.strike} ${s.type} expires ${s.expiry} with the stock within ${policy.pin_band_pct * 100}% of the strike. Whether you're assigned won't be known until after the close; close it to avoid an unplanned position over the weekend or overnight.`, RULES.options_exercise.source);
      }
    }
    for (const l of legs.filter((x) => x.side === "long" && x.dte <= 1 && x.intrinsic >= RULES.options_exercise.auto_exercise_itm)) {
      const notional = l.strike * l.mult * l.qty;
      if (l.type === "call") {
        const ok = notional <= capacity;
        add("auto_exercise", ok ? "warn" : "fail", `Long ${l.strike} call is in the money at expiry and will be auto-exercised: buying ${l.qty * l.mult} shares for $${round(notional, 2)}${ok ? "." : ", more than the account can pay for. Sell it or send do-not-exercise instructions."}`, RULES.options_exercise.source);
      } else {
        const held = Number(account.shares_held) || 0;
        add("auto_exercise", "warn", `Long ${l.strike} put is in the money at expiry and will be auto-exercised: selling ${l.qty * l.mult} shares${held >= l.qty * l.mult ? " you hold" : ", which opens a short position for the shares you don't hold"}.`, RULES.options_exercise.source);
      }
    }

    // Net Greeks, when given
    const greek = (g) => {
      if (!legs.every((l) => typeof l.greeks[g] === "number")) return null;
      return round(legs.reduce((a, l) => a + (l.side === "long" ? 1 : -1) * l.greeks[g] * l.mult * l.qty, 0), 4);
    };
    const greeks = { delta_shares: greek("delta"), gamma: greek("gamma"), theta_per_day: greek("theta"), vega: greek("vega") };
    if (greeks.delta_shares != null) {
      greeks.delta_dollars = round(greeks.delta_shares * S, 2);
      if (Math.abs(greeks.delta_dollars) > policy.max_delta_dollars_pct_of_equity * equity) add("delta_exposure", "warn", `Net delta is equivalent to $${greeks.delta_dollars} of stock, ${round((Math.abs(greeks.delta_dollars) / equity) * 100, 1)}% of equity.`);
      else add("delta_exposure", "pass", `Net delta $${greeks.delta_dollars} of stock equivalent.`);
    } else {
      notes.push("Send delta, gamma, theta and vega on every leg to get net Greeks.");
    }

    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    const decision = fails ? "reject" : warns ? "approve_with_warnings" : "approve";
    return {
      decision,
      summary: `${decision.toUpperCase()}: ${fails} failed, ${warns} warning(s), ${checks.length - fails - warns} passed.`,
      margin_requirement_usd: round(requirement, 2),
      max_loss_usd: unlimited ? "unlimited" : round(maxLoss, 2),
      required_options_level: requiredLevel,
      structures: structures.map((s) => ({
        kind: s.kind,
        quantity: s.qty,
        legs: [s.short?.label, s.long?.label].filter(Boolean),
        requirement_usd: round(s.requirement, 2),
        ...(s.max_loss !== undefined ? { max_loss_usd: s.max_loss == null ? null : round(s.max_loss, 2) } : {}),
      })),
      greeks,
      checks,
      notes,
      rules_version: RULES_VERSION,
      disclaimer: DISCLAIMER,
    };
  },
};
