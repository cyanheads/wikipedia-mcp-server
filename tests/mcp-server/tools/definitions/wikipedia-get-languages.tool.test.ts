/**
 * @fileoverview Tests for wikipedia_get_languages tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-languages.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetLanguages } from '@/mcp-server/tools/definitions/wikipedia-get-languages.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

describe('wikipediaGetLanguages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns language editions for a valid article', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi.fn().mockResolvedValue({
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
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.languages).toHaveLength(2);
    expect(result.languages[0]?.language_code).toBe('fr');
    expect(result.total_languages).toBe(2);
    expect(result.source_language).toBe('en');
  });

  it('throws no_other_languages when article has no translations', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi.fn().mockResolvedValue({ languages: [] }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Very Local Article' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_other_languages' },
    });
  });

  it('format renders language codes, titles, and URLs', () => {
    const output = {
      source_title: 'Python (programming language)',
      source_language: 'en',
      languages: [
        {
          language_code: 'fr',
          title: 'Python (langage)',
          url: 'https://fr.wikipedia.org/wiki/Python_(langage)',
        },
      ],
      total_languages: 1,
    };
    const blocks = wikipediaGetLanguages.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('fr');
    expect(text).toContain('Python (langage)');
    expect(text).toContain('https://fr.wikipedia.org');
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
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('maps language entries from service to output shape', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi.fn().mockResolvedValue({
        languages: [
          {
            languageCode: 'ja',
            title: 'パイソン (プログラミング言語)',
            url: 'https://ja.wikipedia.org/wiki/%E3%83%91%E3%82%A4%E3%82%BD%E3%83%B3',
          },
        ],
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.languages[0]).toEqual({
      language_code: 'ja',
      title: 'パイソン (プログラミング言語)',
      url: 'https://ja.wikipedia.org/wiki/%E3%83%91%E3%82%A4%E3%82%BD%E3%83%B3',
    });
  });

  it('passes source language to service', async () => {
    const getLanguagesFn = vi.fn().mockResolvedValue({
      languages: [
        {
          languageCode: 'en',
          title: 'Python (programming language)',
          url: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
        },
      ],
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: getLanguagesFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(getLanguagesFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.source_language).toBe('fr');
  });

  it('source_title echoes the input title', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi.fn().mockResolvedValue({
        languages: [
          { languageCode: 'de', title: 'Python', url: 'https://de.wikipedia.org/wiki/Python' },
        ],
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetLanguages.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetLanguages.handler(input, ctx);

    expect(result.source_title).toBe('Python (programming language)');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      source_title: 'Python',
      source_language: 'en',
      languages: [
        {
          language_code: 'fr',
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
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getLanguages: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetLanguages.errors });
    const input = wikipediaGetLanguages.input.parse({ title: 'Python' });
    await expect(wikipediaGetLanguages.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });
});
