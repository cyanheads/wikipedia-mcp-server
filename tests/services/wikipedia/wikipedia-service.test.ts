/**
 * @fileoverview Tests for WikipediaService initialization, language validation, HTTP error
 * handling, and data-mapping logic.
 * @module tests/services/wikipedia/wikipedia-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  articleTableRead,
  articleUrl,
  buildBaseUrl,
  DATA_TABLE_MAX_BYTES,
  type EditionIndex,
  extractReferences,
  GEOSEARCH_MAX_LIMIT,
  getWikipediaService,
  htmlSectionToPlainText,
  initWikipediaService,
  isBlankTitle,
  isInvalidTitle,
  isMalformedLanguage,
  LEAD_SECTION_TITLE,
  parseSiteMatrix,
  redirectInfo,
  SEARCH_MAX_LIMIT,
  SEARCH_RESULT_WINDOW,
  splitArticleIntoSections,
  tocLineToPlainText,
  WikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';

/**
 * `apiGet` is the private fetch seam every public method funnels through. Spying on it needs the
 * method declared as a function: `vi.spyOn` narrows its key parameter to the callable properties of
 * the object it is handed, so an `{ apiGet: unknown }` cast leaves it with none to choose from.
 */
type PrivateApiGet = { apiGet: (...args: unknown[]) => Promise<unknown> };

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

/**
 * Silence and record `logger.warning` for one test. `vi.spyOn` hands back the *existing* spy when
 * one is already installed, so the recorded calls have to be cleared per test and the original
 * restored afterwards — otherwise a later test reads an earlier one's warning.
 */
function captureWarnings() {
  const spy = vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
  spy.mockClear();
  onTestFinished(() => {
    spy.mockRestore();
  });
  return spy;
}

it.each(['', ' colspan="0" rowspan="0"', ' colspan="bad" rowspan="bad"'])(
  'characterizes absent or invalid spans as one cell: %s',
  (attributes) => {
    expect(
      htmlSectionToPlainText(
        `<table class="wikitable"><tr><th>A</th><th>B</th></tr><tr><td${attributes}>X</td><td>Y</td></tr></table>`,
      ),
    ).toBe('| A | B |\n| --- | --- |\n| X | Y |');
  },
);

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
    // Without the edition check this would burn the whole retry ladder before failing.
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

  it('refetches and warns when the storage read throws', async () => {
    const warned = captureWarnings();
    const throwingStorage = {
      get: async () => {
        throw new Error('storage backend offline');
      },
      set: async (key: string, value: unknown) => {
        storageBacking.set(key, value);
      },
    } as unknown as StorageService;
    initWikipediaService(mockConfig, throwingStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue(TEST_EDITION_INDEX);
    const ctx = createMockContext();

    // An unreadable cache degrades to a refetch, not to a failed call.
    expect(await svc.isUnknownEdition('ht', ctx)).toBe(false);
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);

    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('unreadable from storage'),
      expect.anything(),
    );
    const [, payload] = warned.mock.calls[0] ?? [];
    // The correlation fields survive, and the underlying failure reaches the emitted line —
    // `withExtra` rides `extra`, which the logger flattens into the same field the old context
    // spread wrote directly.
    expect(payload).toMatchObject({ requestId: ctx.requestId });
    expect(JSON.stringify(payload)).toContain('storage backend offline');
  });

  it('serves the index from the memo and warns when persisting it fails', async () => {
    const warned = captureWarnings();
    const readOnlyStorage = {
      get: async (key: string) => storageBacking.get(key) ?? null,
      set: async () => {
        throw new Error('storage is read-only');
      },
    } as unknown as StorageService;
    initWikipediaService(mockConfig, readOnlyStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue(TEST_EDITION_INDEX);
    const ctx = createMockContext();

    // A failed write is memo-only, not a failed resolution — and the second call is still served
    // from the memo rather than refetching.
    expect(await svc.isUnknownEdition('gsw', ctx)).toBe(false);
    expect(await svc.editionHost('gsw', ctx)).toBe('https://als.wikipedia.org');
    expect(svc.fetchEditionIndex).toHaveBeenCalledTimes(1);

    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('could not be persisted'),
      expect.anything(),
    );
    const [, payload] = warned.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ requestId: ctx.requestId });
    expect(JSON.stringify(payload)).toContain('storage is read-only');
  });

  it('warns with the upstream failure detail when the sitematrix fetch fails', async () => {
    const warned = captureWarnings();
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockRejectedValue(new Error('sitematrix unreachable'));
    const ctx = createMockContext();

    await svc.isUnknownEdition('fr', ctx);

    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('sitematrix unavailable'),
      expect.anything(),
    );
    const [, payload] = warned.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ requestId: ctx.requestId });
    expect(JSON.stringify(payload)).toContain('sitematrix unreachable');
  });

  it('forwards expectedStatuses from restGet to the fetch layer', async () => {
    const svc = initService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc as unknown as PrivateApiGet, 'apiGet')
      .mockResolvedValue({ extract: 'x' });

    await svc.restGet('en', '/page/summary/Test', ctx, { expectedStatuses: [404] });
    expect(spy.mock.calls[0]?.[4]).toEqual({ expectedStatuses: [404] });
  });

  it('resolves request hosts from the registry, including a langcode≠subdomain code', async () => {
    const svc = initService();
    const ctx = createMockContext();
    const fetchSpy = vi
      .spyOn(svc as unknown as PrivateApiGet, 'apiGet')
      .mockResolvedValue({ query: { pages: {} } });

    await svc.actionGet('gsw', { action: 'query' }, ctx).catch(() => undefined);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('https://als.wikipedia.org/w/api.php');
  });
});

describe('WikipediaService — caller cancellation', () => {
  /** Record the `signal` the upstream request was issued with, answering a minimal 200. */
  function stubFetch() {
    const seen: (AbortSignal | null | undefined)[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      seen.push(init?.signal);
      return Promise.resolve(
        new Response('{"extract":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    return seen;
  }

  it("composes the handler context's AbortSignal into the upstream request", async () => {
    const svc = initService();
    const seen = stubFetch();
    const controller = new AbortController();
    // The live handler `Context` carries a signal; `RequestContext` does not declare one, and
    // `fetchWithTimeout` strips non-serializable context fields — so the service has to pass it
    // through explicitly for a client disconnect to cancel the in-flight request.
    const ctx = { ...createMockContext(), signal: controller.signal };

    await svc.restGet('en', '/page/summary/Test', ctx);

    const issued = seen[0];
    expect(issued).toBeInstanceOf(AbortSignal);
    expect(issued?.aborted).toBe(false);

    controller.abort();
    expect(issued?.aborted).toBe(true);
  });

  it('issues the request when the context carries no signal', async () => {
    const svc = initService();
    const seen = stubFetch();
    const { signal: _unused, ...ctx } = createMockContext();

    await expect(svc.restGet('en', '/page/summary/Test', ctx)).resolves.toMatchObject({
      extract: 'x',
    });
    // The timeout deadline is still armed — only the caller-cancellation half is absent.
    expect(seen[0]).toBeInstanceOf(AbortSignal);
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {},
    });

    await expect(svc.getArticleFull('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws NotFound when page has missing flag', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

  it('reads the formatversion=2 pages array, the shape upstream actually sends (characterization)', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        pages: [
          {
            pageid: 41545,
            ns: 0,
            title: 'Avogadro constant',
            extract: 'The Avogadro constant is a ratio.',
          },
        ],
      },
    });

    const result = await svc.getArticleFull('Avogadro constant', 'en', createMockContext());
    expect(result).toMatchObject({
      title: 'Avogadro constant',
      pageid: 41545,
      content: 'The Avogadro constant is a ratio.',
    });
  });
});

describe('WikipediaService.getSummary — REST API mapping', () => {
  beforeEach(() => {
    initService();
  });

  it('maps REST summary fields to domain types', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockResolvedValue({
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

  it('returns metadata and an empty extract when REST summary has none', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Empty Article',
      pageid: 1,
    });

    await expect(svc.getSummary('Empty Article', 'en', ctx)).resolves.toMatchObject({
      title: 'Empty Article',
      pageid: 1,
      extract: '',
    });
  });

  it('marks 404 an expected status so an article miss is not logged as an error', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    const spy = vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Test',
      extract: 'Content.',
    });

    await svc.getSummary('Test', 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', '/page/summary/Test', ctx, {
      expectedStatuses: [404],
    });
  });

  it('maps coordinates, canonical URL, and revision from the REST payload (issue #44)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Eiffel Tower',
      pageid: 9232,
      extract: 'The Eiffel Tower is a tower in Paris.',
      coordinates: { lat: 48.85822222, lon: 2.2945 },
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Eiffel_Tower' } },
      revision: '1374916289',
      timestamp: '2026-09-14T20:37:52Z',
    });

    const result = await svc.getSummary('Eiffel Tower', 'en', ctx);
    expect(result.latitude).toBe(48.85822222);
    expect(result.longitude).toBe(2.2945);
    expect(result.url).toBe('https://en.wikipedia.org/wiki/Eiffel_Tower');
    expect(result.revisionId).toBe('1374916289');
    expect(result.lastModified).toBe('2026-09-14T20:37:52Z');
  });

  it('reads an explicit null coordinates the same as an absent one (issue #44)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // A non-geotagged article carries the key with a null value rather than omitting it.
    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Vantablack',
      pageid: 46654049,
      extract: 'Vantablack is a class of super-black coatings.',
      coordinates: null,
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Vantablack' } },
      revision: '1372000000',
      timestamp: '2026-08-01T00:00:00Z',
    });

    const result = await svc.getSummary('Vantablack', 'en', ctx);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    // The rest of the passthrough is unaffected by the absent coordinate.
    expect(result.url).toBe('https://en.wikipedia.org/wiki/Vantablack');
    expect(result.revisionId).toBe('1372000000');
  });

  it('leaves every added field undefined when the payload omits them (issue #44)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Sparse',
      extract: 'Sparse payload.',
    });

    const result = await svc.getSummary('Sparse', 'en', ctx);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    expect(result.url).toBeUndefined();
    expect(result.revisionId).toBeUndefined();
    expect(result.lastModified).toBeUndefined();
  });

  it('drops a half-populated coordinate rather than reporting one axis (issue #44)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'standard',
      title: 'Half Coordinate',
      extract: 'Only one axis.',
      coordinates: { lat: 48.8 },
    });

    const result = await svc.getSummary('Half Coordinate', 'en', ctx);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
  });

  it('wraps NotFound from restGet into a user-friendly message', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'restGet').mockRejectedValue(
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'nosuchsection', info: 'There is no section 99.' },
    });

    await expect(svc.getArticleSection('Python', 99, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('throws NotFound for missingtitle error code', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'missingtitle', info: 'The page you requested does not exist.' },
    });

    await expect(svc.getArticleSection('Nonexistent', 1, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws ServiceUnavailable for unknown API error codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Something went wrong.' },
    });

    await expect(svc.getArticleSection('Python', 1, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Wikipedia API error'),
    });
  });

  it('derives sectionTitle from the rendered heading, markup stripped', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'missingtitle', info: 'The page does not exist.' },
    });

    await expect(svc.getSections('Nonexistent', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No Wikipedia article found'),
    });
  });

  it('throws ServiceUnavailable for unknown API error codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

describe('WikipediaService.getSections — tocdata line is rendered HTML (issue #36)', () => {
  beforeEach(() => {
    initService();
  });

  it('strips tags, decodes entities once, and folds no-break spaces in section titles', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // `line` is rendered HTML, not plain text. The first two entries are verbatim from
    // es:Semana Santa en Sevilla, whose Roman-numeral century template wraps its numeral in a
    // <span> and whose heading wikitext used `&nbsp;`, reaching the API as a literal U+00A0. The
    // last three cover the two entity cases and a line that is already plain.
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Semana Santa en Sevilla',
        pageid: 1174639,
        tocdata: {
          sections: [
            {
              tocLevel: 2,
              hLevel: 3,
              line: 'Siglos <span>XVI</span> y <span>XVII</span>',
              number: '5.1',
              index: '32',
            },
            {
              tocLevel: 2,
              hLevel: 3,
              line: 'Siglo <span>XVIII</span>',
              number: '5.2',
              index: '33',
            },
            { tocLevel: 1, hLevel: 2, line: 'Pasos &amp; palios', number: '6', index: '36' },
            {
              tocLevel: 1,
              hLevel: 2,
              line: 'El tag &amp;lt;ref&amp;gt;',
              number: '7',
              index: '37',
            },
            { tocLevel: 1, hLevel: 2, line: 'Historia', number: '8', index: '38' },
          ],
        },
      },
    });

    const result = await svc.getSections('Semana Santa en Sevilla', 'es', ctx);

    expect(result.sections.map((s) => s.title)).toEqual([
      'Siglos XVI y XVII',
      'Siglo XVIII',
      // One decode pass: `&amp;` becomes `&` …
      'Pasos & palios',
      // … and the same pass leaves `&amp;lt;` as the literal text `&lt;` rather than re-reading it
      // as a tag delimiter (issue #3's single-pass rule).
      'El tag &lt;ref&gt;',
      // A line that is already plain text comes back unchanged.
      'Historia',
    ]);
    for (const section of result.sections) {
      expect(section.title).not.toMatch(/[<> ]/);
    }
  });

  it('leaves the empty-tocdata fallback deriving headings from the article text', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet')
      .mockResolvedValueOnce({
        parse: { title: 'Stubby', pageid: 42, tocdata: { sections: [] } },
      })
      .mockResolvedValueOnce({
        query: {
          pages: {
            '42': {
              pageid: 42,
              title: 'Stubby',
              extract: 'Lead text.\n\n== First ==\nBody.\n\n=== Nested ===\nMore.',
            },
          },
        },
      });

    const result = await svc.getSections('Stubby', 'en', ctx);
    expect(result.sections).toEqual([
      { index: 1, number: '1', title: 'First', level: 2 },
      { index: 2, number: '2', title: 'Nested', level: 3 },
    ]);
  });
});

