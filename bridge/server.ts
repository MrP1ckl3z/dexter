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
 *   DEXTER_BRIDGE_TOKEN    - shared secret required on every /research call
 *                            (Authorization: Bearer <token>). SECURITY: if
 *                            this is not set, the server refuses to bind to
 *                            0.0.0.0 and falls back to 127.0.0.1-only so it's
 *                            never silently open on the network. Set it and
 *                            it'll bind to 0.0.0.0 as normal.
 *   DEXTER_RATE_LIMIT      - max /research calls per minute per caller
 *                            (default 10). Each call is a real, billed
 *                            Anthropic API request.
 */

import { Agent } from '../src/agent/agent.js';
import type { AgentEvent } from '../src/agent/types.js';

const PORT = Number(process.env.PORT ?? 8090);
const MODEL = process.env.DEXTER_MODEL ?? 'claude-sonnet-4-6';
const MODEL_PROVIDER = process.env.DEXTER_MODEL_PROVIDER ?? 'anthropic';
const BRIDGE_TOKEN = process.env.DEXTER_BRIDGE_TOKEN;
const RATE_LIMIT = Number(process.env.DEXTER_RATE_LIMIT ?? 10);

// SECURITY: no token configured -> bind loopback-only. Never silently expose
// a token-less endpoint on 0.0.0.0 just because someone forgot to set it.
const HOSTNAME = BRIDGE_TOKEN ? '0.0.0.0' : '127.0.0.1';

interface ResearchResponse {
  answer: string;
  iterations: number;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  thinking: string[];
}

// --- minimal in-memory rate limiter (per source IP, fixed 60s window) ---
const requestCounts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(key);
  if (!entry || now - entry.windowStart > 60_000) {
    requestCounts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
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
  hostname: HOSTNAME,
  async fetch(req, server) {
    const url = new URL(req.url);
    const clientIp = server.requestIP(req)?.address ?? 'unknown';

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        ok: true,
        model: MODEL,
        provider: MODEL_PROVIDER,
        auth: BRIDGE_TOKEN ? 'enabled' : 'DISABLED (loopback-only fallback)',
      });
    }

    if (url.pathname === '/research' && req.method === 'POST') {
      // Auth check (only relevant when BRIDGE_TOKEN is set, i.e. bound to 0.0.0.0)
      if (BRIDGE_TOKEN) {
        const authHeader = req.headers.get('authorization') ?? '';
        const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (provided !== BRIDGE_TOKEN) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }

      if (isRateLimited(clientIp)) {
        return Response.json(
          { error: `rate limit exceeded (${RATE_LIMIT}/min) — each request is a billed API call` },
          { status: 429 }
        );
      }

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

console.log(`Dexter bridge listening on http://${HOSTNAME}:${PORT}`);
console.log(`  model: ${MODEL_PROVIDER}/${MODEL}`);
console.log(
  `  cryonith tool: ${process.env.CRYONITH_MCP_URL ? 'enabled -> ' + process.env.CRYONITH_MCP_URL : 'disabled (set CRYONITH_MCP_URL to enable)'}`
);
if (!BRIDGE_TOKEN) {
  console.warn(
    '  ⚠️  DEXTER_BRIDGE_TOKEN is not set — bound to 127.0.0.1 only. ' +
      'Set DEXTER_BRIDGE_TOKEN to enable network access with auth.'
  );
} else {
  console.log(`  auth: bearer token required, rate limit ${RATE_LIMIT}/min per caller`);
}
