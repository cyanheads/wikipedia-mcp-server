/**
 * @fileoverview Tests for WikipediaService initialization, language validation, HTTP error
 * handling, and data-mapping logic.
 * @module tests/services/wikipedia/wikipedia-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBaseUrl,
  type EditionIndex,
  GEOSEARCH_MAX_LIMIT,
  getWikipediaService,
  htmlSectionToPlainText,
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
        text: '<div class="mw-heading mw-heading2"><h2 id="Etymology">Etymology</h2></div>\n<p>In 1664, New York was named after the Duke of York.\n</p>',
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

describe('WikipediaService.getArticleSection — formatversion=2 parse text (issue #1)', () => {
  beforeEach(() => {
    initService();
  });

  it('reads parse.text as a plain string (formatversion=2 shape)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // formatversion=2: text is `string`, not `{ '*': string }`.
    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Albert Einstein',
        pageid: 736,
        text: '<div class="mw-heading mw-heading2"><h2 id="Special_relativity">Special relativity</h2></div>\n<p>Einstein developed special relativity.\n</p>',
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

  it('derives sectionTitle from the rendered heading, markup stripped', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Roman Empire',
        pageid: 25507,
        // tocdata reports this heading as `<i>Pax Romana</i>`; the rendered text carries no markup.
        text: '<div class="mw-heading mw-heading3"><h3 id="Pax_Romana"><i>Pax Romana</i></h3></div>\n<p>The Roman peace lasted two centuries.\n</p>',
      },
    });

    const result = await svc.getArticleSection('Roman Empire', 3, 'en', ctx);
    expect(result.sectionTitle).toBe('Pax Romana');
    expect(result.content).toContain('Roman peace');
  });

  it('falls back to "Section N" title when the rendered section has no heading', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc as unknown as { actionGet: unknown }, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Article',
        pageid: 42,
        text: '<p>Just plain text without a heading.\n</p>',
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

/**
 * Fixture shaped like `action=parse&prop=text&section=N` for a section that has subsections, with
 * the noise the parser attaches to an isolated section parse: a deduplicated template stylesheet, a
 * `[1]` footnote marker whose target is not in the payload, and the reference list plus cite-error
 * complaint appended after the content. Inline `{{code}}` templates arrive already expanded, which
 * is the property the wikitext path could not have.
 */
const SECTION_WITH_SUBSECTIONS_HTML = `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<div class="mw-heading mw-heading2"><h2 id="Syntax_and_semantics">Syntax and semantics</h2></div>
<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output .hatnote{font-style:italic}</style>
<p>Python is meant to be an easily readable language.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1"><span class="cite-bracket">&#91;</span>1<span class="cite-bracket">&#93;</span></a></sup>
</p>
<div class="mw-heading mw-heading3"><h3 id="Indentation">Indentation</h3></div>
<p>Python uses <a href="/wiki/Whitespace_character" title="Whitespace character">whitespace</a> indentation to delimit blocks.
</p>
<div class="mw-heading mw-heading3"><h3 id="Statements_and_control_flow">Statements and control flow</h3></div>
<p>Python's statements include the following:
</p>
<ul><li>The assignment statement, using a single equals sign <code>=</code></li>
<li>The <code>if</code> statement, which conditionally executes a block of code, along with <code>else</code> and <code>elif</code> (a contraction of <code>else if</code>)</li></ul>
<div class="mw-heading mw-heading3"><h3 id="Function_syntax">Function syntax</h3></div>
<p>Here is an example:
</p>
<pre><span class="kw">def</span> printer(input1):
    print(input1)

printer(<span class="st">"hello"</span>)
</pre>
<div class="reflist"><ol class="references">
<li id="cite_note-1"><span class="reference-text">Some citation.</span></li>
</ol></div><p><span class="error mw-ext-cite-error" lang="en" dir="ltr">Cite error: There are <code>&lt;ref&gt;</code> tags on this page.</span></p></div>`;

