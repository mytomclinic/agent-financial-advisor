// Web-standard request handler (Request -> Response). Runs on Node 18+ via
// server.js and on any fetch-style host (Cloudflare Workers, Deno, Bun).
import { TOOLS, TOOL_MAP } from "./tools/index.js";
import { ValidationError } from "./lib/validate.js";
import { RULES_VERSION } from "./lib/regs.js";
import { CREDIT_PACKS, bazaarHttpPost, hashKey } from "./billing/payments.js";
import { AuditLog } from "./billing/audit.js";
import { EXAMPLES } from "./tools/examples.js";

export const SERVICE = {
  name: "Agent Financial Advisor",
  version: "0.1.0",
  tagline: "The compliance officer, risk manager, tax advisor and performance auditor for AI agents that trade and advise.",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "payment-required, payment-response, x-payment-response, mcp-session-id", ...headers } });

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  // MCP clients that only take a URL can put the key in it: /mcp?key=afa_...
  return req.headers.get("x-api-key") || new URL(req.url).searchParams.get("key");
}

// Where a caller came from, for /stats: ?src=devto on the URL, else the referring host.
function sourceOf(req) {
  const src = new URL(req.url).searchParams.get("src");
  if (src && /^[a-z0-9_.-]{1,32}$/i.test(src)) return src.toLowerCase();
  try { return new URL(req.headers.get("referer")).host || null; } catch { return null; }
}

// x402 v2 clients send PAYMENT-SIGNATURE; v1 clients send X-PAYMENT.
const paymentHeader = (req) => req.headers.get("payment-signature") || req.headers.get("x-payment");

const clientIp = (req) => req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";

// Input schema with a worked example, so an LLM can see a valid request before its first call.
const schemaWithExample = (t) => (EXAMPLES[t.name] ? { ...t.inputSchema, examples: [EXAMPLES[t.name]] } : t.inputSchema);
const priceText = (t) => (t.price_usd ? `$${t.price_usd}${t.paid_only ? ", paid only" : ""}` : "free");

