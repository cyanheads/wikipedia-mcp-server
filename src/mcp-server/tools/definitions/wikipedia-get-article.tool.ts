/**
 * @fileoverview wikipedia_get_article tool — fetch article content as clean plain text.
 * @module mcp-server/tools/definitions/wikipedia-get-article.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetArticle = tool('wikipedia_get_article', {
  title: 'Get Wikipedia Article',
  description:
    'Fetch article content as clean plain text. Without section_index: returns the full article ' +
    '(40–100KB for major articles) with == Section == markers preserved for structure. ' +
    'With section_index (from wikipedia_get_sections): returns just that section as plain text ' +
    '(1–10KB). Use section targeting when only part of the article is needed.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z.string().describe('Article title.'),
    section_index: z
      .number()
      .optional()
      .describe(
        'Section index from wikipedia_get_sections. Omit for the full article. Providing this returns only the targeted section as plain text.',
      ),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: z.object({
    title: z.string().describe('Resolved article title.'),
    pageid: z
      .number()
      .optional()
      .describe('Wikipedia page ID. Absent on API parse responses that omit it.'),
    content: z
      .string()
      .describe('Plain-text article content. Full articles include == Section == markers.'),
    section_title: z
      .string()
      .optional()
      .describe('Section title when section_index was provided. Absent for full-article reads.'),
    content_type: z.string().describe('Content type: "full_article" or "section".'),
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
      reason: 'invalid_section',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The section_index is out of range for this article.',
      recovery: 'Call wikipedia_get_sections first to obtain valid section_index values.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The language code is not a valid BCP 47 code.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const language = input.language || 'en';

    // Validate language code eagerly so the contract reason appears in data.reason.
    if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    // Reject section_index 0 — wikipedia_get_sections returns indices starting at 1.
    // Index 0 refers to the lead section which wikitext parsing returns as templates/infoboxes
    // (no readable text). Full-article reads handle the lead via the extracts API.
    if (input.section_index === 0) {
      throw ctx.fail(
        'invalid_section',
        'section_index 0 is not valid. Section indices start at 1 (use wikipedia_get_sections to discover valid values). To read the lead section, omit section_index entirely.',
        {
          sectionIndex: 0,
          recovery: {
            hint: 'Use wikipedia_get_sections to get valid indices (starting at 1). Omit section_index to read the full article including its lead section.',
          },
        },
      );
    }

    const svc = getWikipediaService();

    if (input.section_index != null) {
      // Section-targeted path: wikitext + stripping
      ctx.log.info('Fetching article section', {
        title: input.title,
        sectionIndex: input.section_index,
        language,
      });
      const result = await svc.getArticleSection(input.title, input.section_index, language, ctx);
      ctx.log.info('Section fetched', {
        title: result.title,
        sectionTitle: result.sectionTitle,
        contentLength: result.content.length,
      });
      return {
        title: result.title,
        pageid: result.pageid,
        content: result.content,
        section_title: result.sectionTitle,
        content_type: 'section',
        language,
      };
    }

    // Full-article path
    ctx.log.info('Fetching full article', { title: input.title, language });
    const result = await svc.getArticleFull(input.title, language, ctx);
    ctx.log.info('Article fetched', {
      title: result.title,
      contentLength: result.content.length,
    });
    return {
      title: result.title,
      pageid: result.pageid,
      content: result.content,
      content_type: 'full_article',
      language,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title}`);
    lines.push(
      `**Type:** ${result.content_type} | **Language:** ${result.language}` +
        (result.pageid != null ? ` | **Page ID:** ${result.pageid}` : ''),
    );
    if (result.section_title) lines.push(`**Section:** ${result.section_title}`);
    lines.push('');
    lines.push(result.content);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
