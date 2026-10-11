import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { cdpJwt, parseCdpKey } from "../src/billing/cdpAuth.js";
import { billingConfig } from "../src/billing/payments.js";

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

test("Ed25519 CDP key signs a verifiable facilitator JWT", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const json = JSON.stringify({ id: "key-123", privateKey: Buffer.concat([seed, pub]).toString("base64") });
  const key = parseCdpKey({ json });
  const jwt = await cdpJwt(key, "POST", "https://api.cdp.coinbase.com/platform/v2/x402/verify", 1000);
  const [h, c, s] = jwt.split(".");
  assert.equal(decode(h).alg, "EdDSA");
  assert.equal(decode(h).kid, "key-123");
  const claims = decode(c);
  assert.equal(claims.uri, "POST api.cdp.coinbase.com/platform/v2/x402/verify");
  assert.equal(claims.exp, 1120);
  assert.ok(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")));
});

test("legacy EC PEM CDP key signs ES256", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "sec1" });
  const key = parseCdpKey({ json: JSON.stringify({ name: "organizations/x/apiKeys/y", privateKey: pem }) });
  const jwt = await cdpJwt(key, "POST", "https://api.cdp.coinbase.com/platform/v2/x402/settle");
  const [h, c, s] = jwt.split(".");
  assert.equal(decode(h).alg, "ES256");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});

test("a CDP key switches the default facilitator to CDP; mainnet uses CAIP-2 eip155:8453", () => {
  const cfg = billingConfig({ X402_NETWORK: "base", CDP_API_KEY_ID: "k", CDP_API_KEY_SECRET: Buffer.alloc(64).toString("base64") });
  assert.equal(cfg.facilitatorUrl, "https://api.cdp.coinbase.com/platform/v2/x402");
  assert.equal(cfg.caip2, "eip155:8453");
  assert.equal(cfg.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(billingConfig({}).facilitatorUrl, "https://x402.org/facilitator");
});
