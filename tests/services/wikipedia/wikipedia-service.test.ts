/**
 * @fileoverview Tests for WikipediaService initialization, language validation, and wikitext stripping.
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
