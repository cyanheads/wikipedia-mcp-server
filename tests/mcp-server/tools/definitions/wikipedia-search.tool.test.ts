/**
 * @fileoverview Tests for wikipedia_search tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaSearch } from '@/mcp-server/tools/definitions/wikipedia-search.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

describe('wikipediaSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ranked results for a valid query', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
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
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearch.input.parse({ query: 'Python', limit: 10, language: 'en' });
    const result = await wikipediaSearch.handler(input, ctx);

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
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ results: [], totalResults: 0 }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaSearch.errors });
    const input = wikipediaSearch.input.parse({ query: 'xyzzy_no_match_ever_12345' });
    const result = await wikipediaSearch.handler(input, ctx);

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
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearch.input.parse({ query: 'Test' });
    await wikipediaSearch.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Test', 10, 'en', ctx);
  });

  it('caps limit at 50', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
      totalResults: 1,
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearch.input.parse({ query: 'Test', limit: 999 });
    await wikipediaSearch.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Test', 50, 'en', ctx);
  });

  it('format renders title, pageid, wordcount, and snippet', () => {
    const output = {
      results: [{ title: 'Python', pageid: 23862, snippet: 'A language.', wordcount: 4000 }],
      language: 'en',
    };
    const blocks = wikipediaSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Python');
    expect(text).toContain('23862');
    expect(text).toContain('4000');
    expect(text).toContain('A language.');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearch.errors });
    const input = wikipediaSearch.input.parse({ query: 'Python', language: 'INVALID!!' });
    await expect(wikipediaSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('rejects float limit at schema parse time (issue #14)', () => {
    expect(() => wikipediaSearch.input.parse({ query: 'Python', limit: 5.7 })).toThrow();
  });

  it('rejects negative limit at schema parse time (issue #10)', () => {
    expect(() => wikipediaSearch.input.parse({ query: 'Python', limit: -1 })).toThrow();
  });

  it('rejects zero limit at schema parse time (issue #10)', () => {
    expect(() => wikipediaSearch.input.parse({ query: 'Python', limit: 0 })).toThrow();
  });

  it('passes non-default language to service', async () => {
    const searchFn = vi.fn().mockResolvedValue({
      results: [
        { title: 'Python (langage)', pageid: 999, snippet: 'Langage de prog.', wordcount: 3000 },
      ],
      totalResults: 1,
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearch.input.parse({ query: 'Python', language: 'fr' });
    const result = await wikipediaSearch.handler(input, ctx);

    expect(searchFn).toHaveBeenCalledWith('Python', 10, 'fr', ctx);
    expect(result.language).toBe('fr');
  });

  it('format renders zero results correctly', () => {
    const output = { results: [], language: 'en' };
    const blocks = wikipediaSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('0 results');
    expect(text).toContain('en');
  });

  it('enrichment totalCount reflects upstream total, not result array length', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: vi.fn().mockResolvedValue({
        results: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
        totalResults: 500,
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearch.input.parse({ query: 'test', limit: 1 });
    await wikipediaSearch.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(500);
  });

  it('handles unicode query without error', async () => {
    const searchFn = vi.fn().mockResolvedValue({ results: [], totalResults: 0 });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: searchFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaSearch.errors });
    const input = wikipediaSearch.input.parse({ query: '東京タワー' });
    const result = await wikipediaSearch.handler(input, ctx);
    expect(result.results).toHaveLength(0);
    expect(searchFn).toHaveBeenCalledWith('東京タワー', 10, 'en', ctx);
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
    const blocks = wikipediaSearch.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('service error propagates without swallowing', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaSearch.errors });
    const input = wikipediaSearch.input.parse({ query: 'Python' });
    await expect(wikipediaSearch.handler(input, ctx)).rejects.toThrow('Network error');
  });
});
