// Billing: free tier, prepaid credits on API keys, and pay-per-call with x402
// (HTTP 402 + USDC). See https://x402.org for the protocol.
// Speaks x402 v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers,
// CAIP-2 network ids) and still accepts v1 X-PAYMENT clients.
import { createHash, randomBytes } from "node:crypto";
import { cdpJwt, parseCdpKey } from "./cdpAuth.js";

const NETWORKS = {
  base: { caip2: "eip155:8453", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenName: "USD Coin" },
  "base-sepolia": { caip2: "eip155:84532", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenName: "USDC" },
};
const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";

export const CREDIT_PACKS = {
  5: { price_usd: 5, credits_usd: 5 },
  20: { price_usd: 20, credits_usd: 22 },
  100: { price_usd: 100, credits_usd: 120 },
};

export function billingConfig(env = {}) {
  const network = env.X402_NETWORK || "base-sepolia";
  const cdpKey = parseCdpKey({ json: env.CDP_API_KEY_JSON, id: env.CDP_API_KEY_ID, secret: env.CDP_API_KEY_SECRET });
  return {
    payTo: env.PAY_TO || null,
    network,
    caip2: NETWORKS[network]?.caip2 || network,
    asset: env.X402_ASSET || NETWORKS[network]?.usdc,
    tokenName: NETWORKS[network]?.tokenName || "USDC",
    facilitatorUrl: env.FACILITATOR_URL || (cdpKey ? CDP_FACILITATOR : "https://x402.org/facilitator"),
    facilitatorAuth: env.FACILITATOR_AUTH || null,
    cdpKey,
    // Floor on pay-per-call x402 prices so per-settlement fees can't eat a sub-cent call.
    // API-key credits are charged the plain list price.
    minX402Usd: Number(env.X402_MIN_USD ?? 0.01),
    freeDailyPerKey: Number(env.FREE_DAILY_CALLS || 25),
    freeDailyAnon: Number(env.FREE_DAILY_ANON || 5),
    maxKeysPerIpPerDay: Number(env.MAX_KEYS_PER_IP || 3),
  };
}

export const hashKey = (k) => createHash("sha256").update(k).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
export const atomic = (usd) => String(Math.round(usd * 1e6));

export const x402Price = (cfg, usd) => Math.max(usd, cfg.minX402Usd || 0);

// v1 requirements (legacy network names, maxAmountRequired).
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
    extra: { name: cfg.tokenName, version: "2" },
  };
}

// v2 requirements (CAIP-2 network, amount).
export function paymentRequirementsV2(cfg, { usd }) {
  return {
    scheme: "exact",
    network: cfg.caip2,
    amount: atomic(usd),
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 120,
    extra: { name: cfg.tokenName, version: "2" },
  };
}

