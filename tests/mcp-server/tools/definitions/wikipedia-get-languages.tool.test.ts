/**
 * @fileoverview Tests for wikipedia_get_languages tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-languages.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { wikipediaGetLanguages } from '@/mcp-server/tools/definitions/wikipedia-get-languages.tool.js';
import { initWikipediaService } from '@/services/wikipedia/wikipedia-service.js';
import { parseTargets } from '../../../helpers/commonmark.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

describe('wikipediaGetLanguages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('returns language editions for a valid article', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        languages: [
          {
            languageCode: 'fr',
            title: 'Python (langage)',
            url: 'https://fr.wikipedia.org/wiki/Python_(langage)',
          },
          {
            languageCode: 'de',
            title: 'Python (Programmiersprache)',
            url: 'https://de.wikipedia.org/wiki/Python_(Programmiersprache)',
          },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.languages).toHaveLength(2);
    expect(result.languages[0]?.language_code).toBe('fr');
    expect(result.total_languages).toBe(2);
    expect(result.source_language).toBe('en');
  });

  it('throws no_other_languages when article has no translations', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({ title: 'Very Local Article', languages: [] }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Very Local Article' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_other_languages' },
    });
  });

  it('format renders language codes, edition codes, titles, and URLs', () => {
    const output = {
      source_title: 'Python (programming language)',
      source_language: 'en',
      languages: [
        {
          language_code: 'gsw',
          edition_code: 'als',
          title: 'Python (Programmiersprache)',
          url: 'https://als.wikipedia.org/wiki/Python_(Programmiersprache)',
        },
      ],
      total_languages: 1,
    };
    const blocks = wikipediaGetLanguages.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('gsw');
    expect(text).toContain('als');
    expect(text).toContain('Python (Programmiersprache)');
    expect(text).toContain(
      '(code `gsw`): [article](<https://als.wikipedia.org/wiki/Python_(Programmiersprache)>)',
    );
    expect(text).toContain('1 languages');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python', language: 'INVALID!!' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws not_found with data.reason when article is missing (issue #12)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockWikipediaService({
      getLanguages: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('maps language entries from service to output shape', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        languages: [
          {
            languageCode: 'ja',
            editionCode: 'ja',
            title: 'パイソン (プログラミング言語)',
            url: 'https://ja.wikipedia.org/wiki/%E3%83%91%E3%82%A4%E3%82%BD%E3%83%B3',
          },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.languages[0]).toEqual({
      language_code: 'ja',
      edition_code: 'ja',
      title: 'パイソン (プログラミング言語)',
      url: 'https://ja.wikipedia.org/wiki/%E3%83%91%E3%82%A4%E3%82%BD%E3%83%B3',
    });
  });

  it('surfaces edition_code distinct from language_code (issue #17)', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        languages: [
          {
            languageCode: 'gsw',
            editionCode: 'als',
            title: 'Python (Programmiersprache)',
            url: 'https://als.wikipedia.org/wiki/Python_(Programmiersprache)',
          },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    // The subdomain ("als"), not the language code ("gsw"), is the value usable as `language`.
    expect(result.languages[0]?.language_code).toBe('gsw');
    expect(result.languages[0]?.edition_code).toBe('als');
  });

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python', language: 'zz' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws not_found with data.reason for a blank title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: '' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found with data.reason for a whitespace-only title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: '   ' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('refuses a title MediaWiki cannot name a page with, before any call (issue #42)', async () => {
    const getLanguagesFn = vi.fn();
    mockWikipediaService({ getLanguages: getLanguagesFn });

    for (const title of ['Cat|Dog', 'Foo[bar]', 'A{b}']) {
      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const rejection = await Promise.resolve(
        wikipediaGetLanguages.handler(wikipediaGetLanguages.input.parse({ title }), ctx),
      ).then(
        () => undefined,
        (err: unknown) => err as { message: string; data: { reason: string } },
      );

      expect(rejection?.data.reason).toBe('invalid_title');
      expect(rejection?.message).not.toMatch(/https?:\/\//);
    }
    // "Cat|Dog" used to come back as Cat's 278 language links.
    expect(getLanguagesFn).not.toHaveBeenCalled();
  });

  it('accepts a fragment title and titles that only look illegal (issue #42)', async () => {
    const getLanguagesFn = vi.fn().mockResolvedValue({
      title: 'Python (programming language)',
      languages: [
        { languageCode: 'fr', title: 'Python (langage)', url: 'https://fr.wikipedia.org/wiki/P' },
      ],
    });
    mockWikipediaService({ getLanguages: getLanguagesFn });

    for (const title of ['Python (programming language)#History', '100% Cat', 'A_B', ':Cat']) {
      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      await wikipediaGetLanguages.handler(wikipediaGetLanguages.input.parse({ title }), ctx);
      expect(getLanguagesFn).toHaveBeenCalledWith(title, 'en', ctx);
    }
  });

  it('passes source language to service', async () => {
    const getLanguagesFn = vi.fn().mockResolvedValue({
      title: 'Python (langage)',
      languages: [
        {
          languageCode: 'en',
          title: 'Python (programming language)',
          url: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
        },
      ],
    });
    mockWikipediaService({
      getLanguages: getLanguagesFn,
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(getLanguagesFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.source_language).toBe('fr');
  });

  it('source_title reports the resolved title rather than echoing the input (issue #27)', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({
        title: 'New York City',
        languages: [
          { languageCode: 'de', title: 'New York City', url: 'https://de.wikipedia.org/wiki/NYC' },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    // "NYC" redirects to "New York City"; the response must name the article the links belong to.
    const input = wikipediaGetLanguages.input.parse({ title: 'NYC' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.source_title).toBe('New York City');
  });

  it('omits url and edition_code for an entry with no known host (issue #24)', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockResolvedValue({
        title: 'Test',
        languages: [{ languageCode: 'zzz', title: 'Test (Unknown)' }],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Test' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.languages[0]).toEqual({ language_code: 'zzz', title: 'Test (Unknown)' });
  });

  it('format marks an entry whose host is unknown instead of rendering an empty link (issue #24)', () => {
    const blocks = wikipediaGetLanguages.format!({
      source_title: 'Test',
      source_language: 'en',
      languages: [{ language_code: 'zzz', title: 'Test (Unknown)' }],
      total_languages: 1,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('edition subdomain unavailable');
    expect(text).toContain('no URL available');
    expect(text).not.toContain('zzz.wikipedia.org');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      source_title: 'Python',
      source_language: 'en',
      languages: [
        {
          language_code: 'fr',
          edition_code: 'fr',
          title: 'Python (langage)',
          url: 'https://fr.wikipedia.org/wiki/Python',
        },
      ],
      total_languages: 1,
    };
    const blocks = wikipediaGetLanguages.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  describe('editions filter (issue #45)', () => {
    /** Three of Zürich's langlinks, including the gsw/als code-vs-subdomain mismatch. */
    const zurichLanguages = [
      {
        languageCode: 'fr',
        editionCode: 'fr',
        title: 'Zurich',
        url: 'https://fr.wikipedia.org/wiki/Zurich',
      },
      {
        languageCode: 'de',
        editionCode: 'de',
        title: 'Zürich',
        url: 'https://de.wikipedia.org/wiki/Z%C3%BCrich',
      },
      {
        languageCode: 'gsw',
        editionCode: 'als',
        title: 'Züri',
        url: 'https://als.wikipedia.org/wiki/Z%C3%BCri',
      },
      {
        languageCode: 'ja',
        editionCode: 'ja',
        title: 'チューリッヒ',
        url: 'https://ja.wikipedia.org/wiki/%E3%83%81%E3%83%A5%E3%83%BC%E3%83%AA%E3%83%83%E3%83%92',
      },
    ];

    /** Hosts the stubbed registry serves, by every code it indexes. */
    const stubHosts = new Map(
      ['en', 'fr', 'de', 'ja', 'es', 'ht', 'als'].map((code) => [
        code,
        `https://${code}.wikipedia.org`,
      ]),
    ).set('gsw', 'https://als.wikipedia.org');

    function mockZurich() {
      mockWikipediaService({
        getLanguages: vi.fn().mockResolvedValue({ title: 'Zürich', languages: zurichLanguages }),
        editionHost: async (code: string) => stubHosts.get(code.toLowerCase()),
      });
    }

    it('keeps only the requested editions and reports the codes with no article', async () => {
      mockZurich();

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({
        title: 'Zürich',
        editions: ['fr', 'de', 'gsw', 'es'],
      });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages.map((l) => l.language_code)).toEqual(['fr', 'de', 'gsw']);
      // "gsw" is the langlinks code; the edition it names lives on the "als" subdomain.
      expect(result.languages[2]?.edition_code).toBe('als');
      expect(result.missing).toEqual(['es']);
      // The filter narrows what comes back, not what exists.
      expect(result.total_languages).toBe(4);
    });

    it('matches an edition by its subdomain as well as its language code, case-insensitively', async () => {
      mockZurich();

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({
        title: 'Zürich',
        editions: ['ALS', ' Fr '],
      });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages.map((l) => l.edition_code)).toEqual(['fr', 'als']);
      expect(result.missing).toEqual([]);
    });

    it('returns an empty list rather than an error when every requested code misses', async () => {
      mockZurich();

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({
        title: 'Zürich',
        editions: ['es', 'ht'],
      });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages).toEqual([]);
      expect(result.missing).toEqual(['es', 'ht']);
      expect(result.total_languages).toBe(4);
    });

    it('classifies every code on an article with no other editions, and fails only unfiltered', async () => {
      mockWikipediaService({
        getLanguages: vi.fn().mockResolvedValue({ title: 'Very Local Article', languages: [] }),
        editionHost: async (code: string) => stubHosts.get(code.toLowerCase()),
      });

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const result = await wikipediaGetLanguages.handler(
        wikipediaGetLanguages.input.parse({ title: 'Very Local Article', editions: ['fr'] }),
        ctx,
      );
      expect(result).toEqual({
        source_title: 'Very Local Article',
        source_language: 'en',
        languages: [],
        total_languages: 0,
        missing: ['fr'],
      });

      // Without editions there is nothing to classify and nothing to list.
      await expect(
        wikipediaGetLanguages.handler(
          wikipediaGetLanguages.input.parse({ title: 'Very Local Article' }),
          createMockContext({ errors: wikipediaGetLanguages.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'no_other_languages' } });
    });

    it('omits missing entirely and lists every edition when the filter is not passed', async () => {
      mockZurich();

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({ title: 'Zürich' });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages).toHaveLength(4);
      expect(result.total_languages).toBe(4);
      expect(result.missing).toBeUndefined();
    });

    it('rejects an empty editions array at the schema, naming the field', () => {
      const rejection = (() => {
        try {
          wikipediaGetLanguages.input.parse({ title: 'Zürich', editions: [] });
          return;
        } catch (err) {
          return err as { issues?: Array<{ path: PropertyKey[] }> };
        }
      })();

      expect(rejection?.issues?.[0]?.path).toContain('editions');
    });

    it('format renders the narrowed count and the codes with no article', () => {
      const blocks = wikipediaGetLanguages.format!({
        source_title: 'Zürich',
        source_language: 'en',
        languages: [
          {
            language_code: 'gsw',
            edition_code: 'als',
            title: 'Züri',
            url: 'https://als.wikipedia.org/wiki/Z%C3%BCri',
          },
        ],
        total_languages: 165,
        missing: ['xx'],
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

      expect(text).toContain('1 of 165 languages available');
      expect(text).toContain('No article in:');
      expect(text).toContain('xx');
      expect(text).toContain('Züri');
    });

    it('format says so when every requested edition matched', () => {
      const blocks = wikipediaGetLanguages.format!({
        source_title: 'Zürich',
        source_language: 'en',
        languages: [
          { language_code: 'fr', edition_code: 'fr', title: 'Zurich', url: 'https://fr.example' },
        ],
        total_languages: 165,
        missing: [],
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

      expect(text).toContain('Every requested edition matched');
      expect(text).not.toContain('No article in:');
    });

    it('format keeps the unfiltered heading when no filter was applied', () => {
      const blocks = wikipediaGetLanguages.format!({
        source_title: 'Zürich',
        source_language: 'en',
        languages: [
          { language_code: 'fr', edition_code: 'fr', title: 'Zurich', url: 'https://fr.example' },
        ],
        total_languages: 165,
      });
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

      expect(text).toContain('165 languages available');
      expect(text).not.toContain('narrowed to the requested editions');
      expect(text).not.toContain('Every requested edition matched');
    });
  });

  /**
   * The editions classification run through the real service: the registry is built from a
   * sitematrix response, and each article's interlanguage links come from a langlinks response,
   * so normalization, the registry's own spellings, and the legacy-code table are all under test.
   */
  describe('editions classification (issues #76, #80)', () => {
    /** Sitematrix rows as `[language code, subdomain]`; the subdomain defaults to the code. */
    const SITEMATRIX_ROWS: ReadonlyArray<readonly [string, string?]> = [
      ['en'],
      ['fr'],
      ['de'],
      ['ja'],
      ['zh'],
      ['gsw', 'als'],
      ['yue', 'zh-yue'],
      ['simple'],
      ['be-tarask'],
      ['no'],
      ['eml'],
    ];

    function siteMatrix() {
      const sitematrix: Record<string, unknown> = { count: SITEMATRIX_ROWS.length + 1 };
      SITEMATRIX_ROWS.forEach(([code, subdomain = code], i) => {
        sitematrix[String(i)] = {
          code,
          name: code,
          site: [{ url: `https://${subdomain}.wikipedia.org`, code: 'wiki' }],
        };
      });
      // The live matrix lists be-x-old as a language with no wiki of its own.
      sitematrix[String(SITEMATRIX_ROWS.length)] = { code: 'be-x-old', name: 'x', site: [] };
      return { sitematrix };
    }

    /** One langlinks entry the way `llprop=url` returns it. */
    function link(lang: string, subdomain: string, title: string) {
      return { lang, title, url: `https://${subdomain}.wikipedia.org/wiki/${title}` };
    }

    /** Interlanguage links by `<origin> <title>` — what each edition's page links out to. */
    const PAGES = new Map<string, ReturnType<typeof link>[]>([
      [
        'https://en.wikipedia.org Python (programming language)',
        [link('fr', 'fr', 'Python_(langage)'), link('de', 'de', 'Python_(Programmiersprache)')],
      ],
      [
        'https://als.wikipedia.org Erde',
        [link('de', 'de', 'Erde'), link('en', 'en', 'Earth'), link('fr', 'fr', 'Terre')],
      ],
      [
        'https://en.wikipedia.org Tokyo',
        [link('ja', 'ja', '東京都'), link('zh', 'zh', '東京都'), link('fr', 'fr', 'Tokyo')],
      ],
      ['https://en.wikipedia.org Libby Creek', []],
      [
        'https://en.wikipedia.org Earth',
        [
          link('be-tarask', 'be-tarask', 'Зямля'),
          link('eml', 'eml', 'Tèra'),
          link('nb', 'no', 'Jorden'),
          link('gsw', 'als', 'Erde'),
          link('fr', 'fr', 'Terre'),
        ],
      ],
      ['https://no.wikipedia.org Jorden', [link('en', 'en', 'Earth'), link('de', 'de', 'Erde')]],
      ['https://example.org Libby Creek', []],
    ]);

    function isSitematrix(request: Request): boolean {
      return new URL(request.url).searchParams.get('action') === 'sitematrix';
    }

    function langlinksPage(request: Request): Response {
      const url = new URL(request.url);
      const title = url.searchParams.get('titles') ?? '';
      const links = PAGES.get(`${url.origin} ${title}`);
      return Response.json({
        query: {
          pages: [
            links === undefined
              ? { title, missing: true }
              : { pageid: 1, title, ...(links.length > 0 && { langlinks: links }) },
          ],
        },
      });
    }

    /** Init the real service over in-memory storage and answer its upstream requests. */
    function serveWikipedia(
      options: {
        baseUrl?: string;
        onSitematrix?: (request: Request) => void;
        sitematrixUnavailable?: boolean;
      } = {},
    ) {
      initWikipediaService({} as AppConfig, createInMemoryStorage(), 'test', options.baseUrl);
      const http = createFetchMock([
        {
          match: isSitematrix,
          respond: (request) => {
            options.onSitematrix?.(request);
            // An error envelope fails the registry build on the first response, with no retry.
            if (options.sitematrixUnavailable) {
              return Response.json({ error: { code: 'unknownerror', info: 'Sitematrix down.' } });
            }
            // A real fetch rejects once its own signal has fired.
            if (request.signal.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            return Response.json(siteMatrix());
          },
        },
        { match: (request) => !isSitematrix(request), respond: langlinksPage },
      ]);
      http.install();
      onTestFinished(() => {
        http.restore();
      });
      return http;
    }

    function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.map((block) => block.text ?? '').join('\n');
    }

    const UNKNOWN_NOTICE = /name no Wikipedia edition/;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('reports the queried edition under source_editions, never missing (#76 repro 1)', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Python (programming language)',
        language: 'en',
        editions: ['en', 'fr'],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        languages: [{ language_code: 'fr', edition_code: 'fr' }],
        source_editions: ['en'],
        missing: [],
      });
      expect(result.structuredContent).not.toHaveProperty('unknown_editions');
      const text = contentText(result);
      expect(text).toContain('**Queried edition (this article):** `en`');
      expect(text).not.toContain('No article in:');
    });

    it('recognizes both spellings of a mismatch edition as the queried one (#76 repro 2)', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Erde',
        language: 'gsw',
        editions: ['als', 'gsw', 'de'],
      });

      expect(result.structuredContent).toMatchObject({
        source_language: 'gsw',
        languages: [{ language_code: 'de' }],
        source_editions: ['als', 'gsw'],
        missing: [],
      });
      expect(contentText(result)).toContain('**Queried edition (this article):** `als`, `gsw`');
    });

    it('echoes a queried-edition code as passed, whatever its case or spacing', async () => {
      serveWikipedia();
      for (const code of ['EN', ' en ']) {
        const result = await runToolContract(wikipediaGetLanguages, {
          title: 'Python (programming language)',
          editions: [code],
        });
        expect(result.structuredContent).toMatchObject({ source_editions: [code], missing: [] });
      }
    });

    it('reports codes naming no edition under unknown_editions, with a notice (#80 repro 1)', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Tokyo',
        editions: ['jp', 'cn', 'ja'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        languages: [{ language_code: 'ja' }],
        total_languages: 3,
        unknown_editions: ['jp', 'cn'],
        missing: [],
      });
      expect(structured.notice).toMatch(UNKNOWN_NOTICE);
      expect(structured.notice).toContain('"ja"');
      expect(structured.notice).toContain('"zh"');
      expect(structured).not.toHaveProperty('source_editions');

      const text = contentText(result);
      expect(text).toContain('**Not a Wikipedia edition:** `jp`, `cn`');
      expect(text).not.toContain('No article in:');
      // A call whose only problem is an unknown code has not had every edition matched.
      expect(text).not.toContain('Every requested edition matched');
      expect(text).toMatch(UNKNOWN_NOTICE);
    });

    it('classifies every code on an article with no other editions (#80 repro 2)', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Libby Creek',
        editions: ['fr', 'jp'],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        source_title: 'Libby Creek',
        languages: [],
        total_languages: 0,
        missing: ['fr'],
        unknown_editions: ['jp'],
      });
      const text = contentText(result);
      expect(text).toContain('**0 of 0 languages available** (narrowed to the requested editions)');
      expect(text).toContain('**No article in:** `fr`');
      expect(text).toContain('**Not a Wikipedia edition:** `jp`');

      const unfiltered = await runToolContract(wikipediaGetLanguages, { title: 'Libby Creek' });
      expect(unfiltered.isError).toBe(true);
      expect(unfiltered.structuredContent).toMatchObject({
        error: { data: { reason: 'no_other_languages' } },
      });
    });

    it('renders each requested code as one code in content[], separators and backticks included', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Tokyo',
        editions: ['fr, de', 'a`b'],
      });
      expect(result.structuredContent).toMatchObject({ unknown_editions: ['fr, de', 'a`b'] });
      const line = contentText(result)
        .split('\n')
        .find((l) => l.startsWith('**Not a Wikipedia edition:**'));
      expect(line).toBe('**Not a Wikipedia edition:** `fr, de`, ``a`b``');
    });

    it('never reports a real edition unknown, whatever spelling names it', async () => {
      serveWikipedia();
      const codes = ['gsw', 'als', 'yue', 'zh-yue', 'simple', 'be-tarask', 'JA', ' fr '];
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Libby Creek',
        editions: codes,
      });

      expect(result.structuredContent).toMatchObject({ languages: [], missing: codes });
      expect(result.structuredContent).not.toHaveProperty('unknown_editions');
      expect(result.structuredContent).not.toHaveProperty('notice');
    });

    it('reports a malformed code or an Object property name as unknown, not as a failure', async () => {
      serveWikipedia();
      const codes = ['en_US', 'constructor', '__proto__', ''];
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Libby Creek',
        editions: codes,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ missing: [], unknown_editions: codes });
    });

    it('never reports a legacy code unknown, and keeps zh-cn and zh-tw unknown', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Libby Creek',
        editions: ['nb', 'be-x-old', 'egl', 'zh-cn', 'zh-tw'],
      });

      expect(result.structuredContent).toMatchObject({
        missing: ['nb', 'be-x-old', 'egl'],
        unknown_editions: ['zh-cn', 'zh-tw'],
      });
    });

    it('matches a legacy code to the entry of the edition it names', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Earth',
        editions: ['be-x-old', 'egl', 'nb', 'no'],
      });

      // The langlinks codes are be-tarask and eml; the article exists in both editions.
      expect(result.structuredContent).toMatchObject({
        languages: [
          { language_code: 'be-tarask', edition_code: 'be-tarask' },
          { language_code: 'eml', edition_code: 'eml' },
          { language_code: 'nb', edition_code: 'no' },
        ],
        missing: [],
      });
      expect(contentText(result)).toContain('**Every requested edition matched.**');
    });

    it('accepts a legacy code as language and reads the edition it names', async () => {
      const http = serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Jorden',
        language: 'nb',
        editions: ['no', 'en'],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        source_language: 'nb',
        languages: [{ language_code: 'en' }],
        // `no` names the edition `nb` was resolved to: the article read here.
        source_editions: ['no'],
        missing: [],
      });
      const langlinks = http.calls.filter(({ request }) => !isSitematrix(request));
      expect(langlinks.map(({ request }) => new URL(request.url).origin)).toEqual([
        'https://no.wikipedia.org',
      ]);
    });

    it('adds no field and no notice to a call whose codes all name editions', async () => {
      serveWikipedia();
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Tokyo',
        editions: ['ja', 'fr'],
      });

      expect(result.structuredContent).toEqual({
        source_title: 'Tokyo',
        source_language: 'en',
        languages: [
          {
            language_code: 'ja',
            edition_code: 'ja',
            title: '東京都',
            url: 'https://ja.wikipedia.org/wiki/東京都',
          },
          {
            language_code: 'fr',
            edition_code: 'fr',
            title: 'Tokyo',
            url: 'https://fr.wikipedia.org/wiki/Tokyo',
          },
        ],
        total_languages: 3,
        missing: [],
      });
      expect(contentText(result)).toContain('**Every requested edition matched.**');
      expect(contentText(result)).not.toMatch(UNKNOWN_NOTICE);
    });

    it('classifies nothing unknown under a base-URL override, matching the queried code as written', async () => {
      serveWikipedia({ baseUrl: 'https://example.org' });
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Libby Creek',
        editions: ['jp', 'EN', 'als'],
      });

      // The override host may serve any editions, so only the string comparison applies.
      expect(result.structuredContent).toMatchObject({
        languages: [],
        source_editions: ['EN'],
        missing: ['jp', 'als'],
      });
      expect(result.structuredContent).not.toHaveProperty('unknown_editions');
    });

    it('claims no code names no edition while the registry is unavailable', async () => {
      const http = serveWikipedia({ sitematrixUnavailable: true });
      const result = await runToolContract(wikipediaGetLanguages, {
        title: 'Tokyo',
        editions: ['gsw', 'jp', 'ja'],
      });

      // Only the incomplete offline set could answer, and it lacks the real edition gsw, so an
      // unknown verdict would be unfounded: every unmatched code is missing.
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        languages: [{ language_code: 'ja' }],
        missing: ['gsw', 'jp'],
      });
      expect(structured).not.toHaveProperty('unknown_editions');
      expect(structured).not.toHaveProperty('notice');
      expect(contentText(result)).not.toContain('Not a Wikipedia edition');
      expect(contentText(result)).not.toMatch(UNKNOWN_NOTICE);
      // The degraded path really was taken: the one sitematrix request failed.
      expect(http.calls.filter(({ request }) => isSitematrix(request))).toHaveLength(1);
    });

    it('cancels only the caller that left while the registry was cold, and keeps serving the rest', async () => {
      const first = new AbortController();
      const reason = new DOMException('first caller went away', 'AbortError');
      const sitematrixAborted: boolean[] = [];
      serveWikipedia({
        onSitematrix: (request) => {
          first.abort(reason);
          sitematrixAborted.push(request.signal.aborted);
        },
      });

      const [cancelled, served] = await Promise.all([
        runToolContract(
          wikipediaGetLanguages,
          { title: 'Erde', language: 'gsw' },
          { context: { signal: first.signal } },
        ),
        runToolContract(wikipediaGetLanguages, { title: 'Erde', language: 'gsw' }),
      ]);

      expect(cancelled.isError).toBe(true);
      expect(cancelled.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(contentText(cancelled)).toContain('first caller went away');
      // `gsw` is absent from the offline edition set: only the built registry accepts it.
      expect(served.isError).toBeFalsy();
      expect(served.structuredContent).toMatchObject({ source_title: 'Erde', total_languages: 3 });
      expect(sitematrixAborted).toEqual([false]);
    });

    it('states each class in the field descriptions', () => {
      const output = wikipediaGetLanguages.output.shape;
      expect(wikipediaGetLanguages.input.shape.editions.description).toMatch(
        /source_editions[\s\S]*unknown_editions[\s\S]*missing/,
      );
      expect(output.source_editions.description).toMatch(/queried edition/i);
      expect(output.unknown_editions.description).toMatch(/no Wikipedia edition/i);
      expect(output.missing.description).toMatch(/no article/i);
    });
  });

  it('escapes markdown-active upstream titles in format() and leaves the structured values raw (issue #43)', () => {
    const output = {
      source_title: 'HTML <element>',
      source_language: 'en',
      languages: [
        {
          language_code: 'fr',
          edition_code: 'fr',
          title: 'Balise <script> et _emphase_',
          url: 'https://fr.wikipedia.org/wiki/HTML',
        },
      ],
      total_languages: 1,
    };
    const text = wikipediaGetLanguages.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(text).toContain('HTML \\<element\\>');
    expect(text).toContain('Balise \\<script\\> et \\_emphase\\_');
    expect(text).not.toContain('<script>');
    // The URL is not prose: it is a link destination, unescaped, so the link stays followable.
    expect(text).toContain(': [article](<https://fr.wikipedia.org/wiki/HTML>)');
    expect(output.languages[0]?.title).toBe('Balise <script> et _emphase_');
  });

  it('links each edition so CommonMark reads its URL back byte for byte (#78)', () => {
    // MediaWiki leaves parentheses unencoded in a URL, so a title with one unmatched paren yields a
    // URL a bare `(…)` destination cannot hold.
    const urls = [
      'https://de.wikipedia.org/wiki/M*A*S*H_(Fernsehserie)',
      'https://fr.wikipedia.org/wiki/Parenth%C3%A8se_)_seule',
      'https://ja.wikipedia.org/wiki/%E9%A0%86_(_%E9%96%8B',
    ];
    const text = wikipediaGetLanguages.format!({
      source_title: 'M*A*S*H (TV series)',
      source_language: 'en',
      languages: urls.map((url, i) => ({
        language_code: `x${i}`,
        edition_code: `x${i}`,
        title: `T${i}`,
        url,
      })),
      total_languages: urls.length,
    })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(parseTargets(text)).toEqual(
      urls.map((href) => ({ kind: 'link', href, text: 'article' })),
    );
    expect(text).toContain(
      '- **T0** — pass `language: "x0"` (code `x0`): [article](<https://de.wikipedia.org/wiki/M*A*S*H_(Fernsehserie)>)',
    );
  });

  it('non-McpError from service propagates without wrapping', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });
});

