/**
 * @fileoverview wikipedia_get_languages tool — list language editions available for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-languages.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  getWikipediaService,
  isBlankTitle,
  isMalformedLanguage,
} from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaGetLanguages = tool('wikipedia_get_languages', {
  title: 'Get Wikipedia Article Languages',
  description:
    'List the language editions available for a Wikipedia article. Returns language codes, article titles in each language, and full URLs. Useful for cross-language research and for discovering the correct article title in a target language before fetching it. Redirect pages are followed automatically, and source_title reports the resolved article the links belong to. The language parameter specifies which edition to query from.',
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
    source_title: z
      .string()
      .describe(
        'Resolved article title in the source language edition — the redirect target when the input was an alias.',
      ),
    source_language: z.string().describe('The language edition that was queried.'),
    languages: z
      .array(
        z
          .object({
            language_code: z
              .string()
              .describe(
                'MediaWiki language code from langlinks (e.g. "gsw"). May differ from the Wikipedia subdomain — use edition_code as the `language` input to other tools.',
              ),
            edition_code: z
              .string()
              .optional()
              .describe(
                'Wikipedia edition subdomain that serves this article (e.g. "als"). Pass THIS value as the `language` parameter to other wikipedia-mcp-server tools; language_code is not always a valid edition. Absent when the serving host could not be established — language_code alone does not determine it.',
              ),
            title: z.string().describe('Article title in this language edition.'),
            url: z
              .string()
              .optional()
              .describe(
                'Full URL to the article in this language edition. Absent when the API omitted it and no host is known for the language code.',
              ),
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

    // Reject a blank/whitespace-only title before any fetch — the langlinks query otherwise returns
    // an empty response shape that leaks as a generic serviceUnavailable with no typed reason.
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

    ctx.log.info('Fetching language links', { title: input.title, language });

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
    const { title: resolvedTitle, languages } = getLanguagesResult;

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

    ctx.log.info('Language links fetched', { title: resolvedTitle, count: languages.length });

    return {
      source_title: resolvedTitle,
      source_language: language,
      languages: languages.map((l) => ({
        language_code: l.languageCode,
        ...(l.editionCode && { edition_code: l.editionCode }),
        title: l.title,
        ...(l.url && { url: l.url }),
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
      // An entry whose serving host is unknown carries neither edition_code nor url — say so
      // rather than rendering an empty link the caller cannot follow.
      const target = lang.edition_code
        ? `pass \`language: "${lang.edition_code}"\``
        : 'edition subdomain unavailable';
      const link = lang.url ? `: [article](${lang.url})` : ' (no URL available)';
      lines.push(`- **${lang.title}** — ${target} (code \`${lang.language_code}\`)${link}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
