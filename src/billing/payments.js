// Billing: free tier, prepaid credits on API keys, and pay-per-call with x402
// (HTTP 402 + USDC). See https://x402.org for the protocol.
import { createHash, randomBytes } from "node:crypto";

const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const CREDIT_PACKS = {
  5: { price_usd: 5, credits_usd: 5 },
  20: { price_usd: 20, credits_usd: 22 },
  100: { price_usd: 100, credits_usd: 120 },
};

export function billingConfig(env = {}) {
  const network = env.X402_NETWORK || "base-sepolia";
  return {
    payTo: env.PAY_TO || null,
    network,
    asset: env.X402_ASSET || USDC[network],
    facilitatorUrl: env.FACILITATOR_URL || "https://x402.org/facilitator",
    facilitatorAuth: env.FACILITATOR_AUTH || null,
    freeDailyPerKey: Number(env.FREE_DAILY_CALLS || 25),
    freeDailyAnon: Number(env.FREE_DAILY_ANON || 5),
    maxKeysPerIpPerDay: Number(env.MAX_KEYS_PER_IP || 3),
  };
}

const hashKey = (k) => createHash("sha256").update(k).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
export const atomic = (usd) => String(Math.round(usd * 1e6));

export function paymentRequirements(cfg, { usd, resource, description }) {
  return {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: atomic(usd),
    resource,
    description,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: 120,
    asset: cfg.asset,
    extra: { name: cfg.network === "base" ? "USD Coin" : "USDC", version: "2" },
  };
}

