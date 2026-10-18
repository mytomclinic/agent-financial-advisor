// Pay for one call with x402 (USDC on Base) from your agent's own wallet.
//
//   npm i viem
//   AGENT_PRIVATE_KEY=0x... node x402_client.mjs
//
// The server answers 402 with a PAYMENT-REQUIRED header; the client signs an
// EIP-3009 USDC transfer authorization and retries with PAYMENT-SIGNATURE.
// Nothing moves until the server's facilitator settles it, and only the quoted amount.
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const URL_ = process.env.AFA_URL || "https://agent-financial-advisor.agent-financial-advisor.workers.dev";
const MAX_USD = 0.05; // refuse to pay more than this per call
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const CHAIN_IDS = { "eip155:8453": 8453, "eip155:84532": 84532 };

export async function callTool(tool, body) {
  const post = (headers = {}) => fetch(`${URL_}/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const first = await post();
  if (first.status !== 402) return first.json();

  const required = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
  const req = required.accepts[0];
  if (Number(req.amount) / 1e6 > MAX_USD) throw new Error(`Price ${Number(req.amount) / 1e6} USDC is above MAX_USD`);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: req.payTo, value: req.amount, validAfter: String(now - 600), validBefore: String(now + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString("hex")}` };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_IDS[req.network], verifyingContract: req.asset },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  const payment = { x402Version: 2, resource: required.resource, accepted: req, payload: { signature, authorization } };
  const paid = await post({ "payment-signature": Buffer.from(JSON.stringify(payment)).toString("base64") });
  return paid.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await callTool("position_size", { equity: 50000, entry_price: 100, stop_price: 95, method: "fixed_fractional", risk_pct: 0.01 });
  console.log(JSON.stringify(out, null, 2));
}
