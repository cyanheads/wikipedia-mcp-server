/**
 * @fileoverview wikipedia_search tool — full-text search across Wikipedia articles.
 * @module mcp-server/tools/definitions/wikipedia-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaSearch = tool('wikipedia_search', {
  title: 'Search Wikipedia',
  description:
    'Search Wikipedia articles by full-text query. Returns ranked results with plain-text titles, ' +
    'snippets (HTML stripped), page IDs, and word counts. Use when the exact article ' +
    'title is unknown or to discover multiple articles on a topic. Returned pageid values ' +
    'identify articles for use in other tools. Supports all Wikipedia language editions.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().describe('Search query — use natural language or key terms.'),
    limit: z
      .number()
      .default(10)
      .describe('Maximum number of results to return (default 10, max 50).'),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            title: z.string().describe('Article title.'),
            pageid: z.number().describe('Wikipedia page ID.'),
            snippet: z.string().describe('Plain-text search snippet with matched terms.'),
            wordcount: z.number().describe('Article word count.'),
          })
          .describe('A single search result entry.'),
      )
      .describe('Ranked search results.'),
    total_results: z.number().describe('Total number of matching results in Wikipedia.'),
    query_used: z.string().describe('The query that was searched.'),
    language: z.string().describe('Language edition queried.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'Search returned zero results for the query.',
      recovery: 'Broaden the query or try different keywords and search again.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The language code is not a valid BCP 47 code.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const limit = Math.min(input.limit, 50);
    const language = input.language || 'en';

    if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    ctx.log.info('Searching Wikipedia', { query: input.query, limit, language });

    const svc = getWikipediaService();
    const { results, totalResults } = await svc.search(input.query, limit, language, ctx);

    if (results.length === 0) {
      throw ctx.fail(
        'no_results',
        `No Wikipedia articles found for query "${input.query}" in language "${language}".`,
        {
          query: input.query,
          language,
          recovery: { hint: `Try different keywords or a broader query than "${input.query}".` },
        },
      );
    }

    ctx.log.info('Search complete', { count: results.length, totalResults, language });

    return {
      results,
      total_results: totalResults,
      query_used: input.query,
      language,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.results.length} of ${result.total_results} results** for "${result.query_used}" (${result.language})\n`,
    ];
    for (const item of result.results) {
      lines.push(`### ${item.title}`);
      lines.push(`**Page ID:** ${item.pageid} | **Words:** ${item.wordcount}`);
      if (item.snippet) lines.push(item.snippet);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
