/**
 * @fileoverview wikipedia_get_references tool — list an article's footnotes with their links and DOIs.
 * @module mcp-server/tools/definitions/wikipedia-get-references.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdown,
  escapeMarkdownOutsideBlocks,
  urlLink,
} from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  isBlankTitle,
  isInvalidTitle,
  isMalformedLanguage,
  REFERENCES_PAGE_MAX_BYTES,
  referencesContinuation,
  referencesCursor,
} from '@/services/wikipedia/wikipedia-service.js';

const NO_REFERENCES_NOTICE =
  'This article has no footnotes. A bibliography, further-reading, or external-links section is not a footnote list: find it with wikipedia_get_sections and read it with wikipedia_get_article.';

const ReferenceSchema = z
  .object({
    id: z.string().describe('Anchor id of the footnote (e.g. "cite_note-sandre-2").'),
    group: z
      .string()
      .optional()
      .describe(
        'Notes group the footnote belongs to (e.g. "lower-alpha", "N"). Absent for the main reference list.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'In-text marker without brackets (e.g. "2", "a", "N 1"). Absent when no marker in the article links to the footnote.',
      ),
    text: z
      .string()
      .describe(
        'Footnote text as plain text. Markers of other footnotes inside it are kept as [label].',
      ),
    urls: z
      .array(z.string())
      .optional()
      .describe('Every external link in the footnote, verbatim, archive copies included.'),
    dois: z.array(z.string()).optional().describe('DOIs from doi.org links, percent-decoded.'),
    work_ids: z
      .array(z.string())
      .optional()
      .describe(
        'CITEREF anchors a short citation links to. The citations they name are in works on the same page.',
      ),
  })
  .describe('One footnote.');

const WorkSchema = z
  .object({
    id: z.string().describe('CITEREF anchor id of the full citation (e.g. "CITEREFGalinsky2012").'),
    text: z.string().describe('Full citation as plain text.'),
    urls: z
      .array(z.string())
      .optional()
      .describe('Every external link in the citation, verbatim, archive copies included.'),
    dois: z.array(z.string()).optional().describe('DOIs from doi.org links, percent-decoded.'),
  })
  .describe('One full citation.');

const OutputSchema = z.object({
  title: z.string().describe('Resolved article title.'),
  pageid: z
    .number()
    .optional()
    .describe('Wikipedia page ID. Absent on API parse responses that omit it.'),
  url: z
    .string()
    .optional()
    .describe(
      'Canonical desktop URL of the article (e.g. "https://en.wikipedia.org/wiki/Seine"), for citing the page.',
    ),
  revision_id: z
    .string()
    .describe(
      'ID of the revision the footnotes were read from. Every page of one read carries the same revision.',
    ),
  redirected_from: z
    .string()
    .optional()
    .describe('Original alias followed to the resolved article.'),
  total_references: z
    .number()
    .describe('Footnotes in the article across every reference list, on all pages.'),
  references: z
    .array(ReferenceSchema)
    .describe('Footnotes on this page, in document order. Empty when the article has none.'),
  works: z
    .array(WorkSchema)
    .describe(
      'Full citations the work_ids on this page resolve to, each once. A work_id with no matching anchor in the article has no entry.',
    ),
  next_cursor: z
    .string()
    .optional()
    .describe(
      'Pass unchanged as cursor with the same title and language for the next page. Absent on the last page.',
    ),
});

type ReferencesOutput = z.infer<typeof OutputSchema>;

export const wikipediaGetReferences = tool('wikipedia_get_references', {
  title: 'Get Wikipedia References',
  description:
    'List the footnotes an article cites — its reference lists, in document order — with each footnote\'s text, external links (archive copies included), and DOIs. wikipedia_get_article drops footnote markers and reference lists, so use this for the sources behind a claim. label is the in-text marker without brackets; group names a notes list such as "lower-alpha" and is absent for the main list. A short citation such as "Galinsky 2012, pp. 75–76" carries work_ids, and works on the same page holds the full citations they name, each once. Pages hold whole footnotes within 40,000 UTF-8 bytes on both surfaces; follow next_cursor as cursor with the same title and language to continue at the same revision. Bibliography and further-reading entries no footnote points to are not listed — read those sections with wikipedia_get_article. Redirects are followed; the revision_id and url cite the article read.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    title: z
      .string()
      .describe(
        'Article title (e.g. "Seine"). A trailing #fragment is accepted and ignored; the characters < > [ ] { } and | cannot appear in a Wikipedia page name.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque next_cursor from the previous page. Keep title and language unchanged. Empty means the first page.',
      ),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: OutputSchema,

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Where to look instead when the article has no footnotes.'),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Wikipedia article exists for the given title, or the title is blank.',
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
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed, was issued for another title or language, or points past the last footnote.',
      recovery:
        'Pass the previous next_cursor unchanged with the same title and language, or omit cursor to start again.',
      thrownBy: 'service',
    },
    {
      reason: 'revision_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The revision the cursor is pinned to no longer exists, is hidden, or cannot be read or verified.',
      recovery:
        'Retry the same cursor if the failure was transient; if the pinned revision no longer exists or is hidden, omit cursor to start over at the current revision.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { language } = input;
    const svc = getWikipediaService();
    const continuation = referencesContinuation(input.title, language, input.cursor, ctx);

    if (isMalformedLanguage(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language },
      );
    }
    if (await svc.isUnknownEdition(language, ctx)) {
      throw ctx.fail(
        'invalid_language',
        `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
        { language },
      );
    }
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
    if (isInvalidTitle(input.title)) {
      throw ctx.fail(
        'invalid_title',
        `Article title "${input.title}" is not a valid Wikipedia page name. The characters < > [ ] { } and | are not allowed in a title, nor are percent escapes (%41), three or more tildes, or relative paths; a trailing #fragment is fine.`,
        { title: input.title },
      );
    }

    ctx.log.info('Fetching references', {
      title: input.title,
      language,
      offset: continuation?.offset ?? 0,
    });
    let result: Awaited<ReturnType<typeof svc.getReferences>>;
    try {
      result = await svc.getReferences(input.title, language, ctx, continuation);
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

    const offset = continuation?.offset ?? 0;
    const total = result.references.length;
    const page = (count: number): ReferencesOutput => {
      const references = result.references.slice(offset, offset + count);
      const workIds = new Set(references.flatMap((entry) => entry.work_ids ?? []));
      const next = offset + count;
      return {
        title: result.title,
        pageid: result.pageid,
        url: result.url,
        revision_id: String(result.revisionId),
        ...(result.redirect?.redirected_from && {
          redirected_from: result.redirect.redirected_from,
        }),
        total_references: total,
        references,
        works: [...workIds].flatMap((id) => result.works.get(id) ?? []),
        ...(next < total && {
          next_cursor: referencesCursor(input.title, language, result.revisionId, next),
        }),
      };
    };

    if (total === 0) {
      ctx.enrich.notice(NO_REFERENCES_NOTICE);
      return page(0);
    }

    const output = page(pageSize(total - offset, (count) => fits(page(count))));
    ctx.log.info('References fetched', {
      title: result.title,
      total,
      returned: output.references.length,
    });
    return output;
  },

  // Upstream text is escaped on the way into the markdown; structuredContent keeps it raw.
  format: (result) => [{ type: 'text', text: formatReferences(result) }],
});

/** Whether a page fits {@link REFERENCES_PAGE_MAX_BYTES} on both the JSON and the Markdown surface. */
function fits(page: ReferencesOutput): boolean {
  return (
    Buffer.byteLength(JSON.stringify(page)) <= REFERENCES_PAGE_MAX_BYTES &&
    Buffer.byteLength(formatReferences(page)) <= REFERENCES_PAGE_MAX_BYTES
  );
}

