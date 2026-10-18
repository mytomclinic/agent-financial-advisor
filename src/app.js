// Web-standard request handler (Request -> Response). Runs on Node 18+ via
// server.js and on any fetch-style host (Cloudflare Workers, Deno, Bun).
import { TOOLS, TOOL_MAP } from "./tools/index.js";
import { ValidationError } from "./lib/validate.js";
import { RULES_VERSION } from "./lib/regs.js";
import { CREDIT_PACKS, bazaarHttpPost } from "./billing/payments.js";
import { EXAMPLES } from "./tools/examples.js";

export const SERVICE = {
  name: "Agent Financial Advisor",
  version: "0.1.0",
  tagline: "The compliance officer, risk manager, tax advisor and performance auditor for AI agents that trade and advise.",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "payment-required, payment-response, x-payment-response", ...headers } });

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : req.headers.get("x-api-key");
}

// x402 v2 clients send PAYMENT-SIGNATURE; v1 clients send X-PAYMENT.
const paymentHeader = (req) => req.headers.get("payment-signature") || req.headers.get("x-payment");

const clientIp = (req) => req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";

function toolCard(t, base) {
  return { name: t.name, title: t.title, description: t.description, price_usd: t.price_usd, endpoint: `${base}/v1/tools/${t.name}`, input_schema: t.inputSchema };
}

function overview(base) {
  const lines = [
    `# ${SERVICE.name}`,
    "",
    `> ${SERVICE.tagline}`,
    "",
    "Call these before you act. Rule-based, deterministic, sourced to the regulation, and current (rules version " + RULES_VERSION + ").",
    "",
    "## Tools",
    ...TOOLS.map((t) => `- **${t.name}** (${t.price_usd ? `$${t.price_usd}/call` : "free"}): ${t.description}`),
    "",
    "## Use",
    `- REST: POST ${base}/v1/tools/{name} with a JSON body. Schemas: GET ${base}/v1/tools, OpenAPI: ${base}/openapi.json`,
    `- MCP (streamable HTTP): ${base}/mcp`,
    "- Free trial: a few calls a day without a key. Free API key (POST /v1/keys) adds 25 free calls a day.",
    "- Pay per call with x402 (USDC on Base; minimum $0.01 per call), or prepay credits at list price: POST /v1/credits?pack=5|20|100 (packs of $20 and $100 include 10% and 20% bonus credit).",
    "",
    "Outputs are automated analysis for software agents, not personalized investment, tax or legal advice.",
  ];
  return lines.join("\n");
}

