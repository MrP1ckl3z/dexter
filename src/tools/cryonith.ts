import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from './types.js';

/**
 * Bridge tool: gives the Dexter research agent read-only access to Cryonith LLC's
 * live trading system (portfolio, tax-loss harvesting, ROI, recommendations, risk checks)
 * via Cryonith's own MCP server (src/shared/mcp_server.py, JSON-RPC over HTTP on /mcp).
 *
 * SAFETY: this allowlist deliberately excludes `approve_trade` and `skip_trade`.
 * Dexter is a research/analysis agent — it should never be able to execute or
 * cancel a trade on its own. Those actions stay human-in-the-loop via Cryonith
 * directly (Telegram approval flow).
 */

const CRYONITH_MCP_URL = process.env.CRYONITH_MCP_URL ?? 'http://localhost:8765/mcp';

const ALLOWED_TOOLS = [
  'get_health',
  'get_portfolio',
  'get_roi_report',
  'get_tax_scout',
  'get_recommendations',
  'run_risk_check',
] as const;

const CryonithInputSchema = z.object({
  tool: z.enum(ALLOWED_TOOLS).describe(
    'Which Cryonith read-only tool to call: ' +
      'get_health (system status), ' +
      'get_portfolio (current live positions/holdings), ' +
      'get_roi_report (return-on-investment report), ' +
      'get_tax_scout (tax-loss harvesting opportunities + YTD summary), ' +
      'get_recommendations (pending + optionally freshly-generated trade recommendations; ' +
      'pass include_generated=true in args to compute new ones), ' +
      'run_risk_check (simulate whether a hypothetical trade would pass Cryonith\'s pre-trade ' +
      'risk gate — requires symbol, action, quantity, price in args; does NOT place a trade).'
  ),
  args: z
    .record(z.string(), z.any())
    .optional()
    .describe('Arguments for the selected tool, e.g. {"include_generated": true} or {"symbol": "BTC", "action": "buy", "quantity": 1, "price": 65000}.'),
});

async function callCryonithMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(CRYONITH_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    throw new Error(`Cryonith MCP returned HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.error) {
    throw new Error(`Cryonith MCP error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }

  // The server wraps results as { content: [{ type: 'text', text: '<json string>' }] }
  const text = body.result?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return body.result;
}

export const cryonithTool = new DynamicStructuredTool({
  name: 'cryonith_data',
  description:
    "Read-only access to Cryonith LLC's live trading system: current portfolio, " +
    'tax-loss harvesting opportunities, ROI reports, pending/generated trade ' +
    "recommendations, and a pre-trade risk-check simulator. Cannot place, approve, " +
    'or cancel trades — use this for research/analysis only.',
  schema: CryonithInputSchema,
  func: async (input) => {
    try {
      const data = await callCryonithMcp(input.tool, input.args ?? {});
      return formatToolResult(data, [CRYONITH_MCP_URL]);
    } catch (e) {
      return formatToolResult(
        { error: e instanceof Error ? e.message : String(e) },
        [CRYONITH_MCP_URL]
      );
    }
  },
});

export const CRYONITH_TOOL_DESCRIPTION = `Use this tool to look up Cryonith LLC's real, live trading data instead of guessing:

- **get_portfolio** — current holdings/positions
- **get_tax_scout** — tax-loss harvesting opportunities + YTD summary
- **get_roi_report** — return-on-investment report
- **get_recommendations** — pending trade recommendations (add {"include_generated": true} to compute fresh ones)
- **run_risk_check** — dry-run a hypothetical trade against Cryonith's pre-trade risk gate (symbol, action, quantity, price)
- **get_health** — system status

This tool is READ-ONLY. It cannot execute, approve, or skip a trade — those stay human-approved via Cryonith's own Telegram flow. Use this tool whenever a question is about Cryonith's actual holdings, tax position, or recommendations, rather than general market research (use financial_search / financial_metrics / web_search for that instead).`;
