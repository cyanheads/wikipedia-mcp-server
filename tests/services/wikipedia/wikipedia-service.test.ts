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
  buildBaseUrl,
  type EditionIndex,
  GEOSEARCH_MAX_LIMIT,
  getWikipediaService,
  initWikipediaService,
  isBlankTitle,
  isMalformedLanguage,
  parseSiteMatrix,
  splitArticleIntoSections,
  WikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';

const mockConfig = {} as AppConfig;
const TEST_USER_AGENT =
  'wikipedia-mcp-server/test (https://github.com/cyanheads/wikipedia-mcp-server)';

/** In-memory StorageService stand-in; the backing map is cleared before every test. */
const storageBacking = new Map<string, unknown>();
const mockStorage = {
  get: async (key: string) => storageBacking.get(key) ?? null,
  set: async (key: string, value: unknown) => {
    storageBacking.set(key, value);
  },
} as unknown as StorageService;

/**
 * Edition index the tests resolve hosts against. Covers a plain edition, a langcode≠subdomain
 * pair (`gsw` → `als`), a closed edition (`aa`), and an edition the pre-sitematrix allowlist
 * rejected (`ht`).
 */
const TEST_EDITION_INDEX: EditionIndex = {
  hosts: {
    en: 'https://en.wikipedia.org',
    fr: 'https://fr.wikipedia.org',
    de: 'https://de.wikipedia.org',
    ht: 'https://ht.wikipedia.org',
    als: 'https://als.wikipedia.org',
    gsw: 'https://als.wikipedia.org',
    aa: 'https://aa.wikipedia.org',
    'bat-smg': 'https://bat-smg.wikipedia.org',
    simple: 'https://simple.wikipedia.org',
  },
  fetchedAt: '2026-07-29T00:00:00.000Z',
};

/**
 * Initialize the service with the sitematrix fetch stubbed, so no test in this file reaches the
 * network for the edition index.
 */
function initService(baseUrl?: string): WikipediaService {
  initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT, baseUrl);
  const svc = getWikipediaService();
  vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue(TEST_EDITION_INDEX);
  return svc;
}

beforeEach(() => {
  storageBacking.clear();
});

describe('WikipediaService init/accessor', () => {
  beforeEach(() => {
    initService();
  });

  it('getWikipediaService returns the initialized instance', () => {
    const svc = getWikipediaService();
    expect(svc).toBeInstanceOf(WikipediaService);
  });
});

