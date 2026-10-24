// Node entry point: adapts node:http to the fetch-style handler in app.js.
import { createServer } from "node:http";
import { handle } from "./app.js";
import { Billing, billingConfig } from "./billing/payments.js";
import { FileStore } from "./billing/store.js";

const env = process.env;
const store = new FileStore(env.DATA_DIR || new URL("../data", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ctx = {
  store,
  billing: new Billing(store, billingConfig(env)),
  publicUrl: env.PUBLIC_URL || null,
  adminToken: env.ADMIN_TOKEN || null,
  auditSecret: env.AUDIT_SECRET || null,
};

const port = Number(env.PORT || 8787);
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const host = req.headers.host || `localhost:${port}`;
  const forwardedFor = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  headers.set("x-forwarded-for", String(forwardedFor));
  const request = new Request(`http://${host}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const response = await handle(request, ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`Agent Financial Advisor listening on http://localhost:${port}  (payments ${ctx.billing.cfg.payTo ? `ON, ${ctx.billing.cfg.network}` : "OFF: free preview"})`);
});

process.on("SIGINT", () => { store.flush(); process.exit(0); });
