/**
 * @fileoverview wikipedia_get_languages tool — list language editions available for a Wikipedia article.
 * @module mcp-server/tools/definitions/wikipedia-get-languages.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdown } from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  isBlankTitle,
  isInvalidTitle,
  isMalformedLanguage,
} from '@/services/wikipedia/wikipedia-service.js';

/** One langlink as the tool returns it, before the `editions` filter selects from the set. */
type LanguageEntry = {
  language_code: string;
  edition_code?: string;
  title: string;
  url?: string;
};

/**
 * One edition code in the form both sides of the `editions` filter are compared in. Codes are
 * matched case-insensitively, and a caller's stray surrounding space is not a reason to report an
 * edition missing.
 */
function normalizeEditionCode(code: string): string {
  return code.trim().toLowerCase();
}

/** Every code an entry answers to — its language code, and its subdomain when the two differ. */
function codesFor(entry: LanguageEntry): string[] {
  const language = normalizeEditionCode(entry.language_code);
  return entry.edition_code === undefined
    ? [language]
    : [language, normalizeEditionCode(entry.edition_code)];
}

/**
 * Select the requested editions out of an article's full langlink set, and report which requested
 * codes matched nothing.
 *
 * A local selection rather than a narrower upstream request: `prop=langlinks`' `lllang` parameter
 * is single-valued, so several codes have no request shape of their own and the one `lllimit=500`
 * fetch already holds every candidate.
 */
function applyEditionsFilter(
  entries: LanguageEntry[],
  requested: string[],
): { matched: LanguageEntry[]; missing: string[] } {
  const wanted = new Set(requested.map(normalizeEditionCode));
  const matched = entries.filter((entry) => codesFor(entry).some((code) => wanted.has(code)));
  const found = new Set(matched.flatMap(codesFor));
  return {
    matched,
    // Echoed as passed, so the caller reads back the spelling it sent.
    missing: requested.filter((code) => !found.has(normalizeEditionCode(code))),
  };
}

export const wikipediaGetLanguages = tool('wikipedia_get_languages', {
  title: 'Get Wikipedia Article Languages',
  description:
    'List the language editions available for a Wikipedia article. Returns language codes, article titles in each language, and full URLs. Useful for cross-language research and for discovering the correct article title in a target language before fetching it. A popular article exists in hundreds of editions, so pass editions to narrow the answer to the codes you care about — the codes with no article come back under missing, and total_languages still reports the full count. Redirect pages are followed automatically, and source_title reports the resolved article the links belong to. The language parameter specifies which edition to query from.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z
      .string()
      .describe(
        'Article title in the source language edition. A trailing #fragment is accepted and ignored; the characters < > [ ] { } and | cannot appear in a Wikipedia page name.',
      ),
    language: z
      .string()
      .default('en')
      .describe(
        'Wikipedia language edition to query from (default "en"). Examples: "fr", "de", "ja".',
      ),
    editions: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Edition codes to keep, e.g. ["fr", "de", "gsw"]. Each is matched case-insensitively against both edition_code and language_code, so either spelling of a mismatch edition finds it ("gsw" matches the edition whose edition_code is "als"). Omit to list every edition. A code with no article for this title is reported under missing rather than dropped, and is not a failure.',
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
      .describe(
        'Available language editions excluding the source language. Narrowed to the requested codes when editions was given, and empty when none of them matched.',
      ),
    total_languages: z
      .number()
      .describe(
        'Total number of other language editions the article has. Always the unfiltered count, so it exceeds the length of languages whenever editions narrowed the list.',
      ),
    missing: z
      .array(z.string())
      .optional()
      .describe(
        'Requested edition codes with no article for this title, echoed as they were passed. Present whenever editions was given — empty when every code matched — and absent otherwise.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Wikipedia article exists for the title in the specified language.',
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
        'Article title must not be blank. Provide a title, or use wikipedia_search_articles to find one.',
        {
          recovery: {
            hint: 'Provide a non-empty article title, or use wikipedia_search_articles to discover one.',
          },
        },
      );
    }

    // Reject a title MediaWiki cannot name a page with, before any fetch — `Cat|Dog` is two titles
    // to the langlinks query, which answered it with the `Cat` article's 278 language links.
    if (isInvalidTitle(input.title)) {
      throw ctx.fail(
        'invalid_title',
        `Article title "${input.title}" is not a valid Wikipedia page name. The characters < > [ ] { } and | are not allowed in a title, nor are percent escapes (%41), three or more tildes, or relative paths; a trailing #fragment is fine.`,
        { title: input.title, ...ctx.recoveryFor('invalid_title') },
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
          recovery: { hint: 'Use wikipedia_search_articles to find the correct article title.' },
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

    const entries: LanguageEntry[] = languages.map((l) => ({
      language_code: l.languageCode,
      ...(l.editionCode && { edition_code: l.editionCode }),
      title: l.title,
      ...(l.url && { url: l.url }),
    }));

    // `no_other_languages` was decided above on the unfiltered set, so a filter that matches
    // nothing on an article that does have editions stays a success with an empty list.
    const filter = input.editions ? applyEditionsFilter(entries, input.editions) : undefined;

    ctx.log.info('Language links fetched', {
      title: resolvedTitle,
      count: entries.length,
      ...(filter && { requested: input.editions?.length, matched: filter.matched.length }),
    });

    return {
      source_title: resolvedTitle,
      source_language: language,
      languages: filter?.matched ?? entries,
      // Always the unfiltered count — the filter narrows what is returned, not what exists.
      total_languages: entries.length,
      ...(filter && { missing: filter.missing }),
    };
  },

  // Upstream titles are escaped on the way into the markdown; structuredContent keeps them raw.
  // Edition codes stay in code spans, which suppress markdown on their own, and a URL is left
  // intact so the link stays followable.
  format: (result) => {
    // `missing` is present exactly when the caller passed `editions`, so it is also what says
    // whether the list below is the whole set or the slice that was asked for.
    const filtered = result.missing !== undefined;
    const lines: string[] = [
      `## Language editions for "${escapeMarkdown(result.source_title)}" (${result.source_language})`,
      filtered
        ? `**${result.languages.length} of ${result.total_languages} languages available** (narrowed to the requested editions)`
        : `**${result.total_languages} languages available**`,
    ];
    if (result.missing?.length) {
      lines.push(
        `**No article in:** ${result.missing.map((code) => escapeMarkdown(code)).join(', ')}`,
      );
    } else if (filtered) {
      lines.push('**Every requested edition matched.**');
    }
    lines.push('');
    for (const lang of result.languages) {
      // An entry whose serving host is unknown carries neither edition_code nor url — say so
      // rather than rendering an empty link the caller cannot follow.
      const target = lang.edition_code
        ? `pass \`language: "${lang.edition_code}"\``
        : 'edition subdomain unavailable';
      const link = lang.url ? `: [article](${lang.url})` : ' (no URL available)';
      lines.push(
        `- **${escapeMarkdown(lang.title)}** — ${target} (code \`${lang.language_code}\`)${link}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
