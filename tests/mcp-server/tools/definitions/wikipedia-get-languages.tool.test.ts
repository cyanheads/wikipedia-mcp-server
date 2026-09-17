/**
 * @fileoverview Tests for wikipedia_get_languages tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-languages.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetLanguages } from '@/mcp-server/tools/definitions/wikipedia-get-languages.tool.js';
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
    expect(text).toContain('https://als.wikipedia.org');
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

    function mockZurich() {
      mockWikipediaService({
        getLanguages: vi.fn().mockResolvedValue({ title: 'Zürich', languages: zurichLanguages }),
      });
    }

    it('keeps only the requested editions and reports the codes with no article', async () => {
      mockZurich();

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({
        title: 'Zürich',
        editions: ['fr', 'de', 'gsw', 'xx'],
      });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages.map((l) => l.language_code)).toEqual(['fr', 'de', 'gsw']);
      // "gsw" is the langlinks code; the edition it names lives on the "als" subdomain.
      expect(result.languages[2]?.edition_code).toBe('als');
      expect(result.missing).toEqual(['xx']);
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
        editions: ['xx', 'qqq'],
      });
      const result = await wikipediaGetLanguages.handler(input, ctx);

      expect(result.languages).toEqual([]);
      expect(result.missing).toEqual(['xx', 'qqq']);
      expect(result.total_languages).toBe(4);
    });

    it('still fails with no_other_languages when the article itself has no other editions', async () => {
      mockWikipediaService({
        getLanguages: vi.fn().mockResolvedValue({ title: 'Very Local Article', languages: [] }),
      });

      const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
      const input = wikipediaGetLanguages.input.parse({
        title: 'Very Local Article',
        editions: ['fr'],
      });
      // The gate reads the unfiltered count, so a filter never turns a bare article into a match.
      await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_other_languages' },
      });
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
    // The URL is not prose and is left intact so the link stays followable.
    expect(text).toContain('https://fr.wikipedia.org/wiki/HTML');
    expect(output.languages[0]?.title).toBe('Balise <script> et _emphase_');
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
