#!/usr/bin/env node
/**
 * @fileoverview wikipedia-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initWikipediaService } from './services/wikipedia/wikipedia-service.js';

await createApp({
  name: 'wikipedia-mcp-server',
  title: 'wikipedia-mcp-server',
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions: `Wikipedia MCP server providing encyclopedic context via the MediaWiki REST API and Action API.
- Use wikipedia_get_summary for "what is X?" lookups (90% of cases) — returns the lead section, Wikidata QID, and thumbnail.
- Use wikipedia_search when the exact article title is unknown.
- Use wikipedia_get_sections then wikipedia_get_article with section_index for targeted section reads — much smaller than full articles.
- All tools support a language parameter (default "en") for multi-language workflows.
- wikipedia_get_summary returns page_type: "disambiguation" for disambiguation pages — follow up with wikipedia_search.`,
  landing: { requireAuth: false },
  setup(core) {
    const serverConfig = getServerConfig();
    initWikipediaService(core.config, core.storage, serverConfig.userAgent);
  },
});