function openapi(base) {
  const paths = {};
  for (const t of TOOLS) {
    paths[`/v1/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.title,
        description: `${t.description}\n\nPrice: ${t.price_usd ? `$${t.price_usd} per call` : "free"}.`,
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema } } },
        responses: { 200: { description: "Analysis result" }, 400: { description: "Invalid input" }, 402: { description: "Payment required (x402)" } },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: SERVICE.name, version: SERVICE.version, description: SERVICE.tagline }, servers: [{ url: base }], paths, components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } } };
}

// Discovery info for the x402 Bazaar: the input schema, an example body, and the
// example's top-level output fields (computed once per tool; handlers are pure).
const discoveryCache = {};
async function discoveryFor(tool) {
  if (!EXAMPLES[tool.name]) return null;
  if (!discoveryCache[tool.name]) {
    let outputExample;
    try {
      const out = await tool.handler(structuredClone(EXAMPLES[tool.name]));
      outputExample = Object.fromEntries(Object.entries(out).filter(([, v]) => v === null || typeof v !== "object").slice(0, 12));
    } catch {
      outputExample = undefined;
    }
    discoveryCache[tool.name] = bazaarHttpPost({ inputSchema: tool.inputSchema, example: EXAMPLES[tool.name], outputExample });
  }
  return discoveryCache[tool.name];
}

async function runTool(tool, args, ctx, req, base, via) {
  // Compute first (cheap, pure): bad input returns 400 without touching quota, credits or payment.
  let result;
  try {
    result = await tool.handler(args || {});
  } catch (e) {
    return { status: 400, body: { error: e.message, type: e instanceof ValidationError ? "validation" : "input" } };
  }
  const auth = await ctx.billing.authorize({
    usd: tool.price_usd,
    apiKey: bearer(req),
    paymentHeader: paymentHeader(req),
    ip: clientIp(req),
    resource: `${base}/v1/tools/${tool.name}`,
    description: tool.description,
    discovery: tool.price_usd ? await discoveryFor(tool) : null,
  });
  if (!auth.allowed) return { status: auth.status, body: auth.body, headers: auth.headers };
  const fin = await auth.finalize();
  const headers = fin.paymentResponse ? { [fin.paymentResponseHeader]: fin.paymentResponse } : {};
  const charged = auth.mode === "x402" ? ctx.billing.x402Price(tool.price_usd) : tool.price_usd;
  const billing = { mode: auth.mode, price_usd: charged, ...(fin.credits_left_usd != null ? { credits_left_usd: fin.credits_left_usd } : {}), ...(fin.hint ? { hint: fin.hint } : {}) };
  await ctx.store.append("usage", { ts: new Date().toISOString(), tool: tool.name, mode: auth.mode, via });
  return { status: 200, body: { ...result, _billing: billing }, headers };
}

// Public aggregate usage: counts only, no keys, IPs or payers. Cached per isolate
// so a busy /stats can't run up KV list operations.
const STATS_TTL_MS = 10 * 60 * 1000;
const statsCache = new WeakMap(); // keyed by store
async function publicStats(ctx) {
  const hit = statsCache.get(ctx.store);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.body;
  const [usage, ledger, keys] = await Promise.all([ctx.store.list("usage"), ctx.store.list("ledger"), ctx.store.list("keys")]);
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const tally = (rows, field) => rows.reduce((o, r) => ((o[r[field] || "unknown"] = (o[r[field] || "unknown"] || 0) + 1), o), {});
  const window = (rows) => ({ total: rows.length, last_7d: rows.filter((r) => r.ts >= since(7)).length, last_24h: rows.filter((r) => r.ts >= since(1)).length });
  const paid = ledger.filter((r) => r.mode === "x402");
  const cash = ledger.filter((r) => r.mode === "x402" || r.mode === "credit_purchase");
  const body = {
    as_of: new Date().toISOString(),
    calls: { ...window(usage), by_tool: tally(usage, "tool"), by_mode: tally(usage, "mode"), by_interface: tally(usage, "via") },
    paid_calls: window(paid),
    api_keys_issued: window(keys),
    revenue_usd: Math.round(cash.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6,
    first_call: usage.reduce((m, r) => (!m || r.ts < m ? r.ts : m), null),
  };
  statsCache.set(ctx.store, { at: Date.now(), body });
  return body;
}

async function handleMcp(req, ctx, base) {
  let msg;
  try {
    msg = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(msg) ? msg : [msg];
  const replies = [];
  for (const m of batch) {
    const reply = (result) => replies.push({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code, message) => replies.push({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
    if (m.id === undefined) continue; // notification
    switch (m.method) {
      case "initialize":
        reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-financial-advisor", version: SERVICE.version }, instructions: overview(base) });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: `${t.description} Price: ${t.price_usd ? `$${t.price_usd}` : "free"}.`, inputSchema: t.inputSchema })) });
        break;
      case "tools/call": {
        const tool = TOOL_MAP[m.params?.name];
        if (!tool) { fail(-32602, `Unknown tool: ${m.params?.name}`); break; }
        const out = await runTool(tool, m.params?.arguments, ctx, req, base, "mcp");
        const isError = out.status !== 200;
        reply({ content: [{ type: "text", text: JSON.stringify(out.body, null, 2) }], ...(isError ? { isError: true } : { structuredContent: out.body }) });
        break;
      }
      default:
        fail(-32601, `Method not found: ${m.method}`);
    }
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(msg) ? replies : replies[0]);
}

export async function handle(req, ctx) {
  const url = new URL(req.url);
  const base = ctx.publicUrl || `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-expose-headers": "payment-required, payment-response, x-payment-response" } });

  try {
    if (req.method === "GET" && (path === "/" || path === "/llms.txt")) return new Response(overview(base), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    if (req.method === "GET" && path === "/health") return json({ ok: true, version: SERVICE.version, rules_version: RULES_VERSION, payments_enabled: Boolean(ctx.billing.cfg.payTo), network: ctx.billing.cfg.network, facilitator: new URL(ctx.billing.cfg.facilitatorUrl).host, facilitator_auth: Boolean(ctx.billing.cfg.cdpKey || ctx.billing.cfg.facilitatorAuth) });
    if (req.method === "GET" && path === "/v1/tools") return json({ service: SERVICE, tools: TOOLS.map((t) => toolCard(t, base)) });
    if (req.method === "GET" && path === "/pricing") return json({ currency: "USD", per_call: Object.fromEntries(TOOLS.map((t) => [t.name, t.price_usd])), free_calls_per_day_with_key: ctx.billing.cfg.freeDailyPerKey, anonymous_trial_calls_per_day: ctx.billing.cfg.freeDailyAnon, credit_packs: CREDIT_PACKS, payment: { protocol: "x402", versions: [2, 1], asset: "USDC", network: ctx.billing.cfg.network, caip2: ctx.billing.cfg.caip2, min_per_call_usd: ctx.billing.cfg.minX402Usd } });
    if (req.method === "GET" && path === "/stats") return json(await publicStats(ctx));
    if (req.method === "GET" && path === "/openapi.json") return json(openapi(base));
    if (req.method === "GET" && path === "/.well-known/x402") return json({ x402Version: 2, network: ctx.billing.cfg.caip2, payTo: ctx.billing.cfg.payTo, resources: TOOLS.filter((t) => t.price_usd).map((t) => ({ resource: `${base}/v1/tools/${t.name}`, method: "POST", price_usd: ctx.billing.x402Price(t.price_usd), list_price_usd: t.price_usd, description: t.description })) });

    if (path === "/mcp") {
      if (req.method === "POST") return handleMcp(req, ctx, base);
      return json({ error: "Use POST for MCP JSON-RPC (streamable HTTP, JSON responses)." }, 405);
    }

    if (req.method === "POST" && path === "/v1/keys") {
      const body = await req.json().catch(() => ({}));
      const r = await ctx.billing.issueKey(clientIp(req), body.label);
      return json(r, r.error ? 429 : 201);
    }
    if (req.method === "GET" && path === "/v1/keys/me") {
      const k = bearer(req);
      const info = k && (await ctx.billing.keyInfo(k));
      return info ? json(info) : json({ error: "Send a valid API key as Authorization: Bearer <key>." }, 401);
    }
    if (req.method === "POST" && path === "/v1/credits") {
      const pack = CREDIT_PACKS[url.searchParams.get("pack") || "5"];
      const k = bearer(req);
      if (!pack) return json({ error: "pack must be 5, 20 or 100" }, 400);
      if (!k || !(await ctx.billing.keyInfo(k))) return json({ error: "Credits attach to an API key: send Authorization: Bearer <key> (get one free at POST /v1/keys)." }, 401);
      const resource = `${base}/v1/credits?pack=${pack.price_usd}`;
      const pay = paymentHeader(req);
      if (!pay) {
        const pr = ctx.billing.paymentRequired(pack.price_usd, resource, `${pack.credits_usd} USD of advisory credits`, "Payment required for credit pack.");
        return json(pr.body, 402, pr.headers);
      }
      const auth = await ctx.billing.authorizeX402({ usd: pack.price_usd, paymentHeader: pay, resource, description: `${pack.credits_usd} USD of advisory credits` });
      if (!auth.allowed) return json(auth.body, auth.status, auth.headers || {});
      const fin = await auth.finalize();
      if (!fin.settled) return json({ error: "Payment could not be settled; no charge was made." }, 402);
      const balance = await ctx.billing.addCredits(k, pack.credits_usd);
      return json({ credits_added_usd: pack.credits_usd, credits_usd: balance }, 200, { [fin.paymentResponseHeader]: fin.paymentResponse });
    }

    const m = path.match(/^\/v1\/tools\/([a-z_]+)$/);
    if (m && req.method === "POST") {
      const tool = TOOL_MAP[m[1]];
      if (!tool) return json({ error: `Unknown tool ${m[1]}`, tools: Object.keys(TOOL_MAP) }, 404);
      const args = await req.json().catch(() => null);
      if (args === null) return json({ error: "Body must be JSON." }, 400);
      const out = await runTool(tool, args, ctx, req, base, "rest");
      return json(out.body, out.status, out.headers || {});
    }

    if (req.method === "GET" && path === "/admin/revenue") {
      if (!ctx.adminToken || bearer(req) !== ctx.adminToken) return json({ error: "unauthorized" }, 401);
      const usage = await ctx.store.list("usage");
      const byTool = {};
      usage.forEach((u) => { byTool[u.tool] = (byTool[u.tool] || 0) + 1; });
      return json({ ...(await ctx.billing.revenue()), calls_total: usage.length, calls_by_tool: byTool });
    }

    return json({ error: "Not found", see: `${base}/` }, 404);
  } catch (e) {
    return json({ error: "Internal error", detail: e.message }, 500);
  }
}
