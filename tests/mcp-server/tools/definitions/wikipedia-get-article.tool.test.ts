/**
 * @fileoverview Tests for wikipedia_get_article tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-article.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import {
  getWikipediaService,
  initWikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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
      truncated: false,
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
      truncated: false,
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

  it('reads the lead through section_index 0, which #7 used to reject (issues #7, #40)', async () => {
    const getArticleSectionFn = vi.fn().mockResolvedValue({
      title: 'United States',
      pageid: 3434750,
      sectionTitle: 'Introduction',
      content: 'The United States of America is a country primarily located in North America.',
    });
    mockWikipediaService({ getArticleSection: getArticleSectionFn });

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'United States', section_index: 0 });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(getArticleSectionFn).toHaveBeenCalledWith('United States', 0, 'en', ctx);
    expect(result.content_type).toBe('section');
    // The label the overflow outline prints for the lead, never "Section 0".
    expect(result.section_title).toBe('Introduction');
    expect(result.section_title).not.toBe('Section 0');
    expect(result.content).toContain('United States of America');
  });

  it('rejects a negative section_index at schema parse time, before any call (issues #9, #40)', () => {
    const getArticleSectionFn = vi.fn();
    mockWikipediaService({ getArticleSection: getArticleSectionFn });

    const parsed = wikipediaGetArticle.input.safeParse({ title: 'Python', section_index: -1 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toContain('section_index');
    expect(getArticleSectionFn).not.toHaveBeenCalled();
  });

  it('rejects a non-integer section_index at schema parse time, before any call (issue #40)', () => {
    const getArticleSectionFn = vi.fn();
    mockWikipediaService({ getArticleSection: getArticleSectionFn });

    const parsed = wikipediaGetArticle.input.safeParse({ title: 'Python', section_index: 1.5 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toContain('section_index');
    expect(getArticleSectionFn).not.toHaveBeenCalled();
  });

  it('refuses a title MediaWiki cannot name a page with, before any call (issue #42)', async () => {
    const getArticleFullFn = vi.fn();
    const getArticleSectionFn = vi.fn();
    mockWikipediaService({
      getArticleFull: getArticleFullFn,
      getArticleSection: getArticleSectionFn,
    });

    for (const title of ['Cat|Dog', 'Foo[bar]', 'A{b}', 'A<B']) {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      const rejection = await Promise.resolve(
        wikipediaGetArticle.handler(wikipediaGetArticle.input.parse({ title }), ctx),
      ).then(
        () => undefined,
        (err: unknown) => err as { message: string; data: { reason: string } },
      );

      expect(rejection?.data.reason).toBe('invalid_title');
      // No upstream call means no "exists but has no readable content" claim and no fetch URL.
      expect(rejection?.message).not.toMatch(/https?:\/\//);
    }
    expect(getArticleFullFn).not.toHaveBeenCalled();
    expect(getArticleSectionFn).not.toHaveBeenCalled();
  });

  it('accepts a fragment title on both read paths (issue #42)', async () => {
    const getArticleFullFn = vi.fn().mockResolvedValue({
      title: 'Python (programming language)',
      pageid: 23862,
      content: 'Python is a language.',
    });
    const getArticleSectionFn = vi.fn().mockResolvedValue({
      title: 'Python (programming language)',
      pageid: 23862,
      sectionTitle: 'History',
      content: 'Python was created in 1991.',
    });
    mockWikipediaService({
      getArticleFull: getArticleFullFn,
      getArticleSection: getArticleSectionFn,
    });

    const fragment = 'Python (programming language)#History';
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    await wikipediaGetArticle.handler(wikipediaGetArticle.input.parse({ title: fragment }), ctx);
    await wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: fragment, section_index: 1 }),
      ctx,
    );

    expect(getArticleFullFn).toHaveBeenCalledWith(fragment, 'en', ctx);
    expect(getArticleSectionFn).toHaveBeenCalledWith(fragment, 1, 'en', ctx);
  });

  it('accepts titles that only look illegal (issue #42)', async () => {
    const getArticleFullFn = vi.fn().mockResolvedValue({ title: 'T', pageid: 1, content: 'Body.' });
    mockWikipediaService({ getArticleFull: getArticleFullFn });

    for (const title of ['100% Cat', 'A_B', 'A+B', ':Cat', 'AC/DC']) {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      await wikipediaGetArticle.handler(wikipediaGetArticle.input.parse({ title }), ctx);
      expect(getArticleFullFn).toHaveBeenCalledWith(title, 'en', ctx);
    }
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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
      truncated: false,
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
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

    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'Big Article' });
    const result = await wikipediaGetArticle.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.sections_suggested).toBe(true);
    expect(result.original_length).toBe(big.length);
    expect(result.content_type).toBe('full_article');
    // Outline points at this server's targeted-read path, not the framework default wording.
    expect(result.content).toContain('wikipedia_get_sections');
    expect(result.content).toContain('section_index');
    // The outline names Introduction among its sections, so it also names the input that reads it.
    expect(result.content).toContain('Introduction');
    expect(result.content).toContain('section_index 0');
    // The outline lists section names and sizes, not the raw section bodies.
    expect(result.content).not.toContain('lorem ipsum');
  });

  it('passes the citation fields through on the section, full, and outline paths (issue #53)', async () => {
    const citation = {
      url: 'https://en.wikipedia.org/wiki/New_York_City',
      revisionId: '1376082128',
    };
    const big = `Lead.\n\n${Array.from(
      { length: 6 },
      (_, i) => `== Section ${i + 1} ==\n\n${'lorem ipsum dolor sit amet. '.repeat(1000)}`,
    ).join('\n\n')}`;
    const getArticleFull = vi
      .fn()
      .mockResolvedValueOnce({
        title: 'New York City',
        pageid: 645042,
        content: 'Short.',
        ...citation,
        lastModified: '2026-09-21T23:42:01Z',
      })
      .mockResolvedValueOnce({
        title: 'New York City',
        pageid: 645042,
        content: big,
        ...citation,
        lastModified: '2026-09-21T23:42:01Z',
      });
    const getArticleSection = vi.fn().mockResolvedValue({
      title: 'New York City',
      pageid: 645042,
      sectionTitle: 'Etymology',
      content: 'Named after the Duke of York.',
      ...citation,
    });
    mockWikipediaService({ getArticleFull, getArticleSection });

    const run = async (input: Record<string, unknown>) => {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      return wikipediaGetArticle.output.parse(
        await wikipediaGetArticle.handler(wikipediaGetArticle.input.parse(input), ctx),
      );
    };
    const full = await run({ title: 'NYC' });
    const outline = await run({ title: 'NYC' });
    const section = await run({ title: 'NYC', section_index: 1 });

    expect(full.truncated).toBe(false);
    expect(outline.truncated).toBe(true);
    for (const result of [full, outline]) {
      expect(result).toMatchObject({
        url: citation.url,
        revision_id: '1376082128',
        last_modified: '2026-09-21T23:42:01Z',
      });
    }
    expect(section).toMatchObject({ url: citation.url, revision_id: '1376082128' });
    expect(section).not.toHaveProperty('last_modified');
  });

  it('omits the citation lines from format() when the fields are absent (issue #53)', () => {
    const text = renderText({
      title: 'Python',
      content: 'Body.',
      content_type: 'full_article',
      truncated: false,
      language: 'en',
    });
    expect(text).not.toContain('**URL:**');
    expect(text).not.toContain('**Revision ID:**');
    expect(text).not.toContain('**Last modified:**');
  });

  it('names its citation fields and describes them the way wikipedia_get_summary does (issue #53)', async () => {
    const { wikipediaGetSummary } = await import(
      '@/mcp-server/tools/definitions/wikipedia-get-summary.tool.js'
    );
    const article = wikipediaGetArticle.output.shape;
    const summary = wikipediaGetSummary.output.shape;
    expect(article.url.description).toBe(summary.url.description);
    for (const field of ['url', 'revision_id', 'last_modified'] as const) {
      expect(article[field].safeParse(undefined).success).toBe(true);
      expect(article[field].description).toBeTruthy();
    }
    expect(article.revision_id.description).toContain('oldid=<revision_id>');
    expect(article.last_modified.description).toContain('ISO 8601 timestamp of that revision');
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

  it('escapes markdown-active upstream text in format() and leaves the structured value raw (issue #43)', () => {
    const content =
      'The markup text <title>This is a title</title> defines the browser page title.\nItalic text may be implemented by _underscores_ or *single-asterisks*.\n# Not a heading';
    const output = {
      title: 'HTML <element>',
      pageid: 13782,
      content,
      section_title: 'Markup *basics*',
      content_type: 'section',
      truncated: false,
      language: 'en',
    };
    const text = wikipediaGetArticle.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(text).toContain('\\<title\\>');
    expect(text).toContain('\\_underscores\\_');
    expect(text).toContain('\\*single-asterisks\\*');
    expect(text).toContain('\\# Not a heading');
    expect(text).toContain('HTML \\<element\\>');
    expect(text).toContain('Markup \\*basics\\*');
    expect(text).not.toContain('<title>');
    // The structured value the handler returned is untouched — only the render path escapes.
    expect(output.content).toBe(content);
    expect(output.title).toBe('HTML <element>');
  });

  it('renders a fenced code block into content[] raw while escaping the prose around it (issue #49)', () => {
    const content =
      '== Code examples ==\n\nProgram <main>:\n\n```\nif n < 0:\n    factorial *= i\n```\n\nSee A[hi].';
    const text = renderText({
      title: 'Python',
      content,
      section_title: 'Code examples',
      content_type: 'section',
      truncated: false,
      language: 'en',
    });

    expect(text).toContain('```\nif n < 0:\n    factorial *= i\n```');
    expect(text).not.toContain('n \\< 0');
    expect(text).not.toContain('\\*=');
    expect(text).toContain('Program \\<main\\>:');
    expect(text).toContain('See A\\[hi\\].');
  });

  it('renders table rows into content[] with raw delimiters and escaped cells (issue #50)', () => {
    const content = '| Candidate | Note |\n| --- | --- |\n| <b>Trump</b> | a \\| b |';
    const text = renderText({
      title: 'Election',
      content,
      section_title: 'Results',
      content_type: 'section',
      truncated: false,
      language: 'en',
    });

    expect(text).toContain(
      '| Candidate | Note |\n| --- | --- |\n| \\<b\\>Trump\\</b\\> | a \\| b |',
    );
  });

  describe('section read end to end through the real renderer (issues #48, #49, #50)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      initWikipediaService({} as AppConfig, fakeStorage(), 'wikipedia-mcp-server/test');
      const svc = getWikipediaService();
      vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue({
        hosts: { en: 'https://en.wikipedia.org' },
        fetchedAt: '2026-09-22T00:00:00.000Z',
      });
      vi.spyOn(svc, 'actionGet').mockResolvedValue({
        parse: { title: 'Sample', pageid: 7, revid: 1376082128, text: SAMPLE_SECTION_HTML },
      });
    });

    it('carries the revision and the composed URL, with no last_modified, on both surfaces (issue #53)', async () => {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      const input = wikipediaGetArticle.input.parse({ title: 'Sample', section_index: 3 });
      const result = wikipediaGetArticle.output.parse(
        await wikipediaGetArticle.handler(input, ctx),
      );

      expect(result.revision_id).toBe('1376082128');
      expect(result.url).toBe('https://en.wikipedia.org/wiki/Sample');
      expect(result).not.toHaveProperty('last_modified');
      const text = renderText(result);
      expect(text).toContain('**URL:** https://en.wikipedia.org/wiki/Sample');
      expect(text).toContain('**Revision ID:** 1376082128');
      expect(text).not.toContain('Last modified');
    });

    it('carries superscripts, a fenced code block, and table rows in structuredContent', async () => {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      const input = wikipediaGetArticle.input.parse({ title: 'Sample', section_index: 3 });
      const result = wikipediaGetArticle.output.parse(
        await wikipediaGetArticle.handler(input, ctx),
      );

      expect(result.content).toBe(
        [
          '== Sample ==',
          '',
          'Value 6.02214076×10²³ mol⁻¹ for <N_A>.',
          '',
          '```',
          'if n < 0:',
          '    x *= 2',
          '```',
          '',
          '| Name | Value |',
          '| --- | --- |',
          '| a | b \\| c |',
          '| <script> | 10⁸ |',
        ].join('\n'),
      );
    });

    it('renders the same content into content[], escaped only outside the code and the delimiters', async () => {
      const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
      const input = wikipediaGetArticle.input.parse({ title: 'Sample', section_index: 3 });
      const result = wikipediaGetArticle.output.parse(
        await wikipediaGetArticle.handler(input, ctx),
      );

      expect(renderText(result)).toContain(
        [
          '== Sample ==',
          '',
          'Value 6.02214076×10²³ mol⁻¹ for \\<N\\_A\\>.',
          '',
          '```',
          'if n < 0:',
          '    x *= 2',
          '```',
          '',
          '| Name | Value |',
          '| --- | --- |',
          '| a | b \\| c |',
          '| \\<script\\> | 10⁸ |',
        ].join('\n'),
      );
    });
  });
});

describe('wikipediaGetArticle — abbreviations, nested scripts, group rows, and infobox chrome (issues #48, #50)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'wikipedia-mcp-server/test');
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue({
      hosts: { fr: 'https://fr.wikipedia.org' },
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'Échantillon', pageid: 9, revid: 42, text: FRENCH_SECTION_HTML },
    });
  });

  async function read(): Promise<ReturnType<typeof wikipediaGetArticle.output.parse>> {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({
      title: 'Échantillon',
      section_index: 0,
      language: 'fr',
    });
    return wikipediaGetArticle.output.parse(await wikipediaGetArticle.handler(input, ctx));
  }

  const expected = [
    'Tour Eiffel',
    'Hauteur: 330 m',
    '',
    'Au XIXe siècle, M^(me) n’est pas Mme, et e^(−t²) reste un exposant.',
    '',
    '| Saison | Classement | Classement |',
    '| --- | --- | --- |',
    '| Groupe A |  |  |',
    '| 1923-24 | 12e/14 | Relégué |',
  ];

  it('carries them in structuredContent', async () => {
    expect((await read()).content).toBe(expected.join('\n'));
  });

  it('renders the same content into content[]', async () => {
    const text = renderText(await read());
    expect(text).toContain(expected.join('\n'));
    expect(text).not.toContain('Seen from');
    expect(text).not.toContain('modifier');
  });
});

/**
 * Parser HTML carrying an infobox with an image caption, a colon-ended label, and an edit link;
 * French abbreviations beside a bare superscript; and a table with a group row.
 */