describe('htmlSectionToPlainText — parser HTML rendering (issue #28)', () => {
  const text = htmlSectionToPlainText(SECTION_WITH_SUBSECTIONS_HTML);

  it('keeps every subsection heading attached to its own body, in document order', () => {
    // The wikitext path hoisted all headings into one leading block, so the body that followed had
    // no headings inside it and no way to tell where one subsection ended and the next began.
    expect(text).toContain(
      '=== Indentation ===\n\nPython uses whitespace indentation to delimit blocks.',
    );
    expect(text.indexOf('== Syntax and semantics ==')).toBeLessThan(
      text.indexOf('Python is meant to be an easily readable language.'),
    );
    expect(text.indexOf('Python is meant to be an easily readable language.')).toBeLessThan(
      text.indexOf('=== Indentation ==='),
    );
    expect(text.indexOf('=== Indentation ===')).toBeLessThan(
      text.indexOf('=== Statements and control flow ==='),
    );
    // No two headings are adjacent — that adjacency was the fake table of contents.
    expect(text).not.toMatch(/^={2,6} .+ ={2,6}\n\n={2,6} /m);
  });

  it('preserves inline template text that wikitext stripping dropped', () => {
    expect(text).toContain(
      'The if statement, which conditionally executes a block of code, along with else and elif (a contraction of else if)',
    );
    expect(text).toContain('The assignment statement, using a single equals sign =');
  });

  it('renders each list item on its own line', () => {
    expect(text).toContain(
      "Python's statements include the following:\n\nThe assignment statement, using a single equals sign =\nThe if statement,",
    );
  });

  it('preserves line breaks and indentation inside a pre block', () => {
    expect(text).toContain('def printer(input1):\n    print(input1)\n\nprinter("hello")');
  });

  it('drops stylesheets, footnote markers, the appended reference list, and the cite-error notice', () => {
    expect(text).not.toContain('mw-parser-output');
    expect(text).not.toContain('font-style');
    expect(text).not.toContain('[1]');
    expect(text).not.toContain('Some citation.');
    expect(text).not.toContain('Cite error');
  });

  it('leaves no HTML tags, entities, or sentinels in the output', () => {
    expect(text).not.toMatch(/<\/?[a-z][a-z0-9]*[\s>/]/i);
    expect(text).not.toMatch(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i);
    expect(text).not.toMatch(/\uFFFF/);
  });

  it('drops a table whole, including one nested inside another', () => {
    const nested =
      '<p>Before.</p><table><tr><td>outer cell<table><tr><td>inner cell</td></tr></table>trailing outer cell</td></tr></table><p>After.</p>';
    expect(htmlSectionToPlainText(nested)).toBe('Before.\n\nAfter.');
  });

  it('drops an element hidden with an inline style, whatever its tag', () => {
    expect(
      htmlSectionToPlainText(
        '<p>Kept.</p><div style="display:none">Hidden.</div><p>Also kept.</p>',
      ),
    ).toBe('Kept.\n\nAlso kept.');
    // Casing, spacing, and neighbouring declarations are all things MediaWiki emits.
    expect(
      htmlSectionToPlainText('<p>A</p><span style="border:1px; display: NONE;padding:0">B</span>'),
    ).toBe('A');
    // Only `none` hides an element — every other display value is visible content.
    expect(htmlSectionToPlainText('<p>A</p><div style="display:block">B</div>')).toBe('A\n\nB');
  });

  it('does not consume the rest of the payload for a hidden void element', () => {
    // `<img>` has no end tag, so a nesting walk started from it would find no close and delete
    // everything after it.
    expect(
      htmlSectionToPlainText('<p>Before.</p><img style="display:none" src="x"><p>After.</p>'),
    ).toBe('Before.\n\nAfter.');
  });

  it('drops figures but keeps a same-tag element without the required class', () => {
    expect(
      htmlSectionToPlainText('<p>Text.</p><figure><figcaption>Caption.</figcaption></figure>'),
    ).toBe('Text.');
    // `sup` is dropped only when it carries the `reference` class.
    expect(htmlSectionToPlainText('<p>E = mc<sup>2</sup></p>')).toBe('E = mc2');
  });

  it('decodes named and numeric entities', () => {
    expect(
      htmlSectionToPlainText('<p>Tom &amp; Jerry &#8212; &quot;quoted&quot; &lt;tag&gt;</p>'),
    ).toBe('Tom & Jerry — "quoted" <tag>');
  });

  it('decodes each entity once, so an escaped reference stays literal text', () => {
    // An article writing *about* a character reference arrives as `&amp;#39;` and means the six
    // characters `&#39;` — decoding the ampersand and then re-reading the result yields an
    // apostrophe instead.
    expect(htmlSectionToPlainText('<p>Escape it as &amp;#39; or &amp;amp; in wikitext.</p>')).toBe(
      'Escape it as &#39; or &amp; in wikitext.',
    );
  });

  it('keeps a numeric reference outside Unicode range as written', () => {
    // `String.fromCodePoint` throws above U+10FFFF, and `&amp;#1114112;` is exactly what an article
    // documenting the range limit contains.
    expect(htmlSectionToPlainText('<p>&amp;#1114112; is out of range.</p>')).toBe(
      '&#1114112; is out of range.',
    );
    expect(htmlSectionToPlainText('<p>so is &amp;#x110000;</p>')).toBe('so is &#x110000;');
  });

  it('cannot be made to inject a pre block into surrounding prose', () => {
    // The `<pre>` placeholder is a U+FFFF-delimited index. Decoding must not be able to synthesize
    // that shape from escaped text, or the parked block lands in the middle of the paragraph.
    expect(
      htmlSectionToPlainText('<p>lead &amp;#xFFFF;0&amp;#xFFFF; tail</p><pre>  code</pre>'),
    ).toBe('lead &#xFFFF;0&#xFFFF; tail\n\n  code');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlSectionToPlainText('')).toBe('');
  });
});

