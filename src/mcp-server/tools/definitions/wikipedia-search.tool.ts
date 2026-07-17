/**
 * @fileoverview wikipedia_search tool — full-text search across Wikipedia articles.
 * @module mcp-server/tools/definitions/wikipedia-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService, isUnknownEdition } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaSearch = tool('wikipedia_search', {
  title: 'Search Wikipedia',
  description:
    'Search Wikipedia articles by full-text query. Returns ranked results with plain-text titles, snippets (HTML stripped), page IDs, and word counts. Best when the exact article title is unknown or when multiple articles on a topic are needed. Pass a result title to wikipedia_get_summary, wikipedia_get_article, or wikipedia_get_sections for follow-up reads. Use offset to page beyond the first result page. Supports all Wikipedia language editions.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().describe('Search query (e.g. "Python programming language").'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        'Maximum number of results to return per page (default 10, max 50). Must be a positive integer.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset for pagination (default 0). Pass the nextOffset from a previous response to fetch the next page; limit still governs the per-page size. An offset past the total match count returns an empty result array, not an error.',
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
            pageid: z
              .number()
              .describe(
                'Stable numeric Wikipedia page ID — a durable reference for cross-referencing or de-duplication. Not a tool input; pass the title to follow-up tools.',
              ),
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
    offset: z
      .number()
      .int()
      .describe('The result offset applied to this page (echo of the input).'),
    shown: z.number().int().describe('Number of results returned on this page.'),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset to request the next page. Present only when more results remain — pass it back as offset to continue; absent at the end of results.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no results matched — e.g. try different keywords, or that the end of results was reached when paging. Absent on successful result pages.',
      ),
  },

  errors: [
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language is not a valid BCP 47 code, or names a Wikipedia edition that does not exist.',
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

    // Reject a structurally-valid code that names no Wikipedia edition (skipped when a
    // single-instance base-URL override is set — that host may serve any editions).
    if (isUnknownEdition(language)) {
      throw ctx.fail(
        'invalid_language',
        `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    ctx.log.info('Searching Wikipedia', {
      query: input.query,
      limit,
      offset: input.offset,
      language,
    });

    const svc = getWikipediaService();
    const { results, totalResults, nextOffset } = await svc.search(
      input.query,
      limit,
      language,
      ctx,
      input.offset,
    );

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalResults);
    ctx.enrich({
      offset: input.offset,
      shown: results.length,
      ...(nextOffset != null ? { nextOffset } : {}),
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        input.offset > 0
          ? `No results at offset ${input.offset} for "${input.query}" in language "${language}"${totalResults ? ` (total matches: ${totalResults})` : ''}. The end of the result set was reached — lower the offset to page back.`
          : `No Wikipedia articles found for "${input.query}" in language "${language}". Try different keywords or a broader query.`,
      );
    }

    ctx.log.info('Search complete', {
      count: results.length,
      totalResults,
      offset: input.offset,
      nextOffset,
      language,
    });

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
