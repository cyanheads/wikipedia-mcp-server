/**
 * @fileoverview Tests for wikipedia_get_summary tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-summary.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetSummary } from '@/mcp-server/tools/definitions/wikipedia-get-summary.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

const mockSummary = {
  title: 'Python (programming language)',
  pageType: 'article',
  pageid: 23862,
  wikidataQid: 'Q28865',
  description: 'General-purpose programming language',
  extract: 'Python is a high-level, general-purpose programming language.',
  thumbnailUrl:
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Python-logo-notext.svg/100px-Python-logo-notext.svg.png',
};

describe('wikipediaGetSummary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns summary fields for a valid article', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSummary: vi.fn().mockResolvedValue(mockSummary),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSummary.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(result.title).toBe('Python (programming language)');
    expect(result.page_type).toBe('article');
    expect(result.pageid).toBe(23862);
    expect(result.wikibase_item).toBe('Q28865');
    expect(result.description).toBe('General-purpose programming language');
    expect(result.extract).toBe('Python is a high-level, general-purpose programming language.');
    expect(result.thumbnail_url).toContain('wikimedia');
    expect(result.language).toBe('en');
  });

  it('surfaces disambiguation page_type without throwing', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSummary: vi.fn().mockResolvedValue({
        ...mockSummary,
        title: 'Python',
        pageType: 'disambiguation',
        wikidataQid: undefined,
        thumbnailUrl: undefined,
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSummary.input.parse({ title: 'Python' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(result.page_type).toBe('disambiguation');
  });

  it('handles sparse upstream (no thumbnail, no QID)', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSummary: vi.fn().mockResolvedValue({
        ...mockSummary,
        wikidataQid: undefined,
        thumbnailUrl: undefined,
        description: undefined,
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSummary.input.parse({ title: 'SomePage' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(result.wikibase_item).toBeUndefined();
    expect(result.thumbnail_url).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('format renders title, page_type, extract, and optional fields', () => {
    const output = {
      title: 'Python',
      page_type: 'article',
      pageid: 23862,
      wikibase_item: 'Q28865',
      description: 'A language',
      extract: 'Python is a language.',
      thumbnail_url: 'https://example.com/img.png',
      language: 'en',
    };
    const blocks = wikipediaGetSummary.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Python');
    expect(text).toContain('article');
    expect(text).toContain('Q28865');
    expect(text).toContain('23862');
    expect(text).toContain('Python is a language.');
    expect(text).toContain('https://example.com/img.png');
  });

  it('format renders correctly without optional fields', () => {
    const output = {
      title: 'Test',
      page_type: 'disambiguation',
      pageid: undefined,
      wikibase_item: undefined,
      description: undefined,
      extract: 'Test may refer to many things.',
      thumbnail_url: undefined,
      language: 'en',
    };
    const blocks = wikipediaGetSummary.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('disambiguation');
    expect(text).toContain('Test may refer to many things.');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Python', language: 'INVALID!!' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });
});