/**
 * Fixture shaped like `{{col-begin}}`'s output: two `<ul>` lists laid out in columns by a
 * `role="presentation"` table, preceded by a hatnote. This is the whole body of a Discography or
 * Filmography section, so dropping the table leaves the heading and the hatnote alone.
 */
const LAYOUT_TABLE_HTML = `<div class="mw-heading mw-heading2"><h2 id="Discography">Discography</h2></div>
<div role="note" class="hatnote navigation-not-searchable">Main article: <a href="/wiki/D" title="D">D</a></div>
<div>
<table class="col-begin" role="presentation">
<tbody><tr>
<td class="col-break col-break-2">
<p><b>Studio albums</b>
</p>
<ul><li><i><a href="/wiki/One" title="One">One</a></i> (2006)</li>
<li><i><a href="/wiki/Two" title="Two">Two</a></i> (2008)</li></ul>
</td>
<td class="col-break col-break-2">
<p><b>Re-recorded albums</b>
</p>
<ul><li><i><a href="/wiki/Three" title="Three">Three</a></i> (2021)</li></ul>
</td></tr></tbody></table></div>`;

describe('htmlSectionToPlainText — layout vs data tables (issue #32)', () => {
  it('keeps the lists a layout table wraps, one item per line', () => {
    const text = htmlSectionToPlainText(LAYOUT_TABLE_HTML);
    expect(text).toBe(
      '== Discography ==\n\nMain article: D\n\nStudio albums\n\nOne (2006)\nTwo (2008)\n\nRe-recorded albums\n\nThree (2021)',
    );
  });

  it('separates adjacent cells instead of concatenating them into one line', () => {
    // Without `td` as a block boundary the two columns run together as `Two (2008)Re-recorded`.
    expect(htmlSectionToPlainText(LAYOUT_TABLE_HTML)).not.toMatch(/\(2008\)[^\n]/);
    expect(
      htmlSectionToPlainText(
        '<table role="presentation"><tbody><tr><th>Header</th></tr><tr><td>Left</td><td>Right</td></tr></tbody></table>',
      ),
    ).toBe('Header\n\nLeft\n\nRight');
  });

  it('still drops a data table whole, leaking no cell text into the prose', () => {
    const data =
      '<p>Lead.</p><table class="wikitable"><tbody><tr><th>Year</th><th>Title</th></tr><tr><td>2006</td><td>One</td></tr></tbody></table><p>Trailing.</p>';
    expect(htmlSectionToPlainText(data)).toBe('Lead.\n\nTrailing.');
  });

  it('drops a layout table nested inside a data table along with its parent', () => {
    const nested =
      '<p>Lead.</p><table class="wikitable"><tbody><tr><td>cell<table role="presentation"><tbody><tr><td><ul><li>list item</li></ul></td></tr></tbody></table>trailing cell</td></tr></tbody></table><p>After.</p>';
    const text = htmlSectionToPlainText(nested);
    expect(text).toBe('Lead.\n\nAfter.');
    expect(text).not.toContain('list item');
  });

  it('drops a data table nested inside a layout table while keeping the layout table content', () => {
    const nested =
      '<table role="presentation"><tbody><tr><td><ul><li>keep me</li></ul><table class="wikitable"><tbody><tr><td>drop me</td></tr></tbody></table><p>keep me too</p></td></tr></tbody></table>';
    const text = htmlSectionToPlainText(nested);
    expect(text).toBe('keep me\n\nkeep me too');
    expect(text).not.toContain('drop me');
  });

  it('drops a maintenance banner, which is a layout table carrying an editor notice', () => {
    // The ambox family is `role="presentation"` plus `class="metadata"` — page furniture about the
    // article, not the article.
    const ambox =
      '<p>Body.</p><table class="box-Update plainlinks metadata ambox ambox-content" role="presentation"><tbody><tr><td class="mbox-text">This article needs to be updated. (November 2024)</td></tr></tbody></table>';
    expect(htmlSectionToPlainText(ambox)).toBe('Body.');
  });
});