/**
 * The most whole footnotes, of `remaining`, a page holds — at least one, so an oversized footnote
 * comes back alone rather than blocking the walk. Grows the count by doubling, then bisects the last
 * step, so each page is measured a logarithmic number of times rather than once per footnote.
 */
function pageSize(remaining: number, fitsCount: (count: number) => boolean): number {
  let good = 1;
  let bad: number | undefined;
  for (let count = 2; good < remaining; count *= 2) {
    const candidate = Math.min(count, remaining);
    if (!fitsCount(candidate)) {
      bad = candidate;
      break;
    }
    good = candidate;
  }
  while (bad !== undefined && bad - good > 1) {
    const middle = Math.floor((good + bad) / 2);
    if (fitsCount(middle)) good = middle;
    else bad = middle;
  }
  return good;
}

/**
 * A footnote or work as a list item: heading line, indented text, then one line per link or id. Each
 * line escapes whole, so an id or DOI that opens a line (`10.1017/…`) is not read as a list marker.
 */
function citationItem(
  heading: string,
  text: string,
  urls: readonly string[] = [],
  dois: readonly string[] = [],
  workIds: readonly string[] = [],
): string[] {
  const lines = [`- ${escapeMarkdown(heading)}`];
  if (text) {
    lines.push(
      escapeMarkdownOutsideBlocks(text)
        .split('\n')
        .map((line) => (line ? `  ${line}` : line))
        .join('\n'),
    );
  }
  for (const url of urls) lines.push(`  URL: ${urlLink(url)}`);
  for (const doi of dois) lines.push(`  ${escapeMarkdown(`DOI: ${doi}`)}`);
  for (const id of workIds) lines.push(`  ${escapeMarkdown(`Work: ${id}`)}`);
  return lines;
}

/** The Markdown twin of a references page, measured against the page budget as well as rendered. */
function formatReferences(result: ReferencesOutput): string {
  const lines = [`# ${escapeMarkdown(result.title)}`];
  lines.push(
    `**Revision ID:** ${result.revision_id}` +
      (result.pageid != null ? ` | **Page ID:** ${result.pageid}` : ''),
  );
  if (result.url) lines.push(`**URL:** ${urlLink(result.url)}`);
  if (result.redirected_from)
    lines.push(`**Redirected from:** ${escapeMarkdown(result.redirected_from)}`);
  lines.push(
    `**Total references:** ${result.total_references} (${result.references.length} on this page)`,
  );
  if (result.next_cursor) lines.push(`**Next cursor:** ${result.next_cursor}`);
  if (result.references.length) {
    lines.push('', '## References');
    for (const entry of result.references) {
      const heading = `${entry.label === undefined ? '' : `[${entry.label}] `}${entry.id}${entry.group === undefined ? '' : ` (group: ${entry.group})`}`;
      lines.push(...citationItem(heading, entry.text, entry.urls, entry.dois, entry.work_ids));
    }
  }
  if (result.works.length) {
    lines.push('', '## Works');
    for (const work of result.works) {
      lines.push(...citationItem(work.id, work.text, work.urls, work.dois));
    }
  }
  return lines.join('\n');
}
