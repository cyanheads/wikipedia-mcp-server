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
});
