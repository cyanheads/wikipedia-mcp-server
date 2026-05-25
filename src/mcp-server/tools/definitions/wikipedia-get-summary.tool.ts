/**
 * @fileoverview wikipedia_get_summary tool — fetch the lead section summary for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-summary.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetSummary = tool('wikipedia_get_summary', {
  title: 'Get Wikipedia Summary',
  description:
    'Fetch the lead-section summary for a Wikipedia article — the 2–4 paragraph intro that answers "what is X?". Returns plain-text extract, Wikidata QID (wikibase_item) for cross-referencing with wikidata-mcp-server, short description, and thumbnail URL. Redirect pages are followed automatically. When page_type is "disambiguation", the title matched a disambiguation page — call wikipedia_search with a more specific query to find the intended article. Prefer this over wikipedia_get_article unless full article depth is needed.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z
      .string()
      .describe('Article title (URL-decoded), e.g. "Python (programming language)".'),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: z.object({
    title: z.string().describe('Resolved article title (may differ from input for redirects).'),
    page_type: z
      .string()
      .describe(
        'Page type from the Wikipedia REST API. Common values: "standard" (regular article), "disambiguation" (disambiguation page), "no-extract" (article with no extract). When "disambiguation", call wikipedia_search with a more specific query.',
      ),
    pageid: z.number().optional().describe('Wikipedia page ID. Absent when the API omits it.'),
    wikibase_item: z
      .string()
      .optional()
      .describe(
        'Wikidata QID (e.g. "Q28865"). Use to chain into wikidata-mcp-server without a separate lookup.',
      ),
    description: z.string().optional().describe('Short description of the article subject.'),
    extract: z.string().describe('Plain-text lead-section extract.'),
    thumbnail_url: z
      .string()
      .optional()
      .describe('URL of the article thumbnail image, if available.'),
    language: z.string().describe('Language edition queried.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Wikipedia article exists for the given title.',
      recovery: 'Use wikipedia_search to discover the correct article title and try again.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The language code is not a valid BCP 47 code.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const { language } = input;

    if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    ctx.log.info('Fetching summary', { title: input.title, language });

    const svc = getWikipediaService();
    let result: Awaited<ReturnType<typeof svc.getSummary>>;
    try {
      result = await svc.getSummary(input.title, language, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, {
          title: input.title,
          language,
          recovery: { hint: 'Use wikipedia_search to find the correct article title.' },
        });
      }
      throw err;
    }

    ctx.log.info('Summary fetched', {
      title: result.title,
      pageType: result.pageType,
      hasQid: Boolean(result.wikidataQid),
    });

    return {
      title: result.title,
      page_type: result.pageType,
      pageid: result.pageid,
      wikibase_item: result.wikidataQid,
      description: result.description,
      extract: result.extract,
      thumbnail_url: result.thumbnailUrl,
      language,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title}`);
    if (result.description) lines.push(`*${result.description}*`);
    lines.push(`**Type:** ${result.page_type} | **Language:** ${result.language}`);
    if (result.pageid != null) lines.push(`**Page ID:** ${result.pageid}`);
    if (result.wikibase_item) lines.push(`**Wikidata QID:** ${result.wikibase_item}`);
    if (result.thumbnail_url) lines.push(`**Thumbnail:** ${result.thumbnail_url}`);
    lines.push('');
    lines.push(result.extract);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
