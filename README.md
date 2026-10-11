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

## Run locally (Node 20+, no dependencies)

```
npm test          # 17 tests
npm start         # http://localhost:8787  (payments off until PAY_TO is set)
```

Try it:

```
curl localhost:8787/llms.txt
curl -X POST localhost:8787/v1/tools/position_size -H "content-type: application/json" \
  -d '{"equity":50000,"entry_price":100,"stop_price":95,"method":"fixed_fractional"}'
```

MCP clients: point a streamable-HTTP MCP connection at `http://localhost:8787/mcp`
(send `Authorization: Bearer <key>` for the keyed free tier and credits).

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
| GET | `/admin/revenue` | Revenue and usage (ADMIN_TOKEN) |

## Configuration (env vars)

| Var | Default | |
|---|---|---|
| `PAY_TO` | unset | USDC receiving address. Unset = free preview, no payments |
| `X402_NETWORK` | `base-sepolia` | `base` for real money |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | CDP facilitator for mainnet |
| `FACILITATOR_AUTH` | unset | Authorization header for the facilitator |
| `FREE_DAILY_CALLS` / `FREE_DAILY_ANON` | 25 / 5 | Free tier |
| `ADMIN_TOKEN` | unset | For `/admin/revenue` |
| `DATA_DIR` | `./data` | Node store and ledger |
| `PUBLIC_URL` | request host | Used in payment requirements |

## Deploy (free)

Cloudflare Workers: `npx wrangler kv namespace create AFA_KV`, put the id in `wrangler.toml`, then `npx wrangler deploy`.

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
