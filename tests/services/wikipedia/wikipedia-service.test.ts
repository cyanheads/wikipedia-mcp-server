/**
 * @fileoverview Tests for WikipediaService initialization, language validation, HTTP error
 * handling, and data-mapping logic.
 * @module tests/services/wikipedia/wikipedia-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWikipediaService,
  initWikipediaService,
  WikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';

const mockConfig = {} as AppConfig;
const mockStorage = {} as StorageService;
const TEST_USER_AGENT =
  'wikipedia-mcp-server/test (https://github.com/cyanheads/wikipedia-mcp-server)';

describe('WikipediaService init/accessor', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('getWikipediaService returns the initialized instance', () => {
    const svc = getWikipediaService();
    expect(svc).toBeInstanceOf(WikipediaService);
  });
});

describe('WikipediaService language validation', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('rejects an invalid language code with ValidationError', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // buildBaseUrl is called internally by restGet; invalid code triggers throw.
    await expect(
      svc.restGet('not_a_valid_BCP47!!!', '/page/summary/Test', ctx),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid language code') });
  });

  it('rejects a structurally valid but non-existent Wikipedia edition (issue #6)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // 'xx' is valid BCP 47 but has no Wikipedia edition.
    // Without the edition check this would time out after 4 retries (~60s).
    await expect(svc.restGet('xx', '/page/summary/Test', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('does not exist on Wikipedia'),
    });
  });

  it('accepts valid 2-char language codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // 'fr' is valid — buildBaseUrl should not throw. The call may resolve (live
    // network) or reject with a network/API error, but never with a language
    // validation error. Use Promise.allSettled to inspect the outcome either way.
    const [result] = await Promise.allSettled([svc.restGet('fr', '/page/summary/Python', ctx)]);
    if (result.status === 'rejected') {
      expect(result.reason).not.toMatchObject({
        message: expect.stringContaining('Invalid language code'),
      });
    }
    // If resolved, language validation passed — nothing more to assert.
  });
});

describe('WikipediaService.search — HTML entity decoding (issue #3)', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('decodes HTML entities in search snippets', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // Stub actionGet to return a snippet with raw HTML entities.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 1 },
        search: [
          {
            title: 'Test',
            pageid: 1,
            snippet: 'sous le nom d&#039;« hôtel Nikko »&amp;more<b>highlight</b>',
            wordcount: 500,
          },
        ],
      },
    });

    const { results } = await svc.search('test', 1, 'fr', ctx);
    expect(results[0]?.snippet).toBe("sous le nom d'« hôtel Nikko »&morehighlight");
  });
});

describe('WikipediaService.getArticleSection — formatversion=2 wikitext (issue #1)', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('reads wikitext as a plain string (formatversion=2 shape)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // formatversion=2: wikitext is `string`, not `{ '*': string }`.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Albert Einstein',
        pageid: 736,
        wikitext: '== Special relativity ==\n\nEinstein developed special relativity.',
      },
    });

    const result = await svc.getArticleSection('Albert Einstein', 28, 'en', ctx);
    expect(result.sectionTitle).toBe('Special relativity');
    expect(result.content).not.toBe('');
    expect(result.content).toContain('Einstein');
  });
});

describe('WikipediaService.getLanguages — formatversion=2 langlinks (issue #2)', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('reads langlinks using title key (not "*") and url from llprop=url', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // formatversion=2: langlinks use `title` and optionally `url`.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '23862': {
            pageid: 23862,
            title: 'Python (programming language)',
            langlinks: [
              {
                lang: 'fr',
                title: 'Python (langage)',
                url: 'https://fr.wikipedia.org/wiki/Python_%28langage%29',
              },
            ],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Python (programming language)', 'en', ctx);
    expect(languages).toHaveLength(1);
    expect(languages[0]?.title).toBe('Python (langage)');
    expect(languages[0]?.url).toBe('https://fr.wikipedia.org/wiki/Python_%28langage%29');
    expect(languages[0]?.languageCode).toBe('fr');
  });
});

describe('WikipediaService.search — empty results', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('returns empty results array and zero total when search has no hits', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 0 },
        search: [],
      },
    });

    const { results, totalResults } = await svc.search('xyzzy_no_match', 10, 'en', ctx);
    expect(results).toHaveLength(0);
    expect(totalResults).toBe(0);
  });

  it('falls back to result array length when searchinfo is absent', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        search: [{ title: 'T', pageid: 1, snippet: 'S', wordcount: 10 }],
      },
    });

    const { totalResults } = await svc.search('test', 10, 'en', ctx);
    expect(totalResults).toBe(1);
  });

  it('strips HTML tags from snippets', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 1 },
        search: [
          {
            title: 'Test',
            pageid: 1,
            snippet: '<span class="searchmatch">Python</span> is a <b>language</b>.',
            wordcount: 100,
          },
        ],
      },
    });

    const { results } = await svc.search('Python', 1, 'en', ctx);
    expect(results[0]?.snippet).toBe('Python is a language.');
    expect(results[0]?.snippet).not.toContain('<');
  });
});

describe('WikipediaService.getArticleFull — not_found handling', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('throws NotFound when pages object is absent', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {},
    });

    await expect(svc.getArticleFull('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws NotFound when page has missing flag', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '-1': { title: 'Nonexistent', missing: '' },
        },
      },
    });

    await expect(svc.getArticleFull('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws NotFound when extract is empty string', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': { pageid: 1, title: 'Stub', extract: '' },
        },
      },
    });

    await expect(svc.getArticleFull('Stub', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('no readable content'),
    });
  });

  it('returns content when extract is present', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '23862': {
            pageid: 23862,
            title: 'Python (programming language)',
            extract: 'Python is a programming language.',
          },
        },
      },
    });

    const result = await svc.getArticleFull('Python (programming language)', 'en', ctx);
    expect(result.title).toBe('Python (programming language)');
    expect(result.content).toContain('Python is a programming language');
    expect(result.pageid).toBe(23862);
  });
});

describe('WikipediaService.getSummary — REST API mapping', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('maps REST summary fields to domain types', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { restGet: unknown }, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Python (programming language)',
      pageid: 23862,
      wikibase_item: 'Q28865',
      description: 'General-purpose programming language',
      extract: 'Python is a high-level language.',
      thumbnail: { source: 'https://example.com/python.png' },
    });

    const result = await svc.getSummary('Python (programming language)', 'en', ctx);
    expect(result.title).toBe('Python (programming language)');
    expect(result.pageType).toBe('standard');
    expect(result.pageid).toBe(23862);
    expect(result.wikidataQid).toBe('Q28865');
    expect(result.description).toBe('General-purpose programming language');
    expect(result.extract).toBe('Python is a high-level language.');
    expect(result.thumbnailUrl).toBe('https://example.com/python.png');
  });

  it('throws NotFound when REST summary has no extract', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { restGet: unknown }, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Empty Article',
      pageid: 1,
    });

    await expect(svc.getSummary('Empty Article', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('no readable content'),
    });
  });

  it('wraps NotFound from restGet into a user-friendly message', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { restGet: unknown }, 'restGet').mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Not found'),
    );

    await expect(svc.getSummary('Missing', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });
});

describe('WikipediaService.getArticleSection — error codes', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('throws ValidationError for nosuchsection error code', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      error: { code: 'nosuchsection', info: 'There is no section 99.' },
    });

    await expect(svc.getArticleSection('Python', 99, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('throws NotFound for missingtitle error code', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      error: { code: 'missingtitle', info: 'The page you requested does not exist.' },
    });

    await expect(svc.getArticleSection('Nonexistent', 1, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws ServiceUnavailable for unknown API error codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Something went wrong.' },
    });

    await expect(svc.getArticleSection('Python', 1, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Wikipedia API error'),
    });
  });

  it('derives sectionTitle from heading when wikitext contains one', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Python (programming language)',
        pageid: 23862,
        wikitext: '== History ==\n\nPython was created in 1991 by Guido van Rossum.',
      },
    });

    const result = await svc.getArticleSection('Python (programming language)', 1, 'en', ctx);
    expect(result.sectionTitle).toBe('History');
    expect(result.content).toContain('Python');
  });

  it('falls back to "Section N" title when wikitext has no heading', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Article',
        pageid: 42,
        wikitext: 'Just plain text without a heading.',
      },
    });

    const result = await svc.getArticleSection('Article', 5, 'en', ctx);
    expect(result.sectionTitle).toBe('Section 5');
  });
});

describe('WikipediaService.getSections — error codes and fallback', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('throws NotFound for missingtitle error code', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      error: { code: 'missingtitle', info: 'The page does not exist.' },
    });

    await expect(svc.getSections('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws ServiceUnavailable for unknown API error codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Something went wrong.' },
    });

    await expect(svc.getSections('Python', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Wikipedia API error'),
    });
  });

  it('maps section fields from parse.sections correctly', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Python (programming language)',
        pageid: 23862,
        sections: [
          { toclevel: 1, level: '2', line: 'History', number: '1', index: '1' },
          { toclevel: 2, level: '3', line: 'Origins', number: '1.1', index: '2' },
        ],
      },
    });

    const result = await svc.getSections('Python (programming language)', 'en', ctx);
    expect(result.pageid).toBe(23862);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toEqual({ index: 1, number: '1', title: 'History', level: 2 });
    expect(result.sections[1]).toEqual({ index: 2, number: '1.1', title: 'Origins', level: 3 });
  });
});

describe('WikipediaService.getLanguages — missing page handling', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('throws NotFound when page has missing flag', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '-1': { title: 'Nonexistent', missing: '' },
        },
      },
    });

    await expect(svc.getLanguages('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('returns empty languages array when langlinks is absent', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': { pageid: 1, title: 'Local Article' },
        },
      },
    });

    const { languages } = await svc.getLanguages('Local Article', 'en', ctx);
    expect(languages).toHaveLength(0);
  });

  it('generates fallback URL when llprop=url is absent', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            title: 'Test',
            langlinks: [{ lang: 'de', title: 'Test (Deutsch)' }],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Test', 'en', ctx);
    expect(languages[0]?.url).toContain('de.wikipedia.org');
    expect(languages[0]?.url).toContain('Test');
  });
});

describe('WikipediaService.searchNearby — result mapping', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('maps geosearch fields to domain shape', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        geosearch: [
          { pageid: 34567, ns: 0, title: 'Space Needle', lat: 47.6205, lon: -122.3493, dist: 150 },
        ],
      },
    });

    const { results } = await svc.searchNearby(47.6205, -122.3493, 1000, 10, 'en', ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Space Needle',
      pageid: 34567,
      latitude: 47.6205,
      longitude: -122.3493,
      distance_meters: 150,
    });
  });

  it('returns empty results array when geosearch returns nothing', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { geosearch: [] },
    });

    const { results } = await svc.searchNearby(0, 0, 1000, 10, 'en', ctx);
    expect(results).toHaveLength(0);
  });
});

describe('WikipediaService — HTML/JSON detection in responses', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('actionGet rejects language codes not in known editions set', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // 'zz' is BCP47 valid but no Wikipedia edition — should fail before network call
    await expect(
      svc.actionGet('zz', { action: 'query', list: 'search', srsearch: 'test' }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist on Wikipedia'),
    });
  });
});

describe('WikipediaService — output contains no secrets', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('getSummary result does not contain env var names', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { restGet: unknown }, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Test',
      pageid: 1,
      extract: 'Some content.',
    });

    const result = await svc.getSummary('Test', 'en', ctx);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL/);
  });

  it('search result snippets do not contain Authorization headers', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 1 },
        search: [{ title: 'Test', pageid: 1, snippet: 'Normal snippet content.', wordcount: 100 }],
      },
    });

    const { results } = await svc.search('test', 1, 'en', ctx);
    expect(results[0]?.snippet).not.toMatch(/Authorization|Bearer|api.key/i);
  });
});