describe('WikipediaService language validation', () => {
  beforeEach(() => {
    initService();
  });

  it('rejects an invalid language code with ValidationError', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // The structural check runs during host resolution inside restGet, before any lookup.
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

    // 'fr' is valid — host resolution should not throw. The call may resolve (live
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

describe('isMalformedLanguage — structural gate', () => {
  it('accepts 2- and 3-letter codes and hyphenated variants', () => {
    for (const code of ['en', 'gsw', 'zh-min-nan', 'be-tarask', 'roa-rup', 'map-bms']) {
      expect(isMalformedLanguage(code)).toBe(false);
    }
  });

  it('accepts "simple", a live edition longer than three letters', () => {
    // simple.wikipedia.org is a language row in the sitematrix, not a special; a 2–3 character
    // first-subtag bound rejected it outright and made the edition unreachable.
    expect(isMalformedLanguage('simple')).toBe(false);
  });

  it('rejects codes that cannot name an edition on shape alone', () => {
    for (const code of ['', 'e', 'not_a_code!!', 'toolongsubtag', 'en_US', 'en-']) {
      expect(isMalformedLanguage(code)).toBe(true);
    }
  });
});

describe('buildBaseUrl — compose vs single-instance override (issue #16)', () => {
  it('composes a per-language host when no override is set', () => {
    expect(buildBaseUrl('en')).toBe('https://en.wikipedia.org');
    expect(buildBaseUrl('als')).toBe('https://als.wikipedia.org');
  });

  it('rejects a nonexistent edition in compose mode', () => {
    expect(() => buildBaseUrl('zz')).toThrow('does not exist on Wikipedia');
  });

  it('uses the override verbatim and ignores language when set', () => {
    expect(buildBaseUrl('en', 'https://wiki.example.com')).toBe('https://wiki.example.com');
    // Language is not validated in override mode — any code maps to the one fixed host.
    expect(buildBaseUrl('zz', 'https://wiki.example.com')).toBe('https://wiki.example.com');
  });

  it('strips a trailing slash from the override', () => {
    expect(buildBaseUrl('en', 'https://wiki.example.com/')).toBe('https://wiki.example.com');
  });
});

describe('WikipediaService.isUnknownEdition — edition-check scoping (issues #16, #18, #26)', () => {
  it('flags a structurally-valid code that names no Wikipedia edition in compose mode', async () => {
    const svc = initService();
    const ctx = createMockContext();
    expect(await svc.isUnknownEdition('zz', ctx)).toBe(true);
    expect(await svc.isUnknownEdition('fr', ctx)).toBe(false);
    expect(await svc.isUnknownEdition('als', ctx)).toBe(false);
  });

  it('flags a malformed code without consulting the registry', async () => {
    const svc = initService();
    const ctx = createMockContext();
    expect(await svc.isUnknownEdition('not_a_code!!', ctx)).toBe(true);
  });

  it('accepts a real edition the pre-sitematrix allowlist rejected (issue #26)', async () => {
    const svc = initService();
    const ctx = createMockContext();
    // ht.wikipedia.org answers HTTP 200; the hand-maintained allowlist called it nonexistent.
    expect(await svc.isUnknownEdition('ht', ctx)).toBe(false);
  });

  it('rejects the phantom "hat" entry the allowlist waved through (issue #26)', async () => {
    const svc = initService();
    const ctx = createMockContext();
    // Haitian Creole is served at ht.wikipedia.org; "hat" is no subdomain at all.
    expect(await svc.isUnknownEdition('hat', ctx)).toBe(true);
    // The fallback set must not carry it either, or a degraded run reintroduces the bug.
    expect(() => buildBaseUrl('hat')).toThrow('does not exist on Wikipedia');
  });

  it('accepts the MediaWiki language code of a langcode≠subdomain edition (issue #24)', async () => {
    const svc = initService();
    const ctx = createMockContext();
    // Alemannic: code "gsw", edition on "als". Both spellings resolve to the same host.
    expect(await svc.isUnknownEdition('gsw', ctx)).toBe(false);
    expect(await svc.editionHost('gsw', ctx)).toBe('https://als.wikipedia.org');
    expect(await svc.editionHost('als', ctx)).toBe('https://als.wikipedia.org');
  });

  it('accepts "simple" through both the registry and the offline set', async () => {
    const svc = initService();
    const ctx = createMockContext();
    expect(await svc.isUnknownEdition('simple', ctx)).toBe(false);
    expect(await svc.editionHost('simple', ctx)).toBe('https://simple.wikipedia.org');
    expect(buildBaseUrl('simple')).toBe('https://simple.wikipedia.org');
  });

  it('accepts a closed edition — read-only is not gone', async () => {
    const svc = initService();
    const ctx = createMockContext();
    expect(await svc.isUnknownEdition('aa', ctx)).toBe(false);
  });

  it('skips the edition check when a single-instance override is configured', async () => {
    const svc = initService('https://wiki.example.com');
    const ctx = createMockContext();
    // A custom host may serve any editions, so nothing is treated as unknown.
    expect(await svc.isUnknownEdition('zz', ctx)).toBe(false);
    expect(await svc.isUnknownEdition('fr', ctx)).toBe(false);
  });

  it('does not fetch the sitematrix in single-instance override mode', async () => {
    const svc = initService('https://wiki.example.com');
    const ctx = createMockContext();
    await svc.isUnknownEdition('fr', ctx);
    expect(svc.fetchEditionIndex).not.toHaveBeenCalled();
    expect(await svc.editionHost('fr', ctx)).toBeUndefined();
  });
});

describe('parseSiteMatrix — sitematrix parsing (issue #26)', () => {
  const matrix = {
    sitematrix: {
      count: 1072,
      '0': {
        code: 'aa',
        name: 'Qafár af',
        // A closed edition — its host still answers, so it stays in the index.
        site: [
          { url: 'https://aa.wikipedia.org', code: 'wiki', closed: true },
          { url: 'https://aa.wiktionary.org', code: 'wiktionary', closed: true },
        ],
      },
      '1': {
        code: 'gsw',
        name: 'Alemannisch',
        site: [{ url: 'https://als.wikipedia.org', code: 'wiki' }],
      },
      '2': {
        code: 'simple',
        name: 'Simple English',
        site: [{ url: 'https://simple.wikipedia.org', code: 'wiki' }],
      },
      // No Wikipedia edition — only sibling projects.
      '3': {
        code: 'xyz',
        name: 'No Wiki',
        site: [{ url: 'https://xyz.wiktionary.org', code: 'wiktionary' }],
      },
      // Malformed url for one language must not discard the rest of the matrix.
      '4': { code: 'bad', name: 'Bad', site: [{ url: 'not a url', code: 'wiki' }] },
    },
  };

  it('indexes each edition by subdomain and by MediaWiki language code', () => {
    const index = parseSiteMatrix(matrix);
    expect(index.hosts.als).toBe('https://als.wikipedia.org');
    expect(index.hosts.gsw).toBe('https://als.wikipedia.org');
  });

  it('keeps closed editions', () => {
    expect(parseSiteMatrix(matrix).hosts.aa).toBe('https://aa.wikipedia.org');
  });

  it('keeps simple.wikipedia.org, which the matrix lists as a language rather than a special', () => {
    expect(parseSiteMatrix(matrix).hosts.simple).toBe('https://simple.wikipedia.org');
  });

  it('skips languages with no wikipedia edition and unparseable hosts', () => {
    const { hosts } = parseSiteMatrix(matrix);
    expect(hosts.xyz).toBeUndefined();
    expect(hosts.bad).toBeUndefined();
  });

  it('ignores the count sibling and stamps fetchedAt', () => {
    const index = parseSiteMatrix(matrix);
    expect(index.hosts.count).toBeUndefined();
    expect(Date.parse(index.fetchedAt)).not.toBeNaN();
  });

  it('throws when the response lists no editions rather than returning an empty index', () => {
    expect(() => parseSiteMatrix({ sitematrix: { count: 0 } })).toThrow('no language editions');
  });
});

describe('WikipediaService edition index — cache and fallback (issue #26)', () => {
  it('persists a fetched index to storage and reuses it without refetching', async () => {
    const svc = initService();
    const ctx = createMockContext();

    await svc.isUnknownEdition('ht', ctx);
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);
    expect(storageBacking.get('wikipedia/edition-index')).toMatchObject({
      hosts: expect.objectContaining({ ht: 'https://ht.wikipedia.org' }),
    });

    // Second call is served by the process memo.
    await svc.isUnknownEdition('fr', ctx);
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);
  });

  it('reads a warm storage entry instead of fetching', async () => {
    storageBacking.set('wikipedia/edition-index', TEST_EDITION_INDEX);
    const svc = initService();
    const ctx = createMockContext();

    expect(await svc.isUnknownEdition('ht', ctx)).toBe(false);
    expect(svc.fetchEditionIndex).not.toHaveBeenCalled();
  });

  it('issues one fetch for concurrent resolutions', async () => {
    const svc = initService();
    const ctx = createMockContext();

    await Promise.all([
      svc.isUnknownEdition('fr', ctx),
      svc.isUnknownEdition('de', ctx),
      svc.isUnknownEdition('ht', ctx),
    ]);
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);
  });

  it('falls back to the offline edition set when the sitematrix fetch fails', async () => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    const fetchSpy = vi
      .spyOn(svc, 'fetchEditionIndex')
      .mockRejectedValue(new Error('sitematrix unreachable'));
    const ctx = createMockContext();

    // The guard still rejects a nonexistent subdomain rather than opening the gate.
    expect(await svc.isUnknownEdition('zz', ctx)).toBe(true);
    // And a code in the offline set still resolves rather than failing every call.
    expect(await svc.isUnknownEdition('fr', ctx)).toBe(false);
    // The failure suppresses further attempts for a window instead of refetching per call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // A real edition absent from the incomplete offline set is the cost of the degraded path.
    expect(await svc.isUnknownEdition('ht', ctx)).toBe(true);
    expect(await svc.editionHost('gsw', ctx)).toBeUndefined();
  });

  it('refetches when storage holds an index with no hosts', async () => {
    storageBacking.set('wikipedia/edition-index', { hosts: {}, fetchedAt: 'x' });
    const svc = initService();
    const ctx = createMockContext();

    expect(await svc.isUnknownEdition('ht', ctx)).toBe(false);
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);
  });

  it('forwards expectedStatuses from restGet to the fetch layer', async () => {
    const svc = initService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc as unknown as { apiGet: unknown }, 'apiGet')
      .mockResolvedValue({ extract: 'x' });

    await svc.restGet('en', '/page/summary/Test', ctx, { expectedStatuses: [404] });
    expect(spy.mock.calls[0]?.[4]).toEqual({ expectedStatuses: [404] });
  });

  it('resolves request hosts from the registry, including a langcode≠subdomain code', async () => {
    const svc = initService();
    const ctx = createMockContext();
    const fetchSpy = vi
      .spyOn(svc as unknown as { apiGet: unknown }, 'apiGet')
      .mockResolvedValue({ query: { pages: {} } });

    await svc.actionGet('gsw', { action: 'query' }, ctx).catch(() => undefined);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('https://als.wikipedia.org/w/api.php');
  });
});

