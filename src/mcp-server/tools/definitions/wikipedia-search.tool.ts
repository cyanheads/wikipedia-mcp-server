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
    'Search Wikipedia articles by full-text query. Returns ranked results with plain-text titles, snippets (HTML stripped), page IDs, and word counts. Best when the exact article title is unknown or when multiple articles on a topic are needed. Returned pageid values can be passed to other tools. Supports all Wikipedia language editions.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().describe('Search query (e.g. "Python programming language").'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        'Maximum number of results to return (default 10, max 50). Must be a positive integer.',
      ),
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
            title: z.string().describe('Article title (e.g. "Python (programming language)").'),
            pageid: z.number().describe('Wikipedia page ID — use as input to other tools.'),
            snippet: z.string().describe('Plain-text search snippet with matched terms.'),
            wordcount: z.number().describe('Article word count.'),
          })
          .describe('A single search result entry.'),
      )
      .describe('Ranked search results.'),
    language: z.string().describe('Language edition queried.'),
  }),

  // Agent-facing context — query echo, total match count, and optional empty-result
  // notice. Reaches structuredContent AND content[] automatically; disjoint from output.
  enrichment: {
    effectiveQuery: z.string().describe('The query sent to Wikipedia.'),
    totalCount: z.number().describe('Total matching results in Wikipedia.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no results matched — e.g. try different keywords. Absent on successful result pages.',
      ),
  },

  errors: [
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language code is not a valid BCP 47 code.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const { language } = input;
    const limit = Math.min(input.limit, 50);

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

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalResults);

    if (results.length === 0) {
      ctx.enrich.notice(
        `No Wikipedia articles found for "${input.query}" in language "${language}". Try different keywords or a broader query.`,
      );
    }

    ctx.log.info('Search complete', { count: results.length, totalResults, language });

    return { results, language };
  },

  format: (result) => {
    const lines: string[] = [`**${result.results.length} results** (${result.language})\n`];
    for (const item of result.results) {
      lines.push(`### ${item.title}`);
      lines.push(`**Page ID:** ${item.pageid} | **Words:** ${item.wordcount}`);
      if (item.snippet) lines.push(item.snippet);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
