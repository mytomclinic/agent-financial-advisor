import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/app.js";
import { Billing, billingConfig } from "../src/billing/payments.js";
import { MemoryStore } from "../src/billing/store.js";
import { EXAMPLES } from "../src/tools/examples.js";

const BASE = "http://test.local";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

function setup({ payTo = null, fetchImpl } = {}) {
  const store = new MemoryStore();
  const billing = new Billing(store, billingConfig({ PAY_TO: payTo, FREE_DAILY_CALLS: "2", FREE_DAILY_ANON: "1" }), fetchImpl);
  const ctx = { store, billing, adminToken: "admin" };
  const call = (path, { method = "GET", body, headers = {} } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", ...headers }, body: body ? JSON.stringify(body) : undefined }), ctx);
  return { call, store, billing };
}

const sizing = { equity: 10000, entry_price: 50, stop_price: 48, method: "fixed_fractional" };

test("discovery endpoints", async () => {
  const { call } = setup();
  assert.equal((await call("/health")).status, 200);
  const tools = await (await call("/v1/tools")).json();
  assert.ok(tools.tools.length >= 7);
  const oa = await (await call("/openapi.json")).json();
  assert.ok(oa.paths["/v1/tools/pre_trade_check"]);
  assert.match(await (await call("/llms.txt")).text(), /pre_trade_check/);
});

test("anonymous trial, then 402 with x402 requirements", async () => {
  const { call } = setup({ payTo: PAY_TO });
  assert.equal((await call("/v1/tools/position_size", { method: "POST", body: sizing })).status, 200);
  const r = await call("/v1/tools/position_size", { method: "POST", body: sizing });
  assert.equal(r.status, 402);
  const body = await r.json();
  // $0.005 list price, raised to the $0.01 pay-per-call minimum.
  assert.equal(body.accepts[0].maxAmountRequired, "10000");
  assert.equal(body.accepts[0].payTo, PAY_TO);
  const v2 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.accepts[0].network, "eip155:84532");
  assert.equal(v2.accepts[0].amount, "10000");
  assert.equal(v2.resource.url, `${BASE}/v1/tools/position_size`);
  const bazaar = v2.extensions.bazaar;
  assert.equal(bazaar.info.input.method, "POST");
  assert.equal(bazaar.info.input.body.method, "fixed_fractional");
  assert.equal(bazaar.info.output.example.quantity, 100);
  assert.ok(v2.resource.description.length <= 500);
});

test("x402 v2 payment uses PAYMENT-SIGNATURE and returns PAYMENT-RESPONSE", async () => {
  const bodies = [];
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const op = url.split("/").pop();
    const body = op === "verify" ? { isValid: true, payer: "0xabc" } : { success: true, transaction: "0xtx", network: "eip155:84532", payer: "0xabc" };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const { call } = setup({ payTo: PAY_TO, fetchImpl: fakeFetch });
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: {} })).toString("base64");
  const r = await call("/v1/tools/position_size", { method: "POST", body: sizing, headers: { "payment-signature": payment } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("payment-response"));
  assert.equal(bodies[0].x402Version, 2);
  assert.equal(bodies[0].paymentRequirements.amount, "10000");
  assert.equal(bodies[0].paymentRequirements.network, "eip155:84532");
  // The settled payload carries the resource and discovery info for the Bazaar.
  assert.equal(bodies[1].paymentPayload.resource.url, `${BASE}/v1/tools/position_size`);
  assert.equal(bodies[1].paymentPayload.extensions.bazaar.info.input.type, "http");
  assert.equal((await r.json())._billing.price_usd, 0.01);
});

test("bad input is 400 and does not use quota", async () => {
  const { call } = setup();
  assert.equal((await call("/v1/tools/position_size", { method: "POST", body: { method: "kelly" } })).status, 400);
  assert.equal((await call("/v1/tools/position_size", { method: "POST", body: sizing })).status, 200);
});

test("API key: free tier, then 402 when out of credits", async () => {
  const { call, billing } = setup({ payTo: PAY_TO });
  const { api_key } = await (await call("/v1/keys", { method: "POST" })).json();
  const auth = { authorization: `Bearer ${api_key}` };
  for (let i = 0; i < 2; i += 1) assert.equal((await call("/v1/tools/position_size", { method: "POST", body: sizing, headers: auth })).status, 200);
  assert.equal((await call("/v1/tools/position_size", { method: "POST", body: sizing, headers: auth })).status, 402);
  await billing.addCredits(api_key, 0.01);
  const ok = await call("/v1/tools/position_size", { method: "POST", body: sizing, headers: auth });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json())._billing.credits_left_usd, 0.005);
});

test("x402 payment is verified, settled and recorded", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    const op = url.split("/").pop();
    const body = op === "verify" ? { isValid: true, payer: "0xabc" } : { success: true, transaction: "0xtx", network: "base-sepolia", payer: "0xabc" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { call } = setup({ payTo: PAY_TO, fetchImpl: fakeFetch });
  const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} })).toString("base64");
  const r = await call("/v1/tools/strategy_audit", { method: "POST", body: { returns: [0.01, -0.005, 0.002, 0.003] }, headers: { "x-payment": payment } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("x-payment-response"));
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["verify", "settle"]);
  const rev = await (await call("/admin/revenue", { headers: { authorization: "Bearer admin" } })).json();
  assert.equal(rev.cash_received_usd, 0.1);
});

