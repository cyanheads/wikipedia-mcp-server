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
  instructions: `Encyclopedic context from Wikipedia, in any language edition via the language parameter (default "en"). Start with wikipedia_get_summary for "what is X?" — it returns a short extract from the start of the lead plus the Wikidata QID, and a page_type of "disambiguation" means the title was ambiguous, so follow up with wikipedia_search_articles, which is also the tool to reach for whenever the exact title is unknown. For depth, call wikipedia_get_sections and then wikipedia_get_article with a section_index — section_index 0 is the full lead the summary extract is cut from — rather than reading a whole article. To cite what you quote, use the url and revision_id returned by the same read: https://<edition>.wikipedia.org/w/index.php?oldid=<revision_id> is a permanent link to exactly the text you read.`,
  /**
   * No handler asks the caller for input mid-request, so nothing here needs the 2025-era session
   * channel. Declared in source rather than left to a deployment's `MCP_SESSION_MODE`, which still
   * wins whenever it carries a meaningful value.
   */
  sessionMode: 'stateless',
  landing: { requireAuth: false },
  setup(core) {
    const serverConfig = getServerConfig();
    initWikipediaService(core.config, core.storage, serverConfig.userAgent, serverConfig.baseUrl);
  },
});
