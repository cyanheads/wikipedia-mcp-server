/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

import { wikipediaGetArticle } from './wikipedia-get-article.tool.js';
import { wikipediaGetLanguages } from './wikipedia-get-languages.tool.js';
import { wikipediaGetSections } from './wikipedia-get-sections.tool.js';
import { wikipediaGetSummary } from './wikipedia-get-summary.tool.js';
import { wikipediaSearch } from './wikipedia-search.tool.js';
import { wikipediaSearchNearby } from './wikipedia-search-nearby.tool.js';

export const allToolDefinitions = [
  wikipediaSearch,
  wikipediaGetSummary,
  wikipediaGetArticle,
  wikipediaGetSections,
  wikipediaSearchNearby,
  wikipediaGetLanguages,
];