/**
 * Fixture shaped like the Math extension's output for one display formula: a `display:none` MathML
 * twin for screen readers, then the fallback `<img>` whose `alt` carries the TeX.
 */
const DISPLAY_MATH_HTML = `<p>The time evolution of a quantum state is described by the Schrödinger equation:
<span class="mwe-math-element mwe-math-element-block"><span class="mwe-math-mathml-display mwe-math-mathml-a11y" style="display: none;"><math display="block" xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle i\\hbar {\\frac {\\partial }{\\partial t}}\\psi (t)=H\\psi (t).}">
  <semantics>
    <mrow class="MJX-TeXAtom-ORD">
      <mstyle displaystyle="true" scriptlevel="0">
        <mi>i</mi>
        <mi class="MJX-variant">&#x210F;</mi>
        <mi>&#x03C8;</mi>
        <mo>=</mo>
        <mi>H</mi>
        <mo>.</mo>
      </mstyle>
    </mrow>
    <annotation encoding="application/x-tex">{\\displaystyle i\\hbar {\\frac {\\partial }{\\partial t}}\\psi (t)=H\\psi (t).}</annotation>
  </semantics>
</math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/5c41b5" class="mwe-math-fallback-image-display mw-invert skin-invert" aria-hidden="true" style="vertical-align: -2.005ex;" alt="{\\displaystyle i\\hbar {\\frac {\\partial }{\\partial t}}\\psi (t)=H\\psi (t).}"></span>
</p>
<p>Here <span class="mwe-math-element mwe-math-element-inline"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle H}"><semantics><mrow><mi>H</mi></mrow><annotation encoding="application/x-tex">{\\displaystyle H}</annotation></semantics></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/75a9ed" class="mwe-math-fallback-image-inline mw-invert skin-invert" aria-hidden="true" alt="{\\displaystyle H}"></span> denotes the Hamiltonian.
</p>`;

