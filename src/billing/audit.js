// Tamper-evident record of every keyed call: each entry hashes the request and
// response, links to the previous entry's hash, and carries a server HMAC, so a
// customer can show later what was checked, when, under which rules version.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Key-order-independent JSON, so the same input always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

const GENESIS = "0".repeat(64);
const FIELDS = ["seq", "ts", "tool", "input_sha256", "output_sha256", "decision", "rules_version", "prev_hash"];

export class AuditLog {
  // `secret` signs entries; without one, entries are hash-chained but unsigned.
  constructor(store, secret) {
    this.store = store;
    this.signKey = secret ? createHmac("sha256", secret).update("afa-audit-v1").digest() : null;
  }

  sign(hash) {
    return this.signKey ? createHmac("sha256", this.signKey).update(hash).digest("hex") : null;
  }

  async append(keyId, { tool, input, output }) {
    const headKey = `audit:${keyId}:head`;
    const head = (await this.store.get(headKey)) || { seq: 0, hash: GENESIS };
    const entry = {
      seq: head.seq + 1,
      ts: new Date().toISOString(),
      tool,
      input_sha256: sha256(canonical(input ?? {})),
      output_sha256: sha256(canonical(output)),
      decision: typeof output?.decision === "string" ? output.decision : null,
      rules_version: output?.rules_version ?? null,
      prev_hash: head.hash,
    };
    entry.hash = sha256(canonical(Object.fromEntries(FIELDS.map((f) => [f, entry[f]]))));
    entry.signature = this.sign(entry.hash);
    await this.store.append(`audit:${keyId}`, entry);
    await this.store.set(headKey, { seq: entry.seq, hash: entry.hash });
    return entry;
  }

  async list(keyId) {
    return (await this.store.list(`audit:${keyId}`)).sort((a, b) => a.seq - b.seq);
  }

  // Checks one entry's hash and signature, and, given the full list, the chain.
  verifyEntry(e) {
    const hashOk = e.hash === sha256(canonical(Object.fromEntries(FIELDS.map((f) => [f, e[f]]))));
    let sigOk = null;
    if (this.signKey && e.signature) {
      const want = Buffer.from(this.sign(e.hash), "hex");
      const got = Buffer.from(String(e.signature), "hex");
      sigOk = want.length === got.length && timingSafeEqual(want, got);
    }
    return { hash_ok: hashOk, signature_ok: sigOk };
  }

  // From genesis by default; pass the first entry's prev_hash to check a slice.
  verifyChain(entries, start = GENESIS) {
    let prev = start;
    for (const e of entries) {
      const { hash_ok, signature_ok } = this.verifyEntry(e);
      if (!hash_ok || signature_ok === false || e.prev_hash !== prev) return { ok: false, broken_at_seq: e.seq };
      prev = e.hash;
    }
    return { ok: true, entries: entries.length, head: prev };
  }
}

export const hashInput = (v) => sha256(canonical(v ?? {}));