describe('isBlankTitle — blank/whitespace title guard (issue #20)', () => {
  it('flags empty and whitespace-only titles', () => {
    expect(isBlankTitle('')).toBe(true);
    expect(isBlankTitle('   ')).toBe(true);
    expect(isBlankTitle('\t\n ')).toBe(true);
  });

  it('accepts a non-blank title (surrounding whitespace is not blank)', () => {
    expect(isBlankTitle('Python')).toBe(false);
    expect(isBlankTitle('  Python  ')).toBe(false);
  });
});

describe('WikipediaService — redirect resolution (issue #19)', () => {
  beforeEach(() => {
    initService();
  });

  it('getArticleFull requests redirect resolution and surfaces the resolved title/pageid', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        redirects: [{ from: 'NYC', to: 'New York City' }],
        pages: {
          '645042': {
            pageid: 645042,
            title: 'New York City',
            extract: 'New York City is the most populous city in the United States.',
          },
        },
      },
    });

    const result = await svc.getArticleFull('NYC', 'en', ctx);
    // The alias resolves to the target article rather than an empty redirect stub.
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ redirects: 'true' }), ctx);
    expect(result.title).toBe('New York City');
    expect(result.pageid).toBe(645042);
    expect(result.content).toContain('New York City');
  });

  it('getArticleSection requests redirect resolution and surfaces the resolved title', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'New York City',
        pageid: 645042,
        wikitext: '== Etymology ==\n\nIn 1664, New York was named after the Duke of York.',
      },
    });

    const result = await svc.getArticleSection('NYC', 1, 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ redirects: 'true' }), ctx);
    expect(result.title).toBe('New York City');
    expect(result.content).toContain('New York');
  });

  it('getSections requests redirect resolution via prop=tocdata and surfaces the resolved title', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'New York City',
        pageid: 645042,
        tocdata: {
          sections: [{ tocLevel: 1, hLevel: 2, line: 'Etymology', number: '1', index: '1' }],
        },
      },
    });

    const result = await svc.getSections('NYC', 'en', ctx);
    // Migrated off deprecated prop=sections and resolving the alias in one call.
    expect(spy).toHaveBeenCalledWith(
      'en',
      expect.objectContaining({ prop: 'tocdata', redirects: 'true' }),
      ctx,
    );
    expect(result.title).toBe('New York City');
    expect(result.pageid).toBe(645042);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toEqual({ index: 1, number: '1', title: 'Etymology', level: 2 });
  });
});

