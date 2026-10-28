# Agent Financial Advisor

The compliance officer, risk manager, tax advisor and performance auditor for AI agents that trade and advise.
Agents call it before they act; it answers with sourced, deterministic checks and charges a small fee per call.


## Tools

| Tool | Price | Does |
|---|---|---|
| `rules_digest` | free | Current US trading/margin/settlement/tax rules with effective dates and sources |
| `pre_trade_check` | $0.005 | Buying power, cash-account violations, intraday margin (post-PDT), Reg SHO, wash sales, concentration, risk-to-stop, liquidity, spread, fat finger, leverage, market hours |
| `position_size` | $0.005 | Fixed-fractional, volatility-target or fractional-Kelly sizing with caps |
| `tax_lot_plan` | $0.02 | FIFO/LIFO/HIFO/min-tax lot selection, ST/LT split, wash sales, loss harvesting scan |
| `portfolio_review` | $0.05 | Weights, HHI, sector/asset-class exposure, rebalance trades, Sharpe/Sortino/drawdown/VaR/beta |
| `strategy_audit` | $0.10 | Trade stats, t-stat, Probabilistic and Deflated Sharpe Ratio, overfitting red flags |
| `suitability_check` | $0.03 | Reg BI / fiduciary suitability review with a hashed audit memo |
| `advisor_memo` | $0.10, paid only | Runs the checks above on a planned trade, options position or portfolio, then Claude writes a go / no-go memo with risks, required changes, rules cited and an audit note. Never looser than the rule checks |
| `options_risk_check` | $0.01 | Covered/cash-secured/spread/naked classification, FINRA 4210 margin, cash-account limits, approval level, dividend early assignment, pin risk, auto-exercise, max loss, net Greeks |

Drop-in code (Alpaca order guard, MCP client configs, x402 paying client): [examples/](examples/).

## Run locally (Node 20+, no dependencies)

```
npm test
npm start         # http://localhost:8787  (payments off until PAY_TO is set)
```

Try it:

```
curl localhost:8787/llms.txt
curl -X POST localhost:8787/v1/tools/position_size -H "content-type: application/json" \
  -d '{"equity":50000,"entry_price":100,"stop_price":95,"method":"fixed_fractional"}'
```

MCP clients: point a streamable-HTTP MCP connection at `http://localhost:8787/mcp`.
For the keyed free tier and credits, send `Authorization: Bearer <key>`, use `/mcp?key=<key>`, or have the agent call
the free `get_api_key` tool, which binds a new key to the MCP session. Add `?src=<name>` to any URL to attribute usage in `/stats`.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/`, `/llms.txt` | Agent-readable overview |
| GET | `/v1/tools`, `/openapi.json`, `/pricing`, `/.well-known/x402` | Discovery |
| POST | `/v1/tools/{name}` | Run a tool |
| POST | `/mcp` | MCP JSON-RPC |
| POST | `/v1/keys` | Free API key |
| GET | `/v1/keys/me` | Key balance |
| POST | `/v1/credits?pack=5\|20\|100` | Buy credits with x402 |
| GET | `/v1/audit` | Your tamper-evident audit log: every keyed paid call, hash-chained and server-signed (`?since_seq=`) |
| POST | `/v1/audit/verify` | Verify audit entries' hashes, signatures and chain |
| GET | `/stats` | Public aggregate usage: calls, paid calls, keys issued, revenue (no identities; cached 10 min) |
| GET | `/admin/revenue` | Revenue and usage (ADMIN_TOKEN) |

## Configuration (env vars)

| Var | Default | |
|---|---|---|
| `PAY_TO` | unset | USDC receiving address. Unset = free preview, no payments |
| `X402_NETWORK` | `base-sepolia` | `base` for real money |
| `CDP_API_KEY_JSON` | unset | Secret: the downloaded CDP key file. When set, payments go through the Coinbase CDP facilitator (needed for mainnet). `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` also work |
| `FACILITATOR_URL` | CDP if a key is set, else `https://x402.org/facilitator` | Override the facilitator |
| `FACILITATOR_AUTH` | unset | Static Authorization header for a non-CDP facilitator |
| `X402_MIN_USD` | `0.01` | Minimum pay-per-call x402 price (credits pay list price) |
| `FREE_DAILY_CALLS` / `FREE_DAILY_ANON` | 25 / 5 | Free tier |
| `ADMIN_TOKEN` | unset | For `/admin/revenue` |
| `ANTHROPIC_API_KEY` | unset | Secret: turns on `advisor_memo` (Claude Sonnet 5.5). Unset = the tool answers 503 and charges nothing |
| `MEMO_DAILY_CAP_USD` | 3 | Daily Claude spend cap for `advisor_memo`; past it the tool pauses until 00:00 UTC |
| `DATA_DIR` | `./data` | Node store and ledger |
| `PUBLIC_URL` | request host | Used in payment requirements |

## Deploy (free)

Cloudflare Workers: `npx wrangler kv namespace create AFA_KV`, put the id in `wrangler.toml`, then `npx wrangler deploy`.

Real USDC: `npx wrangler secret put CDP_API_KEY_JSON < secrets/cdp_api_key.json`, set `X402_NETWORK = "base"` in `wrangler.toml`, deploy.

advisor_memo: `npx wrangler secret put ANTHROPIC_API_KEY < secrets/anthropic-key.txt`.

## Payments (x402)

Speaks x402 v2: a 402 carries a base64 `PAYMENT-REQUIRED` header (CAIP-2 network, e.g. `eip155:8453`), clients pay with
`PAYMENT-SIGNATURE`, and the settlement comes back in `PAYMENT-RESPONSE`. v1 clients (`X-PAYMENT`, body `accepts`) still work.

End-to-end test on the test network: `npm i --no-save viem && node scripts/e2e-payment.mjs <server url> --fund`.

## Layout

```
src/app.js            fetch-style router: REST, MCP, billing hooks
src/server.js         Node entry
src/worker.js         Cloudflare Workers entry (KV store)
src/billing/          free tier, API keys, credits, x402, ledger
src/tools/            the advisory tools
src/lib/regs.js       rule table with sources (reviewed weekly)
src/lib/calendar.js   NYSE calendar
test/                 node --test suites
```