describe('WikipediaService.getLanguages — missing page handling', () => {
  beforeEach(() => {
    initService();
  });

  it('throws NotFound when page has missing flag', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
      .spyOn(svc, 'actionGet')
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
      .spyOn(svc, 'actionGet')
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: { geosearch: geoResults(10) },
    });

    const { results, truncated } = await svc.searchNearby(0, 0, 1000, 10, 'en', ctx);
    expect(results).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  it('reports truncated true on genuine overflow and trims the probe result', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'restGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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

    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: { searchinfo: { totalhits: 0 }, search: [] },
    });

    await svc.search('q', 10, 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ sroffset: '0' }), ctx);
  });

  it('returns an empty result array for an offset past totalhits (no error)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    vi.spyOn(svc, 'actionGet').mockResolvedValue({
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
    // `sup` is dropped only when it carries the `reference` class; any other renders (issue #48).
    expect(htmlSectionToPlainText('<p>E = mc<sup>2</sup></p>')).toBe('E = mc²');
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
    ).toBe('lead &#xFFFF;0&#xFFFF; tail\n\n```\n  code\n```');
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

  it('renders a data table as rows rather than running its cells into the prose (issue #50)', () => {
    // Reverses this block's original "drops a data table whole": a `wikitable` now renders as pipe
    // rows. Its cells still never reach the prose as paragraphs of their own.
    const data =
      '<p>Lead.</p><table class="wikitable"><tbody><tr><th>Year</th><th>Title</th></tr><tr><td>2006</td><td>One</td></tr></tbody></table><p>Trailing.</p>';
    expect(htmlSectionToPlainText(data)).toBe(
      'Lead.\n\n| Year | Title |\n| --- | --- |\n| 2006 | One |\n\nTrailing.',
    );
  });

  // The two nesting cases below use an unclassed table without `role` — a table the renderer still
  // drops. A `wikitable` renders since issue #50, and its own nesting cases are covered there.
  it('drops a layout table nested inside a data table along with its parent', () => {
    const nested =
      '<p>Lead.</p><table><tbody><tr><td>cell<table role="presentation"><tbody><tr><td><ul><li>list item</li></ul></td></tr></tbody></table>trailing cell</td></tr></tbody></table><p>After.</p>';
    const text = htmlSectionToPlainText(nested);
    expect(text).toBe('Lead.\n\nAfter.');
    expect(text).not.toContain('list item');
  });

  it('drops a data table nested inside a layout table while keeping the layout table content', () => {
    const nested =
      '<table role="presentation"><tbody><tr><td><ul><li>keep me</li></ul><table><tbody><tr><td>drop me</td></tr></tbody></table><p>keep me too</p></td></tr></tbody></table>';
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

/**
 * Fixture shaped like `Barack Obama`'s `External links` section: `{{Library resources box}}` and
 * `{{Sister project links}}` — both `<div class="side-box metadata …">`, which the `<table>` rule
 * never reached — then `{{Spoken Wikipedia}}`, which carries neither `metadata` nor `side-box`. The
 * section's own content is the `Official` subsection below all three.
 */
const SIDE_BOX_SECTION_HTML = `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<div class="mw-heading mw-heading2"><h2 id="External_links">External links</h2></div>
<div class="side-box metadata side-box-right"><style data-mw-deduplicate="TemplateStyles:r1126788409">.mw-parser-output .plainlist ol{list-style:none}</style>
<div class="side-box-abovebelow">
<a href="/wiki/Wikipedia:The_Wikipedia_Library" title="Wikipedia:The Wikipedia Library">Library resources</a> about <br /> <b>Barack Obama</b> <hr /></div>
<div class="side-box-flex">
<div class="side-box-text plainlist"><ul><li><a class="external text" href="https://ftl.toolforge.org/x?st=viaf">Online books</a></li>
<li><a class="external text" href="https://ftl.toolforge.org/y?st=viaf">Resources in your library</a></li></ul></div></div>
<div class="side-box-abovebelow"><b>By Barack Obama</b>
<div class="plainlist"><ul><li><a class="external text" href="https://ftl.toolforge.org/z?at=viaf">Online books</a></li></ul></div></div>
</div>
<div role="navigation" aria-labelledby="sister-projects" class="side-box metadata side-box-right sister-box sistersitebox plainlinks">
<div class="side-box-abovebelow">
<b>Barack Obama</b>  at Wikipedia's <a href="/wiki/Wikipedia:Wikimedia_sister_projects" title="Wikipedia:Wikimedia sister projects"><span id="sister-projects">sister projects</span></a></div>
<div class="side-box-flex">
<div class="side-box-text plainlist"><ul><li><span class="sister-link"><a href="https://commons.wikimedia.org/wiki/Barack_Obama" class="extiw" title="c:Barack Obama">Media</a> from Commons</span></li><li><span class="sister-link"><a href="https://www.wikidata.org/wiki/Q76" class="extiw" title="d:Q76">Data</a> from Wikidata</span></li></ul></div></div>
</div>
<div class="spoken-wikipedia noprint haudio"><div class="spoken-wikipedia-header"><span class="spoken-wikipedia-listen-to">Listen to this article</span><br />(3&#160;parts, <span class="duration"><span class="h">2</span> hours and <span class="min">11</span> minutes</span>)</div><div class="spoken-wikipedia-files">
<ol><li><span typeof="mw:File"><span><audio id="mwe_player_2" controls="" preload="none" class="mw-file-element"><source src="//upload.wikimedia.org/wikipedia/commons/2/22/En-Barack_Obama_1of3-article.ogg" type="audio/ogg" /></audio></span></span></li></ol>
</div><div class="spoken-wikipedia-disclaimer">These audio files were created from a revision of this article dated 3&#160;July&#160;2026<span style="display: none;">&#160;(<span class="bday dtstart published updated itvstart">2026-07-03</span>)</span>, and do not reflect subsequent edits.</div><div class="spoken-wikipedia-footer">(<a href="/wiki/Wikipedia:Media_help" class="mw-redirect" title="Wikipedia:Media help">Audio help</a>&#160;· <a href="/wiki/Wikipedia:Spoken_articles" title="Wikipedia:Spoken articles">More spoken articles</a>)</div></div>
<div class="mw-heading mw-heading3"><h3 id="Official">Official</h3></div>
<ul><li><span class="official-website"><span class="url"><a rel="nofollow" class="external text" href="https://www.obama.org/">Official website</a> of The Obama Foundation</span></span></li></ul></div>`;

describe('htmlSectionToPlainText — side boxes and furniture bars (issue #34)', () => {
  const text = htmlSectionToPlainText(SIDE_BOX_SECTION_HTML);

  it('leaves the section with its heading and its own content only', () => {
    expect(text).toBe(
      '== External links ==\n\n=== Official ===\n\nOfficial website of The Obama Foundation',
    );
  });

  it('drops the library-resources side box, labels and all', () => {
    for (const label of [
      'Library resources',
      'Online books',
      'Resources in your library',
      'By Barack Obama',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  it('drops the sister-projects side box', () => {
    for (const label of [
      "at Wikipedia's sister projects",
      'Media from Commons',
      'Data from Wikidata',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  it('drops the spoken-article box, which asserts a recording plain text cannot reach', () => {
    for (const label of [
      'Listen to this article',
      'hours and',
      'do not reflect subsequent edits',
      'More spoken articles',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  it('drops a portal bar and a sister bar, which carry the marker with role="navigation"', () => {
    const bars = `<p>Body.</p><div class="portal-bar noprint metadata noviewer portal-bar-bordered" role="navigation" aria-label="Portals"><span class="portal-bar-header"><a href="/wiki/Wikipedia:Contents/Portals" title="Wikipedia:Contents/Portals">Portals</a>:</span><ul class="portal-bar-content"><li class="portal-bar-item"><a href="/wiki/Portal:Cities" title="Portal:Cities">Cities</a></li></ul></div><div class="noprint metadata sister-bar" role="navigation" aria-label="sister-projects"><div class="sister-bar-header"><b>Mathematics</b> at Wikipedia's sister projects:</div><ul class="sister-bar-content"><li class="sister-bar-item"><span class="sister-bar-link"><a href="https://en.wiktionary.org/wiki/x" class="extiw" title="wikt:x"><b>Definitions</b></a> from Wiktionary</span></li></ul></div>`;
    expect(htmlSectionToPlainText(bars)).toBe('Body.');
  });

  it('drops a maintenance banner emitted as a div, not only the table form', () => {
    // English Wikipedia's ambox family is a `role="presentation"` table the table rule already
    // dropped; several other editions emit the same banner as a `<div>`.
    const divAmbox = `<p>Lead.</p><div class="mbox-Нет_источников plainlinks metadata ambox ambox-content"><div class="mbox-text"><div class="mbox-text-div">В статье <b>не хватает ссылок на источники</b>.</div><div class="mbox-textsmall-div hide-when-compact"><span class="hide-when-compact"> Информация должна быть проверяема.</span> <span class="mbox-date"><i>(<span class="date">17 декабря 2024</span>)</i></span></div></div></div><p>Trailing.</p>`;
    expect(htmlSectionToPlainText(divAmbox)).toBe('Lead.\n\nTrailing.');
  });

  it('keeps a hatnote that carries the marker, which names an article to read next', () => {
    // French Wikipedia's `{{Article détaillé}}` — the counterpart of English Wikipedia's `{{Main}}` —
    // is a `bandeau-container` carrying `metadata`, so dropping every element with the marker would
    // delete the pointer. `fr:Paris` alone has 46 of them.
    const detail = `<div class="bandeau-container bandeau-section metadata bandeau-niveau-information"><div class="bandeau-cell bandeau-icone-css loupe">Article détaillé&#160;: <a href="/wiki/Plans_de_Paris" title="Plans de Paris">Plans de Paris</a>.</div></div>
<p>Au milieu du Bassin parisien, deux îles sur la Seine constituent le cœur historique de Paris.</p>`;
    expect(htmlSectionToPlainText(detail)).toBe(
      'Article détaillé : Plans de Paris.\n\nAu milieu du Bassin parisien, deux îles sur la Seine constituent le cœur historique de Paris.',
    );
  });

  it('keeps a side box without the marker, whose captions are the article describing a recording', () => {
    // `{{Listen}}` is `class="side-box side-box-right listen noprint"` with no `metadata`, and its
    // captions are prose about the audio, so the marker is what separates the two side-box uses.
    const listen = `<div class="side-box side-box-right listen noprint">
<div class="side-box-flex">
<div class="side-box-text plainlist"><div class="haudio">
<div class="listen-file-header"><a href="/wiki/File:Taylor_Swift_-_Our_Song.ogg" title="File:Taylor Swift - Our Song.ogg">"Our Song" (2006)</a></div>
<div class="description">Swift sings with a <a href="/wiki/Southern_American_English" title="Southern American English">Southern</a> accent in "Our Song".</div></div></div></div>
</div>`;
    const rendered = htmlSectionToPlainText(listen);
    expect(rendered).toContain('"Our Song" (2006)');
    expect(rendered).toContain('Swift sings with a Southern accent in "Our Song".');
  });

  it('keeps content beside a side box nested inside a layout table', () => {
    // A dropped element inside a kept one: the walk enters the layout table, then removes only the
    // side box's own subtree.
    const nested = `<table role="presentation"><tbody><tr><td><ul><li>keep me</li></ul><div class="side-box metadata side-box-right"><div class="side-box-abovebelow">Library resources</div><div class="side-box-text"><ul><li>Online books</li></ul></div></div><p>keep me too</p></td></tr></tbody></table>`;
    const rendered = htmlSectionToPlainText(nested);
    expect(rendered).toBe('keep me\n\nkeep me too');
    expect(rendered).not.toContain('Library resources');
    expect(rendered).not.toContain('Online books');
  });

  it('drops a layout table nested inside a side box along with its parent', () => {
    // The reverse nesting: a kept-by-its-own-rule element inside a dropped one goes with the box,
    // because the box's whole body is furniture.
    const nested = `<p>Lead.</p><div class="side-box metadata side-box-right"><div class="side-box-text"><table role="presentation"><tbody><tr><td><ul><li>Online books</li></ul></td></tr></tbody></table></div></div><p>After.</p>`;
    const rendered = htmlSectionToPlainText(nested);
    expect(rendered).toBe('Lead.\n\nAfter.');
    expect(rendered).not.toContain('Online books');
  });

  it('consumes the whole side box, not up to the first nested close tag', () => {
    // Every real side box wraps its body in `side-box-abovebelow`/`side-box-flex` divs. A non-greedy
    // match would end the box at the first inner `</div>` and spill the rest into the prose.
    const sameTag = `<p>Before.</p><div class="side-box metadata side-box-right"><div>inner one</div><div>inner two</div>trailing box text</div><p>After.</p>`;
    expect(htmlSectionToPlainText(sameTag)).toBe('Before.\n\nAfter.');
  });

  it('drops an unclosed side box through to the end of the payload', () => {
    // Same contract the table rule already has: an unclosed element runs to the end rather than
    // leaving the walk to guess where it stopped.
    expect(
      htmlSectionToPlainText('<p>Before.</p><div class="side-box metadata"><p>Library resources'),
    ).toBe('Before.');
  });

  it('does not treat a void element carrying the marker as a container', () => {
    // A nesting walk started from a void tag would find no close and delete the rest of the payload.
    expect(
      htmlSectionToPlainText('<p>Before.</p><img class="side-box metadata" src="x"><p>After.</p>'),
    ).toBe('Before.\n\nAfter.');
  });

  it('still keeps a layout table that carries neither the marker nor a box class', () => {
    expect(htmlSectionToPlainText(LAYOUT_TABLE_HTML)).toBe(
      '== Discography ==\n\nMain article: D\n\nStudio albums\n\nOne (2006)\nTwo (2008)\n\nRe-recorded albums\n\nThree (2021)',
    );
  });
});

describe('htmlSectionToPlainText — tables the renderer still drops (characterization)', () => {
  it('drops a navbox, whose tables carry neither a data-table class nor the layout role', () => {
    const navbox = `<p>Before.</p><div role="navigation" class="navbox" aria-label="Navbox"><table class="nowraplinks navbox-inner"><tbody><tr><th class="navbox-group">Topics</th><td class="navbox-list"><ul><li>Alpha</li><li>Beta</li></ul></td></tr></tbody></table></div><p>After.</p>`;
    expect(htmlSectionToPlainText(navbox)).toBe('Before.\n\nAfter.');
  });

  it('drops a sidebar table', () => {
    const sidebar = `<table class="sidebar nomobile nowraplinks"><tbody><tr><th class="sidebar-title">Series</th></tr><tr><td class="sidebar-content">Part one</td></tr></tbody></table><p>Body.</p>`;
    expect(htmlSectionToPlainText(sidebar)).toBe('Body.');
  });

  it('drops an unclassed chart table, such as the bar boxes beside a results table', () => {
    const barbox = `<p>Lead.</p><div class="barbox"><table><caption class="bb-default">Popular vote</caption><tbody><tr><td colspan="2" class="bb-min8"><b>Trump</b></td><td class="bb-b"><div style="width:49.80%">&#8203;</div></td><td colspan="2" class="bb-r">49.80%</td></tr></tbody></table></div><p>After.</p>`;
    expect(htmlSectionToPlainText(barbox)).toBe('Lead.\n\nAfter.');
  });

  it('renders a succession box as layout prose — the layout role outranks its wikitable class', () => {
    const succession = `<table role="presentation" class="wikitable succession-box noprint"><tbody><tr><td class="succession-before">Preceded by<br /><b>Alpha</b></td><td class="succession-title">Office</td><td class="succession-after">Succeeded by<br /><b>Beta</b></td></tr></tbody></table>`;
    expect(htmlSectionToPlainText(succession)).toBe(
      'Preceded by\nAlpha\n\nOffice\n\nSucceeded by\nBeta',
    );
  });

  it('renders an unclosed pre as prose, losing none of its text', () => {
    expect(htmlSectionToPlainText('<p>Lead.</p><pre>  x &lt; y')).toBe('Lead.\n\nx < y');
  });

  it('renders an unclosed superscript as its text, losing none of what follows', () => {
    expect(htmlSectionToPlainText('<p>10<sup>23 and the rest</p>')).toBe('1023 and the rest');
  });
});

describe('htmlSectionToPlainText — superscripts and subscripts (issue #48)', () => {
  it('renders exponents as Unicode superscripts, so they stay apart from the digits beside them', () => {
    expect(
      htmlSectionToPlainText(
        '<p>the exact value 6.02214076×10<sup>23</sup>&#160;<a href="/wiki/Mole_(unit)">mol</a><sup>−1</sup> (reciprocal mole)</p>',
      ),
    ).toBe('the exact value 6.02214076×10²³ mol⁻¹ (reciprocal mole)');
    expect(htmlSectionToPlainText('<p>about 1.496×10<sup>8</sup>&#160;kilometres</p>')).toBe(
      'about 1.496×10⁸ kilometres',
    );
    expect(htmlSectionToPlainText('<p>O(<i>n</i><sup>2</sup>) and 2<sup>n-1</sup></p>')).toBe(
      'O(n²) and 2ⁿ⁻¹',
    );
  });

  it('renders digit subscripts as Unicode subscripts', () => {
    expect(htmlSectionToPlainText('<p>H<sub>2</sub>O and CO<sub>2</sub></p>')).toBe('H₂O and CO₂');
    expect(htmlSectionToPlainText('<p><sup>1</sup>⁄<sub>2</sub> cup</p>')).toBe('¹⁄₂ cup');
  });

  it('marks a superscript with no Unicode form by a caret, parenthesized past one character', () => {
    expect(htmlSectionToPlainText('<p>e<sup>x</sup> in the 19<sup>th</sup> century</p>')).toBe(
      'e^x in the 19^(th) century',
    );
  });

  it('marks a subscript with no Unicode form by an underscore', () => {
    expect(htmlSectionToPlainText('<p>denoted <i>N</i><sub>A</sub> or v<sub>max</sub></p>')).toBe(
      'denoted N_A or v_(max)',
    );
  });

  it('keeps a bracketed or symbol-only superscript as written — a marker, not an exponent', () => {
    expect(
      htmlSectionToPlainText(
        '<p>Claim.<sup class="noprint Inline-Template Template-Fact">[<i>citation needed</i>]</sup> Tallest<sup class="citation nobold">[I]</sup> tower<sup>†</sup> (<a>listen</a><sup class="ext-phonos-attribution">ⓘ</sup>)</p>',
      ),
    ).toBe('Claim.[citation needed] Tallest[I] tower† (listenⓘ)');
  });

  it('still drops a footnote reference marker whole', () => {
    expect(
      htmlSectionToPlainText(
        '<p>Mass 1.989×10<sup>30</sup>&#160;kg<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>',
      ),
    ).toBe('Mass 1.989×10³⁰ kg');
  });

  it('decodes a caret-marked superscript once', () => {
    expect(htmlSectionToPlainText('<p>x<sup>a&amp;lt;b</sup></p>')).toBe('x^(a&lt;b)');
  });

  it('renders a superscript inside a heading', () => {
    expect(htmlSectionToPlainText('<h2>Order 2<sup>n</sup></h2><p>Body.</p>')).toBe(
      '== Order 2ⁿ ==\n\nBody.',
    );
  });

  it('keeps an abbreviation superscript joined, as its edition writes it in plain text', () => {
    // French Wikipedia wraps ordinals and abbreviations in `<abbr>`: {{s|XIX}}, {{1er}}, {{Mme}}, {{n°}}.
    const html =
      '<p>Au <abbr class="abbr" title="Dix-neuvième"><span class="romain" style="text-transform:uppercase">XIX</span><sup style="font-size:72%">e</sup></abbr> siècle, le <abbr class="abbr" title="premier">1<sup>er</sup></abbr> mai, <abbr class="abbr" title="Madame">M<sup>me</sup></abbr> Curie, <abbr class="abbr" title="numéro">n<sup>o</sup></abbr> 5, <abbr class="abbr" title="Douzième">12<sup>e</sup></abbr>/14.</p>';
    expect(htmlSectionToPlainText(html)).toBe(
      'Au XIXe siècle, le 1er mai, Mme Curie, no 5, 12e/14.',
    );
  });

  it('still marks an exponent outside an abbreviation, and renders glyph digits inside one', () => {
    expect(
      htmlSectionToPlainText(
        '<p>N &lt; 2<sup>K</sup>, e<sup>x</sup>, 12<sup>e</sup> and 40 <abbr title="mètres carrés">m<sup>2</sup></abbr></p>',
      ),
    ).toBe('N < 2^K, e^x, 12^e and 40 m²');
  });

  it('does not let an unclosed abbreviation reach past a block to join a later exponent', () => {
    expect(htmlSectionToPlainText('<p><abbr>XIX</p><p>Then e<sup>x</sup>.</abbr></p>')).toBe(
      'XIX\n\nThen e^x.',
    );
  });

  it('renders a nested script from the inside out, so an inner exponent stays an exponent', () => {
    expect(
      htmlSectionToPlainText(
        '<p>∫ e<sup>−t<sup>2</sup></sup> dt, x<sup>a<sub>i</sub></sup>, 2<sup>2<sup>n</sup></sup></p>',
      ),
    ).toBe('∫ e^(−t²) dt, x^(a_i), 2^(2ⁿ)');
  });
});

describe('htmlSectionToPlainText — fenced code blocks (issue #49)', () => {
  it('fences a pre block and keeps its lines and indentation verbatim', () => {
    const html =
      '<p>Program:</p><div class="mw-highlight mw-highlight-lang-python"><pre><span></span><span class="k">if</span> n &lt; 0:\n    factorial *= i\n</pre></div><p>After.</p>';
    expect(htmlSectionToPlainText(html)).toBe(
      'Program:\n\n```\nif n < 0:\n    factorial *= i\n```\n\nAfter.',
    );
  });

  it('makes the fence longer than any backtick run inside the block', () => {
    expect(htmlSectionToPlainText('<pre>a ``` b\n````\nc</pre>')).toBe(
      '`````\na ``` b\n````\nc\n`````',
    );
  });

  it('omits a pre block with no text rather than emitting an empty fence', () => {
    expect(htmlSectionToPlainText('<p>Lead.</p><pre>\n  \n</pre><p>After.</p>')).toBe(
      'Lead.\n\nAfter.',
    );
  });

  it('cannot be made to inject a parked block through a decoded placeholder character', () => {
    // A block is parked behind a U+FFFF-delimited index. A numeric reference decoding to U+FFFF
    // would let prose rebuild that placeholder and pull the block into the middle of a sentence.
    const text = htmlSectionToPlainText('<p>lead &#xFFFF;0&#xFFFF; tail</p><pre>code</pre>');
    expect(text).toBe('lead &#xFFFF;0&#xFFFF; tail\n\n```\ncode\n```');
    expect(text.match(/code/g)).toHaveLength(1);
  });
});

describe('WikipediaService — revision-pinned table pages (#67)', () => {
  function fixture(html: string) {
    const svc = initService();
    const action = vi
      .spyOn(svc, 'actionGet')
      .mockResolvedValue({ parse: { title: 'Tables', revid: 42, text: html } });
    const ctx = createMockContext();
    const read = (cursor?: string, index = 1) =>
      svc.getArticleSection(
        'Tables',
        1,
        'en',
        ctx,
        articleTableRead('Tables', 'en', 1, index, cursor, ctx),
      );
    return { action, read, svc, ctx };
  }

  it('pins every continuation to oldid and preserves repeated and blank rows across pages', async () => {
    const value = 'é_*'.repeat(6000);
    const html = `<h2>Rows</h2><table class="wikitable"><caption>Caption</caption><tr><th>H</th></tr><tr><td>A${value}</td></tr><tr><td></td></tr><tr><td>A${value}</td></tr><tr><td>Z</td></tr></table>`;
    const { read, action } = fixture(html);
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await read(cursor);
      pages.push(page);
      cursor = page.tablePage?.next_cursor;
      // Current content changes after page 1; oldid remains the captured revision.
      action.mockImplementation(async (_language, params) => ({
        parse: {
          title: 'Tables',
          revid: params.oldid ? 42 : 99,
          text: params.oldid ? html : '<table class="wikitable"><tr><td>changed</td></tr></table>',
        },
      }));
    } while (cursor);
    expect(pages.map((page) => page.content).join('\n')).toBe(
      `Caption\n\n| H |\n| --- |\n| A${value} |\n|  |\n| A${value} |\n| Z |`,
    );
    expect(pages.map((page) => page.revisionId)).toEqual(['42', '42']);
    expect(pages.map((page) => page.tablePage?.row_offset)).toEqual([0, 3]);
    expect(pages.map((page) => page.tablePage?.rows_returned)).toEqual([3, 2]);
    for (const call of action.mock.calls.slice(1)) {
      expect(call[1]).toMatchObject({ oldid: '42' });
      expect(call[1]).not.toHaveProperty('page');
    }
  });

  it('returns a header-only page and advances before the first data row', async () => {
    const { read } = fixture(
      `<table class="wikitable"><caption>C</caption><tr><th>${'h'.repeat(39976)}</th></tr><tr><td>next row</td></tr></table>`,
    );
    const first = await read();
    expect(first.tablePage).toMatchObject({ rows_returned: 1, row_offset: 0 });
    expect(first.tablePage?.next_cursor).toBeTruthy();
    const next = await read(first.tablePage?.next_cursor);
    expect(next.content).toBe('| next row |');
    expect(next.tablePage).toMatchObject({
      row_offset: 1,
      rows_returned: 1,
      table_continued: true,
    });
    expect(next.tablePage?.next_cursor).toBeUndefined();
  });

  it('fills exactly the byte cap and continues with the next complete row', async () => {
    const header = '| H |\n| --- |\n';
    const value = 'y'.repeat(40000 - header.length - 4);
    const { read } = fixture(
      `<table class="wikitable"><tr><th>H</th></tr><tr><td>${value}</td></tr><tr><td>tail</td></tr></table>`,
    );
    const first = await read();
    expect(Buffer.byteLength(first.content)).toBe(40000);
    expect(first.tablePage).toMatchObject({ rows_returned: 2 });
    expect(first.tablePage?.oversized_row).toBeUndefined();
    const next = await read(first.tablePage?.next_cursor);
    expect(next.content).toBe('| tail |');
    expect(next.tablePage).toMatchObject({ row_offset: 2, rows_returned: 1 });
    expect(next.tablePage?.next_cursor).toBeUndefined();
  });

  it.each(['header', 'data'] as const)(
    'delivers an oversized %s row alone and then advances',
    async (kind) => {
      const huge = 'x'.repeat(40001);
      const html =
        kind === 'header'
          ? `<table class="wikitable"><tr><th>${huge}</th></tr><tr><td>tail</td></tr></table>`
          : `<table class="wikitable"><tr><th>H</th></tr><tr><td>${huge}</td></tr><tr><td>tail</td></tr></table>`;
      const { read } = fixture(html);
      let page = await read();
      if (kind === 'data') page = await read(page.tablePage?.next_cursor);
      expect(page.content).toContain(huge);
      expect(page.tablePage).toMatchObject({ rows_returned: 1, oversized_row: true });
      const tail = await read(page.tablePage?.next_cursor);
      expect(tail.content).toBe('| tail |');
      expect(tail.tablePage?.next_cursor).toBeUndefined();
    },
  );

  it('counts only independently rendered tables in order and preserves nested cells and spans', async () => {
    const { read } = fixture(
      '<table role="presentation"><tr><td><table class="wikitable"><tr><th>H</th></tr><tr><td rowspan="2">X<table class="wikitable"><tr><td>Y<table><tr><td>Z</td></tr></table></td></tr></table></td><td>one</td></tr><tr><td>two</td></tr></table></td></tr></table><table class="infobox"><tr><th>Label:</th><td>Value</td></tr></table>',
    );
    const first = await read();
    expect(first.content).toBe('| H |  |\n| --- | --- |\n| X; Y; Z | one |\n| X; Y; Z | two |');
    expect(first.tablePage?.table_count).toBe(2);
    expect((await read(undefined, 2)).content).toBe('Label: Value');
    await expect(read(undefined, 3)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_table', availableCount: 2 },
    });
  });

  it('pages infobox label/value rows and terminates empty tables', async () => {
    const { read } = fixture(
      `<table class="infobox"><caption>Box</caption><tr><th>One</th><td>${'v'.repeat(25000)}</td></tr><tr><th>Two:</th><td>${'w'.repeat(25000)}</td></tr></table><table class="wikitable"><caption>Empty</caption></table>`,
    );
    const first = await read();
    expect(first.content).toBe(`Box\nOne: ${'v'.repeat(25000)}`);
    const next = await read(first.tablePage?.next_cursor);
    expect(next.content).toBe(`Two: ${'w'.repeat(25000)}`);
    expect(next.tablePage?.next_cursor).toBeUndefined();
    const empty = await read(undefined, 2);
    expect(empty.content).toBe('Empty');
    expect(empty.tablePage).toMatchObject({ rows_returned: 0, table_rows: 0 });
    expect(empty.tablePage?.next_cursor).toBeUndefined();
  });

  it('fails when a pinned revision is unavailable or replaced, never reading current content', async () => {
    const { read, action } = fixture(
      `<table class="wikitable"><tr><th>H</th></tr><tr><td>${'x'.repeat(40001)}</td></tr></table>`,
    );
    const first = await read();
    for (const response of [
      { error: { code: 'nosuchrevid', info: 'missing revision' } },
      { parse: { title: 'Tables', revid: 99, text: '<p>changed</p>' } },
      { parse: { revid: 42 } },
    ]) {
      action.mockResolvedValue(response);
      await expect(read(first.tablePage?.next_cursor)).rejects.toMatchObject({
        data: { reason: 'revision_unavailable' },
      });
    }
    expect(action).toHaveBeenCalledTimes(4);
  });
});

/**
 * Fixture shaped like the `2024 United States presidential election` `Electoral results` table: a
 * caption, two header rows joined by `rowspan`, a `colspan` header over two columns, footnote
 * markers inside header cells, a `colspan` label on a totals row, and a `<th>` row header in the body.
 */
const RESULTS_TABLE_HTML = `<p>Candidates are listed individually below.</p>
<table class="wikitable">
<caption>Electoral results
</caption>
<tbody><tr>
<th rowspan="2">Presidential candidate
</th>
<th colspan="2">Popular vote<sup id="cite_ref-fec_1-1" class="reference"><a href="#cite_note-fec-1">[1]</a></sup>
</th>
<th rowspan="2">Electoral<br />vote
</th></tr>
<tr>
<th>Count
</th>
<th>Percentage
</th></tr>
<tr>
<td><b> <a href="/wiki/Donald_Trump" title="Donald Trump">Donald Trump</a></b>
</td>
<td style="text-align:right;">77,302,580
</td>
<td style="text-align:right;">49.80%
</td>
<td style="text-align:right;">312
</td></tr>
<tr style="text-align:right">
<td colspan="2" style="text-align:left;"><b>Other</b>
</td>
<td>0.30%
</td>
<td>—
</td></tr>
<tr style="text-align:right">
<th colspan="3">Needed to win
</th>
<td>270
</td></tr></tbody></table>
<p>After the table.</p>`;

/** Fixture shaped like the `Eiffel Tower` infobox: title, section headers, and label/value rows. */
const INFOBOX_HTML = `<table class="infobox vcard"><tbody><tr><th colspan="2" class="infobox-above fn org">Eiffel Tower</th></tr><tr><th colspan="2" class="infobox-header">Height</th></tr><tr><th scope="row" class="infobox-label">Architectural</th><td class="infobox-data">300&#160;m (984&#160;ft)<sup id="cite_ref-CTBUH_2-0" class="reference"><a href="#cite_note-CTBUH-2">[2]</a></sup></td></tr><tr><th scope="row" class="infobox-label"><div style="display: inline-block;">Structural engineer</div></th><td class="infobox-data"><a href="/wiki/Maurice_Koechlin">Maurice Koechlin</a><br /><a href="/wiki/%C3%89mile_Nouguier">Émile Nouguier</a></td></tr><tr><th scope="row" class="infobox-label">Coordinates</th><td class="infobox-data"><span class="geo-dms"><span class="latitude">48°51′29.6″N</span> <span class="longitude">2°17′40.2″E</span></span><span style="display:none">48.858222; 2.294500</span></td></tr><tr style="display:none"><td colspan="2">hidden row</td></tr><tr><td colspan="2" class="infobox-full-data"><span class="url"><a href="https://www.toureiffel.paris/en">toureiffel.paris</a></span></td></tr></tbody></table>
<p>The <b>Eiffel Tower</b> is a lattice tower.</p>`;

describe('htmlSectionToPlainText — data tables and infoboxes (issue #50)', () => {
  it('keeps repeated rows and omits blank rows in an inline table (characterization #67)', () => {
    expect(
      htmlSectionToPlainText(
        '<table class="wikitable"><tr><th>H</th></tr><tr><td></td></tr><tr><td>same</td></tr><tr><td>same</td></tr></table>',
      ),
    ).toBe('| H |\n| --- |\n| same |\n| same |');
  });
  it('renders a data table as pipe rows, header row first, with its caption above', () => {
    expect(htmlSectionToPlainText(RESULTS_TABLE_HTML)).toBe(
      [
        'Candidates are listed individually below.',
        '',
        'Electoral results',
        '',
        '| Presidential candidate | Popular vote | Popular vote | Electoral vote |',
        '| --- | --- | --- | --- |',
        '| Presidential candidate | Count | Percentage | Electoral vote |',
        '| Donald Trump | 77,302,580 | 49.80% | 312 |',
        '| Other |  | 0.30% | — |',
        '| Needed to win |  |  | 270 |',
        '',
        'After the table.',
      ].join('\n'),
    );
  });

  it('renders an infobox as one "label: value" line per row', () => {
    expect(htmlSectionToPlainText(INFOBOX_HTML)).toBe(
      [
        'Eiffel Tower',
        'Height',
        'Architectural: 300 m (984 ft)',
        'Structural engineer: Maurice Koechlin; Émile Nouguier',
        'Coordinates: 48°51′29.6″N 2°17′40.2″E',
        'toureiffel.paris',
        '',
        'The Eiffel Tower is a lattice tower.',
      ].join('\n'),
    );
  });

  it('repeats a rowspan cell down every row it covers', () => {
    const html =
      '<table class="wikitable"><tr><th>Year</th><th>Title</th></tr><tr><td rowspan="3">2006</td><td>One</td></tr><tr><td>Two</td></tr><tr><td>Three</td></tr><tr><td>2008</td><td>Four</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe(
      '| Year | Title |\n| --- | --- |\n| 2006 | One |\n| 2006 | Two |\n| 2006 | Three |\n| 2008 | Four |',
    );
  });

  it('renders superscripts inside a cell the same way as in prose', () => {
    const html =
      '<table class="wikitable"><tr><th>Quantity</th><th>Value</th></tr><tr><td>Mass</td><td>1.989×10<sup>30</sup> kg</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toContain('| Mass | 1.989×10³⁰ kg |');
  });

  it('escapes a literal pipe in a cell so it cannot split the row', () => {
    const html =
      '<table class="wikitable"><tr><th>Operator</th></tr><tr><td><code>a | b</code></td></tr><tr><td>x\\|y</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe('| Operator |\n| --- |\n| a \\| b |\n| x\\\\|y |');
  });

  it('flattens a code block inside a cell onto the cell line', () => {
    const html =
      '<table class="wikitable"><tr><th>Language</th><th>Example</th></tr><tr><td>Python</td><td><pre>def f():\n    return 1</pre></td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe(
      '| Language | Example |\n| --- | --- |\n| Python | def f(): return 1 |',
    );
  });

  it('flattens a layout table inside a cell into that cell', () => {
    const html =
      '<table class="wikitable"><tr><th>Artist</th><th>Albums</th></tr><tr><td>A</td><td><table role="presentation"><tr><td><ul><li>One</li><li>Two</li></ul></td></tr></table></td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe(
      '| Artist | Albums |\n| --- | --- |\n| A | One; Two |',
    );
  });

  it('flattens a data table nested two levels deep without letting its rows reach the outer table', () => {
    const html =
      '<table class="wikitable"><tr><th>Outer</th></tr><tr><td>cell<table class="wikitable"><tr><td>inner<table><tr><td>deepest</td></tr></table></td></tr></table>tail</td></tr><tr><td>next</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe(
      '| Outer |\n| --- |\n| cell; inner; deepest; tail |\n| next |',
    );
  });

  it('renders a data table nested in a layout table, keeping the layout content around it', () => {
    const html =
      '<table role="presentation"><tbody><tr><td><p>keep me</p><table class="wikitable"><tr><th>Y</th></tr><tr><td>1</td></tr></table><p>keep me too</p></td></tr></tbody></table>';
    expect(htmlSectionToPlainText(html)).toBe('keep me\n\n| Y |\n| --- |\n| 1 |\n\nkeep me too');
  });

  it('drops furniture nested inside a data table while rendering the table', () => {
    const html =
      '<table class="wikitable"><tr><th>A</th></tr><tr><td>kept<div class="side-box metadata"><p>Library resources</p></div><span style="display:none">hidden</span></td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe('| A |\n| --- |\n| kept |');
  });

  it('leaves a one-line marker in place of a table over the size cap', () => {
    const cell = 'x'.repeat(100);
    const rows = Math.ceil(DATA_TABLE_MAX_BYTES / 100) + 1;
    const html = `<p>Lead.</p><table class="wikitable"><caption>Big</caption><tr><th>H</th></tr>${`<tr><td>${cell}</td></tr>`.repeat(rows)}</table><p>After.</p>`;
    expect(htmlSectionToPlainText(html)).toBe(
      `Lead.\n\nBig\n\n[table omitted: ${rows + 1} rows (table 1)]\n\nAfter.`,
    );
  });

  it('renders a table exactly at the cap in full', () => {
    const header = '| H |\n| --- |\n';
    const cell = 'y'.repeat(DATA_TABLE_MAX_BYTES - header.length - 4);
    const text = htmlSectionToPlainText(
      `<table class="wikitable"><tr><th>H</th></tr><tr><td>${cell}</td></tr></table>`,
    );
    expect(Buffer.byteLength(text)).toBe(DATA_TABLE_MAX_BYTES);
    expect(text).toBe(`${header}| ${cell} |`);
  });

  it('renders nothing for a data table with no cell text, and keeps its caption', () => {
    expect(
      htmlSectionToPlainText(
        '<p>Lead.</p><table class="wikitable"><caption>Empty</caption><tr><td> </td><td></td></tr></table>',
      ),
    ).toBe('Lead.\n\nEmpty');
    expect(htmlSectionToPlainText('<p>Lead.</p><table class="wikitable"></table>')).toBe('Lead.');
  });

  it('renders the rows of an unclosed table and of cells missing their end tags', () => {
    expect(
      htmlSectionToPlainText('<table class="wikitable"><tr><th>A<th>B<tr><td>1<td>2<tr><td>3'),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |');
  });

  it('writes a header cell alone on its row once, as a group label rather than a column heading', () => {
    const html =
      '<table class="wikitable"><tr><th colspan="3">Season by season</th></tr><tr><th>Team</th><th colspan="2">Result</th></tr><tr><th colspan="3">Group A</th></tr><tr><td>X</td><td>3</td><td>1</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe(
      [
        '| Season by season |  |  |',
        '| --- | --- | --- |',
        '| Team | Result | Result |',
        '| Group A |  |  |',
        '| X | 3 | 1 |',
      ].join('\n'),
    );
  });

  it('drops an infobox image caption, which describes a picture the text cannot carry', () => {
    const html =
      '<table class="infobox"><tbody><tr><th colspan="2" class="infobox-above">Eiffel Tower</th></tr><tr><td colspan="2" class="infobox-image"><span typeof="mw:File"><img src="t.jpg" alt="The tower"></span><div class="infobox-caption">Seen from the Champ de Mars, 2009</div></td></tr><tr><td colspan="2" class="infobox-image"><a class="mw-kartographer-map"><img alt="Map" src="m.png"></a><div class="infobox-caption">Interactive map of the Eiffel Tower area</div></td></tr><tr><th class="infobox-label">Height</th><td class="infobox-data">330 m</td></tr></tbody></table>';
    expect(htmlSectionToPlainText(html)).toBe('Eiffel Tower\nHeight: 330 m');
  });

  it('drops the edit links an infobox carries, on each edition’s own markup', () => {
    const html = [
      '<table class="infobox"><tbody><tr><th class="infobox-above">Die Dubarry</th></tr>',
      '<tr><th class="label">Reino:</th><td>Animalia</td></tr>',
      '<tr><td class="noprint" colspan="2"><div class="plainlinks wikidata-link">&#x5b;<a href="https://www.wikidata.org/wiki/Q1">editar datos en Wikidata</a>&#x5d;</div></td></tr>',
      '<tr><td colspan="2"><p class="navbar bordered noprint"><a href="/w/index.php?action=edit">modifier</a></p></td></tr>',
      '<tr><td colspan="2"><div class="plainlinks hlist navbar mini"><ul><li>view</li><li>talk</li><li>edit</li></ul></div></td></tr>',
      '<tr><th class="label">Born</th><td>1908<span class="noprint ForceAgeToShow"> (age 38)</span></td></tr>',
      '</tbody></table>',
    ].join('');
    expect(htmlSectionToPlainText(html)).toBe('Die Dubarry\nReino: Animalia\nBorn: 1908 (age 38)');
  });

  it('keeps the title Module:Navbar sets beside its edit links', () => {
    const html =
      '<div style="font-weight:bold"><div class="navbar plainlinks hlist navbar-collapse navbar-mini"><ul><li class="nv-view"><abbr>v</abbr></li><li class="nv-talk"><abbr>t</abbr></li><li class="nv-edit"><abbr>e</abbr></li></ul></div><div class="navbar-ct-mini">Left-step periodic table (by Charles Janet)</div></div>';
    expect(htmlSectionToPlainText(html)).toBe('Left-step periodic table (by Charles Janet)');
  });

  it('treats a zero or non-numeric span as one cell and clamps a rowspan past the last row', () => {
    const html =
      '<table class="wikitable"><tr><th colspan="0">A</th><th colspan="x">B</th></tr><tr><td rowspan="999">1</td><td>2</td></tr><tr><td>3</td></tr></table>';
    expect(htmlSectionToPlainText(html)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 1 | 3 |');
  });
});

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

describe('htmlSectionToPlainText — parse-preview warnings (issue #57)', () => {
  const PREVIEW_WARNINGS =
    '<p><b>White</b> is a community in Ontario.</p><div class="preview-warning"><strong>Preview warning:</strong> Page using <a href="/wiki/Template:Infobox_settlement" title="Template:Infobox settlement">Template:Infobox settlement</a> with deprecated parameter <code>settlement_type</code>. Replace with <code>type</code>.</div><link rel="mw-deduplicated-inline-style" href="mw-data:TemplateStyles:r1"><div class="preview-warning"><strong>Preview warning:</strong> Page using <a href="/wiki/Template:Infobox_settlement">Template:Infobox settlement</a> with deprecated parameter <code>image_caption</code>. Replace with <code>caption</code>.</div><p>It lies on the river.</p>';

  it('drops every preview warning and keeps the prose around them', () => {
    expect(htmlSectionToPlainText(PREVIEW_WARNINGS)).toBe(
      'White is a community in Ontario.\n\nIt lies on the river.',
    );
  });

  it('keeps a div whose class only starts with preview-warning', () => {
    expect(htmlSectionToPlainText('<div class="preview-warning-note">Kept text.</div>')).toBe(
      'Kept text.',
    );
  });
});

describe('htmlSectionToPlainText — hidden CS1 messages (issue #75)', () => {
  /**
   * A "Modern sources" bibliography entry from Augustus, `action=parse` at revision 1382367536
   * (captured 2026-10-29), trimmed to the one `<li>`. The page's TemplateStyles hide `.cs1-maint`
   * and `.cs1-hidden-error` (`display:none`) and colour `.cs1-visible-error` without hiding it.
   */
  const CITATION =
    '<link rel="mw-deduplicated-inline-style" href="mw-data:TemplateStyles:r1333433106" /><cite id="CITEREFRowell1962" class="citation book cs1">Rowell, Henry Thompson (1962). <a rel="nofollow" class="external text" href="https://books.google.com/books?id=mGJecvVJ4aUC"><i>Rome in the Augustan Age</i></a>. The Centers of Civilization Series. Vol.&#160;5. Norman, Oklahoma: University of Oklahoma Press. <a href="/wiki/ISBN_(identifier)" class="mw-redirect" title="ISBN (identifier)">ISBN</a>&#160;<a href="/wiki/Special:BookSources/0-8061-0956-4" title="Special:BookSources/0-8061-0956-4"><bdi>0-8061-0956-4</bdi></a>.</cite><span title="ctx&#95;ver=Z39.88-2004&amp;rft.genre=book" class="Z3988"></span>';
  const MAINT =
    '<span class="cs1-maint citation-comment"><code class="cs1-code">{{<a href="/wiki/Template:Cite_book" title="Template:Cite book">cite book</a>}}</code>:  CS1 maint: ignored ISBN errors (<a href="/wiki/Category:CS1_maint:_ignored_ISBN_errors" title="Category:CS1 maint: ignored ISBN errors">link</a>)</span>';
  const ROWELL =
    'Rowell, Henry Thompson (1962). Rome in the Augustan Age. The Centers of Civilization Series. Vol. 5. Norman, Oklahoma: University of Oklahoma Press. ISBN 0-8061-0956-4.';

  it('drops the hidden maintenance message from the captured Augustus entry', () => {
    const text = htmlSectionToPlainText(`<ul><li>${CITATION}${MAINT}</li></ul>`);
    expect(text).not.toContain('CS1 maint');
    expect(text).not.toContain('{{cite book}}');
    expect(text).toBe(ROWELL);
  });

  it('leaves the citation text around a hidden message byte-identical', () => {
    expect(htmlSectionToPlainText(`<ul><li>${CITATION}${MAINT}</li></ul>`)).toBe(
      htmlSectionToPlainText(`<ul><li>${CITATION}</li></ul>`),
    );
  });

  it('drops a hidden CS1 error message', () => {
    const hidden =
      '<span class="cs1-hidden-error citation-comment"><code class="cs1-code">{{cite web}}</code>: Unknown parameter <code class="cs1-code">&#124;agency=</code> ignored</span>';
    expect(htmlSectionToPlainText(`<p>${CITATION}${hidden}</p>`)).toBe(ROWELL);
  });

  it('keeps a visible CS1 error, which readers see', () => {
    const visible =
      '<span class="cs1-visible-error citation-comment"><code class="cs1-code">{{cite web}}</code>: </span><span class="cs1-visible-error citation-comment">Missing or empty <code class="cs1-code">&#124;title=</code> (<a href="/wiki/Help:CS1_errors#citation_missing_title">help</a>)</span>';
    expect(htmlSectionToPlainText(`<p>${CITATION}${visible}</p>`)).toBe(
      `${ROWELL}{{cite web}}: Missing or empty |title= (help)`,
    );
  });
});

describe('WikipediaService.getArticleSection — rendered section reads (issue #28)', () => {
  beforeEach(() => {
    initService();
  });

  /** Stub `actionGet` with the given parse payload and hand back the spy for param assertions. */
  function stubParse(payload: unknown) {
    const svc = getWikipediaService();
    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue(payload);
    return { svc, spy };
  }

  it('requests rendered section HTML, not wikitext, with the index forwarded verbatim', async () => {
    const { svc, spy } = stubParse({
      parse: { title: 'Python (programming language)', pageid: 23862, text: '<p>Body.</p>' },
    });

    await svc.getArticleSection('Python (programming language)', 4, 'en', createMockContext());

    const params = spy.mock.calls[0]?.[1] as Record<string, string>;
    // `revid` rides the same request for the citation fields (issue #53).
    expect(params.prop).toBe('text|revid');
    expect(params).not.toHaveProperty('wikitext');
    expect(params.prop).not.toContain('wikitext');
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

/** Lead-section HTML as `section=0` renders it: hatnote and paragraphs, no heading of its own. */
const LEAD_SECTION_HTML = `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<div role="note" class="hatnote navigation-not-searchable">For other uses, see <a href="/wiki/Quokka_(disambiguation)" title="Quokka (disambiguation)">Quokka (disambiguation)</a>.</div>
<table class="infobox biota"><tbody><tr><td>Conservation status</td></tr></tbody></table>
<p>The <b>quokka</b> is a small macropod about the size of a domestic cat.
</p>
<p>It is the only member of the genus <i>Setonix</i>.
</p></div>`;

describe('WikipediaService.getArticleSection — lead section (issue #40)', () => {
  beforeEach(() => {
    initService();
  });

  it('reads the lead through section=0 and labels it Introduction, not "Section 0"', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc, 'actionGet')
      .mockResolvedValue({ parse: { title: 'Quokka', pageid: 235329, text: LEAD_SECTION_HTML } });

    const result = await svc.getArticleSection('Quokka', 0, 'en', ctx);

    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ section: '0' }), ctx);
    expect(result.sectionTitle).toBe(LEAD_SECTION_TITLE);
    expect(result.sectionTitle).toBe('Introduction');
    // The #7 premise — index 0 renders empty — does not hold on the parser-HTML path.
    expect(result.content).not.toBe('');
    expect(result.content).toContain('quokka');
    expect(result.content).toContain('For other uses');
    // The taxobox is an infobox, rendered ahead of the prose as label/value lines (issue #50).
    expect(result.content).toContain('Conservation status\n\nThe quokka');
  });

  it('keeps the "Section N" fallback for a headless section other than the lead', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'Article', pageid: 42, text: '<p>Body without a heading.</p>' },
    });

    const result = await svc.getArticleSection('Article', 5, 'en', ctx);
    expect(result.sectionTitle).toBe('Section 5');
  });

  it('labels the lead Introduction even when its rendered body carries a heading', async () => {
    // The label the outline prints is the contract; a template-emitted heading inside the lead
    // must not rename it to something wikipedia_get_sections never reports.
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Odd',
        pageid: 7,
        text: '<p>Lead prose.</p><div class="mw-heading mw-heading2"><h2 id="X">Stray</h2></div><p>More.</p>',
      },
    });

    const result = await svc.getArticleSection('Odd', 0, 'en', ctx);
    expect(result.sectionTitle).toBe('Introduction');
  });

  it('agrees with the label splitArticleIntoSections prints for the lead', () => {
    const [lead] = splitArticleIntoSections('Lead text.\n\n== History ==\n\nBody.');
    expect(lead?.heading).toBe(LEAD_SECTION_TITLE);
  });
});

describe('isInvalidTitle — MediaWiki page-name guard (issue #42)', () => {
  it('rejects the illegal characters and the multi-title separator', () => {
    for (const title of ['A<B', 'A>B', 'Foo[bar]', 'A]B', 'A{b}', 'A}b', 'Cat|Dog']) {
      expect(isInvalidTitle(title)).toBe(true);
    }
  });

  it('rejects percent escapes, magic tildes, and relative paths', () => {
    for (const title of [
      'A%41B',
      'A~~~B',
      './Cat',
      '../Cat',
      '.',
      '..',
      'Cat/./Dog',
      'Cat/../Dog',
      'Cat/.',
      'Cat/..',
    ]) {
      expect(isInvalidTitle(title)).toBe(true);
    }
  });

  it('accepts a fragment, which MediaWiki strips before resolving the title', () => {
    for (const title of ['A#B', 'Cat#', 'Python (programming language)#History']) {
      expect(isInvalidTitle(title)).toBe(false);
    }
  });

  it('accepts the forms that look illegal but name real pages', () => {
    for (const title of [
      '100% Cat',
      'A~~B',
      ':Cat',
      'A_B',
      'A+B',
      'AC/DC',
      'Rock & Roll',
      'Python (programming language)',
    ]) {
      expect(isInvalidTitle(title)).toBe(false);
    }
  });
});

describe('WikipediaService — Action API error envelopes on HTTP 200 (issue #41)', () => {
  beforeEach(() => {
    initService();
  });

  it('fails a search carrying an error envelope instead of returning an empty result set', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'missingparam', info: 'The "srsearch" parameter must be set.' },
    });

    await expect(svc.search('', 10, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('srsearch'),
    });
  });

  it('maps the offset-too-large refusal to a typed reason naming the window', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: {
        code: 'cirrussearch-offset-too-large',
        info: 'Could not retrieve results. Up to 10000 search results are supported, but results starting at 10000 were requested.',
      },
    });

    await expect(svc.search('Python', 10, 'en', ctx, SEARCH_RESULT_WINDOW)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('10,000'),
      data: { reason: 'offset_too_large' },
    });
  });

  it('clamps the requested page size to this server page-size cap', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc, 'actionGet')
      .mockResolvedValue({ query: { searchinfo: { totalhits: 0 }, search: [] } });

    await svc.search('Python', 999, 'en', ctx);
    expect(spy).toHaveBeenCalledWith(
      'en',
      expect.objectContaining({ srlimit: String(SEARCH_MAX_LIMIT) }),
      ctx,
    );
  });

  it('fails getArticleFull on an error envelope rather than reading past it', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Something went wrong.' },
    });

    await expect(svc.getArticleFull('Python', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Wikipedia API error'),
    });
  });

  it('fails getLanguages on an error envelope rather than reporting no language editions', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Something went wrong.' },
    });

    await expect(svc.getLanguages('Python', 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Wikipedia API error'),
    });
  });

  it('fails searchNearby on an error envelope rather than reporting no nearby articles', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'invalid-coord', info: 'Invalid coordinate provided.' },
    });

    await expect(svc.searchNearby(999, 999, 1000, 10, 'en', ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Invalid coordinate'),
    });
  });

  it('fails the edition-index build on an error envelope rather than parsing an absent matrix', async () => {
    // The sitematrix fetch itself is under test, so it is not stubbed at the method seam here.
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc as unknown as PrivateApiGet, 'apiGet').mockResolvedValue({
      error: { code: 'unknownerror', info: 'Sitematrix is unavailable.' },
    });

    await expect(svc.fetchEditionIndex(ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Sitematrix is unavailable'),
    });
  });
});

