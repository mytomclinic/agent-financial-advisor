export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export function need(obj, path) {
  const v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (v === undefined || v === null || v === "") throw new ValidationError(`Missing required field: ${path}`);
  return v;
}

export function num(v, name, { min = -Infinity, positive = false } = {}) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${name} must be a number`);
  if (positive && n <= 0) throw new ValidationError(`${name} must be greater than 0`);
  if (n < min) throw new ValidationError(`${name} must be at least ${min}`);
  return n;
}

export function arr(v, name, { minLength = 0 } = {}) {
  if (!Array.isArray(v)) throw new ValidationError(`${name} must be an array`);
  if (v.length < minLength) throw new ValidationError(`${name} needs at least ${minLength} item(s)`);
  return v;
}

export function oneOf(v, name, options) {
  if (!options.includes(v)) throw new ValidationError(`${name} must be one of: ${options.join(", ")}`);
  return v;
}

// Account types agents send in practice, mapped to the two the rules distinguish. Retirement accounts
// trade under cash-account rules. A missing type is assumed to be cash, the stricter case, and the
// caller is told so.
const ACCOUNT_TYPES = {
  cash: "cash", cash_account: "cash", ira: "cash", roth: "cash", roth_ira: "cash", traditional_ira: "cash", retirement: "cash", "401k": "cash",
  margin: "margin", margin_account: "margin", reg_t: "margin", regt: "margin", portfolio_margin: "margin",
};
export const ASSUMED_CASH_NOTE = "account.type was not given, so a cash account was assumed (the stricter case). Send account.type = \"margin\" for a margin account.";

export function accountType(account) {
  const raw = account?.type ?? account?.account_type;
  if (raw === undefined || raw === null || raw === "") return { type: "cash", assumed: true };
  const type = ACCOUNT_TYPES[String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_")];
  if (!type) throw new ValidationError("account.type must be one of: cash, margin");
  return { type, assumed: false };
}

export const DISCLAIMER =
  "Automated rule-based analysis for software agents. Not personalized investment, tax or legal advice; " +
  "verify broker-specific rules and consult a licensed professional for decisions affecting real people.";