const b64json = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// x402 `bazaar` extension: how to call a JSON POST endpoint, for discovery catalogs.
export function bazaarHttpPost({ inputSchema, example, outputExample }) {
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: example },
      output: { type: "json", ...(outputExample ? { example: outputExample } : {}) },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json"] },
            body: inputSchema,
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
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
  const url = `${cfg.facilitatorUrl}/${op}`;
  const auth = cfg.cdpKey ? `Bearer ${await cdpJwt(cfg.cdpKey, "POST", url)}` : cfg.facilitatorAuth;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
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

  x402Price(usd) {
    return x402Price(this.cfg, usd);
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
    await this.store.append("keys", { ts: rec.created });
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
  // `paidOnly` tools skip the anonymous trial and the free daily calls on a key.
  async authorize({ usd, apiKey, paymentHeader, ip, resource, description, discovery = null, paidOnly = false }) {
    if (!usd) return { allowed: true, mode: "free_tool", finalize: async () => ({}) };

    if (paymentHeader) return this.authorizeX402({ usd: x402Price(this.cfg, usd), paymentHeader, resource, description, listUsd: usd, discovery });

    if (apiKey) {
      const id = `key:${hashKey(apiKey)}`;
      const rec = await this.store.get(id);
      if (!rec) return { allowed: false, status: 401, body: { error: "Unknown API key." } };
      const day = today();
      if (rec.free_day !== day) { rec.free_day = day; rec.free_used = 0; }
      if (!paidOnly && rec.free_used < this.cfg.freeDailyPerKey) {
        rec.free_used += 1; rec.calls += 1;
        await this.store.set(id, rec);
        return { allowed: true, mode: "free_tier", finalize: async () => ({}) };
      }
      if (rec.credits_usd + 1e-9 >= usd) {
        rec.credits_usd = Math.round((rec.credits_usd - usd) * 1e6) / 1e6; rec.calls += 1;
        await this.store.set(id, rec);
        return { allowed: true, mode: "credits", finalize: async () => { await this.record({ mode: "credits_used", usd, key: id.slice(4, 16) }); return { credits_left_usd: rec.credits_usd }; } };
      }
      return this.paymentRequiredForCall(usd, resource, description, paidOnly ? "This tool is paid only and the key's credits are insufficient." : "Free calls for today are used and credits are insufficient.", discovery);
    }

    if (paidOnly) return this.paymentRequiredForCall(usd, resource, description, "This tool is paid only: pay per call with x402, or use an API key with prepaid credits.", discovery);
    const day = today();
    const anonId = `anon:${ip}:${day}`;
    const anon = (await this.store.get(anonId)) || { n: 0 };
    if (anon.n < this.cfg.freeDailyAnon) {
      anon.n += 1;
      await this.store.set(anonId, anon);
      return { allowed: true, mode: "anonymous_trial", finalize: async () => ({ hint: `Anonymous trial call ${anon.n} of ${this.cfg.freeDailyAnon} today. For 25 free calls a day, get a free API key: call the get_api_key tool over MCP, or POST /v1/keys.` }) };
    }
    return this.paymentRequiredForCall(usd, resource, description, "Anonymous trial calls are used for today.", discovery);
  }

  // 402 response: x402 v2 in the PAYMENT-REQUIRED header, v1 in the body for older clients.
  // `usd` is the amount to collect over x402 (already floored for per-call prices).
  paymentRequired(usd, resource, description, reason, listUsd = usd, discovery = null) {
    const payable = Boolean(this.cfg.payTo);
    const body = {
      x402Version: 1,
      error: reason,
      accepts: payable ? [paymentRequirements(this.cfg, { usd, resource, description })] : [],
      how_to_pay: [
        "Pay per call: resend the request with a PAYMENT-SIGNATURE header (x402 v2) or X-PAYMENT header (x402 v1), USDC on Base.",
        "Or get a free API key (25 free calls a day): POST /v1/keys, or call the get_api_key tool over MCP. Then buy credits if you need more: POST /v1/credits?pack=5|20|100 with that key and an x402 payment. Credits are charged the list price.",
      ],
      price_usd: usd,
      ...(listUsd !== usd ? { list_price_usd: listUsd, note: `Pay-per-call x402 minimum is $${this.cfg.minX402Usd}; prepaid credits pay the list price.` } : {}),
    };
    const v2 = {
      x402Version: 2,
      error: reason,
      resource: { url: resource, description, mimeType: "application/json" },
      accepts: payable ? [paymentRequirementsV2(this.cfg, { usd })] : [],
      ...(discovery ? { extensions: { bazaar: discovery } } : {}),
    };
    return { allowed: false, status: 402, body, headers: { "payment-required": b64json(v2) } };
  }

  // Per-call price over x402, with the floor applied.
  paymentRequiredForCall(usd, resource, description, reason, discovery) {
    return this.paymentRequired(x402Price(this.cfg, usd), resource, description, reason, usd, discovery);
  }

  async authorizeX402({ usd, paymentHeader, resource, description, listUsd = usd, discovery = null }) {
    if (!this.cfg.payTo) return { allowed: false, status: 503, body: { error: "Payments are not enabled on this server yet." } };
    const payload = decodePaymentHeader(paymentHeader);
    if (!payload) return { allowed: false, status: 400, body: { error: "Payment header is not valid base64 JSON." } };
    const v2 = payload.x402Version === 2;
    // The Bazaar catalogs a resource from the settled payload, so make sure it carries
    // the resource and discovery info even if the client didn't echo them.
    if (v2) {
      payload.resource ||= { url: resource, description, mimeType: "application/json" };
      if (discovery) payload.extensions = { bazaar: discovery, ...(payload.extensions || {}) };
    }
    const reqs = v2 ? paymentRequirementsV2(this.cfg, { usd }) : paymentRequirements(this.cfg, { usd, resource, description });
    const body = { x402Version: v2 ? 2 : 1, paymentPayload: payload, paymentRequirements: reqs };
    const v = await facilitator(this.cfg, "verify", body, this.fetch);
    if (!v.ok || !v.json.isValid) {
      const reject = this.paymentRequired(usd, resource, description, `Payment rejected: ${v.json?.invalidReason || v.error}`, listUsd, discovery);
      return { allowed: false, status: 402, body: reject.body, headers: reject.headers };
    }
    return {
      allowed: true,
      mode: "x402",
      payer: v.json.payer,
      finalize: async () => {
        const s = await facilitator(this.cfg, "settle", body, this.fetch);
        const ok = s.ok && s.json.success;
        await this.record({ mode: ok ? "x402" : "x402_settle_failed", usd: ok ? usd : 0, payer: v.json.payer, tx: s.json?.transaction, network: this.cfg.network, x402Version: body.x402Version, resource, ...(ok ? {} : { error: s.json?.errorReason || s.error }) });
        return { paymentResponse: b64json(s.json || {}), paymentResponseHeader: v2 ? "payment-response" : "x-payment-response", settled: ok };
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