describe('WikipediaService — invalid page entries and titles (issue #42)', () => {
  beforeEach(() => {
    initService();
  });

  it('getArticleFull refuses an invalid page entry instead of claiming the article exists', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    // `action=query` answers an illegal title with `invalid: true` and no `missing` key.
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '-1': {
            title: 'A<B',
            invalid: true,
            invalidreason: 'The requested page title contains invalid characters: "<".',
          },
        },
      },
    });

    const rejection = await svc.getArticleFull('A<B', 'en', ctx).then(
      () => undefined,
      (err: unknown) => err as { message: string; data?: { reason?: string } },
    );

    expect(rejection?.data?.reason).toBe('invalid_title');
    expect(rejection?.message).not.toContain('exists but has no readable content');
  });

  it('getLanguages refuses an invalid page entry instead of claiming no other editions', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        pages: {
          '-1': {
            title: 'A<B',
            invalid: true,
            invalidreason: 'The requested page title contains invalid characters: "<".',
          },
        },
      },
    });

    const rejection = await svc.getLanguages('A<B', 'en', ctx).then(
      () => undefined,
      (err: unknown) => err as { message: string; data?: { reason?: string } },
    );

    expect(rejection?.data?.reason).toBe('invalid_title');
    expect(rejection?.message).not.toContain('has no other language editions');
  });

  it('maps the parse API invalidtitle code to the typed reason on both parse paths', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const badTitle = { error: { code: 'invalidtitle', info: 'Bad title "A{b}".' } };

    vi.spyOn(svc, 'actionGet').mockResolvedValue(badTitle);
    await expect(svc.getSections('A{b}', 'en', ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_title' },
    });
    await expect(svc.getArticleSection('A{b}', 1, 'en', ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_title' },
    });
  });
});

