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

  it('re-throws service not_found as typed contract error with data.reason', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi
        .fn()
        .mockRejectedValue(notFound('No Wikipedia article found for "Missing" in language "en".')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Missing' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
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

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Python', language: 'INVALID!!' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws invalid_section for section_index=0 (issue #7)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Python', section_index: 0 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_section' },
    });
  });

  it('throws invalid_section for negative section_index (issue #9)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Python', section_index: -1 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_section' },
    });
  });

  it('throws not_found with data.reason when article is missing (issue #12)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('re-throws service not_found for section path as typed contract error', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleSection: vi
        .fn()
        .mockRejectedValue(notFound('No Wikipedia article found for "Ghost" in language "en".')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Ghost', section_index: 2 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('non-McpError from service propagates without wrapping (full path)', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Anything' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('non-McpError from service propagates without wrapping (section path)', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleSection: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Anything', section_index: 3 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('passes language to service for full article', async () => {
    const getArticleFullFn = vi.fn().mockResolvedValue({
      title: 'Python (langage)',
      pageid: 9999,
      content: 'Contenu en français.',
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: getArticleFullFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(getArticleFullFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.language).toBe('fr');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      title: 'Python',
      pageid: 1,
      content: 'Some article content.',
      section_title: undefined,
      content_type: 'full_article',
      language: 'en',
    };
    const blocks = wikipediaGetArticle.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('full article result has no section_title field', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Albert Einstein',
        pageid: 736,
        content: 'Physics content.',
      }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Albert Einstein' });
    const result = await wikipediaGetArticle.handler(input, ctx);
    expect(result.section_title).toBeUndefined();
    expect(result.content_type).toBe('full_article');
  });
});
