#!/usr/bin/env node
/**
 * dVeracity Semantic MCP server — stdio entrypoint.
 *
 * Exposes the dVeracity Semantic API (natural-language queries over the
 * verified-emissions knowledge graph) and VaaS (standards validation) as
 * MCP tools, so any MCP-capable agent (Claude Code, Cursor, ...) can use
 * them with a dvrc_ API key.
 *
 * Config (env):
 *   DVERACITY_API_KEY  required — dvrc_ key (api-tier subscription)
 *   DVERACITY_API_URL  optional — API base URL (defaults to prod)
 *
 * Tool registrations live in lib/tools.js (registerTools) so the same
 * definitions serve both this stdio entrypoint and the remote HTTP
 * endpoint mounted by dve-backend at POST /mcp.
 *
 * Billing surfaces to the agent as tool errors: a 402 becomes a clear
 * "ask your human operator to purchase credits" message (never a retry
 * loop), per the machine-readable contract at GET /api/v1/semantic/manifest.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { SemanticClient, SemanticApiError } from './lib/client.js';
import { registerTools } from './lib/tools.js';

// The version the server reports is the one npm published — read it from
// package.json so serverInfo can never lag a release (0.3.1 shipped saying 0.3.0).
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)('./package.json');

async function main() {
  const client = new SemanticClient();

  const server = new McpServer({ name: 'dveracity-semantic', version: PACKAGE_VERSION });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[dveracity-semantic-mcp] ready (stdio)${client.keriEnabled() ? ' — KERI mode' : ''}`
  );
}

main().catch((err) => {
  console.error(`[dveracity-semantic-mcp] fatal: ${err.message}`);
  if (err instanceof SemanticApiError && err.actionable) console.error(err.actionable);
  process.exit(1);
});