// ---------------------------------------------------------------------------
// Issues #51 / #52 — spelling suggestion, and description + QID per search/nearby result
// ---------------------------------------------------------------------------

const EN_ORIGIN = 'https://en.wikipedia.org';

/** The Action API query parameters of a request to the English edition, or undefined otherwise. */
function enActionParams(request: Request): URLSearchParams | undefined {
  const url = new URL(request.url);
  return url.origin === EN_ORIGIN && url.pathname === '/w/api.php' ? url.searchParams : undefined;
}

/**
 * Install a strict fetch fake for one test, routing the `list=search` call and the `pageids=`
 * follow-up separately. Both go through the real `apiGet` → `withRetry` → `fetchWithTimeout`
 * path, so the follow-up's retry policy is what actually runs.
 */
function stubSearchFetch(
  search: Record<string, unknown>,
  followUp: () => Response,
): ReturnType<typeof createFetchMock> {
  const http = createFetchMock([
    {
      match: (request) => enActionParams(request)?.get('list') === 'search',
      respond: () => Response.json(search),
    },
    {
      match: (request) => enActionParams(request)?.has('pageids') === true,
      respond: followUp,
    },
  ]);
  http.install();
  onTestFinished(() => {
    http.restore();
  });
  return http;
}

const followUpCalls = (http: ReturnType<typeof createFetchMock>) =>
  http.calls.filter((call) => enActionParams(call.request)?.has('pageids'));

