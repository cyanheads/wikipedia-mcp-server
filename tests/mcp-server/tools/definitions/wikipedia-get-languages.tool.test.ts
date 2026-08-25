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

  it('non-McpError from service propagates without wrapping', async () => {
    mockWikipediaService({
      getLanguages: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    });

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });
});
