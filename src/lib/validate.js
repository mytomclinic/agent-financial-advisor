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

export const DISCLAIMER =
  "Automated rule-based analysis for software agents. Not personalized investment, tax or legal advice; " +
  "verify broker-specific rules and consult a licensed professional for decisions affecting real people.";