function toolCard(t, base) {
  return { name: t.name, title: t.title, description: t.description, price_usd: t.price_usd, ...(t.paid_only ? { paid_only: true } : {}), endpoint: `${base}/v1/tools/${t.name}`, input_schema: schemaWithExample(t) };
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
    ...TOOLS.map((t) => `- **${t.name}** (${t.price_usd ? `$${t.price_usd}/call${t.paid_only ? ", paid only" : ""}` : "free"}): ${t.description}`),
    "",
    "## Use",
    `- REST: POST ${base}/v1/tools/{name} with a JSON body. Schemas: GET ${base}/v1/tools, OpenAPI: ${base}/openapi.json`,
    `- MCP (streamable HTTP): ${base}/mcp`,
    "- Start here: call pre_trade_check before every order. Each tool's input schema carries a worked example (GET /v1/tools, or tools/list over MCP).",
    "- Free trial: a few calls a day without a key. A free API key adds 25 free calls a day: over MCP, call the get_api_key tool (it attaches to your session); over REST, POST /v1/keys. URL-only MCP clients can use /mcp?key=<key>.",
    "- Pay per call with x402 (USDC on Base; minimum $0.01 per call), or prepay credits at list price: POST /v1/credits?pack=5|20|100 (packs of $20 and $100 include 10% and 20% bonus credit).",
    "- Compliance records: every paid call made with an API key is logged in a hash-chained, signed audit log (GET /v1/audit, POST /v1/audit/verify).",
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
        requestBody: { required: true, content: { "application/json": { schema: t.inputSchema, ...(EXAMPLES[t.name] ? { example: EXAMPLES[t.name] } : {}) } } },
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

const auditLog = (ctx) => ctx.audit || (ctx.audit = new AuditLog(ctx.store, ctx.auditSecret ?? ctx.adminToken));
const auditId = (apiKey) => hashKey(apiKey).slice(0, 32);

async function runTool(tool, args, ctx, req, base, via, apiKey = bearer(req)) {
  // Compute first (cheap, pure): bad input returns 400 without touching quota, credits or payment.
  let result;
  try {
    result = await tool.handler(args || {});
  } catch (e) {
    return { status: 400, body: { error: e.message, type: e instanceof ValidationError ? "validation" : "input" } };
  }
  // Tools that call a paid model (advisor_memo) check availability before charging.
  if (tool.compose && !(ctx.memoWriter && (await ctx.memoWriter.available()))) {
    return { status: 503, body: { error: `${tool.name} is paused right now (not configured, or today's spending cap is reached). You were not charged. The individual tools (pre_trade_check, position_size, tax_lot_plan, options_risk_check, portfolio_review) still work.`, type: "unavailable" } };
  }
  const auth = await ctx.billing.authorize({
    paidOnly: Boolean(tool.paid_only),
    usd: tool.price_usd,
    apiKey,
    paymentHeader: paymentHeader(req),
    ip: clientIp(req),
    resource: `${base}/v1/tools/${tool.name}`,
    description: tool.description,
    discovery: tool.price_usd ? await discoveryFor(tool) : null,
  });
  if (!auth.allowed) return { status: auth.status, body: auth.body, headers: auth.headers };
  if (tool.compose) {
    try {
      result = await tool.compose(result, args, ctx);
    } catch (e) {
      // Nothing is settled yet for x402; give prepaid credits back.
      if (auth.mode === "credits") await ctx.billing.addCredits(apiKey, tool.price_usd);
      return { status: 502, body: { error: `Could not write the memo (${e.message}). You were not charged; try again shortly.`, type: "upstream" } };
    }
  }
  const fin = await auth.finalize();
  const headers = fin.paymentResponse ? { [fin.paymentResponseHeader]: fin.paymentResponse } : {};
  const charged = auth.mode === "x402" ? ctx.billing.x402Price(tool.price_usd) : tool.price_usd;
  // Keyed calls get a tamper-evident audit entry the customer can retrieve and verify later.
  let audit;
  if (apiKey && (auth.mode === "free_tier" || auth.mode === "credits")) {
    const e = await auditLog(ctx).append(auditId(apiKey), { tool: tool.name, input: args, output: result });
    audit = { seq: e.seq, hash: e.hash, input_sha256: e.input_sha256 };
  }
  const billing = { mode: auth.mode, price_usd: charged, ...(fin.credits_left_usd != null ? { credits_left_usd: fin.credits_left_usd } : {}), ...(fin.hint ? { hint: fin.hint } : {}) };
  await ctx.store.append("usage", { ts: new Date().toISOString(), tool: tool.name, mode: auth.mode, via, src: sourceOf(req) });
  return { status: 200, body: { ...result, _billing: billing, ...(audit ? { _audit: audit } : {}) }, headers };
}

// Public aggregate usage: counts only, no keys, IPs or payers. Cached per isolate
// so a busy /stats can't run up KV list operations.
const STATS_TTL_MS = 10 * 60 * 1000;
const statsCache = new WeakMap(); // keyed by store
// Claude spend behind advisor_memo, so the weekly review can see demand against the daily cap.
async function memoStats(writer, usage) {
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const today = await writer.spentToday();
  return {
    paid_calls: usage.filter((u) => u.tool === "advisor_memo" && u.mode !== "anonymous_trial").length,
    model_spend_today_usd: r6(today),
    daily_cap_usd: writer.dailyCapUsd,
    cap_reached_today: today >= writer.dailyCapUsd,
    model_spend_month_usd: r6(await writer.spentThisMonth()),
  };
}

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
    calls: { ...window(usage), by_tool: tally(usage, "tool"), by_mode: tally(usage, "mode"), by_interface: tally(usage, "via"), by_source: tally(usage, "src") },
    paid_calls: window(paid),
    api_keys_issued: window(keys),
    revenue_usd: Math.round(cash.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6,
    ...(ctx.memoWriter ? { advisor_memo: await memoStats(ctx.memoWriter, usage) } : {}),
    first_call: usage.reduce((m, r) => (!m || r.ts < m ? r.ts : m), null),
  };
  statsCache.set(ctx.store, { at: Date.now(), body });
  return body;
}

// Free MCP-only tool: lets an agent get its own key mid-session, with no human signup.
// The key is bound to the MCP session, so later calls in that session use it automatically.
const GET_API_KEY = {
  name: "get_api_key",
  title: "Get a free API key",
  description:
    "Free. Creates an API key for this agent (25 free calls a day, then prepaid credits) and attaches it to this MCP session, " +
    "so the next calls use it automatically. Call this when the anonymous trial runs out. Save the key and add ?key=<key> " +
    "to the MCP URL (or send Authorization: Bearer <key>) to keep using it in later sessions.",
  inputSchema: { type: "object", properties: { label: { type: "string", description: "Optional name for the key, such as your agent's name." } } },
};

const SESSION_TTL_NOTE = "Session keys are remembered for 48 hours.";