/**
 * Fixture shaped like a `{{calculator}}` gadget: an outer container the page hides until the gadget
 * script runs, holding button labels, per-step state, and the hidden formula fields that drive it.
 */
const CALCULATOR_GADGET_HTML = `<div class="mw-heading mw-heading3"><h3 id="Optimizing_bubble_sort">Optimizing bubble sort</h3></div>
<div class="bubble-sort-demo calculator-container calculatorgadget-enabled" style="border: 1px solid #a2a9b1; float: right; display:none;padding:0.5em">
<p><b>Step by step bubble sort</b>
</p>
<p><span class="calculator-field-button cdx-button cdx-button--action-destructive">Reset</span>
<span class="calculator-field-button cdx-button cdx-button--weight-primary">Next step</span>
</p>
<p><span class="calculator-field">44</span> <span class="calculator-field">3</span>
</p>
<p><span class="calculator-field calculator-hideifzero">Comparing A and A</span><span class="calculator-field">Swapping since &gt;</span>
</p>
<span class="calculator-field" id="calculator-field-step" data-calculator-type="hidden" style="display:none;">0</span>
</div>
<p>The bubble sort algorithm can be optimized by observing that the n-th pass finds the n-th largest element.
</p>`;

describe('htmlSectionToPlainText — elements the page hides (issue #33)', () => {
  it('renders each formula exactly once, as the TeX the fallback image carries', () => {
    const text = htmlSectionToPlainText(DISPLAY_MATH_HTML);
    expect(text).toBe(
      'The time evolution of a quantum state is described by the Schrödinger equation:\n{\\displaystyle i\\hbar {\\frac {\\partial }{\\partial t}}\\psi (t)=H\\psi (t).}\n\nHere {\\displaystyle H} denotes the Hamiltonian.',
    );
    // Two carriers of the same TeX reached here: the hidden `<annotation>` and the image `alt`.
    expect(text.match(/\\psi \(t\)=H\\psi \(t\)\./g)).toHaveLength(1);
    // The MathML leaf text rendered as a column of one glyph per source line.
    expect(text).not.toMatch(/^ℏ$/m);
    expect(text).not.toContain('application/x-tex');
  });

  it('keeps an inline formula glued to its surrounding punctuation', () => {
    const inline =
      '<p>where (<span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math><mi>n</mi></math></span><img src="s" class="mwe-math-fallback-image-inline" alt="{\\displaystyle n}"></span>) is the count.</p>';
    expect(htmlSectionToPlainText(inline)).toBe('where ({\\displaystyle n}) is the count.');
  });

  it('decodes an escaped TeX operator once, not twice', () => {
    // The `alt` arrives escaped; inserting it before the single decode pass is what keeps
    // `&amp;` literal rather than re-reading the decoded `&` as another entity.
    const escaped =
      '<p><img src="s" class="mwe-math-fallback-image-inline" alt="{\\displaystyle a&lt;b\\ \\&amp;\\ c&gt;d}"></p>';
    expect(htmlSectionToPlainText(escaped)).toBe('{\\displaystyle a<b\\ \\&\\ c>d}');
  });

  it('drops a math image that carries no alt rather than emitting a placeholder', () => {
    expect(
      htmlSectionToPlainText('<p>x<img src="s" class="mwe-math-fallback-image-inline">y</p>'),
    ).toBe('xy');
  });

  it('leaves no gadget chrome or widget state in a calculator section', () => {
    const text = htmlSectionToPlainText(CALCULATOR_GADGET_HTML);
    expect(text).toBe(
      '=== Optimizing bubble sort ===\n\nThe bubble sort algorithm can be optimized by observing that the n-th pass finds the n-th largest element.',
    );
    for (const chrome of ['Reset', 'Next step', 'Step by step', 'Comparing A and A', 'Swapping']) {
      expect(text).not.toContain(chrome);
    }
  });
});