export function decodePaymentHeader(h) {
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function facilitator(cfg, op, body, fetchImpl) {
  const res = await fetchImpl(`${cfg.facilitatorUrl}/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.facilitatorAuth ? { authorization: cfg.facilitatorAuth } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error || json.errorReason || json.invalidReason || `facilitator ${op} HTTP ${res.status}`, json };
  return { ok: true, json };
}

export class Billing {
  constructor(store, cfg, fetchImpl = globalThis.fetch) {
    this.store = store;
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  async issueKey(ip, label) {
    const day = today();
    const ipRec = (await this.store.get(`ipkeys:${ip}:${day}`)) || { n: 0 };
    if (ipRec.n >= this.cfg.maxKeysPerIpPerDay) return { error: "Too many keys created from this address today." };
    ipRec.n += 1;
    await this.store.set(`ipkeys:${ip}:${day}`, ipRec);
    const key = `afa_${randomBytes(24).toString("hex")}`;
    const rec = { created: new Date().toISOString(), label: label || null, credits_usd: 0, free_day: day, free_used: 0, calls: 0 };
    await this.store.set(`key:${hashKey(key)}`, rec);
    return { api_key: key, credits_usd: 0, free_calls_per_day: this.cfg.freeDailyPerKey };
  }

  async keyInfo(key) {
    const rec = await this.store.get(`key:${hashKey(key)}`);
    if (!rec) return null;
    const freeLeft = rec.free_day === today() ? Math.max(0, this.cfg.freeDailyPerKey - rec.free_used) : this.cfg.freeDailyPerKey;
    return { credits_usd: rec.credits_usd, free_calls_left_today: freeLeft, calls: rec.calls, created: rec.created };
  }

  async addCredits(key, usd) {
    const id = `key:${hashKey(key)}`;
    const rec = await this.store.get(id);
    if (!rec) return null;
    rec.credits_usd = Math.round((rec.credits_usd + usd) * 1e6) / 1e6;
    await this.store.set(id, rec);
    return rec.credits_usd;
  }

  // Decide whether a call may run. Returns {allowed, mode, charge, finalize()} or {allowed:false, status, body}.
  async authorize({ usd, apiKey, paymentHeader, ip, resource, description }) {
    if (!usd) return { allowed: true, mode: "free_tool", finalize: async () => ({}) };

    if (paymentHeader) return this.authorizeX402({ usd, paymentHeader, resource, description });

    if (apiKey) {
      const id = `key:${hashKey(apiKey)}`;
      const rec = await this.store.get(id);
      if (!rec) return { allowed: false, status: 401, body: { error: "Unknown API key." } };
      const day = today();
      if (rec.free_day !== day) { rec.free_day = day; rec.free_used = 0; }
      if (rec.free_used < this.cfg.freeDailyPerKey) {
        rec.free_used += 1; rec.calls += 1;
        await this.store.set(id, rec);
        return { allowed: true, mode: "free_tier", finalize: async () => ({}) };
      }
      if (rec.credits_usd + 1e-9 >= usd) {
        rec.credits_usd = Math.round((rec.credits_usd - usd) * 1e6) / 1e6; rec.calls += 1;
        await this.store.set(id, rec);
        return { allowed: true, mode: "credits", finalize: async () => { await this.record({ mode: "credits_used", usd, key: id.slice(4, 16) }); return { credits_left_usd: rec.credits_usd }; } };
      }
      return this.paymentRequired(usd, resource, description, "Free calls for today are used and credits are insufficient.");
    }

    const day = today();
    const anonId = `anon:${ip}:${day}`;
    const anon = (await this.store.get(anonId)) || { n: 0 };
    if (anon.n < this.cfg.freeDailyAnon) {
      anon.n += 1;
      await this.store.set(anonId, anon);
      return { allowed: true, mode: "anonymous_trial", finalize: async () => ({ hint: "Get a free API key (POST /v1/keys) for more free calls per day." }) };
    }
    return this.paymentRequired(usd, resource, description, "Anonymous trial calls are used for today.");
  }

  paymentRequired(usd, resource, description, reason) {
    const body = {
      x402Version: 1,
      error: reason,
      accepts: this.cfg.payTo ? [paymentRequirements(this.cfg, { usd, resource, description })] : [],
      how_to_pay: [
        "Pay per call: resend the request with an X-PAYMENT header (x402, USDC).",
        "Or get a free API key: POST /v1/keys, then buy credits: POST /v1/credits?pack=5|20|100 with that key and an X-PAYMENT header.",
      ],
      price_usd: usd,
    };
    return { allowed: false, status: 402, body };
  }

  async authorizeX402({ usd, paymentHeader, resource, description }) {
    if (!this.cfg.payTo) return { allowed: false, status: 503, body: { error: "Payments are not enabled on this server yet." } };
    const payload = decodePaymentHeader(paymentHeader);
    if (!payload) return { allowed: false, status: 400, body: { error: "X-PAYMENT header is not valid base64 JSON." } };
    const reqs = paymentRequirements(this.cfg, { usd, resource, description });
    const body = { x402Version: payload.x402Version || 1, paymentPayload: payload, paymentRequirements: reqs };
    const v = await facilitator(this.cfg, "verify", body, this.fetch);
    if (!v.ok || !v.json.isValid) {
      return { allowed: false, status: 402, body: { ...this.paymentRequired(usd, resource, description, `Payment rejected: ${v.json?.invalidReason || v.error}`).body } };
    }
    return {
      allowed: true,
      mode: "x402",
      payer: v.json.payer,
      finalize: async () => {
        const s = await facilitator(this.cfg, "settle", body, this.fetch);
        const ok = s.ok && s.json.success;
        await this.record({ mode: ok ? "x402" : "x402_settle_failed", usd: ok ? usd : 0, payer: v.json.payer, tx: s.json?.transaction, network: this.cfg.network, resource });
        return { paymentResponse: Buffer.from(JSON.stringify(s.json || {})).toString("base64"), settled: ok };
      },
    };
  }

  async record(entry) {
    await this.store.append("ledger", { ts: new Date().toISOString(), ...entry });
  }

  async revenue() {
    const rows = await this.store.list("ledger");
    const cash = rows.filter((r) => r.mode === "x402" || r.mode === "credit_purchase");
    const byDay = {};
    cash.forEach((r) => { const d = r.ts.slice(0, 10); byDay[d] = Math.round(((byDay[d] || 0) + r.usd) * 1e6) / 1e6; });
    return {
      cash_received_usd: Math.round(cash.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6,
      credits_consumed_usd: Math.round(rows.filter((r) => r.mode === "credits_used").reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6,
      paid_calls: rows.filter((r) => r.mode === "x402").length,
      by_day: byDay,
      last: rows.slice(-20),
    };
  }
}
