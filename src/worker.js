// Cloudflare Workers entry point (free tier: 100k requests/day).
// Needs a KV namespace bound as AFA_KV and the nodejs_compat flag (see wrangler.toml).
import { handle } from "./app.js";
import { Billing, billingConfig } from "./billing/payments.js";

class KvStore {
  constructor(kv) { this.kv = kv; }
  async get(k) { return this.kv.get(k, "json"); }
  async set(k, v) {
    // Daily counters expire on their own; keys and balances persist.
    const ttl = /^(anon|ipkeys):/.test(k) ? { expirationTtl: 60 * 60 * 48 } : {};
    await this.kv.put(k, JSON.stringify(v), ttl);
  }
  async append(log, entry) {
    await this.kv.put(`log:${log}:${entry.ts || new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(entry));
  }
  async list(log) {
    const out = [];
    let cursor;
    do {
      const page = await this.kv.list({ prefix: `log:${log}:`, cursor });
      for (const k of page.keys) out.push(await this.kv.get(k.name, "json"));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return out;
  }
}

export default {
  async fetch(request, env) {
    const store = new KvStore(env.AFA_KV);
    return handle(request, { store, billing: new Billing(store, billingConfig(env)), publicUrl: env.PUBLIC_URL || null, adminToken: env.ADMIN_TOKEN || null });
  },
};
