/**
 * @fileoverview Tests for wikipedia_search tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.total_results).toBe(2);
    expect(result.query_used).toBe('Python');
    expect(result.language).toBe('en');
  });

  it('throws no_results when search returns empty', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      search: vi.fn().mockResolvedValue({ results: [], totalResults: 0 }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaSearch.errors });
    const input = wikipediaSearch.input.parse({ query: 'xyzzy_no_match_ever_12345' });
    await expect(wikipediaSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
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
      total_results: 1,
      query_used: 'Python',
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
});
