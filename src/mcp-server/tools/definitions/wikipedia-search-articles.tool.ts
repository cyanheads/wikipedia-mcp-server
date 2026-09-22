/**
 * @fileoverview wikipedia_search_articles tool — full-text search across Wikipedia articles.
 * @module mcp-server/tools/definitions/wikipedia-search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdown } from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  isMalformedLanguage,
  SEARCH_MAX_LIMIT,
  SEARCH_RESULT_WINDOW,
} from '@/services/wikipedia/wikipedia-service.js';

/** {@link SEARCH_RESULT_WINDOW} as every caller-facing string spells it. */
const WINDOW = SEARCH_RESULT_WINDOW.toLocaleString('en-US');

export const wikipediaSearchArticles = tool('wikipedia_search_articles', {
  title: 'Search Wikipedia',
  description:
    'Search Wikipedia articles by full-text query. Returns ranked results with plain-text titles, short descriptions, Wikidata QIDs, snippets (HTML stripped), page IDs, and word counts — the description is usually enough to tell same-named articles apart without a summary call per result. When Wikipedia has a spelling correction for the query, it is returned as suggestion. Best when the exact article title is unknown or when multiple articles on a topic are needed. Pass a result title to wikipedia_get_summary, wikipedia_get_article, or wikipedia_get_sections for follow-up reads. Use offset to page beyond the first result page. Supports all Wikipedia language editions.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .describe('Search query (e.g. "Python programming language"). Must not be empty.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_MAX_LIMIT)
      .default(10)
      .describe(
        `Maximum number of results to return per page (default 10, max ${SEARCH_MAX_LIMIT}). Must be a positive integer.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Result offset for pagination (default 0). Pass the nextOffset from a previous response to fetch the next page; limit still governs the per-page size. An offset past the total match count returns an empty result array, not an error. Wikipedia serves no result past ${WINDOW}, so an offset at or beyond that fails — narrow the query instead.`,
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
            description: z
              .string()
              .optional()
              .describe(
                'Short description of the article subject (e.g. "General-purpose programming language"). Absent when the article has none, or when descriptions could not be loaded for the page (see notice).',
              ),
            wikibase_item: z
              .string()
              .optional()
              .describe(
                'Wikidata QID (e.g. "Q28865") for chaining into wikidata-mcp-server. Absent when the article has no Wikidata item, or when it could not be loaded for the page (see notice).',
              ),
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
    truncated: z
      .boolean()
      .optional()
      .describe(
        `True when this page was cut at Wikipedia's ${WINDOW}-result search window and totalCount matches remain that no offset can reach. Absent on every other page, including a genuine last page.`,
      ),
    cap: z
      .number()
      .int()
      .optional()
      .describe(
        'The result ceiling that cut this page — the search window. Present only alongside truncated.',
      ),
    suggestion: z
      .string()
      .optional()
      .describe(
        'Wikipedia\'s spelling correction for the query, when it has one (e.g. "einstein" for "einstien"). Re-run with it as query to search the corrected spelling. Absent when the query has no likely misspelling.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no results matched (naming the spelling suggestion when there is one), when the end of results was reached while paging, when the page was cut at the search window, or when descriptions and Wikidata QIDs could not be loaded for the page. Absent on ordinary result pages.',
      ),
  },
  enrichmentTrailer: {
    suggestion: { label: 'Did you mean' },
  },

  errors: [
    {
      reason: 'empty_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is an empty string, which Wikipedia reads as a missing parameter.',
      recovery:
        'Supply search terms describing the topic, such as a title or a descriptive phrase.',
    },
    {
      reason: 'offset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The offset is at or past the search window, which has no continuation.',
      recovery:
        'Narrow the query with more specific terms rather than paging further into the result set.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language is not a valid BCP 47 code, or names a Wikipedia edition that does not exist.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const { language, limit } = input;
    const svc = getWikipediaService();

    if (isMalformedLanguage(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    // Reject a code that names no Wikipedia edition, checked against the live sitematrix registry
    // (skipped when a single-instance base-URL override is set — that host may serve any editions).
    if (await svc.isUnknownEdition(language, ctx)) {
      throw ctx.fail(
        'invalid_language',
        `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    // Reject an empty query before the fetch: upstream reads `srsearch=` as unset and answers with
    // an error envelope on HTTP 200, which rendered as a successful "no articles found". A
    // whitespace-only query is a different thing — a legitimate search that really matches nothing.
    if (input.query === '') {
      throw ctx.fail(
        'empty_query',
        'Search query must not be empty. Provide search terms, such as an article title or a descriptive phrase.',
        { ...ctx.recoveryFor('empty_query') },
      );
    }

    // Reject an offset at or past the search window before the fetch, for the same reason: upstream
    // refuses it with `cirrussearch-offset-too-large` inside a 200 response.
    if (input.offset >= SEARCH_RESULT_WINDOW) {
      throw ctx.fail(
        'offset_too_large',
        `Offset ${input.offset} is at or past Wikipedia's ${WINDOW}-result search window, which has no continuation. Narrow the query instead of paging further.`,
        { offset: input.offset, ...ctx.recoveryFor('offset_too_large') },
      );
    }

    ctx.log.info('Searching Wikipedia', {
      query: input.query,
      limit,
      offset: input.offset,
      language,
    });

    const { results, totalResults, nextOffset, suggestion, descriptionsUnavailable } =
      await svc.search(input.query, limit, language, ctx, input.offset);

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalResults);
    ctx.enrich({
      offset: input.offset,
      shown: results.length,
      ...(nextOffset != null ? { nextOffset } : {}),
      ...(suggestion ? { suggestion } : {}),
    });

    // `notice` is last-wins, so every condition that has something to say contributes a segment
    // and the page carries them as one notice.
    const notices: string[] = [];
    if (results.length === 0) {
      notices.push(
        input.offset > 0
          ? `No results at offset ${input.offset} for "${input.query}" in language "${language}"${totalResults ? ` (total matches: ${totalResults})` : ''}. The end of the result set was reached — lower the offset to page back.`
          : `No Wikipedia articles found for "${input.query}" in language "${language}". Try different keywords or a broader query.${suggestion ? ` Did you mean "${suggestion}"? Re-run with that query.` : ''}`,
      );
    }
    if (descriptionsUnavailable) {
      notices.push(
        'Descriptions and Wikidata QIDs could not be loaded for this page, so results carry neither. wikipedia_get_summary returns both for any one title, or re-run the search to retry.',
      );
    }

    // A page that ends on the search window looks exactly like the last page of results — full
    // page, no continuation — while matches remain that no offset reaches. Say so, because the
    // only route to them is a narrower query.
    const reached = input.offset + results.length;
    if (results.length > 0 && reached >= SEARCH_RESULT_WINDOW && totalResults > reached) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: SEARCH_RESULT_WINDOW,
        guidance: [
          `Wikipedia serves at most ${WINDOW} results per query, and this page ends there. ${totalResults - reached} further matches exist but no offset reaches them — narrow the query with more specific terms to bring them into the first ${WINDOW}.`,
          ...notices,
        ].join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Search complete', {
      count: results.length,
      totalResults,
      offset: input.offset,
      nextOffset,
      language,
      descriptionsUnavailable,
    });

    return { results, language };
  },

  // Upstream text is escaped on the way into the markdown; structuredContent keeps it raw.
  format: (result) => {
    const lines: string[] = [`**${result.results.length} results** (${result.language})\n`];
    for (const item of result.results) {
      lines.push(`### ${escapeMarkdown(item.title)}`);
      if (item.description) lines.push(`*${escapeMarkdown(item.description)}*`);
      lines.push(
        `**Page ID:** ${item.pageid} | **Words:** ${item.wordcount}${item.wikibase_item ? ` | **Wikidata QID:** ${item.wikibase_item}` : ''}`,
      );
      if (item.snippet) lines.push(escapeMarkdown(item.snippet));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
