#!/usr/bin/env node
// End-to-end x402 v2 payment against a running AFA server, paid from a throwaway
// test wallet. Test network only unless --allow-mainnet is passed.
//
//   npm i --no-save viem
//   node scripts/test-payment.mjs https://<your-worker>.workers.dev [--fund]
//
// --fund asks the CDP faucet for test USDC (needs secrets/cdp_api_key.json).
// The throwaway wallet key is created in secrets/test_wallet.json (gitignored) and never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { cdpJwt, parseCdpKey } from "../src/billing/cdpAuth.js";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) || process.env.AFA_URL || "").replace(/\/+$/, "");
if (!base) throw new Error("Usage: node scripts/test-payment.mjs <server url> [--fund] [--allow-mainnet]");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const { createPublicClient, http, parseAbi } = await import("viem");
const { base: baseMain, baseSepolia } = await import("viem/chains");

const walletFile = "secrets/test_wallet.json";
if (!existsSync(walletFile)) {
  mkdirSync("secrets", { recursive: true });
  writeFileSync(walletFile, JSON.stringify({ note: "Throwaway TEST wallet for x402 tests. Never fund with real money.", privateKey: generatePrivateKey() }));
}
const account = privateKeyToAccount(JSON.parse(readFileSync(walletFile, "utf8")).privateKey);
console.log("test wallet:", account.address);

const tool = "position_size";
const body = JSON.stringify({ equity: 10000, entry_price: 50, stop_price: 48, method: "fixed_fractional" });
const post = (headers = {}) => fetch(`${base}/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}`, ...headers }, body });

// Use up the anonymous trial so the server asks for payment.
let res;
for (let i = 0; i < 10; i += 1) {
  res = await post();
  if (res.status === 402) break;
}
if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);
const required = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString());
const req = required.accepts[0];
console.log("402 asks for", Number(req.amount) / 1e6, "USDC on", req.network, "to", req.payTo);

const chain = { "eip155:84532": baseSepolia, "eip155:8453": baseMain }[req.network];
if (!chain) throw new Error(`Unsupported network ${req.network}`);
if (chain.id === 8453 && !args.includes("--allow-mainnet")) throw new Error("Server is on mainnet; this script only pays on the test network unless --allow-mainnet.");
const rpc = createPublicClient({ chain, transport: http() });
const balance = () => rpc.readContract({ address: req.asset, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });

if (args.includes("--fund")) {
  const key = parseCdpKey({ json: readFileSync("secrets/cdp_api_key.json", "utf8") });
  const url = "https://api.cdp.coinbase.com/platform/v2/evm/faucet";
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await cdpJwt(key, "POST", url)}` }, body: JSON.stringify({ network: "base-sepolia", address: account.address, token: "usdc" }) });
  console.log("faucet:", r.status, (await r.text()).slice(0, 200));
  for (let i = 0; i < 30 && (await balance()) < BigInt(req.amount); i += 1) await new Promise((ok) => setTimeout(ok, 2000));
}
console.log("wallet USDC balance:", Number(await balance()) / 1e6);

const now = Math.floor(Date.now() / 1000);
const authorization = { from: account.address, to: req.payTo, value: req.amount, validAfter: String(now - 600), validBefore: String(now + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString("hex")}` };
const signature = await account.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: chain.id, verifyingContract: req.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
});
const payload = { x402Version: 2, resource: required.resource, accepted: req, payload: { signature, authorization } };
const paid = await post({ "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") });
const out = await paid.json();
console.log("paid call:", paid.status, JSON.stringify(out._billing || out));
const pr = paid.headers.get("payment-response");
if (pr) console.log("settlement:", Buffer.from(pr, "base64").toString());
process.exit(paid.status === 200 ? 0 : 1);