const FRENCH_SECTION_HTML = `<div class="mw-parser-output"><table class="infobox"><tbody><tr><th colspan="2" class="infobox-above">Tour Eiffel</th></tr><tr><td colspan="2" class="infobox-image"><img src="t.jpg" alt=""><div class="infobox-caption">Seen from the Champ de Mars, 2009</div></td></tr><tr><th class="infobox-label">Hauteur :</th><td class="infobox-data">330&#160;m</td></tr><tr><td colspan="2"><p class="navbar bordered noprint"><a href="/w/index.php?action=edit">modifier</a></p></td></tr></tbody></table>
<p>Au <abbr class="abbr" title="Dix-neuvième"><span class="romain">XIX</span><sup>e</sup></abbr> siècle, M<sup>me</sup> n’est pas <abbr class="abbr" title="Madame">M<sup>me</sup></abbr>, et e<sup>−t<sup>2</sup></sup> reste un exposant.</p>
<table class="wikitable"><tbody><tr><th>Saison</th><th colspan="2">Classement</th></tr><tr><th colspan="3">Groupe A</th></tr><tr><td>1923-24</td><td><abbr class="abbr" title="Douzième">12<sup>e</sup></abbr>/14</td><td>Relégué</td></tr></tbody></table></div>`;

describe('wikipediaGetArticle — full read end to end through the real renderer (issues #48, #53)', () => {
  /** Stub the full-read request with a TextExtracts HTML-mode extract for the alias `NYC`. */
  function stubFullRead(extract: string) {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'wikipedia-mcp-server/test');
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue({
      hosts: { en: 'https://en.wikipedia.org' },
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      query: {
        redirects: [{ from: 'NYC', to: 'New York City' }],
        pages: [
          {
            pageid: 645042,
            title: 'New York City',
            extract,
            lastrevid: 1376082128,
            fullurl: 'https://en.wikipedia.org/wiki/New_York_City',
            revisions: [{ revid: 1376082128, timestamp: '2026-09-21T23:42:01Z' }],
          },
        ],
      },
    });
  }

  async function read(): Promise<ReturnType<typeof wikipediaGetArticle.output.parse>> {
    const ctx = createMockContext({ errors: wikipediaGetArticle.errors });
    const input = wikipediaGetArticle.input.parse({ title: 'NYC' });
    return wikipediaGetArticle.output.parse(await wikipediaGetArticle.handler(input, ctx));
  }

  it('carries sections, superscripts, and a fenced code block in structuredContent', async () => {
    stubFullRead(FULL_EXTRACT_HTML);
    const result = await read();

    expect(result.content).toBe(
      [
        'The <city> holds 8.3×10⁶ people and N_A mol⁻¹ nothing.',
        '',
        '== History ==',
        '',
        'Founded in 1624.',
        '',
        '=== Code ===',
        '',
        '```',
        'if n < 0:',
        '    x *= 2',
        '```',
      ].join('\n'),
    );
    expect(result.truncated).toBe(false);
  });

  it('renders the same content into content[], escaped only outside the code block', async () => {
    stubFullRead(FULL_EXTRACT_HTML);
    expect(renderText(await read())).toContain(
      [
        'The \\<city\\> holds 8.3×10⁶ people and N\\_A mol⁻¹ nothing.',
        '',
        '== History ==',
        '',
        'Founded in 1624.',
        '',
        '=== Code ===',
        '',
        '```',
        'if n < 0:',
        '    x *= 2',
        '```',
      ].join('\n'),
    );
  });

  it("reports the redirect target's URL, revision, and revision timestamp on both surfaces (issue #53)", async () => {
    stubFullRead(FULL_EXTRACT_HTML);
    const result = await read();

    expect(result.title).toBe('New York City');
    expect(result.url).toBe('https://en.wikipedia.org/wiki/New_York_City');
    expect(result.revision_id).toBe('1376082128');
    expect(result.last_modified).toBe('2026-09-21T23:42:01Z');
    const text = renderText(result);
    expect(text).toContain('**URL:** https://en.wikipedia.org/wiki/New_York_City');
    expect(text).toContain('**Revision ID:** 1376082128');
    expect(text).toContain('**Last modified:** 2026-09-21T23:42:01Z');
  });

  it('outlines an over-budget article from its rendered headings and keeps the citation fields', async () => {
    // Four sections of ~30 KB rendered: over the 80 KB default budget together, under it apart.
    const body = '<p>lorem ipsum dolor sit amet 10<sup>2</sup>. </p>'.repeat(900);
    stubFullRead(
      `<p>Lead.</p>${['Geography', 'Economy', 'Culture', 'Transport'].map((h) => `<h2><span id="${h}">${h}</span></h2>${body}`).join('')}`,
    );
    const result = await read();

    expect(result.truncated).toBe(true);
    expect(result.sections_suggested).toBe(true);
    for (const heading of ['Introduction', 'Geography', 'Economy', 'Culture', 'Transport']) {
      expect(result.content).toMatch(new RegExp(`^- ${heading} — \\d+ bytes$`, 'm'));
    }
    expect(result.content).not.toContain('lorem ipsum');
    expect(result.content).not.toContain('<h2>');
    expect(result.url).toBe('https://en.wikipedia.org/wiki/New_York_City');
    expect(result.revision_id).toBe('1376082128');
    expect(result.last_modified).toBe('2026-09-21T23:42:01Z');
    const text = renderText(result);
    expect(text).toContain('**Revision ID:** 1376082128');
    expect(text).toContain('**Last modified:** 2026-09-21T23:42:01Z');
  });
});