describe('WikipediaService.search — HTML entity decoding (issue #3)', () => {
  beforeEach(() => {
    initService();
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
    initService();
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
    initService();
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
    expect(languages[0]?.editionCode).toBe('fr');
  });
});

describe('WikipediaService.getLanguages — editionCode derivation (issue #17)', () => {
  beforeEach(() => {
    initService();
  });

  it('derives editionCode from the URL host when code and subdomain diverge', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // Alemannic: language code "gsw" but the edition lives on the "als" subdomain.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '23862': {
            pageid: 23862,
            title: 'Python (programming language)',
            langlinks: [
              {
                lang: 'gsw',
                title: 'Python (Programmiersprache)',
                url: 'https://als.wikipedia.org/wiki/Python_(Programmiersprache)',
              },
            ],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Python (programming language)', 'en', ctx);
    expect(languages[0]?.languageCode).toBe('gsw');
    expect(languages[0]?.editionCode).toBe('als');
  });

  it('handles hyphenated edition subdomains as a single host label', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            title: 'Test',
            langlinks: [
              { lang: 'nan', title: 'Test', url: 'https://zh-min-nan.wikipedia.org/wiki/Test' },
            ],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Test', 'en', ctx);
    expect(languages[0]?.editionCode).toBe('zh-min-nan');
  });
});