describe('WikipediaService.search — spelling suggestion (issue #51)', () => {
  beforeEach(() => {
    initService();
  });

  it('returns the suggestion upstream computes for a zero-hit query', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        searchinfo: {
          totalhits: 0,
          suggestion: 'albert einstein relativity',
          suggestionsnippet: 'albert <em>einstein relativity</em>',
        },
        search: [],
      },
    });

    const result = await svc.search('albert einstien relativty', 10, 'en', createMockContext());
    expect(result.suggestion).toBe('albert einstein relativity');
  });

  it('returns the suggestion on a non-empty page too', async () => {
    const svc = getWikipediaService();
    stubSearchFetch(
      {
        query: {
          searchinfo: { totalhits: 8, suggestion: 'einstein' },
          search: [{ title: 'Albert Einstein', pageid: 736, snippet: 'S', wordcount: 10 }],
        },
      },
      () => Response.json({ query: { pages: [{ pageid: 736, title: 'Albert Einstein' }] } }),
    );

    const result = await svc.search('einstien', 10, 'en', createMockContext());
    expect(result.results).toHaveLength(1);
    expect(result.suggestion).toBe('einstein');
  });

  it('omits the suggestion when upstream sends none', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: { searchinfo: { totalhits: 0 }, search: [] },
    });

    const result = await svc.search('Albert Einstein', 10, 'en', createMockContext());
    expect(result).not.toHaveProperty('suggestion');
  });
});

describe('WikipediaService.search — description and QID follow-up (issue #52)', () => {
  beforeEach(() => {
    initService();
  });

  /** A ranked page whose order differs from pageid order, so a merge by position would be wrong. */
  const rankedSearch = {
    query: {
      searchinfo: { totalhits: 4 },
      search: [
        { title: 'Pythonidae', pageid: 300, snippet: 'Snakes', wordcount: 800 },
        { title: 'Python (programming language)', pageid: 23862, snippet: 'Lang', wordcount: 5000 },
        { title: 'List of Python software', pageid: 3673376, snippet: 'List', wordcount: 900 },
        { title: 'Deleted since indexing', pageid: 77, snippet: 'Gone', wordcount: 1 },
      ],
    },
    continue: { sroffset: 4 },
  };

  it('merges description and wikibase_item by pageid, keeping the search ranking', async () => {
    const svc = getWikipediaService();
    const http = stubSearchFetch(rankedSearch, () =>
      // Upstream answers in pageid order, not ranking order, and each record varies in shape.
      Response.json({
        batchcomplete: true,
        query: {
          pages: [
            { pageid: 77, missing: true },
            {
              pageid: 300,
              title: 'Pythonidae',
              description: 'Family of snakes',
              descriptionsource: 'local',
              pageprops: { wikibase_item: 'Q2717' },
            },
            {
              pageid: 23862,
              title: 'Python (programming language)',
              description: 'General-purpose programming language',
              descriptionsource: 'local',
              pageprops: { wikibase_item: 'Q28865' },
            },
            {
              // A page whose short description is explicitly "none" arrives as an empty string.
              pageid: 3673376,
              title: 'List of Python software',
              description: '',
              descriptionsource: 'local',
              pageprops: { wikibase_item: 'Q6595251' },
            },
          ],
        },
      }),
    );

    const result = await svc.search('python', 4, 'en', createMockContext());

    expect(result.results.map((r) => r.pageid)).toEqual([300, 23862, 3673376, 77]);
    expect(result.results[0]).toEqual({
      title: 'Pythonidae',
      pageid: 300,
      snippet: 'Snakes',
      wordcount: 800,
      description: 'Family of snakes',
      wikibase_item: 'Q2717',
    });
    expect(result.results[1]).toMatchObject({
      description: 'General-purpose programming language',
      wikibase_item: 'Q28865',
    });
    expect(result.results[2]).not.toHaveProperty('description');
    expect(result.results[2]?.wikibase_item).toBe('Q6595251');
    expect(result.results[3]).toEqual({
      title: 'Deleted since indexing',
      pageid: 77,
      snippet: 'Gone',
      wordcount: 1,
    });
    // Existing fields are untouched by the merge.
    expect(result.totalResults).toBe(4);
    expect(result.nextOffset).toBe(4);
    expect(result.descriptionsUnavailable).toBe(false);

    const [lookup] = followUpCalls(http);
    const params = lookup ? enActionParams(lookup.request) : undefined;
    expect(params?.get('pageids')).toBe('300|23862|3673376|77');
    expect(params?.get('prop')).toBe('description|pageprops');
    expect(params?.get('ppprop')).toBe('wikibase_item');
    expect(params?.get('action')).toBe('query');
  });

  it('skips the lookup on an empty page', async () => {
    const svc = getWikipediaService();
    const http = stubSearchFetch({ query: { searchinfo: { totalhits: 12 }, search: [] } }, () =>
      Response.json({ query: { pages: [] } }),
    );

    const result = await svc.search('python', 10, 'en', createMockContext(), 9999);
    expect(result.results).toHaveLength(0);
    expect(http.calls).toHaveLength(1);
    expect(followUpCalls(http)).toHaveLength(0);
    expect(result.descriptionsUnavailable).toBe(false);
  });

  it('returns the results without the fields, once and without retrying, when the lookup fails', async () => {
    const svc = getWikipediaService();
    const warnings = captureWarnings();
    const http = stubSearchFetch(
      rankedSearch,
      () => new Response('upstream overloaded', { status: 503 }),
    );

    const result = await svc.search('python', 4, 'en', createMockContext());

    expect(followUpCalls(http)).toHaveLength(1);
    expect(result.results.map((r) => r.pageid)).toEqual([300, 23862, 3673376, 77]);
    for (const r of result.results) {
      expect(r).not.toHaveProperty('description');
      expect(r).not.toHaveProperty('wikibase_item');
    }
    expect(result.totalResults).toBe(4);
    expect(result.descriptionsUnavailable).toBe(true);
    expect(warnings).toHaveBeenCalled();
  });

  it('treats an Action API error envelope on the lookup as a failed lookup', async () => {
    const svc = getWikipediaService();
    captureWarnings();
    const http = stubSearchFetch(rankedSearch, () =>
      Response.json({ error: { code: 'toomanyvalues', info: 'Too many values supplied.' } }),
    );

    const result = await svc.search('python', 4, 'en', createMockContext());

    expect(followUpCalls(http)).toHaveLength(1);
    expect(result.results).toHaveLength(4);
    expect(result.descriptionsUnavailable).toBe(true);
  });

  it('treats a malformed JSON body on the lookup as a failed lookup', async () => {
    const svc = getWikipediaService();
    captureWarnings();
    const http = stubSearchFetch(
      rankedSearch,
      () => new Response('{"query":{"pages":[', { status: 200 }),
    );

    const result = await svc.search('python', 4, 'en', createMockContext());

    expect(followUpCalls(http)).toHaveLength(1);
    expect(result.results.map((r) => r.pageid)).toEqual([300, 23862, 3673376, 77]);
    expect(result.descriptionsUnavailable).toBe(true);
  });

  it('propagates a caller cancellation during the lookup instead of degrading', async () => {
    const svc = getWikipediaService();
    const warnings = captureWarnings();
    const controller = new AbortController();
    stubSearchFetch(rankedSearch, () => {
      // The caller goes away while the lookup is in flight.
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    await expect(
      svc.search('python', 4, 'en', createMockContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(warnings).not.toHaveBeenCalled();
  });

  it('still fails the search itself when the primary request fails', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      error: { code: 'internal_api_error', info: 'boom' },
    });

    await expect(svc.search('python', 4, 'en', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('WikipediaService.searchNearby — description and QID (issue #52)', () => {
  beforeEach(() => {
    initService();
  });

  it('queries list=geosearch with the coordinate, radius, and probe limit (characterization)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({ query: { geosearch: [] } });

    await svc.searchNearby(48.85822222, 2.2945, 500, 10, 'en', ctx);
    expect(spy).toHaveBeenCalledWith(
      'en',
      expect.objectContaining({
        action: 'query',
        list: 'geosearch',
        gscoord: '48.85822222|2.2945',
        gsradius: '500',
        gslimit: '11',
      }),
      ctx,
    );
  });

  it.each([
    { limit: 10, probe: '11' },
    { limit: GEOSEARCH_MAX_LIMIT, probe: String(GEOSEARCH_MAX_LIMIT) },
  ])(
    'runs the same geosearch as a generator for page props at limit $limit',
    async ({ limit, probe }) => {
      const svc = getWikipediaService();
      const ctx = createMockContext();
      const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({ query: { geosearch: [] } });

      await svc.searchNearby(48.85822222, 2.2945, 20_000, limit, 'en', ctx);
      const params = spy.mock.calls[0]?.[1] as Record<string, string>;
      // The generator must select exactly the page set the list returns, or a result loses its props.
      expect(params.generator).toBe('geosearch');
      expect(params.ggscoord).toBe(params.gscoord);
      expect(params.ggsradius).toBe(params.gsradius);
      expect(params.ggsradius).toBe('10000');
      expect(params.ggslimit).toBe(params.gslimit);
      expect(params.ggslimit).toBe(probe);
      expect(params.prop).toBe('description|pageprops');
      expect(params.ppprop).toBe('wikibase_item');
    },
  );

  it('merges props onto the distance-ordered list by pageid, trimming the probe', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    // Ties at the cap boundary, props in pageid order, and one record of each sparsity shape.
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      batchcomplete: true,
      query: {
        geosearch: [
          { pageid: 9232, ns: 0, title: 'Eiffel Tower', lat: 48.8583, lon: 2.2945, dist: 0 },
          { pageid: 16201796, ns: 0, title: 'Globe Céleste', lat: 48.859, lon: 2.295, dist: 149.4 },
          {
            pageid: 48435351,
            ns: 0,
            title: 'Palazzo Bernardo Nani',
            lat: 48.8583,
            lon: 2.2923,
            dist: 161.2,
          },
          {
            pageid: 27288389,
            ns: 0,
            title: 'Champ de Mars massacre',
            lat: 48.85,
            lon: 2.29,
            dist: 365.7,
          },
          { pageid: 212301, ns: 0, title: 'Champ de Mars', lat: 48.85, lon: 2.29, dist: 365.7 },
        ],
        pages: [
          {
            pageid: 9232,
            title: 'Eiffel Tower',
            description: 'Tower in Paris, France',
            pageprops: { wikibase_item: 'Q243' },
          },
          {
            pageid: 212301,
            title: 'Champ de Mars',
            description: 'Public park in Paris, France',
            pageprops: { wikibase_item: 'Q217925' },
          },
          { pageid: 16201796, title: 'Globe Céleste', pageprops: { wikibase_item: 'Q1468897' } },
          { pageid: 27288389, title: 'Champ de Mars massacre', description: '', pageprops: {} },
          {
            pageid: 48435351,
            title: 'Palazzo Bernardo Nani',
            description: 'Palace on the Grand Canal, Venice',
            pageprops: { wikibase_item: 'Q16585996' },
          },
        ],
      },
    });

    const { results, truncated } = await svc.searchNearby(48.85822222, 2.2945, 500, 4, 'en', ctx);

    expect(truncated).toBe(true);
    expect(results.map((r) => r.pageid)).toEqual([9232, 16201796, 48435351, 27288389]);
    expect(results.map((r) => r.distance_meters)).toEqual([0, 149.4, 161.2, 365.7]);
    expect(results[0]).toEqual({
      title: 'Eiffel Tower',
      pageid: 9232,
      latitude: 48.8583,
      longitude: 2.2945,
      distance_meters: 0,
      description: 'Tower in Paris, France',
      wikibase_item: 'Q243',
    });
    expect(results[1]).not.toHaveProperty('description');
    expect(results[1]?.wikibase_item).toBe('Q1468897');
    expect(results[2]?.description).toBe('Palace on the Grand Canal, Venice');
    expect(results[3]).not.toHaveProperty('description');
    expect(results[3]).not.toHaveProperty('wikibase_item');
  });

  it('leaves a result bare when the generator returned no page for it', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        geosearch: [{ pageid: 5, ns: 0, title: 'Only in the list', lat: 1, lon: 2, dist: 3 }],
        pages: [{ pageid: 6, title: 'Only in the generator', description: 'Elsewhere' }],
      },
    });

    const { results } = await svc.searchNearby(1, 2, 100, 10, 'en', createMockContext());
    expect(results).toEqual([
      { title: 'Only in the list', pageid: 5, latitude: 1, longitude: 2, distance_meters: 3 },
    ]);
  });
});

/**
 * A TextExtracts HTML-mode extract (`prop=extracts` without `explaintext`) in the shape upstream
 * sends it: bare `<hN>` headings, superscripts and subscripts kept, class attributes mostly gone, an
 * inline formula as visible MathML whose `alttext` holds the TeX — including a literal `>` — and a
 * `<pre>` sample.
 */
const HTML_EXTRACT = `<p class="mw-empty-elt">
</p>
<p>In chemistry, the <b>Avogadro constant</b>, commonly denoted <span><b><i>N</i><sub>A</sub></b></span>, has the exact value <span><span data-sort-value="7023602214076000000♠"></span>6.022<span>140</span><span>76</span><span>×</span>10<sup>23</sup> mol<sup>−1</sup></span>.
</p>
<h2><span id="History">History</span></h2>
<p>Named after Amedeo Avogadro.
</p>
<h3><span id="Definition">Definition</span></h3>
<p>For every <span><span><math xmlns="http://www.w3.org/1998/Math/MathML" class="mathjax_ignore" alttext="{\\displaystyle \\varepsilon >0,\\ a&lt;b}">
  <semantics>
    <mrow class="MJX-TeXAtom-ORD">
      <mi>ε</mi>
      <mo>&gt;</mo>
      <mn>0</mn>
    </mrow>
    <annotation encoding="application/x-tex">{\\displaystyle \\varepsilon >0,\\ a&lt;b}</annotation>
  </semantics>
</math></span></span>, it holds.
</p>
<h4><span id="Pseudocode">Pseudocode</span></h4>
<pre>if n &lt; 0:
    x *= 2
</pre>
<ul><li>First</li>
<li>Second</li></ul>`;

/** {@link HTML_EXTRACT} as the full-article path must render it. */
const HTML_EXTRACT_TEXT = [
  'In chemistry, the Avogadro constant, commonly denoted N_A, has the exact value 6.02214076×10²³ mol⁻¹.',
  '',
  '== History ==',
  '',
  'Named after Amedeo Avogadro.',
  '',
  '=== Definition ===',
  '',
  'For every {\\displaystyle \\varepsilon >0,\\ a<b}, it holds.',
  '',
  '==== Pseudocode ====',
  '',
  '```',
  'if n < 0:',
  '    x *= 2',
  '```',
  '',
  'First',
  'Second',
].join('\n');

/** A full-read response for the alias `NYC`, carrying the redirect target's revision and URL. */
function nycFullReadResponse(extract: string) {
  return {
    batchcomplete: true,
    warnings: {
      extracts: { warnings: 'HTML may be malformed and/or unbalanced and may omit inline images.' },
    },
    query: {
      redirects: [{ from: 'NYC', to: 'New York City' }],
      pages: [
        {
          pageid: 645042,
          ns: 0,
          title: 'New York City',
          extract,
          touched: '2026-09-22T15:27:10Z',
          lastrevid: 1376082128,
          fullurl: 'https://en.wikipedia.org/wiki/New_York_City',
          canonicalurl: 'https://en.wikipedia.org/wiki/New_York_City',
          revisions: [
            { revid: 1376082128, parentid: 1376061545, timestamp: '2026-09-21T23:42:01Z' },
          ],
        },
      ],
    },
  };
}

describe('WikipediaService.getArticleFull — HTML-mode extract (issue #48)', () => {
  beforeEach(() => {
    initService();
  });

  it('requests the HTML extract and the citation metadata in one request (issues #48, #53)', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi
      .spyOn(svc, 'actionGet')
      .mockResolvedValue(nycFullReadResponse('<p>New York City.</p>'));

    await svc.getArticleFull('NYC', 'en', ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'en',
      {
        action: 'query',
        titles: 'NYC',
        prop: 'extracts|info|revisions',
        inprop: 'url',
        rvprop: 'ids|timestamp',
        redirects: 'true',
      },
      ctx,
    );
  });

  it('renders headings as == markers, keeps superscripts, fences code, and renders a formula once', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue(nycFullReadResponse(HTML_EXTRACT));

    const { content } = await svc.getArticleFull('NYC', 'en', createMockContext());
    expect(content).toBe(HTML_EXTRACT_TEXT);
    expect(splitArticleIntoSections(content).map((s) => s.heading)).toEqual([
      LEAD_SECTION_TITLE,
      'History',
      'Definition',
      'Pseudocode',
    ]);
  });

  it('loses no text after an unclosed tag, and every heading still splits a section', async () => {
    const svc = getWikipediaService();
    // Unclosed <b>, <i>, <p>, <sup>, and <math>, each followed by more text and a heading. The
    // superscript and the formula each have a closed twin further on that must not reach back.
    const unbalanced = [
      '<p>Lead with an unclosed <b>bold run and 10<sup>8 km of text',
      '<h2>Alpha</h2>',
      '<p>Alpha body <i>never closed, then c<sup>2</sup>.',
      '<p>Formula <math alttext="{\\displaystyle x>1}"><mi>x</mi> left open, still prose.',
      '<h2>Beta</h2>',
      '<p>Beta body <math alttext="{\\displaystyle y}"><mi>y</mi></math> closes.</p>',
    ].join('\n');
    vi.spyOn(svc, 'actionGet').mockResolvedValue(nycFullReadResponse(unbalanced));

    const { content } = await svc.getArticleFull('NYC', 'en', createMockContext());
    for (const text of [
      'Lead with an unclosed bold run and 108 km of text',
      'Alpha body never closed, then c².',
      'left open, still prose.',
      'Beta body {\\displaystyle y} closes.',
    ]) {
      expect(content).toContain(text);
    }
    expect(splitArticleIntoSections(content).map((s) => s.heading)).toEqual([
      LEAD_SECTION_TITLE,
      'Alpha',
      'Beta',
    ]);
  });

  it('reports no readable content when the extract renders to nothing', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue(
      nycFullReadResponse('<p class="mw-empty-elt">\n</p>\n\n<p class="mw-empty-elt">\n\n</p>'),
    );

    await expect(svc.getArticleFull('NYC', 'en', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('no readable content'),
    });
  });
});