// Plain-language next steps for an LLM that hit the paywall over MCP.
function upgradeText(body, hasKey, paidOnly = false) {
  const price = body.price_usd != null ? `$${body.price_usd}` : "a small fee";
  const steps = [
    hasKey
      ? "1. Prepaid credits: POST /v1/credits?pack=5|20|100 with your key and an x402 payment (credits pay the list price)."
      : paidOnly
        ? "1. Call the get_api_key tool (free), then buy prepaid credits: POST /v1/credits?pack=5|20|100 with that key and an x402 payment. Free calls don't cover this tool."
        : "1. Free: call the get_api_key tool now. It gives this session 25 free calls a day and needs no signup.",
    `2. Pay per call: ${price} in USDC on Base with x402 (needs an x402-capable client or wallet; see the PAYMENT-REQUIRED details below).`,
  ];
  return [`${body.error || "Payment required."}`, "", "Next steps:", ...steps].join("\n");
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
  const headers = {};
  let sessionId = req.headers.get("mcp-session-id");
  if (sessionId && !/^[a-f0-9]{32}$/.test(sessionId)) sessionId = null;
  const sessionKey = async () => (sessionId ? (await ctx.store.get(`mcpsess:${sessionId}`))?.key || null : null);
  for (const m of batch) {
    const reply = (result) => replies.push({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code, message) => replies.push({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
    if (m.id === undefined) continue; // notification
    switch (m.method) {
      case "initialize":
        sessionId = sessionId || crypto.randomUUID().replace(/-/g, "");
        headers["mcp-session-id"] = sessionId;
        reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-financial-advisor", version: SERVICE.version }, instructions: overview(base) });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({
          tools: [
            ...TOOLS.map((t) => ({ name: t.name, title: t.title, description: `${t.description} Price: ${priceText(t)}.`, inputSchema: schemaWithExample(t) })),
            { ...GET_API_KEY },
          ],
        });
        break;
      case "tools/call": {
        if (m.params?.name === GET_API_KEY.name) {
          const r = await ctx.billing.issueKey(clientIp(req), m.params?.arguments?.label);
          if (r.error) { reply({ content: [{ type: "text", text: r.error }], isError: true }); break; }
          if (sessionId) await ctx.store.set(`mcpsess:${sessionId}`, { key: r.api_key });
          const text = [
            `API key: ${r.api_key}`,
            sessionId ? `It is attached to this MCP session, so your next calls use it automatically. ${SESSION_TTL_NOTE}` : "This client sent no MCP session id, so pass the key yourself.",
            `To keep it for later sessions, add ?key=${r.api_key} to the MCP URL (${base}/mcp?key=...) or send Authorization: Bearer <key>.`,
            `Free calls per day: ${r.free_calls_per_day}. After that, buy credits (POST ${base}/v1/credits?pack=5|20|100) or pay per call with x402.`,
          ].join("\n");
          reply({ content: [{ type: "text", text }], structuredContent: { ...r, session_bound: Boolean(sessionId) } });
          break;
        }
        const tool = TOOL_MAP[m.params?.name];
        if (!tool) { fail(-32602, `Unknown tool: ${m.params?.name}`); break; }
        const key = bearer(req) || (await sessionKey());
        const out = await runTool(tool, m.params?.arguments, ctx, req, base, "mcp", key);
        if (out.status === 402) {
          reply({ content: [{ type: "text", text: upgradeText(out.body, Boolean(key), Boolean(tool.paid_only)) }, { type: "text", text: JSON.stringify(out.body, null, 2) }], isError: true });
          break;
        }
        const isError = out.status !== 200;
        reply({ content: [{ type: "text", text: JSON.stringify(out.body, null, 2) }], ...(isError ? { isError: true } : { structuredContent: out.body }) });
        break;
      }
      default:
        fail(-32601, `Method not found: ${m.method}`);
    }
  }
  if (!replies.length) return new Response(null, { status: 202, headers });
  return json(Array.isArray(msg) ? replies : replies[0], 200, headers);
}

export async function handle(req, ctx) {
  const url = new URL(req.url);
  const base = ctx.publicUrl || `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-expose-headers": "payment-required, payment-response, x-payment-response, mcp-session-id" } });

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

    if (req.method === "GET" && path === "/v1/audit") {
      const k = bearer(req);
      if (!k || !(await ctx.billing.keyInfo(k))) return json({ error: "Send your API key as Authorization: Bearer <key>." }, 401);
      const log = auditLog(ctx);
      const entries = await log.list(auditId(k));
      const since = Number(url.searchParams.get("since_seq") || 0);
      return json({
        chain: log.verifyChain(entries),
        entries: entries.filter((e) => e.seq > since),
        how_to_verify: "input_sha256 is SHA-256 of your request body as canonical JSON (keys sorted, no whitespace). Each hash covers seq, ts, tool, input_sha256, output_sha256, decision, rules_version and prev_hash; prev_hash links to the entry before. POST entries to /v1/audit/verify to check the server signature.",
      });
    }
    if (req.method === "POST" && path === "/v1/audit/verify") {
      const body = await req.json().catch(() => null);
      const list = Array.isArray(body?.entries) ? body.entries : body?.entry ? [body.entry] : null;
      if (!list) return json({ error: "Send {entry} or {entries: [...]}" }, 400);
      const log = auditLog(ctx);
      return json({ entries: list.map((e) => ({ seq: e.seq, ...log.verifyEntry(e) })), ...(list.length > 1 ? { chain: ((sorted) => log.verifyChain(sorted, sorted[0].prev_hash))([...list].sort((a, b) => a.seq - b.seq)) } : {}) });
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
