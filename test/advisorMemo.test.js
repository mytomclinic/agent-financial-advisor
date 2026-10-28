import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/app.js";
import { Billing, billingConfig } from "../src/billing/payments.js";
import { MemoryStore } from "../src/billing/store.js";
import { ClaudeMemoWriter, costOf } from "../src/advisor/claudeMemo.js";
import { EXAMPLES } from "../src/tools/examples.js";

const BASE = "http://test.local";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

const memo = (recommendation = "proceed") => ({
  recommendation, headline: "Buy 50 AAPL.", rationale: "All checks pass.", key_risks: ["Earnings gap"], required_changes: [], rules_cited: ["FINRA 4210"], audit_note: "Checked.",
});

// Fake Messages API: records requests, answers with `reply` (or an HTTP error).
function fakeClaude({ reply = memo(), status = 200, stop = "end_turn" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const body = status === 200
      ? { model: "claude-sonnet-5-5", stop_reason: stop, content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 1000, output_tokens: 400 } }
      : { error: { message: "overloaded" } };
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

function setup({ claude, apiKey = "sk-test", cap = 3 } = {}) {
  const store = new MemoryStore();
  const billing = new Billing(store, billingConfig({ PAY_TO, FREE_DAILY_CALLS: "25", FREE_DAILY_ANON: "5" }));
  const memoWriter = apiKey ? new ClaudeMemoWriter({ apiKey, store, dailyCapUsd: cap, fetchImpl: (claude || fakeClaude()).fetchImpl }) : null;
  const ctx = { store, billing, memoWriter, adminToken: "admin" };
  const call = (path, { method = "POST", body, headers = {} } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", ...headers }, body: body ? JSON.stringify(body) : undefined }), ctx);
  const keyWithCredits = async (usd) => {
    const { api_key } = await (await call("/v1/keys", { body: {} })).json();
    await billing.addCredits(api_key, usd);
    return api_key;
  };
  return { call, store, billing, keyWithCredits };
}

test("advisor_memo is paid only: no anonymous trial, no free key calls", async () => {
  const { call } = setup();
  const anon = await call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo });
  assert.equal(anon.status, 402);
  assert.match((await anon.json()).error, /paid only/);
  const { api_key } = await (await call("/v1/keys", { body: {} })).json();
  const keyed = await call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo, headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(keyed.status, 402);
  const body = await keyed.json();
  assert.equal(body.accepts[0].maxAmountRequired, "100000");
});

test("advisor_memo with credits returns the memo, charges $0.10 and audits the call", async () => {
  const claude = fakeClaude();
  const { call, keyWithCredits, billing } = setup({ claude });
  const key = await keyWithCredits(1);
  const r = await call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo, headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.recommendation, "proceed");
  assert.equal(out.memo.headline, "Buy 50 AAPL.");
  assert.equal(out.analysis.trade.decision, "approve");
  assert.equal(out._billing.mode, "credits");
  assert.ok(out._audit.seq >= 1);
  assert.equal((await billing.keyInfo(key)).credits_usd, 0.9);
  // The request to Claude: cached system prompt, structured output, the plan and the rule checks.
  const req = claude.calls[0];
  assert.equal(req.body.model, "claude-sonnet-5-5");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.equal(req.body.system[0].cache_control.type, "ephemeral");
  assert.match(req.body.messages[0].content, /Momentum entry/);
  assert.match(req.body.messages[0].content, /"decision":"approve"/);
});

test("the memo can't be looser than the rule checks", async () => {
  const claude = fakeClaude({ reply: memo("proceed") });
  const { call, keyWithCredits } = setup({ claude });
  const key = await keyWithCredits(1);
  // Cash account with too little settled cash: pre_trade_check rejects.
  const trade = { account: { type: "cash", equity: 1000, cash: 1000, settled_cash: 1000 }, order: { symbol: "AAPL", side: "buy", quantity: 50, limit_price: 200 } };
  const out = await (await call("/v1/tools/advisor_memo", { body: { trade }, headers: { authorization: `Bearer ${key}` } })).json();
  assert.equal(out.analysis.trade.decision, "reject");
  assert.equal(out.recommendation, "do_not_proceed");
  assert.equal(out.memo.recommendation, "do_not_proceed");
});

test("a failed memo refunds credits and says so", async () => {
  const { call, keyWithCredits, billing } = setup({ claude: fakeClaude({ status: 529 }) });
  const key = await keyWithCredits(1);
  const r = await call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo, headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /not charged/);
  assert.equal((await billing.keyInfo(key)).credits_usd, 1);
});

test("advisor_memo pauses without an API key or past the daily cap, before charging", async () => {
  const off = setup({ apiKey: null });
  const r = await off.call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo });
  assert.equal(r.status, 503);

  // Each fake call costs 1000 * $2/M + 400 * $10/M = $0.006; a $0.005 cap allows one.
  const capped = setup({ cap: 0.005 });
  const key = await capped.keyWithCredits(1);
  const auth = { authorization: `Bearer ${key}` };
  assert.equal((await capped.call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo, headers: auth })).status, 200);
  assert.equal((await capped.call("/v1/tools/advisor_memo", { body: EXAMPLES.advisor_memo, headers: auth })).status, 503);
  assert.equal((await capped.billing.keyInfo(key)).credits_usd, 0.9);
});

test("advisor_memo validates input before billing", async () => {
  const { call } = setup();
  const r = await call("/v1/tools/advisor_memo", { body: { context: "hi" } });
  assert.equal(r.status, 400);
  const bad = await call("/v1/tools/advisor_memo", { body: { trade: { order: {} } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^trade: /);
});

test("cost accounting uses Sonnet 5.5 prices", () => {
  assert.equal(Math.round(costOf({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }) * 100) / 100, 12.2);
});

test("schemas carry worked examples and rules_digest points to next steps", async () => {
  const { call } = setup();
  const tools = await (await call("/v1/tools", { method: "GET" })).json();
  const ptc = tools.tools.find((t) => t.name === "pre_trade_check");
  assert.deepEqual(ptc.input_schema.examples[0], EXAMPLES.pre_trade_check);
  assert.equal(tools.tools.find((t) => t.name === "advisor_memo").paid_only, true);
  const list = await (await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json();
  assert.ok(list.result.tools.find((t) => t.name === "pre_trade_check").inputSchema.examples);
  assert.match(list.result.tools.find((t) => t.name === "advisor_memo").description, /\$0\.1, paid only/);
  const digest = await (await call("/v1/tools/rules_digest", { body: {} })).json();
  assert.ok(digest.next_steps.length >= 2);
  assert.deepEqual(digest.example_pre_trade_check, EXAMPLES.pre_trade_check);
});

test("MCP paywall text for a paid-only tool points to credits, not free calls", async () => {
  const { call } = setup();
  const r = await (await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "advisor_memo", arguments: EXAMPLES.advisor_memo } } })).json();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Free calls don't cover this tool/);
});