describe('WikipediaService.getArticleFull — citation fields (issue #53)', () => {
  beforeEach(() => {
    initService();
  });

  it("returns the redirect target's revision, that revision's timestamp, and its canonical URL", async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue(nycFullReadResponse('<p>New York City.</p>'));

    const result = await svc.getArticleFull('NYC', 'en', createMockContext());
    expect(result).toEqual({
      title: 'New York City',
      pageid: 645042,
      content: 'New York City.',
      redirect: { redirected_from: 'NYC' },
      redirects: [{ from: 'NYC', to: 'New York City' }],
      revisionId: '1376082128',
      // The revision's own timestamp, never `touched`, which moves without an edit.
      lastModified: '2026-09-21T23:42:01Z',
      url: 'https://en.wikipedia.org/wiki/New_York_City',
    });
  });

  it('leaves the citation fields undefined when upstream omits them', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: { pages: [{ pageid: 1, title: 'Sparse', extract: '<p>Body.</p>' }] },
    });

    const result = await svc.getArticleFull('Sparse', 'en', createMockContext());
    expect(result.revisionId).toBeUndefined();
    expect(result.lastModified).toBeUndefined();
    expect(result.url).toBeUndefined();
  });
});

/**
 * Titles paired with the `fullurl` MediaWiki reports for them (`action=query&prop=info&inprop=url`
 * without `redirects`, so each title is encoded as written). Covers every character class
 * `wfUrlencode` treats specially: `/ : ; @ $ ! * ( ) , ~` stay literal, `? & + = % " '` are escaped,
 * and non-ASCII is percent-encoded UTF-8.
 */
const LIVE_FULLURLS: ReadonlyArray<readonly [host: string, title: string, fullurl: string]> = [
  ['https://en.wikipedia.org', 'AC/DC', 'https://en.wikipedia.org/wiki/AC/DC'],
  [
    'https://en.wikipedia.org',
    'Star Trek: The Original Series',
    'https://en.wikipedia.org/wiki/Star_Trek:_The_Original_Series',
  ],
  ['https://en.wikipedia.org', 'C++', 'https://en.wikipedia.org/wiki/C%2B%2B'],
  ['https://en.wikipedia.org', 'Zürich', 'https://en.wikipedia.org/wiki/Z%C3%BCrich'],
  [
    'https://en.wikipedia.org',
    "Who's Afraid of Virginia Woolf?",
    'https://en.wikipedia.org/wiki/Who%27s_Afraid_of_Virginia_Woolf%3F',
  ],
  [
    'https://en.wikipedia.org',
    'Procter & Gamble',
    'https://en.wikipedia.org/wiki/Procter_%26_Gamble',
  ],
  ['https://en.wikipedia.org', 'AT&T', 'https://en.wikipedia.org/wiki/AT%26T'],
  [
    'https://en.wikipedia.org',
    'M*A*S*H (TV series)',
    'https://en.wikipedia.org/wiki/M*A*S*H_(TV_series)',
  ],
  ['https://en.wikipedia.org', '@midnight', 'https://en.wikipedia.org/wiki/@midnight'],
  ['https://en.wikipedia.org', 'Ke$ha', 'https://en.wikipedia.org/wiki/Ke$ha'],
  ['https://en.wikipedia.org', 'E=MC²', 'https://en.wikipedia.org/wiki/E%3DMC%C2%B2'],
  ['https://en.wikipedia.org', '100%', 'https://en.wikipedia.org/wiki/100%25'],
  [
    'https://en.wikipedia.org',
    '"Hello, World!" program',
    'https://en.wikipedia.org/wiki/%22Hello,_World!%22_program',
  ],
  ['https://en.wikipedia.org', 'A;B', 'https://en.wikipedia.org/wiki/A;B'],
  ['https://en.wikipedia.org', 'A~B', 'https://en.wikipedia.org/wiki/A~B'],
  [
    'https://en.wikipedia.org',
    'What If...? (TV series)',
    'https://en.wikipedia.org/wiki/What_If...%3F_(TV_series)',
  ],
  [
    'https://en.wikipedia.org',
    'Mass–energy equivalence',
    'https://en.wikipedia.org/wiki/Mass%E2%80%93energy_equivalence',
  ],
  [
    'https://en.wikipedia.org',
    'Talk:Python (programming language)',
    'https://en.wikipedia.org/wiki/Talk:Python_(programming_language)',
  ],
  ['https://de.wikipedia.org', 'Straße', 'https://de.wikipedia.org/wiki/Stra%C3%9Fe'],
  [
    'https://ja.wikipedia.org',
    '東京都',
    'https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC%E9%83%BD',
  ],
];

describe('articleUrl — MediaWiki title encoding (issue #53)', () => {
  it.each(LIVE_FULLURLS)('encodes %s %s byte-identically to fullurl', (host, title, fullurl) => {
    expect(articleUrl(host, title)).toBe(fullurl);
  });
});

describe('WikipediaService.getArticleSection — citation fields (issue #53)', () => {
  beforeEach(() => {
    initService();
  });

  const SECTION_HTML =
    '<div class="mw-heading mw-heading2"><h2 id="Etymology">Etymology</h2></div>\n<p>In 1664, New York was named after the Duke of York.</p>';

  it('requests the revision with the section and composes the URL from the resolved title', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();
    const spy = vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: {
        title: 'New York City',
        pageid: 645042,
        revid: 1376082128,
        redirects: [{ from: 'NYC', to: 'New York City' }],
        text: SECTION_HTML,
      },
    });

    const result = await svc.getArticleSection('NYC', 1, 'en', ctx);
    expect(spy).toHaveBeenCalledWith('en', expect.objectContaining({ prop: 'text|revid' }), ctx);
    expect(result).toEqual({
      title: 'New York City',
      pageid: 645042,
      sectionTitle: 'Etymology',
      redirect: { redirected_from: 'NYC' },
      content: 'In 1664, New York was named after the Duke of York.'.replace(
        /^/,
        '== Etymology ==\n\n',
      ),
      revisionId: '1376082128',
      url: 'https://en.wikipedia.org/wiki/New_York_City',
    });
    // action=parse carries no revision timestamp, and a second request is not spent on one.
    expect(result).not.toHaveProperty('lastModified');
  });

  it.each(LIVE_FULLURLS)('composes %s %s as fullurl reports it', async (host, title, fullurl) => {
    const svc = getWikipediaService();
    const language = new URL(host).hostname.split('.')[0] as string;
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue({
      ...TEST_EDITION_INDEX,
      hosts: { ...TEST_EDITION_INDEX.hosts, [language]: host },
    });
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title, pageid: 1, revid: 2, text: SECTION_HTML },
    });

    const result = await svc.getArticleSection(title, 1, language, createMockContext());
    expect(result.url).toBe(fullurl);
  });

  it('omits the URL under a single-instance override, whose article path is unknown', async () => {
    const svc = initService('https://mirror.example.org/');
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'New York City', pageid: 645042, revid: 1376082128, text: SECTION_HTML },
    });

    const result = await svc.getArticleSection('New York City', 1, 'en', createMockContext());
    expect(result.revisionId).toBe('1376082128');
    expect(result.url).toBeUndefined();
  });

  it('leaves the revision undefined when the parse payload omits it', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'Sparse', pageid: 1, text: SECTION_HTML },
    });

    const result = await svc.getArticleSection('Sparse', 1, 'en', createMockContext());
    expect(result.revisionId).toBeUndefined();
    expect(result.url).toBe('https://en.wikipedia.org/wiki/Sparse');
  });
});

describe('WikipediaService.getSummary — extract_html (issue #48)', () => {
  beforeEach(() => {
    initService();
  });

  /** Live `extract` / `extract_html` pair for `Avogadro constant`, trimmed to three sentences. */
  const AVOGADRO_SUMMARY = {
    type: 'standard',
    title: 'Avogadro constant',
    pageid: 41545,
    extract:
      'In chemistry, the Avogadro constant, commonly denoted NA, is a conversion constant. It is an SI defining constant with the exact value 6.02214076×1023 mol−1 (reciprocal mole). It was derived from the number of atoms in 12 grams of carbon-12 (12C).',
    extract_html:
      '<p>In chemistry, the <b>Avogadro constant</b>, commonly denoted <span class="texhtml "><b><i>N</i><sub>A</sub></b></span>, is a conversion constant. It is an SI defining constant with the exact value <span class="nowrap">6.022<span>140</span><span>76</span><span>×</span>10<sup>23</sup> mol<sup>−1</sup></span> (reciprocal mole). It was derived from the number of atoms in 12 grams of carbon-12 (<sup>12</sup>C).</p>',
    revision: '1360615018',
    timestamp: '2026-06-22T16:08:35Z',
  };

  it('reads superscripts and subscripts from extract_html instead of the flattened extract', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'restGet').mockResolvedValue(AVOGADRO_SUMMARY);

    const result = await svc.getSummary('Avogadro constant', 'en', createMockContext());
    expect(result.extract).toBe(
      'In chemistry, the Avogadro constant, commonly denoted N_A, is a conversion constant. It is an SI defining constant with the exact value 6.02214076×10²³ mol⁻¹ (reciprocal mole). It was derived from the number of atoms in 12 grams of carbon-12 (¹²C).',
    );
    // The #44 citation fields ride along unchanged.
    expect(result.revisionId).toBe('1360615018');
    expect(result.lastModified).toBe('2026-06-22T16:08:35Z');
  });

  it('keeps a disambiguation list one entry per line, apart from the sentence that introduces it', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'disambiguation',
      title: 'Mercury',
      extract:
        'Mercury most commonly refers to:Mercury (planet), the closest planet to the Sun\nMercury (element), a chemical element',
      extract_html:
        '<p><b>Mercury</b> most commonly refers to:</p><ul><li>Mercury (planet), the closest planet to the Sun</li>\n<li>Mercury (element), a chemical element</li></ul>',
    });

    const result = await svc.getSummary('Mercury', 'en', createMockContext());
    expect(result.extract).toBe(
      'Mercury most commonly refers to:\n\nMercury (planet), the closest planet to the Sun\nMercury (element), a chemical element',
    );
  });

  it('falls back to the plain extract when the payload carries no extract_html', async () => {
    const svc = getWikipediaService();
    const { extract_html: _omitted, ...plainOnly } = AVOGADRO_SUMMARY;
    vi.spyOn(svc, 'restGet').mockResolvedValue(plainOnly);

    const result = await svc.getSummary('Avogadro constant', 'en', createMockContext());
    expect(result.extract).toBe(AVOGADRO_SUMMARY.extract);
  });

  it('renders available HTML even when the plain REST extract is empty', async () => {
    const svc = getWikipediaService();
    vi.spyOn(svc, 'restGet').mockResolvedValue({
      type: 'mainpage',
      title: 'Main Page',
      extract: '',
      extract_html: '<p>Welcome to Wikipedia, the free encyclopedia.</p>',
    });

    await expect(svc.getSummary('Main Page', 'en', createMockContext())).resolves.toMatchObject({
      extract: 'Welcome to Wikipedia, the free encyclopedia.',
    });
  });
});

describe('htmlSectionToPlainText — visible MathML and unbalanced scripts (issues #48, #53)', () => {
  it('renders a visible formula once, as the TeX its alttext carries, even past a literal >', () => {
    const html =
      '<p>For <math class="mathjax_ignore" alttext="{\\displaystyle (\\forall \\varepsilon >0)\\,(0&lt;|x-p|)}"><semantics><mrow><mi>ε</mi><mo>&gt;</mo></mrow><annotation encoding="application/x-tex">{\\displaystyle (\\forall \\varepsilon >0)}</annotation></semantics></math>, done.</p>';
    expect(htmlSectionToPlainText(html)).toBe(
      'For {\\displaystyle (\\forall \\varepsilon >0)\\,(0<|x-p|)}, done.',
    );
  });

  it('still renders a section-read formula once, from the fallback image, with its hidden twin dropped', () => {
    const html =
      '<p>Here <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math alttext="{\\displaystyle H>0}"><mi>H</mi></math></span><img src="s" class="mwe-math-fallback-image-inline" alt="{\\displaystyle H&gt;0}"></span> holds.</p>';
    expect(htmlSectionToPlainText(html)).toBe('Here {\\displaystyle H>0} holds.');
  });

  it('does not let an unclosed superscript reach across a heading to a later one', () => {
    const html = '<p>About 10<sup>8 km away.</p>\n<h2>Orbit</h2>\n<p>Speed c<sup>2</sup>.</p>';
    expect(htmlSectionToPlainText(html)).toBe('About 108 km away.\n\n== Orbit ==\n\nSpeed c².');
  });
});

// ---------------------------------------------------------------------------
// Issue #55 — transient Action API error envelopes on HTTP 200
// ---------------------------------------------------------------------------

/** One upstream reply, built fresh per request so a body is never read twice. */
type Reply = () => Response;

/** An Action API error envelope on HTTP 200, the shape every refusal arrives in. */
const envelope =
  (code: string, info = `${code} from upstream.`, headers?: Record<string, string>): Reply =>
  () =>
    Response.json({ error: { code, info } }, headers ? { headers } : undefined);

const okReply =
  (body: unknown): Reply =>
  () =>
    Response.json(body);

/**
 * Install a strict fetch fake at the network seam, below `apiGet`, so `withRetry` and the envelope
 * classification both run. Requests `match` selects are answered with `replies` in order, the last
 * one repeating; any other Action API request (the search description lookup) gets an empty page.
 */
function stubUpstream(match: (url: URL) => boolean, ...replies: Reply[]) {
  let next = 0;
  const http = createFetchMock([
    {
      match: (request) => match(new URL(request.url)),
      respond: () => (replies[Math.min(next++, replies.length - 1)] as Reply)(),
    },
    {
      match: (request) => new URL(request.url).pathname === '/w/api.php',
      respond: () => Response.json({ query: { pages: [] } }),
    },
  ]);
  http.install();
  onTestFinished(() => {
    http.restore();
  });
  return {
    http,
    /** Requests `match` selected — the upstream call count under test. */
    calls: () => http.calls.filter((call) => match(new URL(call.request.url))).length,
  };
}

const anyActionRequest = (url: URL) => url.pathname === '/w/api.php';
const searchRequest = (url: URL) => url.searchParams.get('list') === 'search';

/** Fake the clock for one test, so a retry ladder runs without sleeping through its backoff. */
function useFakeClock(): void {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Drive `promise` to completion on the fake clock, capturing its outcome without a rejection. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return await outcome;
}

describe('WikipediaService — contract envelopes stay single-request (issue #55, characterization)', () => {
  beforeEach(() => {
    initService();
    useFakeClock();
  });

  it('keeps an unknown refusal as a single-attempt service failure', async () => {
    const { calls } = stubUpstream(
      searchRequest,
      envelope('unrecognized-refusal', 'Unknown refusal.'),
    );
    const { error } = await settle(
      getWikipediaService().search('river intitle:/river/', 3, 'en', createMockContext()),
    );
    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'Wikipedia API error: Unknown refusal.',
    });
  });

  it('missingtitle: one request, NotFound', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(anyActionRequest, envelope('missingtitle'));

    const { error } = await settle(
      svc.getArticleSection('Nonexistent', 1, 'en', createMockContext()),
    );

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('No Wikipedia article found for "Nonexistent"'),
    });
  });

  it('nosuchsection: one request, ValidationError naming the index', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(anyActionRequest, envelope('nosuchsection'));

    const { error } = await settle(svc.getArticleSection('Python', 99, 'en', createMockContext()));

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Section index 99 does not exist'),
      data: { reason: 'invalid_section', title: 'Python', sectionIndex: 99 },
    });
  });

  it.each([
    ['river insource:/[/', 'cirrussearch-regex-syntax-error'],
    ['insource:/a{99999}/', 'cirrussearch-regex-too-complex-error'],
    ['river intitle:/[/', 'cirrussearch-regex-syntax-error'],
    ['intitle:/a{99999}/', 'cirrussearch-regex-too-complex-error'],
  ])('classifies the regex refusal for %s without retrying', async (query, upstreamCode) => {
    const { calls } = stubUpstream(searchRequest, envelope(upstreamCode!, 'Regex refused.'));
    const { error } = await settle(
      getWikipediaService().search(query!, 3, 'en', createMockContext()),
    );
    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_query',
        upstreamCode,
        recovery: { hint: expect.stringContaining('regex') },
      },
    });
  });

  it('invalidtitle: one request, the invalid_title reason', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(anyActionRequest, envelope('invalidtitle', 'Bad title "A{b}".'));

    const { error } = await settle(svc.getSections('A{b}', 'en', createMockContext()));

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_title' },
    });
  });

  it('cirrussearch-offset-too-large: one request, the offset_too_large reason', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(searchRequest, envelope('cirrussearch-offset-too-large'));

    const { error } = await settle(
      svc.search('Python', 10, 'en', createMockContext(), SEARCH_RESULT_WINDOW),
    );

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'offset_too_large' },
    });
  });

  it('a code outside the transient set is not retried: one request, ServiceUnavailable', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope(
        'cirrussearch-backend-error',
        'We could not complete your search due to a temporary problem. Please try again later.',
      ),
    );

    const { error } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message:
        'Wikipedia API error: We could not complete your search due to a temporary problem. Please try again later.',
    });
  });

  it('the description lookup degrades on its one attempt when it meets a transient envelope', async () => {
    const svc = getWikipediaService();
    captureWarnings();
    const lookupRequest = (url: URL) => url.searchParams.has('pageids');
    const http = createFetchMock([
      {
        match: (request) => searchRequest(new URL(request.url)),
        respond: okReply({
          query: {
            searchinfo: { totalhits: 1 },
            search: [{ title: 'Python', pageid: 24, snippet: 'Snakes', wordcount: 10 }],
          },
        }),
      },
      {
        match: (request) => lookupRequest(new URL(request.url)),
        respond: envelope('cirrussearch-too-busy-error', 'Search is currently too busy.', {
          'retry-after': '1',
        }),
      },
    ]);
    http.install();
    onTestFinished(() => {
      http.restore();
    });

    const { value } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    expect(http.calls.filter((call) => lookupRequest(new URL(call.request.url)))).toHaveLength(1);
    expect(value?.results.map((r) => r.pageid)).toEqual([24]);
    expect(value?.descriptionsUnavailable).toBe(true);
  });
});