describe('WikipediaService.search — empty results', () => {
  beforeEach(() => {
    initService();
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
    initService();
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
    initService();
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

  it('marks 404 an expected status so an article miss is not logged as an error', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { restGet: unknown }, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Test',
      extract: 'Content.',
    });

    await svc.getSummary('Test', 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', '/page/summary/Test', ctx, {
      expectedStatuses: [404],
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
    initService();
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
    initService();
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

  it('maps section fields from parse.tocdata.sections correctly (issue #25)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // prop=tocdata shape: sections nest under parse.tocdata and hLevel is a number (prop=sections
    // put them at parse.sections with a string `level`). Output must be identical either way.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Python (programming language)',
        pageid: 23862,
        tocdata: {
          sections: [
            { tocLevel: 1, hLevel: 2, line: 'History', number: '1', index: '1' },
            { tocLevel: 2, hLevel: 3, line: 'Origins', number: '1.1', index: '2' },
          ],
        },
      },
    });

    const result = await svc.getSections('Python (programming language)', 'en', ctx);
    expect(result.title).toBe('Python (programming language)');
    expect(result.pageid).toBe(23862);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toEqual({ index: 1, number: '1', title: 'History', level: 2 });
    expect(result.sections[1]).toEqual({ index: 2, number: '1.1', title: 'Origins', level: 3 });
  });
});

