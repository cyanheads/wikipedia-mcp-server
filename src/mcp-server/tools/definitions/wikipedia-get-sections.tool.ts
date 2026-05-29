/**
 * @fileoverview wikipedia_get_sections tool — fetch the table of contents for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-sections.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetSections = tool('wikipedia_get_sections', {
  title: 'Get Wikipedia Article Sections',
  description:
    'Fetch the table of contents for a Wikipedia article. Returns section titles, heading levels, section numbering (e.g. "2.1"), and section_index values. Pass a section_index to wikipedia_get_article to retrieve just that section. Useful for enumerating article structure before doing a targeted section read.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z.string().describe('Article title (e.g. "Python (programming language)").'),
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
              .describe('Section index — pass to wikipedia_get_article as section_index.'),
            number: z.string().describe('Section number (e.g. "2.1") for hierarchical navigation.'),
            title: z.string().describe('Section heading text.'),
            level: z.number().describe('Heading depth: 2 = ==, 3 = ===, etc.'),
          })
          .describe('A single table-of-contents entry.'),
      )
      .describe('Ordered list of article sections with index values for targeted reads.'),
    total_sections: z.number().describe('Total number of sections in the article.'),
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
      reason: 'no_sections',
      code: JsonRpcErrorCode.NotFound,
      when: 'Article exists but has no sections (stub or very short article).',
      recovery: 'Use wikipedia_get_article without section_index to read the full short article.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
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

    ctx.log.info('Fetching sections', { title: input.title, language });

    const svc = getWikipediaService();
    let result: Awaited<ReturnType<typeof svc.getSections>>;
    try {
      result = await svc.getSections(input.title, language, ctx);
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

    return {
      title: input.title,
      pageid: result.pageid,
      sections: result.sections,
      total_sections: result.sections.length,
      language,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Table of Contents — ${result.title} (${result.language})`,
      `${result.total_sections} sections` +
        (result.pageid != null ? ` | Page ID: ${result.pageid}` : ''),
      '',
    ];
    for (const s of result.sections) {
      const indent = '  '.repeat(Math.max(0, s.level - 2));
      lines.push(`${indent}${s.number}. **${s.title}** (index: ${s.index}, level: ${s.level})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