test("MCP: initialize, list and call", async () => {
  const { call } = setup();
  const rpc = (id, method, params) => call("/mcp", { method: "POST", body: { jsonrpc: "2.0", id, method, params } }).then((r) => r.json());
  const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.serverInfo.name, "agent-financial-advisor");
  const list = await rpc(2, "tools/list");
  assert.ok(list.result.tools.some((t) => t.name === "tax_lot_plan"));
  const res = await rpc(3, "tools/call", { name: "rules_digest", arguments: { topic: "intraday_margin" } });
  assert.match(res.result.content[0].text, /26-10/);
  const notif = await call("/mcp", { method: "POST", body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(notif.status, 202);
});

test("public /stats shows aggregate usage without identities", async () => {
  const { call } = setup();
  await call("/v1/keys", { method: "POST", body: {} });
  await call("/v1/tools/position_size", { method: "POST", body: sizing });
  await call("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rules_digest", arguments: {} } } });
  const s = await (await call("/stats")).json();
  assert.equal(s.calls.total, 2);
  assert.equal(s.calls.last_24h, 2);
  assert.deepEqual(s.calls.by_interface, { rest: 1, mcp: 1 });
  assert.equal(s.calls.by_tool.position_size, 1);
  assert.equal(s.api_keys_issued.total, 1);
  assert.equal(s.paid_calls.total, 0);
  assert.equal(s.revenue_usd, 0);
  assert.doesNotMatch(JSON.stringify(s), /1\.2\.3\.4|afa_/);
});

test("MCP agent gets its own key mid-session and keeps going after the trial", async () => {
  const { call } = setup({ payTo: PAY_TO });
  const rpc = async (id, method, params, headers = {}) => {
    const r = await call("/mcp?src=devto", { method: "POST", body: { jsonrpc: "2.0", id, method, params }, headers });
    return { body: await r.json(), session: r.headers.get("mcp-session-id") };
  };
  const init = await rpc(1, "initialize", {});
  assert.match(init.session, /^[a-f0-9]{32}$/);
  const h = { "mcp-session-id": init.session };
  const list = await rpc(2, "tools/list", {}, h);
  assert.ok(list.body.result.tools.some((t) => t.name === "get_api_key"));

  const callSize = (id) => rpc(id, "tools/call", { name: "position_size", arguments: sizing }, h);
  assert.ok(!(await callSize(3)).body.result.isError); // anonymous trial (1/day in tests)
  const blocked = (await callSize(4)).body.result;
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /get_api_key/);

  const got = (await rpc(5, "tools/call", { name: "get_api_key", arguments: { label: "bot" } }, h)).body.result;
  assert.equal(got.structuredContent.session_bound, true);
  assert.match(got.structuredContent.api_key, /^afa_/);
  const after = (await callSize(6)).body.result;
  assert.ok(!after.isError);
  assert.equal(after.structuredContent._billing.mode, "free_tier");

  const s = await (await call("/stats")).json();
  assert.equal(s.calls.by_source.devto, 2);
  assert.equal(s.api_keys_issued.total, 1);
});

test("API key in the MCP URL query works for URL-only clients", async () => {
  const { call } = setup({ payTo: PAY_TO });
  const { api_key } = await (await call("/v1/keys", { method: "POST", body: {} })).json();
  const r = await (await call(`/mcp?key=${api_key}`, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "position_size", arguments: sizing } } })).json();
  assert.equal(r.result.structuredContent._billing.mode, "free_tier");
});

test("keyed free calls report the quota and warn near the limit; my_account shows it over MCP", async () => {
  const store = new MemoryStore();
  const billing = new Billing(store, billingConfig({ PAY_TO: "0x000000000000000000000000000000000000dEaD", FREE_DAILY_CALLS: "5" }));
  const ctx = { store, billing, adminToken: "admin" };
  const post = (path, body, headers = {}) => handle(new Request(`http://t.local${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx);
  const { api_key } = await (await post("/v1/keys", {})).json();
  const auth = { authorization: `Bearer ${api_key}` };
  const body = EXAMPLES.position_size;
  const first = (await (await post("/v1/tools/position_size", body, auth)).json())._billing;
  assert.deepEqual([first.quota.free_calls_used, first.quota.free_calls_per_day], [1, 5]);
  assert.ok(first.quota.resets_at.endsWith("T00:00:00.000Z"));
  assert.equal(first.hint, undefined);
  for (let i = 0; i < 3; i++) await post("/v1/tools/position_size", body, auth);
  const fifth = (await (await post("/v1/tools/position_size", body, auth)).json())._billing;
  assert.match(fifth.hint, /0 free calls left today/);
  const mcp = await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_account", arguments: {} } }, auth)).json();
  assert.equal(mcp.result.structuredContent.free_calls_left_today, 0);
  assert.equal(mcp.result.structuredContent.first_paid_call_free_available, true);
});