describe('WikipediaService.getArticleSection — rendered section reads (issue #28)', () => {
  beforeEach(() => {
    initService();
  });

  /** Stub `actionGet` with the given parse payload and hand back the spy for param assertions. */
  function stubParse(payload: unknown) {
    const svc = getWikipediaService();
    const spy = vi
      .spyOn(svc as unknown as { actionGet: unknown }, 'actionGet')
      .mockResolvedValue(payload);
    return { svc, spy };
  }

  it('requests rendered section HTML, not wikitext, with the index forwarded verbatim', async () => {
    const { svc, spy } = stubParse({
      parse: { title: 'Python (programming language)', pageid: 23862, text: '<p>Body.</p>' },
    });

    await svc.getArticleSection('Python (programming language)', 4, 'en', createMockContext());

    const params = spy.mock.calls[0]?.[1] as Record<string, string>;
    expect(params.prop).toBe('text');
    expect(params).not.toHaveProperty('wikitext');
    expect(params.prop).not.toBe('wikitext');
    // The index space is the endpoint's own, shared with getSections' tocdata indices.
    expect(params.section).toBe('4');
    expect(params.page).toBe('Python (programming language)');
  });

  it('returns every subsection of the requested section, each under its own heading', async () => {
    const { svc } = stubParse({
      parse: {
        title: 'Python (programming language)',
        pageid: 23862,
        text: SECTION_WITH_SUBSECTIONS_HTML,
      },
    });

    const result = await svc.getArticleSection(
      'Python (programming language)',
      4,
      'en',
      createMockContext(),
    );

    expect(result.sectionTitle).toBe('Syntax and semantics');
    // `section=N` returns the section plus all of its subsections; none may be dropped.
    for (const heading of ['Indentation', 'Statements and control flow', 'Function syntax']) {
      expect(result.content).toContain(`=== ${heading} ===`);
    }
    expect(splitArticleIntoSections(result.content).map((p) => p.heading)).toEqual([
      'Syntax and semantics',
      'Indentation',
      'Statements and control flow',
      'Function syntax',
    ]);
  });

  it('returns a lone heading and body for a section without subsections', async () => {
    const { svc } = stubParse({
      parse: {
        title: 'TypeScript',
        pageid: 25344315,
        text: '<div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>\n<p>TypeScript was first released in October 2012.\n</p>',
      },
    });

    const result = await svc.getArticleSection('TypeScript', 1, 'en', createMockContext());

    expect(result.sectionTitle).toBe('History');
    expect(result.content).toBe('== History ==\n\nTypeScript was first released in October 2012.');
    expect(splitArticleIntoSections(result.content)).toHaveLength(1);
  });

  it('forwards the first and the last section index unchanged', async () => {
    const { svc, spy } = stubParse({
      parse: { title: 'TypeScript', pageid: 25344315, text: '<p>Body.</p>' },
    });
    const ctx = createMockContext();

    await svc.getArticleSection('TypeScript', 1, 'en', ctx);
    await svc.getArticleSection('TypeScript', 15, 'en', ctx);

    const sections = spy.mock.calls.map((call) => (call[1] as Record<string, string>).section);
    expect(sections).toEqual(['1', '15']);
  });

  it('surfaces an out-of-range index as the API nosuchsection validation error', async () => {
    // Bounds stay with the endpoint: `prop=text` reports `nosuchsection` exactly as `prop=wikitext`
    // did, so no separate check against the section list is needed.
    const { svc } = stubParse({
      error: { code: 'nosuchsection', info: 'There is no section 999 in TypeScript.' },
    });

    await expect(
      svc.getArticleSection('TypeScript', 999, 'en', createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('does not exist'),
    });
  });
});
