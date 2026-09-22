/**
 * @fileoverview Tests for wikipedia_search_articles tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search-articles.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { wikipediaSearchArticles } from '@/mcp-server/tools/definitions/wikipedia-search-articles.tool.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

describe('wikipediaSearchArticles', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('registers under the articles-search name, with the bare name retired (issue #37)', () => {
    expect(wikipediaSearchArticles.name).toBe('wikipedia_search_articles');
    const registered = allToolDefinitions.map((definition) => definition.name);
    expect(registered).toContain('wikipedia_search_articles');
    // The old name is gone from tools/list rather than kept as a second, identical entry.
    expect(registered).not.toContain('wikipedia_search');
    // The sibling coordinate search keeps its own name.
    expect(registered).toContain('wikipedia_search_nearby');
  });

  it('returns ranked results for a valid query', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Python (programming language)',
            pageid: 23862,
            snippet: 'A high-level programming language.',
            wordcount: 5000,
          },
          { title: 'Python', pageid: 24, snippet: 'A genus of snakes.', wordcount: 1200 },
        ],
        totalResults: 2,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({
      query: 'Python',
      limit: 10,
      language: 'en',
    });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.title).toBe('Python (programming language)');
    expect(result.language).toBe('en');

    // Enrichment carries query echo and total
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('Python');
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results with a notice when search returns nothing', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({ results: [], totalResults: 0 }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'xyzzy_no_match_ever_12345' });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toContain('xyzzy_no_match_ever_12345');
  });

  it('defaults limit to 10 and language to en', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [{ title: 'Test', pageid: 1, snippet: 'A test.', wordcount: 100 }],
      totalResults: 1,
    });
    mockWikipediaService({
      search: searchFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Test' });
    await wikipediaSearchArticles.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Test', 10, 'en', ctx, 0);
  });

  it('rejects a limit above the page-size cap at schema parse time (issue #41)', () => {
    const searchFn = vi.fn();
    mockWikipediaService({ search: searchFn });

    // The clamp was silent: `limit: 80` returned 50 results with no signal. The advertised
    // schema now carries the bound the server enforces.
    const parsed = wikipediaSearchArticles.input.safeParse({ query: 'Python', limit: 80 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toContain('limit');
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('still accepts a limit at the cap (issue #41)', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
      totalResults: 1,
    });
    mockWikipediaService({ search: searchFn });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Test', limit: 50 });
    await wikipediaSearchArticles.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Test', 50, 'en', ctx, 0);
  });

  it('rejects an empty query before any fetch, with a typed reason (issue #41)', async () => {
    const searchFn = vi.fn();
    mockWikipediaService({ search: searchFn });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: '' });
    // Upstream answers `srsearch=` with an error envelope on HTTP 200, which used to render as a
    // successful empty result.
    await expect(wikipediaSearchArticles.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('keeps a whitespace-only query as a normal empty search (issue #41)', async () => {
    const searchFn = vi.fn().mockResolvedValue({ results: [], totalResults: 0 });
    mockWikipediaService({ search: searchFn });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: '   ' });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    // `srsearch=%20` is a legitimate search upstream: HTTP 200, `totalhits: 0`, no error.
    expect(searchFn).toHaveBeenCalledWith('   ', 10, 'en', ctx, 0);
    expect(result.results).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toContain('No Wikipedia articles found');
  });

  it('rejects an offset at the search window before any fetch (issue #41)', async () => {
    const searchFn = vi.fn();
    mockWikipediaService({ search: searchFn });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', offset: 10000 });
    const rejection = await Promise.resolve(wikipediaSearchArticles.handler(input, ctx)).then(
      () => undefined,
      (err: unknown) => err as { message: string; data: { reason: string } },
    );

    expect(rejection?.data.reason).toBe('offset_too_large');
    expect(rejection?.message).toContain('10,000');
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('discloses a page cut by the search window, distinguishably from the last page (issue #41)', async () => {
    // `sroffset=9990&srlimit=20` comes back with 10 results and no continue — identical in shape to
    // a genuine end of results, while 3,441 matches remain unreachable.
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `R${i}`,
          pageid: i,
          snippet: 'S',
          wordcount: 10,
        })),
        totalResults: 13441,
        nextOffset: undefined,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', offset: 9990 });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(result.results).toHaveLength(10);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBe(13441);
    expect(enrichment.notice).toContain('10,000');
    // Paging back is what the old notice advised; narrowing the query is the only way past it.
    expect(enrichment.notice).toContain('narrow');
  });

  it('leaves a page short of the window undisclosed and still paging (issue #41)', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `R${i}`,
          pageid: i,
          snippet: 'S',
          wordcount: 10,
        })),
        totalResults: 13441,
        nextOffset: 9990,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', offset: 9980 });
    await wikipediaSearchArticles.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.nextOffset).toBe(9990);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('leaves a normal first page unchanged (issue #41)', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
        totalResults: 13441,
        nextOffset: 10,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python' });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(13441);
    expect(enrichment.nextOffset).toBe(10);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('format renders title, pageid, wordcount, and snippet', () => {
    const output = {
      results: [{ title: 'Python', pageid: 23862, snippet: 'A language.', wordcount: 4000 }],
      language: 'en',
    };
    const blocks = wikipediaSearchArticles.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Python');
    expect(text).toContain('23862');
    expect(text).toContain('4000');
    expect(text).toContain('A language.');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', language: 'INVALID!!' });
    await expect(wikipediaSearchArticles.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', language: 'zz' });
    await expect(wikipediaSearchArticles.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('rejects float limit at schema parse time (issue #14)', () => {
    expect(() => wikipediaSearchArticles.input.parse({ query: 'Python', limit: 5.7 })).toThrow();
  });

  it('rejects negative limit at schema parse time (issue #10)', () => {
    expect(() => wikipediaSearchArticles.input.parse({ query: 'Python', limit: -1 })).toThrow();
  });

  it('rejects zero limit at schema parse time (issue #10)', () => {
    expect(() => wikipediaSearchArticles.input.parse({ query: 'Python', limit: 0 })).toThrow();
  });

  it('passes non-default language to service', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [
        { title: 'Python (langage)', pageid: 999, snippet: 'Langage de prog.', wordcount: 3000 },
      ],
      totalResults: 1,
    });
    mockWikipediaService({
      search: searchFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', language: 'fr' });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Python', 10, 'fr', ctx, 0);
    expect(result.language).toBe('fr');
  });

  it('format renders zero results correctly', () => {
    const output = { results: [], language: 'en' };
    const blocks = wikipediaSearchArticles.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('0 results');
    expect(text).toContain('en');
  });

  it('enrichment totalCount reflects upstream total, not result array length', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
        totalResults: 500,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'test', limit: 1 });
    await wikipediaSearchArticles.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(500);
  });

  it('handles unicode query without error', async () => {
    const searchFn = vi.fn().mockResolvedValue({ results: [], totalResults: 0 });
    mockWikipediaService({
      search: searchFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: '東京タワー' });
    const result = await wikipediaSearchArticles.handler(input, ctx);
    expect(result.results).toHaveLength(0);
    expect(searchFn).toHaveBeenCalledWith('東京タワー', 10, 'en', ctx, 0);
  });

  it('format output does not contain env var names or secret patterns', () => {
    const output = {
      results: [
        {
          title: 'Test',
          pageid: 1,
          snippet: 'A snippet.',
          wordcount: 100,
        },
      ],
      language: 'en',
    };
    const blocks = wikipediaSearchArticles.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('service error propagates without swallowing', async () => {
    mockWikipediaService({
      search: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python' });
    await expect(wikipediaSearchArticles.handler(input, ctx)).rejects.toThrow('Network error');
  });

  it('forwards offset to the service and echoes pagination enrichment (issue #22)', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [{ title: 'Result 6', pageid: 6, snippet: 'S', wordcount: 10 }],
      totalResults: 42,
      nextOffset: 10,
    });
    mockWikipediaService({
      search: searchFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', limit: 5, offset: 5 });
    await wikipediaSearchArticles.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Python', 5, 'en', ctx, 5);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.offset).toBe(5);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.nextOffset).toBe(10);
  });

  it('pages through disjoint result sets via offset (issue #22)', async () => {
    const page1 = [
      { title: 'A', pageid: 1, snippet: 'S', wordcount: 10 },
      { title: 'B', pageid: 2, snippet: 'S', wordcount: 10 },
    ];
    const page2 = [
      { title: 'C', pageid: 3, snippet: 'S', wordcount: 10 },
      { title: 'D', pageid: 4, snippet: 'S', wordcount: 10 },
    ];
    const searchFn = vi
      .fn()
      .mockImplementation((_q: string, _l: number, _lang: string, _ctx: unknown, offset: number) =>
        offset === 0
          ? Promise.resolve({ results: page1, totalResults: 4, nextOffset: 2 })
          : Promise.resolve({ results: page2, totalResults: 4, nextOffset: undefined }),
      );
    mockWikipediaService({
      search: searchFn,
    });

    const ctx1 = createMockContext({ errors: wikipediaSearchArticles.errors });
    const r1 = await wikipediaSearchArticles.handler(
      wikipediaSearchArticles.input.parse({ query: 'Q', limit: 2, offset: 0 }),
      ctx1,
    );
    expect(getEnrichment(ctx1).nextOffset).toBe(2);

    const ctx2 = createMockContext({ errors: wikipediaSearchArticles.errors });
    const r2 = await wikipediaSearchArticles.handler(
      wikipediaSearchArticles.input.parse({ query: 'Q', limit: 2, offset: 2 }),
      ctx2,
    );
    expect(getEnrichment(ctx2).nextOffset).toBeUndefined();

    const ids2 = r2.results.map((x) => x.pageid);
    expect(r1.results.some((x) => ids2.includes(x.pageid))).toBe(false); // disjoint pages
  });

  it('omits nextOffset at the end of the result set (issue #22)', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'Last', pageid: 9, snippet: 'S', wordcount: 10 }],
        totalResults: 6,
        nextOffset: undefined,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', offset: 5 });
    await wikipediaSearchArticles.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.offset).toBe(5);
    expect(enrichment.nextOffset).toBeUndefined();
  });

  it('returns an empty array with an end-of-results notice when offset is past the end (issue #22)', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({ results: [], totalResults: 12, nextOffset: undefined }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Python', offset: 9999 });
    const result = await wikipediaSearchArticles.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.offset).toBe(9999);
    expect(enrichment.notice).toContain('end of the result set');
  });

  it('defaults offset to 0 when omitted (issue #22 backward-compat)', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
      totalResults: 1,
      nextOffset: undefined,
    });
    mockWikipediaService({
      search: searchFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchArticles.errors });
    const input = wikipediaSearchArticles.input.parse({ query: 'Test' });
    await wikipediaSearchArticles.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Test', 10, 'en', ctx, 0);
    expect(getEnrichment(ctx).offset).toBe(0);
  });

  it('rejects negative offset at schema parse time (issue #22)', () => {
    expect(() => wikipediaSearchArticles.input.parse({ query: 'Python', offset: -1 })).toThrow();
  });

  it('rejects float offset at schema parse time (issue #22)', () => {
    expect(() => wikipediaSearchArticles.input.parse({ query: 'Python', offset: 2.5 })).toThrow();
  });

  it('escapes markdown-active upstream text in format() and leaves the structured value raw (issue #43)', () => {
    const snippet =
      'deployments of JSONP are subject to CSRF attacks. Because the HTML <script> element does not respect the same-origin _policy_';
    const output = {
      results: [{ title: 'JSONP <script>', pageid: 123, snippet, wordcount: 4200 }],
      language: 'en',
    };
    const text = wikipediaSearchArticles.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(text).toContain('\\<script\\>');
    expect(text).toContain('\\_policy\\_');
    expect(text).toContain('JSONP \\<script\\>');
    expect(text).not.toContain('<script>');
    expect(output.results[0]?.snippet).toBe(snippet);
    expect(output.results[0]?.title).toBe('JSONP <script>');
  });
});

/** Every text block of a tool result, joined — the domain render plus the enrichment trailer. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
}

describe('wikipediaSearchArticles — contract path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('renders a result on both surfaces (characterization)', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'Python', pageid: 24, snippet: 'A genus of snakes.', wordcount: 1200 }],
        totalResults: 40,
        nextOffset: 1,
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, { query: 'Python', limit: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ title: 'Python', pageid: 24, snippet: 'A genus of snakes.', wordcount: 1200 }],
      language: 'en',
      effectiveQuery: 'Python',
      totalCount: 40,
      offset: 0,
      shown: 1,
      nextOffset: 1,
    });
    const text = contentText(result);
    expect(text).toContain('### Python');
    expect(text).toContain('**Page ID:** 24 | **Words:** 1200');
    expect(text).toContain('A genus of snakes.');
  });
});

describe('wikipediaSearchArticles — spelling suggestion (issue #51)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('names the suggestion in the zero-hit notice and carries it as enrichment', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [],
        totalResults: 0,
        suggestion: 'albert einstein relativity',
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, {
      query: 'albert einstien relativty',
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.suggestion).toBe('albert einstein relativity');
    expect(structured.notice).toBe(
      'No Wikipedia articles found for "albert einstien relativty" in language "en". Try different keywords or a broader query. Did you mean "albert einstein relativity"? Re-run with that query.',
    );
    const text = contentText(result);
    expect(text).toContain('**Did you mean:** albert einstein relativity');
    expect(text).toContain('Did you mean "albert einstein relativity"?');
  });

  it('carries the suggestion on a non-empty page without adding a notice', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [
          { title: 'Albert Einstein', pageid: 736, snippet: 'Physicist.', wordcount: 20000 },
        ],
        totalResults: 8,
        suggestion: 'einstein',
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, { query: 'einstien' });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.suggestion).toBe('einstein');
    expect(structured.notice).toBeUndefined();
    expect(contentText(result)).toContain('**Did you mean:** einstein');
  });

  it('leaves the end-of-results notice alone past offset 0 even when a suggestion arrives', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [],
        totalResults: 8,
        suggestion: 'einstein',
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, {
      query: 'einstien',
      offset: 20,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.notice).toContain('end of the result set');
    expect(structured.notice).not.toContain('Did you mean');
    // The field itself still rides along — only the notice ignores it past offset 0.
    expect(structured.suggestion).toBe('einstein');
  });

  it('adds no suggestion field and keeps the zero-hit notice unchanged when upstream sends none', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({ results: [], totalResults: 0 }),
    });

    const result = await runToolContract(wikipediaSearchArticles, { query: 'xyzzy' });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).not.toHaveProperty('suggestion');
    expect(structured.notice).toBe(
      'No Wikipedia articles found for "xyzzy" in language "en". Try different keywords or a broader query.',
    );
  });
});

describe('wikipediaSearchArticles — description and Wikidata QID (issue #52)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('declares and renders description and wikibase_item per result, omitting them when absent', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [
          {
            title: 'Python (programming language)',
            pageid: 23862,
            snippet: 'A high-level language.',
            wordcount: 5000,
            description: 'General-purpose programming language',
            wikibase_item: 'Q28865',
          },
          // Sparse: a QID but no short description (the service maps upstream's empty one to absent).
          {
            title: 'List of Python software',
            pageid: 3673376,
            snippet: 'Software written in Python.',
            wordcount: 900,
            wikibase_item: 'Q6595251',
          },
          // Sparsest: neither field.
          { title: 'Pythonidae', pageid: 99, snippet: 'Snakes.', wordcount: 800 },
        ],
        totalResults: 3,
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, { query: 'Python' });

    expect(result.isError).toBeFalsy();
    const results = (result.structuredContent as { results: Array<Record<string, unknown>> })
      .results;
    expect(results[0]).toMatchObject({
      description: 'General-purpose programming language',
      wikibase_item: 'Q28865',
    });
    expect(results[1]).not.toHaveProperty('description');
    expect(results[1]?.wikibase_item).toBe('Q6595251');
    expect(results[2]).not.toHaveProperty('description');
    expect(results[2]).not.toHaveProperty('wikibase_item');

    const text = contentText(result);
    expect(text).toContain('*General-purpose programming language*');
    expect(text).toContain('**Wikidata QID:** Q28865');
    expect(text).toContain('**Wikidata QID:** Q6595251');
    expect(text).not.toContain('undefined');
    // No notice: the lookup succeeded, and a missing description is upstream's own absence.
    expect((result.structuredContent as Record<string, unknown>).notice).toBeUndefined();
  });

  it('keeps the results and says descriptions could not be loaded when the lookup failed', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'Python', pageid: 24, snippet: 'Snakes.', wordcount: 1200 }],
        totalResults: 40,
        nextOffset: 1,
        descriptionsUnavailable: true,
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, { query: 'Python', limit: 1 });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.results as unknown[]).length).toBe(1);
    expect(structured.notice).toContain('Descriptions and Wikidata QIDs could not be loaded');
    expect(contentText(result)).toContain('Descriptions and Wikidata QIDs could not be loaded');
  });

  it('emits one notice carrying both the window cut and the failed lookup', async () => {
    mockWikipediaService({
      search: vi.fn().mockResolvedValue({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `R${i}`,
          pageid: i,
          snippet: 'S',
          wordcount: 10,
        })),
        totalResults: 13441,
        nextOffset: undefined,
        descriptionsUnavailable: true,
      }),
    });

    const result = await runToolContract(wikipediaSearchArticles, {
      query: 'Python',
      offset: 9990,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toContain('10,000');
    expect(structured.notice).toContain('Descriptions and Wikidata QIDs could not be loaded');
  });
});