describe('wikipediaGetLanguages — titles that name no page through the real service (issue #87)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService(
      {} as AppConfig,
      createInMemoryStorage(),
      'test',
      'https://en.wikipedia.org',
    );
  });

  const RECOVERY =
    'Use wikipedia_search_articles to find the exact article title and pass it verbatim.';
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('');

  it.each([
    {
      title: 'Special:Random',
      query: { query: { pages: [{ ns: -1, title: 'Special:Random', special: true }] } },
      detail:
        "Special: and Media: titles, in any edition's spelling, name no page; a file's description page is in the File: namespace.",
    },
    {
      title: 'wikt:cat',
      query: { query: { interwiki: [{ title: 'wikt:cat', iw: 'wikt' }] } },
      detail:
        "It begins with an interwiki prefix, which links to another wiki. For another Wikipedia edition, pass the title without the prefix and the edition's code as language.",
    },
  ])(
    'refuses $title as invalid_title with the declared recovery, never as no_other_languages',
    async ({ title, query, detail }) => {
      // The live langlinks answer for each title, captured 2026-11-11.
      const http = createFetchMock([{ match: () => true, respond: () => Response.json(query) }]);
      http.install();
      onTestFinished(() => {
        http.restore();
      });
      const result = await runToolContract(wikipediaGetLanguages, { title });
      const message = `"${title}" is not a valid Wikipedia page name. ${detail}`;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { title, reason: 'invalid_title', recovery: { hint: RECOVERY } },
        },
      });
      expect(text(result)).toBe(
        `Error: ${message}\n\nRecovery: ${RECOVERY}\n\n(reason invalid_title)`,
      );
    },
  );
});
