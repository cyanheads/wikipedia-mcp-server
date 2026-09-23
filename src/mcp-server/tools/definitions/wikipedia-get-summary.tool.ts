/**
 * @fileoverview wikipedia_get_summary tool — fetch the lead section summary for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-summary.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdown,
  escapeMarkdownOutsideBlocks,
} from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  isBlankTitle,
  isInvalidTitle,
  isMalformedLanguage,
} from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetSummary = tool('wikipedia_get_summary', {
  title: 'Get Wikipedia Summary',
  description:
    'Fetch the short article summary that answers "what is X?". The extract is a truncated fragment from the start of the lead section — usually a sentence or two, and as little as a tenth of the lead — alongside the Wikidata QID (wikibase_item) for cross-referencing with wikidata-mcp-server, a short description, a thumbnail URL, the canonical article URL, the revision the extract was read from, and, for a geotagged article, latitude and longitude that pass straight to wikipedia_search_nearby to answer "what else is notable near this". For the lead section in full, call wikipedia_get_article with section_index 0. Redirect pages are followed automatically. When page_type is "disambiguation", the title matched a disambiguation page — call wikipedia_search_articles with a more specific query to find the intended article. Prefer this over wikipedia_get_article unless article depth is needed.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z
      .string()
      .describe(
        'Article title (URL-decoded), e.g. "Python (programming language)". A trailing #fragment is accepted and ignored; the characters < > [ ] { } and | cannot appear in a Wikipedia page name.',
      ),
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
        'Page type from the Wikipedia REST API. Common values: "standard" (regular article), "disambiguation" (disambiguation page), "no-extract" (article with no extract). When "disambiguation", call wikipedia_search_articles with a more specific query.',
      ),
    pageid: z.number().optional().describe('Wikipedia page ID. Absent when the API omits it.'),
    wikibase_item: z
      .string()
      .optional()
      .describe(
        'Wikidata QID (e.g. "Q28865"). Use to chain into wikidata-mcp-server without a separate lookup.',
      ),
    description: z.string().optional().describe('Short description of the article subject.'),
    extract: z
      .string()
      .describe(
        'Plain-text summary extract — a truncated fragment from the start of the lead section, not the whole lead. Superscripts and subscripts stay apart from the text beside them (10²³, H₂O), as wikipedia_get_article renders them. Call wikipedia_get_article with section_index 0 for the full lead.',
      ),
    thumbnail_url: z
      .string()
      .optional()
      .describe('URL of the article thumbnail image, if available.'),
    latitude: z
      .number()
      .optional()
      .describe(
        'WGS 84 latitude of the article subject in decimal degrees. Pass with longitude to wikipedia_search_nearby, whose inputs carry these names, to find other notable articles around the same point. Absent for an article that is not geotagged.',
      ),
    longitude: z
      .number()
      .optional()
      .describe(
        'WGS 84 longitude of the article subject in decimal degrees. Pass with latitude to wikipedia_search_nearby, whose inputs carry these names, to find other notable articles around the same point. Absent for an article that is not geotagged.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'Canonical desktop URL of the article (e.g. "https://en.wikipedia.org/wiki/Eiffel_Tower"), for citing the page rather than composing a URL from the title.',
      ),
    revision_id: z
      .string()
      .optional()
      .describe(
        'ID of the revision the extract was read from. "https://<edition>.wikipedia.org/w/index.php?oldid=<revision_id>" is a permanent link to exactly that version.',
      ),
    last_modified: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of that revision, for dating the content.'),
    language: z.string().describe('Language edition queried.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Wikipedia article exists for the given title.',
      recovery:
        'Use wikipedia_search_articles to discover the correct article title and try again.',
    },
    {
      reason: 'invalid_title',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The title contains characters MediaWiki cannot name a page with.',
      recovery:
        'Use wikipedia_search_articles to find the exact article title and pass it verbatim.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language is not a valid BCP 47 code, or names a Wikipedia edition that does not exist.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const { language } = input;
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

    // Reject a blank/whitespace-only title before any fetch — otherwise the REST endpoint returns a
    // 403 whose raw error carries the fetch URL, bypassing this tool's typed contract.
    if (isBlankTitle(input.title)) {
      throw ctx.fail(
        'not_found',
        'Article title must not be blank. Provide a title, or use wikipedia_search_articles to find one.',
        {
          recovery: {
            hint: 'Provide a non-empty article title, or use wikipedia_search_articles to discover one.',
          },
        },
      );
    }

    // Reject a title MediaWiki cannot name a page with, before any fetch — the REST endpoint
    // otherwise answers 403 or retries a 500 four times, both leaking the fetch URL.
    if (isInvalidTitle(input.title)) {
      throw ctx.fail(
        'invalid_title',
        `Article title "${input.title}" is not a valid Wikipedia page name. The characters < > [ ] { } and | are not allowed in a title, nor are percent escapes (%41), three or more tildes, or relative paths; a trailing #fragment is fine.`,
        { title: input.title, ...ctx.recoveryFor('invalid_title') },
      );
    }

    ctx.log.info('Fetching summary', { title: input.title, language });

    let result: Awaited<ReturnType<typeof svc.getSummary>>;
    try {
      result = await svc.getSummary(input.title, language, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, {
          title: input.title,
          language,
          recovery: { hint: 'Use wikipedia_search_articles to find the correct article title.' },
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
      latitude: result.latitude,
      longitude: result.longitude,
      url: result.url,
      revision_id: result.revisionId,
      last_modified: result.lastModified,
      language,
    };
  },

  // Upstream text is escaped on the way into the markdown; structuredContent keeps it raw.
  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${escapeMarkdown(result.title)}`);
    if (result.description) lines.push(`*${escapeMarkdown(result.description)}*`);
    lines.push(`**Type:** ${result.page_type} | **Language:** ${result.language}`);
    if (result.pageid != null) lines.push(`**Page ID:** ${result.pageid}`);
    if (result.wikibase_item) lines.push(`**Wikidata QID:** ${result.wikibase_item}`);
    if (result.thumbnail_url) lines.push(`**Thumbnail:** ${result.thumbnail_url}`);
    if (result.url) lines.push(`**URL:** ${result.url}`);
    // Each coordinate renders on its own presence rather than as a pair, so format-parity's
    // all-fields-populated sample renders both and a half-populated result cannot go silent.
    if (result.latitude != null) lines.push(`**Latitude:** ${result.latitude}`);
    if (result.longitude != null) lines.push(`**Longitude:** ${result.longitude}`);
    if (result.latitude != null && result.longitude != null) {
      lines.push(
        '**Nearby:** pass latitude and longitude to wikipedia_search_nearby for other notable articles around this point.',
      );
    }
    if (result.revision_id) lines.push(`**Revision ID:** ${result.revision_id}`);
    if (result.last_modified) lines.push(`**Last modified:** ${result.last_modified}`);
    lines.push('');
    // The extract comes from the same renderer as an article read, so a fenced code block or a
    // table row it writes passes through as syntax while the prose around it is escaped.
    lines.push(escapeMarkdownOutsideBlocks(result.extract));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