describe('WikipediaService.getLanguages — missing page handling', () => {
  beforeEach(() => {
    initService();
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

  it('resolves the host from the edition registry when llprop=url is absent (issue #24)', async () => {
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
    expect(languages[0]?.url).toBe('https://de.wikipedia.org/wiki/Test_(Deutsch)');
    expect(languages[0]?.editionCode).toBe('de');
  });

  it('resolves the real subdomain for a langcode≠subdomain edition rather than interpolating the code (issue #24)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            title: 'Test',
            // Alemannic: code "gsw" but the edition lives on "als" — interpolating the code
            // would compose the nonexistent host https://gsw.wikipedia.org.
            langlinks: [{ lang: 'gsw', title: 'Test (Alemannisch)' }],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Test', 'en', ctx);
    expect(languages[0]?.url).toBe('https://als.wikipedia.org/wiki/Test_(Alemannisch)');
    expect(languages[0]?.editionCode).toBe('als');
    expect(languages[0]?.languageCode).toBe('gsw');
  });

  it('omits url and editionCode when no host is known for the language code (issue #24)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            title: 'Test',
            langlinks: [{ lang: 'zzz', title: 'Test (Unknown)' }],
          },
        },
      },
    });

    const { languages } = await svc.getLanguages('Test', 'en', ctx);
    expect(languages).toHaveLength(1);
    expect(languages[0]?.languageCode).toBe('zzz');
    expect(languages[0]?.title).toBe('Test (Unknown)');
    // A fabricated https://zzz.wikipedia.org is worse than an absent field.
    expect(languages[0]?.url).toBeUndefined();
    expect(languages[0]?.editionCode).toBeUndefined();
  });

  it('does not consult the registry when every entry carries a url', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            title: 'Test',
            langlinks: [{ lang: 'fr', title: 'Test', url: 'https://fr.wikipedia.org/wiki/Test' }],
          },
        },
      },
    });

    await svc.getLanguages('Test', 'en', ctx);
    expect(svc.fetchEditionIndex).not.toHaveBeenCalled();
  });
});

describe('WikipediaService.getLanguages — redirect resolution (issue #27)', () => {
  beforeEach(() => {
    initService();
  });

  it('requests redirect resolution and returns the resolved title', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        redirects: [{ from: 'NYC', to: 'New York City' }],
        pages: {
          '645042': {
            pageid: 645042,
            title: 'New York City',
            langlinks: [
              { lang: 'fr', title: 'New York', url: 'https://fr.wikipedia.org/wiki/New_York' },
            ],
          },
        },
      },
    });

    const result = await svc.getLanguages('NYC', 'en', ctx);
    // Without redirects=true the alias is a stub carrying no interwiki links at all.
    expect(spy).toHaveBeenCalledWith(
      'en',
      expect.objectContaining({ redirects: 'true', llprop: 'url', lllimit: '500' }),
      ctx,
    );
    expect(result.title).toBe('New York City');
    expect(result.languages).toHaveLength(1);
  });

  it('falls back to the requested title when the response omits one', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '1': {
            pageid: 1,
            langlinks: [{ lang: 'fr', title: 'T', url: 'https://fr.wikipedia.org/wiki/T' }],
          },
        },
      },
    });

    const result = await svc.getLanguages('Requested', 'en', ctx);
    expect(result.title).toBe('Requested');
  });
});

describe('WikipediaService.searchNearby — result mapping', () => {
  beforeEach(() => {
    initService();
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

    const { results, truncated } = await svc.searchNearby(0, 0, 1000, 10, 'en', ctx);
    expect(results).toHaveLength(0);
    expect(truncated).toBe(false);
  });
});

describe('WikipediaService.searchNearby — limit ceiling and truncation (issue #29)', () => {
  beforeEach(() => {
    initService();
  });

  const geoResults = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      pageid: i + 1,
      ns: 0,
      title: `Place ${i + 1}`,
      lat: 0,
      lon: 0,
      dist: i * 10,
    }));

  it('raises the upstream limit to the geosearch ceiling', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc as unknown as { actionGet: unknown }, 'actionGet')
      .mockResolvedValue({ query: { geosearch: geoResults(200) } });

    const { results } = await svc.searchNearby(0, 0, 10_000, 200, 'en', ctx);
    // 50 was 10x stricter than upstream; 200 results are now reachable in one call.
    expect(results).toHaveLength(200);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ gslimit: '201' }), ctx);
  });

  it('clamps a limit above the ceiling to the ceiling', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc as unknown as { actionGet: unknown }, 'actionGet')
      .mockResolvedValue({ query: { geosearch: geoResults(0) } });

    await svc.searchNearby(0, 0, 1000, 5000, 'en', ctx);
    expect(spy).toHaveBeenCalledWith(
      'en',
      expect.objectContaining({ gslimit: String(GEOSEARCH_MAX_LIMIT) }),
      ctx,
    );
  });

  it('reports truncated false when the match count equals the limit exactly', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    // Upstream returns no total, so truncation is established by the probe result: exactly `limit`
    // matches means the probe found nothing extra.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { geosearch: geoResults(10) },
    });

    const { results, truncated } = await svc.searchNearby(0, 0, 1000, 10, 'en', ctx);
    expect(results).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  it('reports truncated true on genuine overflow and trims the probe result', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { geosearch: geoResults(11) },
    });

    const { results, truncated } = await svc.searchNearby(0, 0, 1000, 10, 'en', ctx);
    // The extra result is a probe, never returned to the caller.
    expect(results).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it('reports truncated at the ceiling, where there is no room to probe', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { geosearch: geoResults(GEOSEARCH_MAX_LIMIT) },
    });

    const { results, truncated } = await svc.searchNearby(
      0,
      0,
      10_000,
      GEOSEARCH_MAX_LIMIT,
      'en',
      ctx,
    );
    expect(results).toHaveLength(GEOSEARCH_MAX_LIMIT);
    expect(truncated).toBe(true);
  });
});

