import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handle } from "../src/app.js";
import { Billing, billingConfig } from "../src/billing/payments.js";
import { MemoryStore } from "../src/billing/store.js";
import { canonical } from "../src/billing/audit.js";
import { EXAMPLES } from "../src/tools/examples.js";

function setup() {
  const store = new MemoryStore();
  const ctx = { store, billing: new Billing(store, billingConfig({ FREE_DAILY_CALLS: "10" })), adminToken: "admin-secret" };
  const call = (path, { method = "GET", body, headers = {} } = {}) =>
    handle(new Request(`http://t.local${path}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...headers }, body: body ? JSON.stringify(body) : undefined }), ctx);
  return { call };
}

const sizing = { method: "fixed_fractional", equity: 10000, entry_price: 50, stop_price: 48 };

test("keyed calls build a signed hash chain the customer can verify", async () => {
  const { call } = setup();
  const { api_key } = await (await call("/v1/keys", { method: "POST", body: {} })).json();
  const auth = { authorization: `Bearer ${api_key}` };
  const r1 = await (await call("/v1/tools/position_size", { method: "POST", body: sizing, headers: auth })).json();
  const r2 = await (await call("/v1/tools/pre_trade_check", { method: "POST", body: EXAMPLES.pre_trade_check, headers: auth })).json();
  assert.equal(r1._audit.seq, 1);
  assert.equal(r2._audit.seq, 2);
  // The customer can recompute the input hash from their own request.
  assert.equal(r1._audit.input_sha256, createHash("sha256").update(canonical(sizing)).digest("hex"));

  const log = await (await call("/v1/audit", { headers: auth })).json();
  assert.equal(log.chain.ok, true);
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[1].prev_hash, log.entries[0].hash);

  const ok = await (await call("/v1/audit/verify", { method: "POST", body: { entries: log.entries } })).json();
  assert.deepEqual(ok.entries.map((e) => [e.hash_ok, e.signature_ok]), [[true, true], [true, true]]);
  assert.equal(ok.chain.ok, true);

  const forged = { ...log.entries[0], decision: "approve" };
  const bad = await (await call("/v1/audit/verify", { method: "POST", body: { entry: forged } })).json();
  assert.equal(bad.entries[0].hash_ok, false);
});

test("anonymous calls are not audited and /v1/audit needs a key", async () => {
  const { call } = setup();
  const r = await (await call("/v1/tools/position_size", { method: "POST", body: sizing })).json();
  assert.equal(r._audit, undefined);
  assert.equal((await call("/v1/audit")).status, 401);
});

test("canonical JSON ignores key order", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
});
