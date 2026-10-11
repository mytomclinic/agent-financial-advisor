// Bearer JWTs for the Coinbase Developer Platform (CDP) API, used to call the
// CDP x402 facilitator. See https://docs.cdp.coinbase.com/api-reference/v2/authentication
// Supports the current Ed25519 secret keys (base64, 64 bytes) and legacy EC PEM keys.
import { createPrivateKey, sign as nodeSign, randomBytes } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// Accepts the downloaded key file as JSON ({id|name, privateKey}) or separate id/secret values.
export function parseCdpKey({ json, id, secret } = {}) {
  if (json) {
    try {
      const k = JSON.parse(json);
      return parseCdpKey({ id: k.id || k.name || k.keyId, secret: k.privateKey || k.secret });
    } catch {
      return null;
    }
  }
  if (!id || !secret) return null;
  return { id, secret: secret.replace(/\\n/g, "\n").trim() };
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

async function signEd25519(seed, data) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
}

export async function cdpJwt(key, method, url, now = Math.floor(Date.now() / 1000)) {
  const u = new URL(url);
  const uri = `${method.toUpperCase()} ${u.host}${u.pathname}`;
  const pem = key.secret.includes("BEGIN");
  const header = { alg: pem ? "ES256" : "EdDSA", typ: "JWT", kid: key.id, nonce: randomBytes(16).toString("hex") };
  const claims = { sub: key.id, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uri, uris: [uri] };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let sig;
  if (pem) {
    sig = nodeSign("sha256", Buffer.from(input), { key: createPrivateKey(key.secret), dsaEncoding: "ieee-p1363" });
  } else {
    const raw = Buffer.from(key.secret, "base64");
    if (raw.length !== 64 && raw.length !== 32) throw new Error("CDP key secret must be a base64 Ed25519 key");
    sig = await signEd25519(raw.subarray(0, 32), Buffer.from(input));
  }
  return `${input}.${b64url(sig)}`;
}