const TOO_BUSY = 'Search is currently too busy. Please try again later.';

const SEARCH_HIT = {
  query: {
    searchinfo: { totalhits: 1 },
    search: [{ title: 'Python', pageid: 24, snippet: 'Snakes', wordcount: 10 }],
  },
};

/** Capture `promise`'s outcome without driving the clock, for tests that step it by hand. */
function capture<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe('WikipediaService — transient envelopes are retried (issue #55)', () => {
  beforeEach(() => {
    initService();
    useFakeClock();
  });

  it.each([
    'ratelimited',
    'readonly',
    'cirrussearch-too-busy-error',
    'cirrussearch-regex-too-busy-error',
  ])('%s: retried, then the search succeeds', async (code) => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(searchRequest, envelope(code), okReply(SEARCH_HIT));

    const { value, error } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    expect(error).toBeUndefined();
    expect(calls()).toBe(2);
    expect(value?.results.map((r) => r.title)).toEqual(['Python']);
    expect(value?.totalResults).toBe(1);
  });

  it('exhausts the default ladder: four requests, then the envelope as ServiceUnavailable', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('cirrussearch-too-busy-error', TOO_BUSY),
    );

    const { error } = await settle(svc.search('the', 10, 'en', createMockContext(), 9990));

    expect(calls()).toBe(4);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `Wikipedia API error: ${TOO_BUSY} (failed after 4 attempts)`,
      data: { retryAttempts: 4 },
    });
  });

  it('retries an empty result page into a normal empty success', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('ratelimited'),
      okReply({ query: { searchinfo: { totalhits: 0 }, search: [] } }),
    );

    const { value } = await settle(svc.search('xyzzy', 10, 'en', createMockContext()));

    expect(calls()).toBe(2);
    expect(value).toMatchObject({ results: [], totalResults: 0, descriptionsUnavailable: false });
  });

  const callers: Array<{
    name: string;
    success: unknown;
    run: (svc: WikipediaService) => Promise<unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: 'getArticleFull',
      success: {
        query: {
          pages: [
            {
              pageid: 23862,
              title: 'Python',
              extract: '<p>Python is a language.</p>',
              revisions: [{ revid: 5, timestamp: '2026-09-01T00:00:00Z' }],
            },
          ],
        },
      },
      run: (svc) => svc.getArticleFull('Python', 'en', createMockContext()),
      expected: { title: 'Python', content: 'Python is a language.' },
    },
    {
      name: 'getArticleSection',
      success: { parse: { title: 'Python', pageid: 23862, revid: 5, text: '<p>Body.</p>' } },
      run: (svc) => svc.getArticleSection('Python', 0, 'en', createMockContext()),
      expected: { title: 'Python', content: 'Body.' },
    },
    {
      name: 'getSections',
      success: {
        parse: {
          title: 'Python',
          pageid: 23862,
          tocdata: { sections: [{ hLevel: 2, line: 'History', number: '1', index: '1' }] },
        },
      },
      run: (svc) => svc.getSections('Python', 'en', createMockContext()),
      expected: { sections: [{ index: 1, number: '1', title: 'History', level: 2 }] },
    },
    {
      name: 'getLanguages',
      success: {
        query: {
          pages: [
            {
              pageid: 23862,
              title: 'Python',
              langlinks: [
                { lang: 'fr', title: 'Python', url: 'https://fr.wikipedia.org/wiki/Python' },
              ],
            },
          ],
        },
      },
      run: (svc) => svc.getLanguages('Python', 'en', createMockContext()),
      expected: { languages: [expect.objectContaining({ languageCode: 'fr' })] },
    },
    {
      name: 'searchNearby',
      success: {
        query: {
          geosearch: [{ pageid: 9232, title: 'Eiffel Tower', lat: 48.858, lon: 2.294, dist: 12 }],
        },
      },
      run: (svc) => svc.searchNearby(48.858, 2.294, 1000, 10, 'en', createMockContext()),
      expected: { results: [expect.objectContaining({ title: 'Eiffel Tower' })] },
    },
  ];

  it.each(callers)('$name picks up the retry', async ({ success, run, expected }) => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(anyActionRequest, envelope('ratelimited'), okReply(success));

    const { value, error } = await settle(run(svc));

    expect(error).toBeUndefined();
    expect(calls()).toBe(2);
    expect(value).toMatchObject(expected);
  });

  it('fetchEditionIndex picks up the retry within its one-retry budget', async () => {
    // The sitematrix fetch itself is under test, so it is not stubbed at the method seam here.
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      anyActionRequest,
      envelope('readonly'),
      okReply({
        sitematrix: {
          count: 1,
          '0': { code: 'en', site: [{ url: 'https://en.wikipedia.org', code: 'wiki' }] },
        },
      }),
    );

    const { value } = await settle(svc.fetchEditionIndex(createMockContext()));

    expect(calls()).toBe(2);
    expect(value?.hosts.en).toBe('https://en.wikipedia.org');
  });

  it('retries the nested full-article read behind the section-list fallback', async () => {
    const svc = getWikipediaService();
    const extractsRequest = (url: URL) =>
      url.searchParams.get('prop') === 'extracts|info|revisions';
    let extractsCalls = 0;
    const http = createFetchMock([
      {
        match: (request) => new URL(request.url).searchParams.get('action') === 'parse',
        respond: okReply({ parse: { title: 'Python', pageid: 1, tocdata: { sections: [] } } }),
      },
      {
        match: (request) => extractsRequest(new URL(request.url)),
        respond: () =>
          extractsCalls++ === 0
            ? envelope('ratelimited')()
            : Response.json({
                query: {
                  pages: [
                    {
                      pageid: 1,
                      title: 'Python',
                      extract: '<p>Lead.</p><h2>History</h2><p>Past.</p>',
                    },
                  ],
                },
              }),
      },
    ]);
    http.install();
    onTestFinished(() => {
      http.restore();
    });

    const { value } = await settle(svc.getSections('Python', 'en', createMockContext()));

    expect(extractsCalls).toBe(2);
    expect(value?.sections).toEqual([{ index: 1, number: '1', title: 'History', level: 2 }]);
  });

  it('waits the Retry-After the 200 response names instead of the exponential backoff', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('cirrussearch-too-busy-error', TOO_BUSY, { 'retry-after': '3' }),
      okReply(SEARCH_HIT),
    );

    const outcome = capture(svc.search('Python', 10, 'en', createMockContext()));
    // Past the widest exponential first backoff (1,000 ms + 25% jitter), short of the header's 3 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(2);

    await vi.runAllTimersAsync();
    expect((await outcome).value?.results).toHaveLength(1);
  });

  it('fails fast, Retry-After intact, when the named wait exceeds the retry budget', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('ratelimited', 'You have exceeded your rate limit.', { 'retry-after': '60' }),
      okReply(SEARCH_HIT),
    );

    const { error } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    expect(calls()).toBe(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'Wikipedia API error: You have exceeded your rate limit.',
      data: { retryAfter: '60' },
    });
  });

  it('keeps honored Retry-After waits inside the 30 s request deadline', async () => {
    const svc = getWikipediaService();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('cirrussearch-too-busy-error', TOO_BUSY, { 'retry-after': '20' }),
    );
    const startedAt = Date.now();

    const { error } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    // 0 s, then 20 s; a second 20 s wait would end past the 30 s deadline, so the ladder stops.
    expect(calls()).toBe(2);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(30_000);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `Wikipedia API error: ${TOO_BUSY}`,
      data: { retryAfter: '20' },
    });
  });

  it('bounds a stalled upstream at the 30 s request deadline', async () => {
    const svc = getWikipediaService();
    let requests = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    const startedAt = Date.now();

    const { error } = await settle(svc.search('Python', 10, 'en', createMockContext()));

    expect(Date.now() - startedAt).toBeLessThanOrEqual(30_000);
    expect(requests).toBe(2);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 30_000 },
    });
  });

  it('stops the ladder when the caller cancels during a backoff', async () => {
    const svc = getWikipediaService();
    const controller = new AbortController();
    const { calls } = stubUpstream(
      searchRequest,
      envelope('cirrussearch-too-busy-error', TOO_BUSY),
      okReply(SEARCH_HIT),
    );

    const outcome = capture(
      svc.search('Python', 10, 'en', createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(calls()).toBe(1);
    controller.abort();
    await vi.runAllTimersAsync();

    expect(calls()).toBe(1);
    expect((await outcome).error).toMatchObject({ name: 'AbortError' });
  });
});

/** The same-table sibling labels must pair only with the leaf in their own row. */
const TREE =
  '<table class="clade"><tr><td class="clade-label">Family</td><td class="clade-leaf"><table class="clade"><tr><td class="clade-label">Rosoideae</td><td class="clade-leaf"><table class="clade"><tr><td class="clade-label"></td><td class="clade-leaf">Roseae</td></tr><tr><td class="clade-label"></td><td class="clade-leaf">Rubeae</td></tr></table></td></tr><tr><td class="clade-slabel"></td></tr><tr><td class="clade-label">Dryadoideae</td><td class="clade-leaf">Dryadeae</td></tr></table></td></tr><tr><td class="clade-label"></td><td class="clade-leaf">outgroup</td></tr></table>';
const RENDERED_TREE =
  '```\n- Family\n  - Rosoideae\n    - Roseae\n    - Rubeae\n  - Dryadoideae\n    - Dryadeae\n- outgroup\n```';

describe('rendering compatibility characterization', () => {
  it('keeps nested cell tables flat and excluded furniture invisible', () => {
    expect(
      htmlSectionToPlainText(
        '<p>Before.</p><table class="wikitable"><tr><th>H</th></tr><tr><td>A<table><tr><td>B</td></tr></table>C</td></tr></table><table class="navbox"><tr><td>hidden</td></tr></table><table><tr><td>chart</td></tr></table><p>After.</p>',
      ),
    ).toBe('Before.\n\n| H |\n| --- |\n| A; B; C |\n\nAfter.');
  });

  it('retains once-decoded TOC entities and conservative redirect indices', () => {
    expect(tocLineToPlainText(' <span>A&nbsp; B</span> &amp;lt;ref&amp;gt; ')).toBe(
      'A B &lt;ref&gt;',
    );
    expect(
      redirectInfo([{ from: 'Alias', tofragment: 'Missing' }], { tocdata: { sections: [] } }),
    ).toEqual({ redirected_from: 'Alias', redirect_section: 'Missing' });
  });
});

describe('clade row pairing (#68)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps sibling ancestry and terminal order through nested forks', () => {
    expect(htmlSectionToPlainText(TREE)).toBe(RENDERED_TREE);
    expect(
      htmlSectionToPlainText(
        `<table class="clade"><tr><td class="clade-label"></td><td class="clade-leaf">${TREE}</td></tr></table>`,
      ),
    ).toBe(
      '```\n-\n  - Family\n    - Rosoideae\n      - Roseae\n      - Rubeae\n    - Dryadoideae\n      - Dryadeae\n  - outgroup\n```',
    );
  });

  it.each([
    '<table class="clade"></table>',
    '<table class="clade"><tr><td class="clade-label">unpaired</td></tr></table>',
    '<table class="clade"><tr><td class="clade-label"></td><td class="clade-leaf"></td></tr></table>',
    '<table class="clade"><tr><td class="clade-label">A</td><td class="clade-leaf">B',
    '<table class="clade"><tr><td class="clade-label">A</td><td class="clade-leaf"><table><tr><td>B</td></tr></table></td></tr></table>',
  ])('marks unparseable trees: %s', (html) => {
    expect(htmlSectionToPlainText(html)).toBe('[table omitted: unparseable clade]');
  });

  it('normalizes inline scripts, formulas, entities and sizes a safe fence', () => {
    expect(
      htmlSectionToPlainText(
        '<table class="clade"><tr><td class="clade-label">CO<sub>2</sub></td><td class="clade-leaf"><math alttext="x^{2}"><mi>x</mi></math> &amp;lt; ```</td></tr></table>',
      ),
    ).toBe('````\n- CO₂\n  - x^{2} &lt; ```\n````');
  });
});

describe('shared scientific heading normalization (#71)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    (size: number) => '<sup'.repeat(Math.ceil(size / 4)),
    (size: number) => '<sup>'.repeat(Math.ceil(size / 5)),
    (size: number) => `${'x'.repeat(size)}\n`,
    (size: number) => 'x\n'.repeat(Math.ceil(size / 2)),
    (size: number) =>
      `<table class="clade"><tr><td class="clade-label"></td><td class="clade-leaf">${'<table class="clade">'.repeat(Math.ceil(size / 21))}`,
  ])('keeps normalization work bounded across input sizes', (input) => {
    const samples: number[] = [];
    for (const size of [1250, 2500, 5000, 10000, 20000, 40000, 80000]) {
      const html = input(size);
      tocLineToPlainText(html);
      let fastestMs = Infinity;
      for (let run = 0; run < 5; run++) {
        const started = process.threadCpuUsage();
        tocLineToPlainText(html);
        const cpu = process.threadCpuUsage(started);
        fastestMs = Math.min(fastestMs, (cpu.user + cpu.system) / 1000);
      }
      expect(fastestMs).toBeLessThan(2000);
      samples.push(fastestMs);
    }
    expect((samples.at(-1) as number) / Math.max(samples[0] as number, 0.01)).toBeLessThanOrEqual(
      256,
    );
  });

  it.each([
    ['CO<sub>2</sub> fertilization effect', 'CO₂ fertilization effect'],
    ['x<sup>n</sup> N<sub>A</sub> 19<sup>th</sup>', 'xⁿ N_A 19^(th)'],
    ['x<sup>a<sub>i</sub></sup>', 'x^(a_i)'],
    ['<abbr>XIX<sup>e</sup></abbr> <abbr>1<sup>er</sup></abbr>', 'XIXe 1er'],
    ['<span> A&nbsp; <b>B</b> </span> &amp;lt;ref&amp;gt;', 'A B &lt;ref&gt;'],
    ['<math alttext="x^{2}"><mi>x</mi></math>', 'x^{2}'],
    [
      '<span style="display:none"><math alttext="x"><mi>x</mi></math></span><img class="mwe-math-fallback-image-inline" alt="x &amp; y">',
      'x & y',
    ],
  ])('agrees with article headings for %s', (html, expected) => {
    expect(tocLineToPlainText(html)).toBe(expected);
    expect(htmlSectionToPlainText(`<h2>${html}</h2>`)).toBe(`== ${expected} ==`);
  });
});

/**
 * MediaWiki passes an editor's `data-*` attributes through to parser HTML, and `\b` matches after a
 * hyphen, so an attribute rule must not read `data-x-class` as `class` or `data-x-style` as `style`.
 * Each case puts the lookalike beside or before the real attribute, or in place of it.
 */
describe('htmlSectionToPlainText — attribute names read whole, never after a hyphen', () => {
  it.each([
    [
      'HIDDEN_BY_STYLE',
      '<p>Keep <span data-x-style="display:none">this</span> text.</p>',
      'Keep this text.',
    ],
    [
      'NOT_CONTENT',
      '<div class="side-box" data-x-class="metadata">Boxed prose.</div>',
      'Boxed prose.',
    ],
    [
      'FURNITURE_BOX',
      '<div class="metadata" data-x-class="side-box">Pointer prose.</div>',
      'Pointer prose.',
    ],
    [
      'NAVIGATION_ROLE',
      '<div class="metadata" data-x-role="navigation">Nav prose.</div>',
      'Nav prose.',
    ],
    [
      'PRESENTATION_ROLE',
      '<p>Before.</p><table data-x-role="presentation"><tr><td>Chart cell</td></tr></table>',
      'Before.',
    ],
    [
      'CLASS_ATTRIBUTE',
      '<table data-x-class="infobox" class="wikitable"><tr><th>H</th></tr><tr><td>v</td></tr></table>',
      '| H |\n| --- |\n| v |',
    ],
    ['hasClass', '<p>10<sup data-x-class="reference" class="x">2</sup> m</p>', '10² m'],
    [
      'MATH_FALLBACK_IMAGE',
      '<p>See <img data-x-class="mwe-math-fallback-image-inline" class="photo" alt="caption"> here.</p>',
      'See here.',
    ],
    [
      'ALT_ATTRIBUTE',
      '<p>Let <img class="mwe-math-fallback-image-inline" data-x-alt="wrong" alt="{\\displaystyle x}"> be.</p>',
      'Let {\\displaystyle x} be.',
    ],
    [
      'ALTTEXT_ATTRIBUTE',
      '<p>Let <math data-x-alttext="wrong" alttext="y^{2}"><mi>y</mi></math> be.</p>',
      'Let y^{2} be.',
    ],
    [
      'colspan',
      '<table class="wikitable"><tr><th>A</th><th>B</th></tr><tr><td data-x-colspan="2">a</td><td>b</td></tr></table>',
      '| A | B |\n| --- | --- |\n| a | b |',
    ],
    [
      'rowspan',
      '<table class="wikitable"><tr><th>A</th><th>B</th></tr><tr><td data-x-rowspan="2">a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      '| A | B |\n| --- | --- |\n| a | b |\n| c | d |',
    ],
  ])('%s ignores a data- attribute ending in its name', (_rule, html, expected) => {
    expect(htmlSectionToPlainText(html)).toBe(expected);
  });
});

