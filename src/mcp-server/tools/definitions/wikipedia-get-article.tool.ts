/**
 * @fileoverview wikipedia_get_article tool — fetch article content as clean plain text.
 * @module mcp-server/tools/definitions/wikipedia-get-article.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { outlineOnOverflow } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  getWikipediaService,
  isBlankTitle,
  isMalformedLanguage,
  splitArticleIntoSections,
} from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetArticle = tool('wikipedia_get_article', {
  title: 'Get Wikipedia Article',
  description:
    'Fetch article content as clean plain text. Without section_index: returns the full article with == Section == markers preserved for structure — or, when the article exceeds the size budget, a compact section outline (truncated: true) that points to wikipedia_get_sections plus a section_index read instead of the full text. With section_index (from wikipedia_get_sections): returns that section and every subsection nested under it, each heading above its own body. Section-targeted reads are faster and smaller when only part of the article is needed. Data tables are omitted from both paths, so a section whose body is entirely a data table returns its heading and little else; tables used only for layout, such as multi-column lists, keep their content. Page furniture is omitted as well — maintenance banners, sister-project and library-resource boxes, portal bars, and spoken-article notices — while a hatnote naming a related article is kept. Redirect pages are followed automatically.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z.string().describe('Article title (e.g. "Python (programming language)").'),
    section_index: z
      .number()
      .optional()
      .describe(
        'Section index from wikipedia_get_sections. Omit for the full article. Providing this returns the targeted section plus every subsection nested under it, as plain text.',
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
      .describe(
        'Plain-text article content. Both full articles and section reads carry == Section == markers above the text each one heads. When truncated is true, this instead carries a section outline (heading names and byte sizes) plus a pointer to the targeted-read path.',
      ),
    section_title: z
      .string()
      .optional()
      .describe('Section title when section_index was provided. Absent for full-article reads.'),
    content_type: z.string().describe('Content type: "full_article" or "section".'),
    truncated: z
      .boolean()
      .describe(
        'True when a full-article read exceeded the size budget and content is a section outline instead of the full text. Always false for section reads and for full articles within budget.',
      ),
    original_length: z
      .number()
      .optional()
      .describe(
        'Character length of the full article text before outlining. Present only when truncated is true.',
      ),
    sections_suggested: z
      .boolean()
      .optional()
      .describe(
        'True when content is an outline — call wikipedia_get_sections, then wikipedia_get_article with a section_index to read a specific section. Present only when truncated is true.',
      ),
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'The section_index is out of range for this article.',
      recovery: 'Call wikipedia_get_sections first to obtain valid section_index values.',
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

    // Validate language code eagerly so the contract reason appears in data.reason.
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

    // Reject a blank/whitespace-only title before any fetch — once, ahead of the section/full
    // branch, so both paths get a consistent typed error instead of a leaked upstream one.
    if (isBlankTitle(input.title)) {
      throw ctx.fail(
        'not_found',
        'Article title must not be blank. Provide a title, or use wikipedia_search to find one.',
        {
          recovery: {
            hint: 'Provide a non-empty article title, or use wikipedia_search to discover one.',
          },
        },
      );
    }

    // Reject section_index < 1 — indices start at 1 (wikipedia_get_sections output).
    // Index 0 is the lead section, which wikipedia_get_sections never lists and which
    // wikipedia_get_summary and full-article reads already cover; negative values are nonsensical
    // and leak a raw API error.
    if (input.section_index != null && input.section_index < 1) {
      throw ctx.fail(
        'invalid_section',
        `section_index ${input.section_index} is not valid. Section indices start at 1 (use wikipedia_get_sections to discover valid values). To read the lead section, omit section_index entirely.`,
        {
          sectionIndex: input.section_index,
          recovery: {
            hint: 'Use wikipedia_get_sections to get valid indices (starting at 1). Omit section_index to read the full article including its lead section.',
          },
        },
      );
    }

    if (input.section_index != null) {
      // Section-targeted path: the section plus its subsections, rendered to plain text.
      ctx.log.info('Fetching article section', {
        title: input.title,
        sectionIndex: input.section_index,
        language,
      });
      let result: Awaited<ReturnType<typeof svc.getArticleSection>>;
      try {
        result = await svc.getArticleSection(input.title, input.section_index, language, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail('not_found', err.message, {
            title: input.title,
            language,
            recovery: { hint: 'Use wikipedia_search to find the correct article title.' },
          });
        }
        if (err instanceof McpError && err.code === JsonRpcErrorCode.ValidationError) {
          throw ctx.fail('invalid_section', err.message, {
            title: input.title,
            sectionIndex: input.section_index,
            recovery: { hint: 'Call wikipedia_get_sections to obtain valid section_index values.' },
          });
        }
        throw err;
      }
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
        truncated: false,
        language,
      };
    }

    // Full-article path
    ctx.log.info('Fetching full article', { title: input.title, language });
    let result: Awaited<ReturnType<typeof svc.getArticleFull>>;
    try {
      result = await svc.getArticleFull(input.title, language, ctx);
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

    // Overflow handling: pre-shape the article into one key per section (so the primitive
    // measures real sections, not one giant `content` blob), then let outlineOnOverflow decide
    // full vs. outline against this server's domain-tuned byte budget. Section-targeted reads
    // above never reach here, so they are unaffected.
    const originalLength = result.content.length;
    const sectionDoc: Record<string, string> = {};
    const seen = new Map<string, number>();
    for (const { heading, body } of splitArticleIntoSections(result.content)) {
      const n = seen.get(heading) ?? 0;
      seen.set(heading, n + 1);
      // Disambiguate rare duplicate headings so no section is silently collapsed away.
      sectionDoc[n > 0 ? `${heading} (${n + 1})` : heading] = body;
    }

    const reCallNotice =
      'This article is large. Call wikipedia_get_sections to list its section indices, then wikipedia_get_article with a section_index to read a specific section.';
    const overflow = outlineOnOverflow(sectionDoc, {
      budget: getServerConfig().articleOverflowBytes,
      notice: () => reCallNotice,
    });

    ctx.log.info('Article fetched', {
      title: result.title,
      contentLength: originalLength,
      truncated: overflow.kind === 'outline',
    });

    if (overflow.kind === 'outline') {
      const content = [
        `Full article outlined — ${originalLength} characters across ${overflow.sections.length} sections (largest first):`,
        '',
        ...overflow.sections.map((s) => `- ${s.name} — ${s.bytes} bytes`),
        '',
        overflow.notice,
      ].join('\n');
      return {
        title: result.title,
        pageid: result.pageid,
        content,
        content_type: 'full_article',
        truncated: true,
        original_length: originalLength,
        sections_suggested: true,
        language,
      };
    }

    return {
      title: result.title,
      pageid: result.pageid,
      content: result.content,
      content_type: 'full_article',
      truncated: false,
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
    // Overflow disclosure — render each field on its own presence, never as mutually-exclusive
    // branches, so format-parity's all-fields-populated sample renders every field.
    if (result.truncated) {
      lines.push('**Truncated:** full article outlined (exceeds the size budget).');
    }
    if (result.original_length != null) {
      lines.push(`**Original length:** ${result.original_length} characters.`);
    }
    if (result.sections_suggested) {
      lines.push(
        '**Sections suggested** — call wikipedia_get_sections, then wikipedia_get_article with a section_index.',
      );
    }
    lines.push('');
    lines.push(result.content);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
