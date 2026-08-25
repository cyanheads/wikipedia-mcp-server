/**
 * @fileoverview Tests for wikipedia_get_summary tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-summary.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetSummary } from '@/mcp-server/tools/definitions/wikipedia-get-summary.tool.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

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
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('returns summary fields for a valid article', async () => {
    mockWikipediaService({
      getSummary: vi.fn().mockResolvedValue(mockSummary),
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
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

  it('resolves a real edition the hand-maintained allowlist rejected (issue #26)', async () => {
    const getSummaryFn = vi
      .fn()
      .mockResolvedValue({ ...mockSummary, title: 'Ayiti', extract: 'Ayiti se yon peyi.' });
    mockWikipediaService({ getSummary: getSummaryFn });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    // ht.wikipedia.org answers HTTP 200 and wikipedia_get_languages advertises "ht", but the
    // allowlist called it nonexistent.
    const input = wikipediaGetSummary.input.parse({ title: 'Ayiti', language: 'ht' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(getSummaryFn).toHaveBeenCalledWith('Ayiti', 'ht', ctx);
    expect(result.language).toBe('ht');
  });

  it('resolves the "simple" edition, whose code is longer than three letters (issue #26)', async () => {
    const getSummaryFn = vi
      .fn()
      .mockResolvedValue({ ...mockSummary, title: 'Python (programming language)' });
    mockWikipediaService({ getSummary: getSummaryFn });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({
      title: 'Python (programming language)',
      language: 'simple',
    });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(getSummaryFn).toHaveBeenCalledWith('Python (programming language)', 'simple', ctx);
    expect(result.language).toBe('simple');
  });

  it('rejects the phantom "hat" code up front with no URL in the message (issue #26)', async () => {
    const getSummaryFn = vi.fn().mockResolvedValue(mockSummary);
    mockWikipediaService({ getSummary: getSummaryFn });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Ayiti', language: 'hat' });
    // `handler` is declared `Promise<T> | T`, so normalize before attaching a rejection handler.
    const rejection = await Promise.resolve(wikipediaGetSummary.handler(input, ctx)).then(
      () => undefined,
      (err: unknown) => err as { message: string; data: { reason: string } },
    );

    expect(rejection?.data.reason).toBe('invalid_language');
    // The guard exists to stop a bogus subdomain from being retried into a URL-leaking error.
    expect(rejection?.message).not.toMatch(/https?:\/\//);
    expect(getSummaryFn).not.toHaveBeenCalled();
  });

  it('surfaces disambiguation page_type without throwing', async () => {
    mockWikipediaService({
      getSummary: vi.fn().mockResolvedValue({
        ...mockSummary,
        title: 'Python',
        pageType: 'disambiguation',
        wikidataQid: undefined,
        thumbnailUrl: undefined,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Python' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(result.page_type).toBe('disambiguation');
  });

  it('handles sparse upstream (no thumbnail, no QID)', async () => {
    mockWikipediaService({
      getSummary: vi.fn().mockResolvedValue({
        ...mockSummary,
        wikidataQid: undefined,
        thumbnailUrl: undefined,
        description: undefined,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
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

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Python', language: 'zz' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws not_found with data.reason when article is missing (issue #12)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockWikipediaService({
      getSummary: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found with data.reason for a blank title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: '' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found with data.reason for a whitespace-only title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: '   ' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('passes non-default language to service', async () => {
    const getSummaryFn = vi.fn().mockResolvedValue({ ...mockSummary, title: 'Python (langage)' });
    mockWikipediaService({
      getSummary: getSummaryFn,
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetSummary.handler(input, ctx);

    expect(getSummaryFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.language).toBe('fr');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      title: 'Test Article',
      page_type: 'article',
      pageid: 1,
      extract: 'Some content.',
      language: 'en',
    };
    const blocks = wikipediaGetSummary.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('handles unicode article title without error', async () => {
    const getSummaryFn = vi.fn().mockResolvedValue({
      ...mockSummary,
      title: 'Tōkyō Tawā',
    });
    mockWikipediaService({
      getSummary: getSummaryFn,
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Tōkyō Tawā' });
    const result = await wikipediaGetSummary.handler(input, ctx);
    expect(result.title).toBe('Tōkyō Tawā');
  });

  it('non-McpError from service propagates without wrapping', async () => {
    mockWikipediaService({
      getSummary: vi.fn().mockRejectedValue(new TypeError('Unexpected upstream shape')),
    });

    const ctx = createMockContext({ errors: wikipediaGetSummary.errors });
    const input = wikipediaGetSummary.input.parse({ title: 'Python' });
    await expect(wikipediaGetSummary.handler(input, ctx)).rejects.toThrow(
      'Unexpected upstream shape',
    );
  });
});
