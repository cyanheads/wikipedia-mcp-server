/**
 * @fileoverview Tests for wikipedia_get_article tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-article.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

describe('wikipediaGetArticle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns full article content when section_index is omitted', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        pageid: 23862,
        content: '== History ==\n\nPython was created in 1991.',
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.title).toBe('Python (programming language)');
    expect(result.content_type).toBe('full_article');
    expect(result.content).toContain('== History ==');
    expect(result.section_title).toBeUndefined();
  });

  it('returns section content when section_index is provided', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleSection: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        pageid: 23862,
        sectionTitle: 'History',
        content: 'Python was created by Guido van Rossum in 1991.',
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({
      title: 'Python (programming language)',
      section_index: 1,
    });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.content_type).toBe('section');
    expect(result.section_title).toBe('History');
    expect(result.content).toContain('Guido van Rossum');
  });

  it('bubbles service errors (not_found) without wrapping', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi
        .fn()
        .mockRejectedValue(notFound('No Wikipedia article found for "Missing" in language "en".')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Missing' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toThrow(/No Wikipedia article/);
  });

  it('format renders content, title, and content_type', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      content: '== History ==\nCreated in 1991.',
      section_title: undefined,
      content_type: 'full_article',
      language: 'en',
    };
    const blocks = wikipediaGetArticle.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Python');
    expect(text).toContain('full_article');
    expect(text).toContain('23862');
    expect(text).toContain('== History ==');
  });

  it('format renders section_title when present', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      content: 'Python was created by Guido.',
      section_title: 'History',
      content_type: 'section',
      language: 'en',
    };
    const blocks = wikipediaGetArticle.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('History');
    expect(text).toContain('section');
  });
});
