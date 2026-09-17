/**
 * @fileoverview wikipedia_get_sections tool — fetch the table of contents for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-sections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdown } from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  isBlankTitle,
  isInvalidTitle,
  isMalformedLanguage,
  LEAD_SECTION_INDEX,
  LEAD_SECTION_TITLE,
} from '@/services/wikipedia/wikipedia-service.js';

/**
 * The lead — the text above the first heading — as a table-of-contents entry.
 *
 * Wikipedia's own table of contents starts at the first heading, so the lead has no upstream row;
 * without one, the section an agent most often wants is the one section this tool never names.
 * Level 1 places it above every `==` section, matching where the page puts it.
 */
const LEAD_SECTION_ENTRY = {
  index: LEAD_SECTION_INDEX,
  number: String(LEAD_SECTION_INDEX),
  title: LEAD_SECTION_TITLE,
  level: 1,
} as const;

export const wikipediaGetSections = tool('wikipedia_get_sections', {
  title: 'Get Wikipedia Article Sections',
  description:
    'Fetch the table of contents for a Wikipedia article. Returns section titles, heading levels, section numbering (e.g. "2.1"), and section_index values. The first entry is the lead section, index 0, titled Introduction — the text above the first heading, which Wikipedia\'s own table of contents omits. Pass a section_index to wikipedia_get_article to retrieve just that section. Useful for enumerating article structure before doing a targeted section read. Redirect pages are followed automatically.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z
      .string()
      .describe(
        'Article title (e.g. "Python (programming language)"). A trailing #fragment is accepted and ignored; the characters < > [ ] { } and | cannot appear in a Wikipedia page name.',
      ),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: z.object({
    title: z.string().describe('Article title as resolved by Wikipedia.'),
    pageid: z.number().optional().describe('Wikipedia page ID. Absent for stub articles.'),
    sections: z
      .array(
        z
          .object({
            index: z
              .number()
              .describe(
                'Section index — pass to wikipedia_get_article as section_index. 0 is the lead section.',
              ),
            number: z
              .string()
              .describe(
                'Section number (e.g. "2.1") for hierarchical navigation; "0" for the lead section.',
              ),
            title: z
              .string()
              .describe('Section heading text; "Introduction" for the lead, which has no heading.'),
            level: z
              .number()
              .describe('Heading depth: 2 = ==, 3 = ===, etc. The lead section reports 1.'),
          })
          .describe('A single table-of-contents entry.'),
      )
      .describe(
        'Article sections in document order with index values for targeted reads, led by the index-0 lead entry.',
      ),
    total_sections: z
      .number()
      .describe('Number of entries returned, counting the index-0 lead section.'),
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
      reason: 'no_sections',
      code: JsonRpcErrorCode.NotFound,
      when: 'Article exists but has no sections (stub or very short article).',
      recovery: 'Use wikipedia_get_article without section_index to read the full short article.',
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

    // Reject a blank/whitespace-only title before any fetch — the parse API otherwise returns a
    // generic "Bad title" error that bypasses this tool's typed contract.
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

    // Reject a title MediaWiki cannot name a page with, before any fetch — the parse API otherwise
    // answers `invalidtitle`, and `Cat|Dog` resolves to a different article entirely.
    if (isInvalidTitle(input.title)) {
      throw ctx.fail(
        'invalid_title',
        `Article title "${input.title}" is not a valid Wikipedia page name. The characters < > [ ] { } and | are not allowed in a title, nor are percent escapes (%41), three or more tildes, or relative paths; a trailing #fragment is fine.`,
        { title: input.title, ...ctx.recoveryFor('invalid_title') },
      );
    }

    ctx.log.info('Fetching sections', { title: input.title, language });

    let result: Awaited<ReturnType<typeof svc.getSections>>;
    try {
      result = await svc.getSections(input.title, language, ctx);
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

    if (result.sections.length === 0) {
      throw ctx.fail(
        'no_sections',
        `Article "${input.title}" exists but has no sections. It may be a stub.`,
        {
          title: input.title,
          recovery: {
            hint: 'Use wikipedia_get_article without section_index to read the full article content.',
          },
        },
      );
    }

    ctx.log.info('Sections fetched', { title: input.title, count: result.sections.length });

    // The lead is prepended here rather than in the service so `no_sections` keeps meaning "this
    // article has no headed sections" — upstream's own table of contents is what that judges.
    const sections = [LEAD_SECTION_ENTRY, ...result.sections];

    return {
      // Resolved title from the service (redirects are followed), not the raw input alias.
      title: result.title,
      pageid: result.pageid,
      sections,
      total_sections: sections.length,
      language,
    };
  },

  // Upstream titles are escaped on the way into the markdown; structuredContent keeps them raw.
  format: (result) => {
    const lines: string[] = [
      `## Table of Contents — ${escapeMarkdown(result.title)} (${result.language})`,
      `${result.total_sections} sections` +
        (result.pageid != null ? ` | Page ID: ${result.pageid}` : ''),
      '',
    ];
    for (const s of result.sections) {
      const indent = '  '.repeat(Math.max(0, s.level - 2));
      lines.push(
        `${indent}${s.number}. **${escapeMarkdown(s.title)}** (index: ${s.index}, level: ${s.level})`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
