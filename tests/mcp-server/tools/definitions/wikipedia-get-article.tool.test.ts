/**
 * @fileoverview Tests for wikipedia_get_article tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-article.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

describe('wikipediaGetArticle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('returns full article content when section_index is omitted', async () => {
    mockWikipediaService({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        pageid: 23862,
        content: '== History ==\n\nPython was created in 1991.',
      }),
    });

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.title).toBe('Python (programming language)');
    expect(result.content_type).toBe('full_article');
    expect(result.content).toContain('== History ==');
    expect(result.section_title).toBeUndefined();
  });

  it('returns section content when section_index is provided', async () => {
    mockWikipediaService({
      getArticleSection: vi.fn().mockResolvedValue({
        title: 'Python (programming language)',
        pageid: 23862,
        sectionTitle: 'History',
        content: 'Python was created by Guido van Rossum in 1991.',
      }),
    });

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
    mockWikipediaService({
      getArticleFull: vi
        .fn()
        .mockRejectedValue(notFound('No Wikipedia article found for "Missing" in language "en".')),
    });

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

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Python', language: 'zz' });
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
    mockWikipediaService({
      getArticleFull: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws invalid_section with data.reason when section_index is out of range (issue #15)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    mockWikipediaService({
      getArticleSection: vi
        .fn()
        .mockRejectedValue(
          validationError(
            'Section index 999 does not exist in "Python (programming language)". Call wikipedia_get_sections to get valid index values.',
          ),
        ),
    });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({
      title: 'Python (programming language)',
      section_index: 999,
    });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_section' },
    });
  });

  it('re-throws service not_found for section path as typed contract error', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockWikipediaService({
      getArticleSection: vi
        .fn()
        .mockRejectedValue(notFound('No Wikipedia article found for "Ghost" in language "en".')),
    });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Ghost', section_index: 2 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('non-McpError from service propagates without wrapping (full path)', async () => {
    mockWikipediaService({
      getArticleFull: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Anything' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('non-McpError from service propagates without wrapping (section path)', async () => {
    mockWikipediaService({
      getArticleSection: vi.fn().mockRejectedValue(new Error('Upstream timeout')),
    });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Anything', section_index: 3 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('throws not_found with data.reason for a blank title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: '' });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found for a whitespace-only title with a section_index (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: '   ', section_index: 1 });
    await expect(wikipediaGetArticle.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('surfaces the redirect-resolved title in output (issue #19)', async () => {
    mockWikipediaService({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'New York City',
        pageid: 645042,
        content: '== Etymology ==\n\nNew York City content.',
      }),
    });

    const ctx = createMockContext();
    // Caller passes the alias "NYC"; output should carry the resolved article title.
    const input = wikipediaGetArticle.input.parse({ title: 'NYC' });
    const result = await wikipediaGetArticle.handler(input, ctx);
    expect(result.title).toBe('New York City');
    expect(result.content).toContain('Etymology');
  });

  it('passes language to service for full article', async () => {
    const getArticleFullFn = vi.fn().mockResolvedValue({
      title: 'Python (langage)',
      pageid: 9999,
      content: 'Contenu en français.',
    });
    mockWikipediaService({
      getArticleFull: getArticleFullFn,
    });

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
    mockWikipediaService({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Albert Einstein',
        pageid: 736,
        content: 'Physics content.',
      }),
    });

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Albert Einstein' });
    const result = await wikipediaGetArticle.handler(input, ctx);
    expect(result.section_title).toBeUndefined();
    expect(result.content_type).toBe('full_article');
  });

  it('returns full content with truncated:false for an article within the byte budget (issue #23)', async () => {
    mockWikipediaService({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Small Article',
        pageid: 1,
        content: '== Intro ==\n\nShort body.\n\n== More ==\n\nAlso short.',
      }),
    });

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Small Article' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.content).toContain('Short body.');
    expect(result.original_length).toBeUndefined();
    expect(result.sections_suggested).toBeUndefined();
    expect(result.content_type).toBe('full_article');
  });

  it('returns a section outline with truncated:true for an over-threshold article (issue #23)', async () => {
    const big = `Lead paragraph.\n\n${Array.from(
      { length: 6 },
      (_, i) => `== Section ${i + 1} ==\n\n${'lorem ipsum dolor sit amet. '.repeat(1000)}`,
    ).join('\n\n')}`;
    mockWikipediaService({
      getArticleFull: vi.fn().mockResolvedValue({
        title: 'Big Article',
        pageid: 42,
        content: big,
      }),
    });

    const ctx = createMockContext();
    const input = wikipediaGetArticle.input.parse({ title: 'Big Article' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.sections_suggested).toBe(true);
    expect(result.original_length).toBe(big.length);
    expect(result.content_type).toBe('full_article');
    // Outline points at this server's targeted-read path, not the framework default wording.
    expect(result.content).toContain('wikipedia_get_sections');
    expect(result.content).toContain('section_index');
    // The outline lists section names and sizes, not the raw section bodies.
    expect(result.content).not.toContain('lorem ipsum');
  });

  it('format renders overflow disclosure fields when truncated (issue #23)', () => {
    const output = {
      title: 'World War II',
      pageid: 32927,
      content: 'Full article outlined — 90000 characters across 39 sections ...',
      content_type: 'full_article',
      truncated: true,
      original_length: 90000,
      sections_suggested: true,
      language: 'en',
    };
    const blocks = wikipediaGetArticle.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('90000');
    expect(text).toContain('Truncated');
    expect(text).toContain('wikipedia_get_sections');
  });
});
