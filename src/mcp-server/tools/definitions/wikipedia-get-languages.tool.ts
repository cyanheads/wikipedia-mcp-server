/**
 * @fileoverview wikipedia_get_languages tool — list language editions available for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-languages.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetLanguages = tool('wikipedia_get_languages', {
  title: 'Get Wikipedia Article Languages',
  description:
    'List the language editions available for a Wikipedia article. Returns language codes, article titles in each language, and full URLs. Useful for cross-language research and for discovering the correct article title in a target language before fetching it. The language parameter specifies which edition to query from.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z.string().describe('Article title in the source language edition.'),
    language: z
      .string()
      .default('en')
      .describe(
        'Wikipedia language edition to query from (default "en"). Examples: "fr", "de", "ja".',
      ),
  }),
  output: z.object({
    source_title: z.string().describe('Article title in the source language edition.'),
    source_language: z.string().describe('The language edition that was queried.'),
    languages: z
      .array(
        z
          .object({
            language_code: z.string().describe('BCP 47 language code (e.g. "fr", "de").'),
            title: z.string().describe('Article title in this language edition.'),
            url: z.string().describe('Full URL to the article in this language edition.'),
          })
          .describe('A single language edition entry.'),
      )
      .describe('Available language editions excluding the source language.'),
    total_languages: z.number().describe('Total number of other language editions available.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Wikipedia article exists for the title in the specified language.',
      recovery: 'Use wikipedia_search to discover the correct article title and try again.',
    },
    {
      reason: 'no_other_languages',
      code: JsonRpcErrorCode.NotFound,
      when: 'Article exists but has no other language editions.',
      recovery: 'The article may be too new or too regional to have been translated yet.',
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

    ctx.log.info('Fetching language links', { title: input.title, language });

    const svc = getWikipediaService();
    let getLanguagesResult: Awaited<ReturnType<typeof svc.getLanguages>>;
    try {
      getLanguagesResult = await svc.getLanguages(input.title, language, ctx);
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
    const { languages } = getLanguagesResult;

    if (languages.length === 0) {
      throw ctx.fail(
        'no_other_languages',
        `Article "${input.title}" in language "${language}" has no other language editions.`,
        {
          title: input.title,
          language,
          ...ctx.recoveryFor('no_other_languages'),
        },
      );
    }

    ctx.log.info('Language links fetched', { title: input.title, count: languages.length });

    return {
      source_title: input.title,
      source_language: language,
      languages: languages.map((l) => ({
        language_code: l.languageCode,
        title: l.title,
        url: l.url,
      })),
      total_languages: languages.length,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Language editions for "${result.source_title}" (${result.source_language})`,
      `**${result.total_languages} languages available**\n`,
    ];
    for (const lang of result.languages) {
      lines.push(`- **${lang.language_code}**: [${lang.title}](${lang.url})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
