// Regulatory rule table. Every value carries its source so agents (and we) can
// check it. Reviewed weekly by the ops routine; bump RULES_VERSION on any change.

export const RULES_VERSION = "2026-10-11";

export const RULES = {
  intraday_margin: {
    title: "FINRA intraday margin standard (replaced the Pattern Day Trader rule)",
    summary:
      "The PDT designation (4+ day trades in 5 business days) and the $25,000 minimum equity for day trading were removed. " +
      "Margin accounts now accrue an intraday margin deficit after IML-reducing transactions (purchases, short sales). " +
      "Deficits should be met promptly; a practice of leaving one unmet past the 5th business day triggers a 90-day restriction " +
      "on creating or increasing short positions or debit balances. Deficits below the lesser of 5% of equity or $1,000 do not count toward that practice.",
    effective_date: "2026-06-04",
    phase_in_until: "2027-10-20",
    deficit_deadline_business_days: 15,
    restriction_trigger_business_days: 5,
    restriction_days: 90,
    de_minimis: { pct_of_equity: 0.05, dollars: 1000 },
    source: "FINRA Regulatory Notice 26-10 (amendments to Rule 4210), https://www.finra.org/rules-guidance/notices/26-10",
  },
  legacy_pdt: {
    title: "Legacy Pattern Day Trader rule (only at brokers still in the phase-in period)",
    summary:
      "Four or more day trades within five business days (and over 6% of trades) in a margin account designates a pattern day trader, " +
      "who must keep $25,000 minimum equity. Brokers may keep this until they adopt the intraday standard, no later than 2027-10-20.",
    min_equity: 25000,
    day_trade_threshold: 4,
    window_business_days: 5,
    sunset_no_later_than: "2027-10-20",
    source: "Former FINRA Rule 4210(f)(8)(B); phase-out per Regulatory Notice 26-10",
  },
  reg_t: {
    title: "Regulation T initial margin and FINRA maintenance margin",
    initial_margin: 0.5,
    maintenance_long: 0.25,
    maintenance_short: 0.3,
    source: "12 CFR 220.12; FINRA Rule 4210(c)",
  },
  settlement: {
    title: "Standard settlement cycle",
    cycle: "T+1",
    effective_date: "2024-05-28",
    source: "SEC Rule 15c6-1 as amended",
  },
  cash_account: {
    title: "Cash account good-faith and free-riding violations",
    summary:
      "Buying with unsettled proceeds and selling before those proceeds settle is a good-faith violation. " +
      "Paying for a purchase with the proceeds of selling that same security is free-riding and freezes the account for 90 days under Reg T.",
    freeze_days: 90,
    source: "12 CFR 220.8",
  },
  short_sale: {
    title: "Regulation SHO",
    summary:
      "A short sale needs a locate (Rule 203). If a stock falls 10% or more from the prior close, Rule 201 restricts short sales " +
      "to prices above the national best bid for the rest of that day and the next.",
    circuit_breaker_drop: 0.1,
    source: "17 CFR 242.201, 242.203",
  },
  wash_sale: {
    title: "Wash sale rule",
    summary:
      "A loss on a sale is disallowed if substantially identical securities are bought within 30 days before or after the sale. " +
      "The disallowed loss is added to the basis of the replacement shares.",
    window_days: 30,
    source: "26 U.S.C. 1091",
  },
  holding_period: {
    title: "Long-term capital gain holding period",
    summary: "Gains on assets held more than one year are long-term.",
    long_term_after_days: 365,
    source: "26 U.S.C. 1222",
  },
  reg_bi: {
    title: "Regulation Best Interest and the adviser fiduciary duty",
    summary:
      "Recommendations to retail customers must be in their best interest given their investment profile (age, objectives, " +
      "horizon, risk tolerance, liquidity needs, experience, finances). Advisers owe a fiduciary duty of care and loyalty.",
    source: "17 CFR 240.15l-1; SEC Interpretation IA-5248 (2019)",
  },
};

// Which day-trading regime applies on a date when the agent hasn't told us.
export function defaultDayTradeRegime(isoDate) {
  return isoDate >= RULES.intraday_margin.effective_date ? "intraday_margin" : "legacy_pdt";
}
