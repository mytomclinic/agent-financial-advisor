import { RULES, RULES_VERSION } from "../lib/regs.js";
import { preTradeCheck } from "./preTradeCheck.js";
import { positionSize } from "./positionSize.js";
import { taxLotPlan } from "./taxLots.js";
import { portfolioReview } from "./portfolioReview.js";
import { strategyAudit } from "./strategyAudit.js";
import { suitabilityCheck } from "./suitability.js";
import { optionsRiskCheck } from "./optionsRisk.js";

// Free: the hook. Agents trained before mid-2026 still believe the $25k PDT rule exists.
const rulesDigest = {
  name: "rules_digest",
  title: "Current trading rules digest",
  price_usd: 0,
  description:
    "Free. The current US trading, margin, settlement and tax rules an agent must follow, with effective dates and sources. " +
    "Includes changes your training data may predate, such as the June 2026 replacement of the Pattern Day Trader rule.",
  inputSchema: { type: "object", properties: { topic: { type: "string", enum: Object.keys(RULES) } } },
  handler(input) {
    const rules = input?.topic ? { [input.topic]: RULES[input.topic] } : RULES;
    return { rules_version: RULES_VERSION, rules };
  },
};

export const TOOLS = [rulesDigest, preTradeCheck, positionSize, taxLotPlan, portfolioReview, strategyAudit, suitabilityCheck, optionsRiskCheck];
export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
