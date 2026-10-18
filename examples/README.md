# Examples

Base URL: `https://agent-financial-advisor.agent-financial-advisor.workers.dev`. MCP: `<base>/mcp`.

## Connect an MCP client

**Claude Code**
```sh
claude mcp add --transport http agent-financial-advisor https://agent-financial-advisor.agent-financial-advisor.workers.dev/mcp
```

**Claude Desktop / claude.ai:** go to Settings, then Connectors, then Add custom connector, and paste the MCP URL.

**Cursor** (`~/.cursor/mcp.json`), and other clients that take a URL:
```json
{ "mcpServers": { "agent-financial-advisor": { "url": "https://agent-financial-advisor.agent-financial-advisor.workers.dev/mcp" } } }
```

Then tell the agent: *"Before placing any order, call pre_trade_check and follow its decision."*

## Call over REST

```sh
curl -s -X POST https://agent-financial-advisor.agent-financial-advisor.workers.dev/v1/tools/rules_digest -d '{"topic":"intraday_margin"}'
curl -s -X POST https://agent-financial-advisor.agent-financial-advisor.workers.dev/v1/keys   # free key: 25 calls a day
```

## Files

| File | What it does |
|---|---|
| [alpaca_pre_trade_guard.py](alpaca_pre_trade_guard.py) | Checks an Alpaca order with `pre_trade_check`, blocks rejects, uses the suggested size, then submits |
| [x402_client.mjs](x402_client.mjs) | Pays per call in USDC from the agent's own wallet (x402 v2), with a price cap |

Every paid tool's example request is also listed in the x402 Bazaar discovery info and at `GET /v1/tools`.