describe('WikipediaService — HTML/JSON detection in responses', () => {
  beforeEach(() => {
    initService();
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
    initService();
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

describe('WikipediaService.search — pagination (issue #22)', () => {
  beforeEach(() => {
    initService();
  });

  it('passes sroffset and surfaces nextOffset from continue.sroffset', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 100 },
        search: [{ title: 'R', pageid: 1, snippet: 'S', wordcount: 10 }],
      },
      continue: { sroffset: 10 },
    });

    const { results, totalResults, nextOffset } = await svc.search('q', 5, 'en', ctx, 5);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ sroffset: '5' }), ctx);
    expect(results).toHaveLength(1);
    expect(totalResults).toBe(100);
    expect(nextOffset).toBe(10);
  });

  it('leaves nextOffset undefined at the end of results (no continue block)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: { totalhits: 6 },
        search: [{ title: 'Last', pageid: 9, snippet: 'S', wordcount: 10 }],
      },
    });

    const { nextOffset } = await svc.search('q', 10, 'en', ctx, 5);
    expect(nextOffset).toBeUndefined();
  });

  it('defaults sroffset to "0" when offset is omitted (backward-compat)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { searchinfo: { totalhits: 0 }, search: [] },
    });

    await svc.search('q', 10, 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ sroffset: '0' }), ctx);
  });

  it('returns an empty result array for an offset past totalhits (no error)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      query: { searchinfo: { totalhits: 12 }, search: [] },
    });

    const { results, totalResults, nextOffset } = await svc.search('q', 10, 'en', ctx, 9999);
    expect(results).toHaveLength(0);
    expect(totalResults).toBe(12);
    expect(nextOffset).toBeUndefined();
  });
});

describe('splitArticleIntoSections — section splitting (issue #23)', () => {
  it('splits on == Heading == markers with the lead captured as Introduction', () => {
    const parts = splitArticleIntoSections(
      'Lead text.\n\n== History ==\n\nHist body.\n\n== Syntax ==\n\nSyntax body.',
    );
    expect(parts).toEqual([
      { heading: 'Introduction', body: 'Lead text.' },
      { heading: 'History', body: 'Hist body.' },
      { heading: 'Syntax', body: 'Syntax body.' },
    ]);
  });

  it('handles subsection heading levels (=== ... ===)', () => {
    const parts = splitArticleIntoSections('== A ==\n\nA body.\n\n=== A.1 ===\n\nSub body.');
    expect(parts.map((p) => p.heading)).toEqual(['A', 'A.1']);
    expect(parts[1]?.body).toBe('Sub body.');
  });

  it('returns a single Introduction part when there are no headings', () => {
    expect(splitArticleIntoSections('Just a lead, no sections.')).toEqual([
      { heading: 'Introduction', body: 'Just a lead, no sections.' },
    ]);
  });

  it('returns an empty array for empty content', () => {
    expect(splitArticleIntoSections('')).toEqual([]);
  });
});