/** A TextExtracts HTML-mode extract with a heading tree, scripts, an escaped tag, and a code sample. */
const FULL_EXTRACT_HTML = `<p class="mw-empty-elt">
</p>
<p>The &lt;city&gt; holds 8.3×10<sup>6</sup> people and <i>N</i><sub>A</sub> mol<sup>−1</sup> nothing.
</p>
<h2><span id="History">History</span></h2>
<p>Founded in 1624.
</p>
<h3><span id="Code">Code</span></h3>
<pre>if n &lt; 0:
    x *= 2
</pre>`;

/** Parser HTML for a section carrying a superscript, a code sample, and a data table. */
const SAMPLE_SECTION_HTML = `<div class="mw-parser-output"><div class="mw-heading mw-heading2"><h2 id="Sample">Sample</h2></div>
<p>Value 6.02214076×10<sup>23</sup>&#160;mol<sup>−1</sup> for &lt;<i>N</i><sub>A</sub>&gt;.<sup class="reference"><a href="#cite_note-1">[1]</a></sup></p>
<pre>if n &lt; 0:
    x *= 2
</pre>
<table class="wikitable"><tbody><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>b | c</td></tr><tr><td>&lt;script&gt;</td><td>10<sup>8</sup></td></tr></tbody></table></div>`;

/** The joined text of every text block format() returns. */
function renderText(output: Parameters<NonNullable<typeof wikipediaGetArticle.format>>[0]): string {
  return wikipediaGetArticle.format!(output)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

/** A StorageService stand-in for the edition index, which the stubbed fetch never needs. */
function fakeStorage(): StorageService {
  return { get: async () => null, set: async () => undefined } as unknown as StorageService;
}
