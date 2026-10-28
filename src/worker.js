// Cloudflare Workers entry point (free tier: 100k requests/day).
// Needs a KV namespace bound as AFA_KV and the nodejs_compat flag (see wrangler.toml).
import { handle } from "./app.js";
import { Billing, billingConfig } from "./billing/payments.js";
import { ClaudeMemoWriter, anthropicKey } from "./advisor/claudeMemo.js";

class KvStore {
  constructor(kv) { this.kv = kv; }
  async get(k) { return this.kv.get(k, "json"); }
  async set(k, v) {
    // Daily counters expire on their own; keys and balances persist.
    const ttl = /^(anon|ipkeys|mcpsess):/.test(k) ? { expirationTtl: 60 * 60 * 48 } : {};
    await this.kv.put(k, JSON.stringify(v), ttl);
  }
  async append(log, entry) {
    // Small rows also ride along as key metadata, so list() needs no per-row reads.
    const value = JSON.stringify(entry);
    const opts = value.length <= 1000 ? { metadata: entry } : {};
    await this.kv.put(`log:${log}:${entry.ts || new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`, value, opts);
  }
  async list(log) {
    const out = [];
    let cursor;
    do {
      const page = await this.kv.list({ prefix: `log:${log}:`, cursor });
      for (const k of page.keys) out.push(k.metadata || (await this.kv.get(k.name, "json")));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return out;
  }
}

// One store per isolate, so per-store caches (like /stats) survive across requests.
let store = null;

export default {
  async fetch(request, env) {
    if (!store || store.kv !== env.AFA_KV) store = new KvStore(env.AFA_KV);
    // advisor_memo stays paused until the ANTHROPIC_API_KEY secret is set.
    const memoWriter = anthropicKey(env) ? new ClaudeMemoWriter({ apiKey: anthropicKey(env), store, dailyCapUsd: Number(env.MEMO_DAILY_CAP_USD || 3) }) : null;
    return handle(request, { store, billing: new Billing(store, billingConfig(env)), memoWriter, publicUrl: env.PUBLIC_URL || null, adminToken: env.ADMIN_TOKEN || null, auditSecret: env.AUDIT_SECRET || null });
  },
};
