#!/usr/bin/env bun
/**
 * Headless HTTP bridge for Dexter.
 *
 * Dexter's own entrypoint (src/index.tsx) is an interactive terminal UI (ink),
 * meant for a human typing at a keyboard. This file bypasses that entirely and
 * calls the underlying Agent class directly, so Cryonith (or anything else)
 * can trigger research programmatically over HTTP.
 *
 * Run: bun run bridge/server.ts
 * Env:
 *   PORT                   - port to listen on (default 8090)
 *   DEXTER_MODEL           - e.g. "claude-sonnet-4-6" (verify exact model id
 *                            against your Anthropic account/docs)
 *   DEXTER_MODEL_PROVIDER  - default "anthropic"
 *   ANTHROPIC_API_KEY      - required for the anthropic provider
 *   CRYONITH_MCP_URL       - if set, Dexter also gets the cryonith_data tool
 *                            (see src/tools/cryonith.ts)
 */

import { Agent } from '../src/agent/agent.js';
import type { AgentEvent } from '../src/agent/types.js';

const PORT = Number(process.env.PORT ?? 8090);
const MODEL = process.env.DEXTER_MODEL ?? 'claude-sonnet-4-6';
const MODEL_PROVIDER = process.env.DEXTER_MODEL_PROVIDER ?? 'anthropic';

interface ResearchResponse {
  answer: string;
  iterations: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  thinking: string[];
}

async function runResearch(query: string): Promise<ResearchResponse> {
  const agent = Agent.create({ model: MODEL, modelProvider: MODEL_PROVIDER });

  const thinking: string[] = [];
  let result: ResearchResponse = { answer: '', iterations: 0, toolCalls: [], thinking };

  for await (const event of agent.run(query) as AsyncGenerator<AgentEvent>) {
    if (event.type === 'thinking') {
      thinking.push(event.message);
    } else if (event.type === 'done') {
      result = {
        answer: event.answer,
        iterations: event.iterations,
        toolCalls: event.toolCalls,
        thinking,
      };
    }
  }

  return result;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({ ok: true, model: MODEL, provider: MODEL_PROVIDER });
    }

    if (url.pathname === '/research' && req.method === 'POST') {
      let body: { query?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }

      if (!body.query || typeof body.query !== 'string') {
        return Response.json({ error: '"query" (string) is required' }, { status: 400 });
      }

      try {
        const result = await runResearch(body.query);
        return Response.json(result);
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      }
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
});

console.log(`Dexter bridge listening on http://0.0.0.0:${PORT}`);
console.log(`  model: ${MODEL_PROVIDER}/${MODEL}`);
console.log(
  `  cryonith tool: ${process.env.CRYONITH_MCP_URL ? 'enabled -> ' + process.env.CRYONITH_MCP_URL : 'disabled (set CRYONITH_MCP_URL to enable)'}`
);