/** A footnote list entry as legacy parser HTML writes it: escaped id, backlink, reference text. */
const footnote = (id: string, body: string) =>
  `<li id="${id.replaceAll('_', '&#95;')}"><span class="mw-cite-backlink"><b><a href="#cite_ref-${id}">^</a></b></span> <span class="reference-text">${body}</span></li>`;
const marker = (id: string, label: string) =>
  `<sup id="cite_ref-${id}" class="reference"><a href="#${id}"><span class="cite-bracket">&#91;</span>${label}<span class="cite-bracket">&#93;</span></a></sup>`;

describe('extractReferences — footnote shapes (#72)', () => {
  it('reads ids, groups, and labels across lists in document order', () => {
    const html = `<p>Claim.${marker('cite_note-a_1-1', 'a')} Other.${marker('cite_note-2', '1')}</p><ol class="references" data-mw-group="note&#95;group">${footnote('cite_note-a_1-1', 'A note.')}</ol><ol class="references">${footnote('cite_note-2', 'Main source.')}</ol>`;
    expect(extractReferences(html).references).toEqual([
      { id: 'cite_note-a_1-1', group: 'note_group', label: 'a', text: 'A note.' },
      { id: 'cite_note-2', label: '1', text: 'Main source.' },
    ]);
  });

  it('labels a footnote cited only inside another, and keeps that marker in the citing text', () => {
    const html = `<p>Claim.${marker('cite_note-1', 'a')}</p><ol class="references" data-mw-group="lower-alpha">${footnote('cite_note-1', `See both.${marker('cite_note-2', '1')}${marker('cite_note-3', '2')}`)}</ol><ol class="references">${footnote('cite_note-2', 'First.')}${footnote('cite_note-3', 'Second.')}</ol>`;
    const { references } = extractReferences(html);
    expect(references.map((entry) => [entry.id, entry.label, entry.text])).toEqual([
      ['cite_note-1', 'a', 'See both.[1][2]'],
      ['cite_note-2', '1', 'First.'],
      ['cite_note-3', '2', 'Second.'],
    ]);
  });

  it('trims the whitespace around a marker from its label', () => {
    const html = `<p>Claim.<sup id="cite_ref-1" class="reference">&#8202; <a href="#cite_note-1"><span class="cite-bracket">&#91;</span>7<span class="cite-bracket">&#93;</span></a>&#8202; </sup></p><ol class="references">${footnote('cite_note-1', 'Source.')}</ol>`;
    expect(extractReferences(html).references).toEqual([
      { id: 'cite_note-1', label: '7', text: 'Source.' },
    ]);
  });

  /**
   * `cite_note-TrumpMakesClaimsOfElectionFraud-294` and its first in-text marker from Joe Biden,
   * revision 1382315866, verbatim. Each `{{rp}}` page number (`sup.reference.nowrap`) is set off by
   * hair spaces, which the page shows as "[288]: 3–4 [289]".
   */
  const BIDEN_RP_FOOTNOTE =
    '<p>Claim.<sup id="cite&#95;ref-TrumpMakesClaimsOfElectionFraud&#95;294-0" class="reference"><a href="#cite_note-TrumpMakesClaimsOfElectionFraud-294"><span class="cite-bracket">&#91;</span>e<span class="cite-bracket">&#93;</span></a></sup></p><ol class="references" data-mw-group="lower-alpha"><li id="cite&#95;note-TrumpMakesClaimsOfElectionFraud-294"><span class="mw-cite-backlink"><b><a href="#cite_ref-TrumpMakesClaimsOfElectionFraud_294-0">^</a></b></span> <span class="reference-text">Attributed to multiple references:<sup id="cite&#95;ref-JackSmithReportVol1&#95;292-0" class="reference"><a href="#cite_note-JackSmithReportVol1-292"><span class="cite-bracket">&#91;</span>288<span class="cite-bracket">&#93;</span></a></sup><sup class="reference nowrap"><span title="Pages: 3–4">&#58;&#8202;3–4&#8202;</span></sup><sup id="cite&#95;ref-JanuarySixFinalReport&#95;293-0" class="reference"><a href="#cite_note-JanuarySixFinalReport-293"><span class="cite-bracket">&#91;</span>289<span class="cite-bracket">&#93;</span></a></sup><sup class="reference nowrap"><span title="Pages: 195–233">&#58;&#8202;195–233&#8202;</span></sup></span>\n</li></ol>';

  it('keeps the space that ends an {{rp}} page number before the next marker (Joe Biden)', () => {
    expect(extractReferences(BIDEN_RP_FOOTNOTE).references).toEqual([
      {
        id: 'cite_note-TrumpMakesClaimsOfElectionFraud-294',
        group: 'lower-alpha',
        label: 'e',
        text: 'Attributed to multiple references:[288]: 3–4 [289]: 195–233',
      },
    ]);
  });

  it('leaves the label out when no marker links to a footnote', () => {
    const html = `<ol class="references">${footnote('cite_note-orphan-1', 'Unused.')}</ol>`;
    expect(extractReferences(html).references).toEqual([
      { id: 'cite_note-orphan-1', text: 'Unused.' },
    ]);
  });

  // A reference list nested in a footnote is not a footnote list of its own: the renderer drops it
  // with every other `ol.references`, and its entries are not listed twice.
  it('treats a list inside a footnote as its text, not as more footnotes', () => {
    const html = `<ol class="references">${footnote('cite_note-1', 'Two sources:<ul><li>One.</li><li>Two.</li></ul>')}<li id="cite_note-2"><span class="reference-text">Next.<ol class="references"><li id="cite_note-inner">Nested.</li></ol></span></li></ol>`;
    expect(extractReferences(html).references.map((entry) => [entry.id, entry.text])).toEqual([
      ['cite_note-1', 'Two sources:\n\nOne.\nTwo.'],
      ['cite_note-2', 'Next.'],
    ]);
  });

  it('falls back to the whole entry when it has no reference-text span', () => {
    const html = '<ol class="references"><li id="cite_note-9">Bare <i>entry</i>.</li></ol>';
    expect(extractReferences(html).references).toEqual([
      { id: 'cite_note-9', text: 'Bare entry.' },
    ]);
  });

  it('keeps each external link once and verbatim, and reads DOIs from doi.org links', () => {
    const body = [
      '<a rel="nofollow" class="external text" href="https://example.org/a?x=1&amp;y=2">A</a>',
      '<a rel="nofollow" class="external text" href="https://web.archive.org/web/2020/https://example.org/a?x=1&amp;y=2">Archived</a>',
      '<a rel="nofollow" class="external text" href="https://example.org/a?x=1&amp;y=2">again</a>',
      '<a rel="nofollow" class="external text" href="https://doi.org/10.1017%2FCBO9781316412299">10.1017/CBO9781316412299</a>',
      '<a rel="nofollow" class="external text" href="https://dx.doi.org/10.4000/physio-geo.2181">x</a>',
      '<a rel="nofollow" class="external text" href="https://doi.org/10.1000/bad%E0%A4%A">bad</a>',
      '<a rel="nofollow" class="external text" href="https://doi.org/">root</a>',
      '<a rel="nofollow" class="external free" href="https://notdoi.org/10.1/x">x</a>',
      '<a href="/wiki/Digital_object_identifier" title="Digital object identifier">doi</a>',
      // The parser upgrades links to HSTS hosts and keeps the editor's URL in an earlier attribute.
      '<a rel="nofollow" class="external text" data-mw-original-href="http://www.pewglobal.org/2016/x/" href="https://www.pewglobal.org/2016/x/">Pew</a>',
    ].join(' ');
    const [entry] = extractReferences(
      `<ol class="references">${footnote('cite_note-1', body)}</ol>`,
    ).references;
    expect(entry?.urls).toEqual([
      'https://example.org/a?x=1&y=2',
      'https://web.archive.org/web/2020/https://example.org/a?x=1&y=2',
      'https://doi.org/10.1017%2FCBO9781316412299',
      'https://dx.doi.org/10.4000/physio-geo.2181',
      'https://doi.org/10.1000/bad%E0%A4%A',
      'https://doi.org/',
      'https://notdoi.org/10.1/x',
      'https://www.pewglobal.org/2016/x/',
    ]);
    expect(entry?.dois).toEqual([
      '10.1017/CBO9781316412299',
      '10.4000/physio-geo.2181',
      '10.1000/bad%E0%A4%A',
    ]);
  });

  it('resolves short citations to the anchored full citations, once each', () => {
    const html = `<ol class="references">${footnote('cite_note-1', '<a href="#CITEREFSmith&#95;2000">Smith 2000</a>, p. 1; <a href="#CITEREFLost1999">Lost 1999</a>.')}${footnote('cite_note-2', '<a href="#CITEREFSmith_2000">Smith 2000</a>, p. 2.')}</ol><ul><li><cite id="CITEREFSmith&#95;2000" class="citation book cs1">Smith, J. (2000). <i>Title</i>. <a rel="nofollow" class="external text" href="https://doi.org/10.1%2Fx">doi</a>.</cite><span class="cs1-maint citation-comment">CS1 maint: extra text</span></li><li><cite id="CITEREFUnused" class="citation">Unused.</cite></li></ul>`;
    const { references, works } = extractReferences(html);
    expect(references.map((entry) => entry.work_ids)).toEqual([
      ['CITEREFSmith_2000', 'CITEREFLost1999'],
      ['CITEREFSmith_2000'],
    ]);
    expect([...works.values()]).toEqual([
      {
        id: 'CITEREFSmith_2000',
        text: 'Smith, J. (2000). Title. doi.',
        urls: ['https://doi.org/10.1%2Fx'],
        dois: ['10.1/x'],
      },
    ]);
  });

  it('drops hidden CS1 messages from footnote text and keeps visible ones (#75)', () => {
    const body =
      '<cite class="citation web cs1">"Title".</cite><span class="cs1-maint citation-comment"><code class="cs1-code">{{cite web}}</code>: CS1 maint: url-status (<a href="/wiki/Category:CS1_maint:_url-status">link</a>)</span><span class="cs1-visible-error citation-comment">Missing or empty |url=</span>';
    expect(
      extractReferences(`<ol class="references">${footnote('cite_note-1', body)}</ol>`)
        .references[0]?.text,
    ).toBe('"Title".Missing or empty |url=');
  });

  it('keeps reading to the end of the payload when the last list or entry is unclosed', () => {
    const html = `<p>${marker('cite_note-1', '1')}</p><ol class="references">${footnote('cite_note-1', 'Closed.')}<li id="cite_note-2"><span class="reference-text">Unclosed <b>text`;
    expect(extractReferences(html).references.map((entry) => [entry.id, entry.text])).toEqual([
      ['cite_note-1', 'Closed.'],
      ['cite_note-2', 'Unclosed'],
    ]);
  });

  it('finds no footnotes in an article without a reference list', () => {
    expect(extractReferences('<p>Prose only.</p><ul><li>Item</li></ul>')).toEqual({
      references: [],
      works: new Map(),
    });
  });
});

describe('WikipediaService.getReferences — one deadline across attempts (#72)', () => {
  beforeEach(() => {
    initService();
    useFakeClock();
  });

  const PARSE = {
    parse: {
      title: 'Seine',
      pageid: 1,
      revid: 5,
      text: `<p>${marker('cite_note-1', '1')}</p><ol class="references">${footnote('cite_note-1', 'Source.')}</ol>`,
    },
  };

  /** A fetch that answers after `delayMs`, or rejects when its signal aborts first. */
  function delayedFetch(delayMs: number) {
    let requests = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      requests++;
      expect(new URL(String(input instanceof Request ? input.url : input)).hostname).toBe(
        'en.wikipedia.org',
      );
      return new Promise<Response>((resolve, reject) => {
        // An infinite delay never answers: setTimeout would clamp it to 1 ms.
        const timer = Number.isFinite(delayMs)
          ? setTimeout(() => resolve(Response.json(PARSE)), delayMs)
          : undefined;
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    return () => requests;
  }

  it('lets one slow full-page parse finish past the default 15 s attempt timeout', async () => {
    const requests = delayedFetch(20_000);
    const startedAt = Date.now();
    const { value, error } = await settle(
      getWikipediaService().getReferences('Seine', 'en', createMockContext()),
    );
    expect(error).toBeUndefined();
    expect(value?.references).toEqual([{ id: 'cite_note-1', label: '1', text: 'Source.' }]);
    expect(requests()).toBe(1);
    expect(Date.now() - startedAt).toBe(20_000);
  });

  it('bounds a stalled parse at the 30 s request deadline, retry included', async () => {
    const requests = delayedFetch(Number.POSITIVE_INFINITY);
    const startedAt = Date.now();
    const { error } = await settle(
      getWikipediaService().getReferences('Seine', 'en', createMockContext()),
    );
    expect(Date.now() - startedAt).toBeLessThanOrEqual(30_000);
    expect(requests()).toBe(2);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 30_000 },
    });
  });

  it('rethrows the caller’s cancellation mid-parse without retrying', async () => {
    const requests = delayedFetch(Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    const outcome = capture(
      getWikipediaService().getReferences(
        'Seine',
        'en',
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(requests()).toBe(1);
    expect((await outcome).error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringContaining('was aborted'),
    });
  });
});

describe('extractReferences — work stays linear in the payload (#72)', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** Fastest of five runs, in milliseconds of this thread's CPU time. */
  function cpuMs(html: string): number {
    extractReferences(html);
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const started = process.threadCpuUsage();
      extractReferences(html);
      const used = process.threadCpuUsage(started);
      fastest = Math.min(fastest, (used.user + used.system) / 1000);
    }
    return fastest;
  }

  /** `size` characters of `unit` repeated, so every shape grows by the same count. */
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  const inEntry = (inner: string) =>
    `<ol class="references"><li id="cite_note-1"><span class="reference-text">${inner}</span></li></ol>`;

  /**
   * Grow `shape` by doubling across a 64× span and bound each size before running the next, so a
   * quadratic regression fails at the first oversized step instead of hanging on the largest. The
   * full-span ratio stays under 256: linear work grows 64×, quadratic 4096×.
   */
  function expectLinear(shape: (size: number) => string, from: number): void {
    const samples: number[] = [];
    for (let size = from; size <= from * 64; size *= 2) {
      const ms = cpuMs(shape(size));
      expect(ms).toBeLessThan(1_000);
      samples.push(ms);
    }
    expect((samples.at(-1) as number) / Math.max(samples[0] as number, 0.05)).toBeLessThan(256);
  }

  // Shapes that reach a regex scan start at 1,250 characters, so their 64× span ends at 80,000,
  // below the size where Bun's regex engine changes mode. The digit run carries 5,000 → 320,000.
  it.each([
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    ['a long line inside a footnote', (n: number) => inEntry(`${fill('§1 x', n)}\ny`)],
    ['breaks throughout a footnote', (n: number) => inEntry(fill('  \r\n', n))],
    ['repeated list openers, never closed', (n: number) => fill('<ol class="references">', n)],
    [
      'repeated entry openers in an open list',
      (n: number) => `<ol class="references">${fill('<li id="cite_note-1">', n)}`,
    ],
    ['repeated marker openers, never closed', (n: number) => fill('<sup class="reference">', n)],
    [
      'repeated marker prefixes',
      (n: number) => `${fill('<sup class="reference"><a href="#cite_note-', n)}>`,
    ],
    [
      'repeated work anchors, never closed',
      (n: number) =>
        `${inEntry(fill('<a href="#CITEREFa">a</a>', n / 2))}${fill('<cite id="CITEREFa">', n / 2)}`,
    ],
    ['nested openers', (n: number) => `${fill('<a', n / 2)}${fill('>', n / 2)}`],
    ['nested list openers', (n: number) => `${fill('<ol', n / 2)}${fill('>', n / 2)}`],
    [
      'repeated external links in a footnote',
      (n: number) => inEntry(fill('<a class="external" href="https://doi.org/10.1%2F', n)),
    ],
    // The renderer's attribute rules, reached through the footnote text it renders.
    ['repeated image openers, never closed', (n: number) => inEntry(`${fill('<img ', n)}>`)],
    [
      'repeated formula-image openers, never closed',
      (n: number) => inEntry(`${fill('<img class="mwe-math-fallback-image-', n)}>`),
    ],
    [
      'repeated formula openers, never closed',
      (n: number) => inEntry(`${fill('<math alttext="x', n)}>`),
    ],
    [
      'one open tag of attributes ending in a rule’s name',
      (n: number) =>
        inEntry(
          `<span${fill(' data-x-class="metadata side-box" data-x-style="display:none" data-x-role="navigation" data-x-alt="a"', n)} class="x">t</span>`,
        ),
    ],
    [
      'one open tag of attribute names without values',
      (n: number) => inEntry(`<div${fill(' class style role alt alttext', n)}>t</div>`),
    ],
    [
      'one class value of near-miss tokens',
      (n: number) => inEntry(`<div class="${fill('metadatax side-boxy referencex ', n)}">t</div>`),
    ],
    [
      'one style value of near-misses',
      (n: number) => inEntry(`<span style="${fill('display: displa ', n)}">t</span>`),
    ],
    [
      'one table cell of span lookalikes',
      (n: number) =>
        inEntry(
          `<table class="wikitable"><tr><td${fill(' data-x-colspan="2" rowspan', n)}>a</td></tr></table>`,
        ),
    ],
  ])('stays linear on %s', (_name, shape) => {
    expectLinear(shape, 1_250);
  });

  it('stays linear on a long digit run inside a footnote, 5,000 to 320,000 characters', () => {
    expectLinear((n) => inEntry(fill('1', n)), 5_000);
  });
});
