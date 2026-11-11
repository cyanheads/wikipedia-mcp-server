/**
 * @fileoverview Tests for wikipedia_get_article tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-article.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import { wikipediaGetSections } from '@/mcp-server/tools/definitions/wikipedia-get-sections.tool.js';
import { quotedNotice } from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  getWikipediaService,
  initWikipediaService,
  redirectInfo,
} from '@/services/wikipedia/wikipedia-service.js';
import { parseTargets, readBackText } from '../../../helpers/commonmark.js';
import { listFixture } from '../../../helpers/list-fixtures.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

describe('wikipediaGetArticle', () => {
  it('selects only the requested outer table and exposes paging metadata (#67)', async () => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
    vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
      parse: {
        title: 'Sample',
        revid: 42,
        text: '<p>Outside</p><table class="wikitable"><tr><th>H</th></tr><tr><td>same</td></tr><tr><td></td></tr><tr><td>same</td></tr></table>',
      },
    });
    const result = await wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: 'Sample', section_index: 1, table_index: 1 }),
      createMockContext({ errors: wikipediaGetArticle.errors }),
    );
    expect(result.content).toBe('| H |\n| --- |\n| same |\n|  |\n| same |');
    expect(result).toMatchObject({
      table_index: 1,
      table_count: 1,
      table_rows: 4,
      row_offset: 0,
      rows_returned: 4,
      revision_id: '42',
      truncated: false,
    });
    expect(renderText(result)).toContain('**Table index:** 1');
  });
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
      getArticleSection: vi.fn().mockRejectedValue(
        validationError(
          'Section index 999 does not exist in "Python (programming language)". Call wikipedia_get_sections to get valid index values.',
          {
            reason: 'invalid_section',
            title: 'Python (programming language)',
            sectionIndex: 999,
          },
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

  it('links the URL so CommonMark reads it back byte for byte (#78)', async () => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'wikipedia-mcp-server/test');
    const svc = getWikipediaService();
    vi.spyOn(svc, 'fetchEditionIndex').mockResolvedValue({
      hosts: { en: 'https://en.wikipedia.org' },
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'M*A*S*H (TV series)', pageid: 7, revid: 42, text: '<p>Lead.</p>' },
    });
    const result = wikipediaGetArticle.output.parse(
      await wikipediaGetArticle.handler(
        wikipediaGetArticle.input.parse({ title: 'M*A*S*H (TV series)', section_index: 0 }),
        createMockContext({ errors: wikipediaGetArticle.errors }),
      ),
    );

    const url = 'https://en.wikipedia.org/wiki/M*A*S*H_(TV_series)';
    expect(result.url).toBe(url);
    const text = renderText(result);
    expect(parseTargets(text)).toEqual([{ kind: 'link', href: url, text: 'en.wikipedia.org' }]);
    expect(text).toContain(`\n**URL:** [en.wikipedia.org](<${url}>)\n`);
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
      expect(text).toContain('**URL:** [en.wikipedia.org](<https://en.wikipedia.org/wiki/Sample>)');
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

describe('wikipediaGetArticle — lists through the real renderer (#81)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
  });

  const contentText = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('\n');
  const actionIs = (action: string) => (request: Request) =>
    new URL(request.url).searchParams.get('action') === action;

  /** A section read whose parse answers `text`, with an ordinary page behind the page-props lookup. */
  async function readSection(text: string) {
    const http = createFetchMock([
      {
        match: actionIs('parse'),
        respond: Response.json({
          parse: { title: 'Tree traversal', pageid: 597584, revid: 1379688139, text },
        }),
      },
      {
        match: actionIs('query'),
        respond: Response.json({ query: { pages: [{ pageid: 597584, title: 'Tree traversal' }] } }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, {
        title: 'Tree traversal',
        section_index: 10,
      });
      return {
        content: (result.structuredContent as { content: string }).content,
        text: contentText(result),
      };
    } finally {
      http.restore();
    }
  }

  it('fences a nested list in content[], so it reads back as the structuredContent text', async () => {
    const { content, text } = await readSection(listFixture('tree-traversal-s10'));
    const list = [
      '1. If the current node is empty then return.',
      '2. Visit the current node for pre-order traversal.',
      "3. For each i from 1 to the current node's number of subtrees − 1, or from the latter to the former for reverse traversal, do:",
      "  1. Recursively traverse the current node's i-th subtree.",
      '  2. Visit the current node for in-order traversal.',
      "4. Recursively traverse the current node's last subtree.",
      '5. Visit the current node for post-order traversal.',
    ].join('\n');
    expect(content).toContain(`\n\n${list}\n\n`);
    expect(text).toContain(`\n\n\`\`\`\n${list}\n\`\`\`\n\n`);
    expect(readBackText(text.slice(text.indexOf('==== Arbitrary trees ====')))).toBe(content);
  });

  it('escapes a flat list in content[] like other line-leading text', async () => {
    const { content, text } = await readSection(
      '<p>Steps:</p><ol start="9"><li>Nine <i>a</i>_b</li><li>Ten</li></ol>',
    );
    expect(content).toBe('Steps:\n\n9. Nine a_b\n10. Ten');
    expect(text).toContain('\nSteps:\n\n9\\. Nine a\\_b\n10\\. Ten');
    expect(readBackText(text.slice(text.indexOf('Steps:')))).toBe(content);
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
    expect(text).toContain(
      '**URL:** [en.wikipedia.org](<https://en.wikipedia.org/wiki/New_York_City>)',
    );
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
      const suffix = heading === 'Introduction' ? ' \\(section_index: 0\\)' : '';
      expect(result.content).toMatch(new RegExp(`^- ${heading} — \\d+ bytes${suffix}$`, 'm'));
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

describe('wikipediaGetArticle — the optional TOC lookup on a full read', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Result = { content: Array<{ type: string; text?: string }> };
  const contentText = (result: Result) =>
    result.content.map((block) => block.text ?? '').join('\n');
  /** The enrichment trailer: the last content block, which carries the notice. */
  const trailer = (result: Result) => result.content.at(-1)?.text ?? '';
  const actionIs = (action: string) => (request: Request) =>
    new URL(request.url).searchParams.get('action') === action;
  const actions = (calls: readonly { request: Request }[]) =>
    calls.map((call) => new URL(call.request.url).searchParams.get('action'));

  const TOC_UNAVAILABLE =
    'Section indices could not be verified because the optional table of contents lookup was unavailable. Call wikipedia_get_sections to retry.';
  const unverifiedTarget = (section: string) =>
    `The alias targets "${section}". This remains a full-article read. Open the canonical URL or call wikipedia_get_sections to locate the target.`;
  const NOT_JSON =
    'Wikipedia Action API returned a response that is not a JSON object — likely rate-limited or under maintenance.';

  /** A full read whose `action=query` answers `query` and whose TOC lookup answers `toc`. */
  function fullReadUpstream(
    query: unknown,
    toc: (request: Request) => Response | Promise<Response>,
  ) {
    return createFetchMock([
      { match: actionIs('query'), respond: () => Response.json(query) },
      { match: actionIs('parse'), respond: toc },
    ]);
  }

  /** The two full reads that consult the TOC: an article over the size budget, and an alias into a section. */
  const READS = [
    {
      read: 'an outlined article',
      input: { title: 'Target' },
      query: {
        query: {
          pages: [
            {
              pageid: 7,
              title: 'Target',
              extract: `<p>${'Lead '.repeat(20000)}</p><h2>Parent</h2><p>Body.</p>`,
            },
          ],
        },
      },
      expected: {
        title: 'Target',
        truncated: true,
        sections_suggested: true,
        notice: TOC_UNAVAILABLE,
      },
      // Unverified: only the lead keeps an index.
      content: /^- Parent — \d+ bytes$/m,
    },
    {
      read: 'an alias into a section',
      input: { title: 'Alias' },
      query: {
        query: {
          redirects: [{ from: 'Alias', to: 'Target', tofragment: 'Parent' }],
          pages: [
            { pageid: 7, title: 'Target', extract: '<p>Lead.</p><h2>Parent</h2><p>Body.</p>' },
          ],
        },
      },
      expected: {
        title: 'Target',
        truncated: false,
        redirected_from: 'Alias',
        redirect_section: 'Parent',
        notice: `${TOC_UNAVAILABLE} ${unverifiedTarget('Parent')}`,
      },
      content: /^Lead\.\n\n== Parent ==\n\nBody\.$/,
    },
  ];

  /** Every way the lookup can fail upstream. Each leaves the read as an unavailable lookup does. */
  const TOC_FAILURES: Array<{ failure: string; respond: () => Response | Promise<Response> }> = [
    { failure: 'HTTP 400', respond: () => new Response('Bad Request', { status: 400 }) },
    { failure: 'HTTP 403', respond: () => new Response('Forbidden', { status: 403 }) },
    { failure: 'HTTP 404', respond: () => new Response('Not Found', { status: 404 }) },
    { failure: 'HTTP 410', respond: () => new Response('Gone', { status: 410 }) },
    {
      failure: 'HTTP 422',
      respond: () => new Response('Unprocessable Content', { status: 422 }),
    },
    {
      failure: 'HTTP 429 with a long Retry-After',
      respond: () =>
        new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '120' } }),
    },
    { failure: 'HTTP 500', respond: () => new Response('Server Error', { status: 500 }) },
    { failure: 'HTTP 503', respond: () => new Response('Unavailable', { status: 503 }) },
    { failure: 'a network failure', respond: () => Promise.reject(new TypeError('fetch failed')) },
    {
      failure: 'an HTML error page',
      respond: () =>
        new Response('<!DOCTYPE html><html><body>Wikimedia Error</body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    },
    {
      failure: 'an XML body',
      respond: () =>
        new Response('<?xml version="1.0"?><api><error code="maxlag"/></api>', {
          headers: { 'Content-Type': 'text/xml' },
        }),
    },
    { failure: 'a body that is not JSON', respond: () => new Response('upstream hiccup') },
    { failure: 'a JSON null body', respond: () => Response.json(null) },
    { failure: 'a JSON array body', respond: () => Response.json([]) },
    { failure: 'a body with no parse', respond: () => Response.json({ batchcomplete: true }) },
    { failure: 'a parse that is a string', respond: () => Response.json({ parse: 'Target' }) },
    {
      failure: 'TOC sections that are a string',
      respond: () => Response.json({ parse: { title: 'Target', tocdata: { sections: 'none' } } }),
    },
    {
      failure: 'a numeric section index',
      respond: () =>
        Response.json({
          parse: {
            title: 'Target',
            tocdata: { sections: [{ line: 'Parent', anchor: 'Parent', index: 7 }] },
          },
        }),
    },
    {
      failure: 'a numeric anchor',
      respond: () =>
        Response.json({
          parse: {
            title: 'Target',
            tocdata: { sections: [{ line: 'Parent', anchor: 7, index: '7' }] },
          },
        }),
    },
    {
      failure: 'an invalidtitle envelope',
      respond: () =>
        Response.json({ error: { code: 'invalidtitle', info: 'Bad title "Target".' } }),
    },
    {
      failure: 'a missingtitle envelope',
      respond: () =>
        Response.json({
          error: { code: 'missingtitle', info: "The page you specified doesn't exist." },
        }),
    },
    {
      failure: 'a ratelimited envelope',
      respond: () => Response.json({ error: { code: 'ratelimited', info: 'Slow down.' } }),
    },
    {
      failure: 'an unrecognized envelope',
      respond: () =>
        Response.json({
          error: { code: 'internal_api_error_DBQueryError', info: 'Database error' },
        }),
    },
  ];

  describe.each(READS)('on $read', ({ input, query, expected, content }) => {
    it.each(TOC_FAILURES)(
      'answers as an unavailable lookup on $failure, after one attempt',
      async ({ respond }) => {
        vi.useFakeTimers();
        const startedAt = Date.now();
        const http = fullReadUpstream(query, respond);
        http.install();
        try {
          const pending = runToolContract(wikipediaGetArticle, input);
          await vi.runAllTimersAsync();
          const result = await pending;
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject(expected);
          expect(wikipediaGetArticle.output.parse(result.structuredContent).content).toMatch(
            content,
          );
          expect(trailer(result)).toBe(`\n\n> ${expected.notice}`);
          // One attempt, no retry, and no wait: the read settles when the lookup does.
          expect(actions(http.calls)).toEqual(['query', 'parse']);
          expect(Date.now() - startedAt).toBe(0);
        } finally {
          http.restore();
        }
      },
    );
  });

  it('propagates a caller cancellation from inside the lookup as RequestCancelled', async () => {
    const caller = new AbortController();
    const http = fullReadUpstream(READS[0]!.query, () => {
      caller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    http.install();
    try {
      const result = await runToolContract(
        wikipediaGetArticle,
        { title: 'Target' },
        { context: { signal: caller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RequestCancelled,
          message: expect.stringContaining('was aborted'),
        },
      });
      expect(contentText(result)).toContain('was aborted');
      expect(contentText(result)).not.toContain(TOC_UNAVAILABLE);
      expect(actions(http.calls)).toEqual(['query', 'parse']);
    } finally {
      http.restore();
    }
  });

  it('reports a read answered with a non-JSON 200 body as a fixed ServiceUnavailable carrying none of it', async () => {
    vi.useFakeTimers();
    const body =
      '<?xml version="1.0" encoding="utf-8"?><api servedby="mw-api-ext"><error code="maxlag" info="Waiting for db1234"/></api>';
    const http = createFetchMock([
      {
        match: actionIs('query'),
        respond: () => new Response(body, { headers: { 'Content-Type': 'text/xml' } }),
      },
    ]);
    http.install();
    try {
      const pending = runToolContract(wikipediaGetArticle, { title: 'Target' });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: `${NOT_JSON} (failed after 4 attempts)`,
        },
      });
      expect(contentText(result)).toContain(NOT_JSON);
      const surfaces = JSON.stringify(result);
      for (const fragment of ['<?xml', 'version=', 'servedby', 'maxlag', 'db1234'])
        expect(surfaces).not.toContain(fragment);
      expect(http.calls).toHaveLength(4);
    } finally {
      http.restore();
    }
  });

  it('reads the section an alias targets back from content[] as structuredContent carries it', async () => {
    const section = '*Seine* _flood_ [1](x) `code` <b>\n# Aftermath';
    const http = fullReadUpstream(
      {
        query: {
          redirects: [{ from: 'Alias', to: 'Target', tofragment: section }],
          pages: [
            { pageid: 7, title: 'Target', extract: '<p>Lead.</p><h2>Parent</h2><p>Body.</p>' },
          ],
        },
      },
      () =>
        Response.json({
          parse: {
            title: 'Target',
            tocdata: { sections: [{ line: 'Parent', anchor: 'Parent', index: '1' }] },
          },
        }),
    );
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, { title: 'Alias' });
      const notice = unverifiedTarget(section);
      expect(result.structuredContent).toMatchObject({ redirect_section: section, notice });
      expect(readBackText(trailer(result))).toBe(notice);
    } finally {
      http.restore();
    }
  });

  it('renders the notice through the shared quoted-notice renderer', () => {
    expect(wikipediaGetArticle.enrichmentTrailer?.notice?.render).toBe(quotedNotice);
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

function service() {
  initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
  return getWikipediaService();
}

/** The same-table sibling labels must pair only with the leaf in their own row. */
const TREE =
  '<table class="clade"><tr><td class="clade-label">Family</td><td class="clade-leaf"><table class="clade"><tr><td class="clade-label">Rosoideae</td><td class="clade-leaf"><table class="clade"><tr><td class="clade-label"></td><td class="clade-leaf">Roseae</td></tr><tr><td class="clade-label"></td><td class="clade-leaf">Rubeae</td></tr></table></td></tr><tr><td class="clade-slabel"></td></tr><tr><td class="clade-label">Dryadoideae</td><td class="clade-leaf">Dryadeae</td></tr></table></td></tr><tr><td class="clade-label"></td><td class="clade-leaf">outgroup</td></tr></table>';
const RENDERED_TREE =
  '```\n- Family\n  - Rosoideae\n    - Roseae\n    - Rubeae\n  - Dryadoideae\n    - Dryadeae\n- outgroup\n```';

describe('scientific rendering through real tool handlers (#68, #71)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('keeps an unparseable tree visible on both article surfaces', async () => {
    const svc = service();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: { title: 'Tree', revid: 42, text: '<h2>Tree</h2><table class="clade"></table>' },
    });
    const result = await wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: 'Tree', section_index: 1 }),
      createMockContext({ errors: wikipediaGetArticle.errors }),
    );
    expect(result.content).toBe('== Tree ==\n\n[table omitted: unparseable clade]');
    expect(renderText(result)).toContain('\\[table omitted: unparseable clade\\]');
    expect(result.truncated).toBe(false);
  });
  it('preserves tree indentation on both article surfaces without adding table ordinals', async () => {
    const svc = service();
    vi.spyOn(svc, 'actionGet').mockResolvedValue({
      parse: {
        title: 'Tree',
        revid: 42,
        text: `<h2>Tree</h2>${TREE}<table class="wikitable"><tr><th>H</th></tr><tr><td>X</td></tr></table>`,
      },
    });
    const read = (table_index?: number) =>
      wikipediaGetArticle.handler(
        wikipediaGetArticle.input.parse({ title: 'Tree', section_index: 1, table_index }),
        createMockContext({ errors: wikipediaGetArticle.errors }),
      );
    const result = await read();
    expect(result.content).toContain(RENDERED_TREE);
    expect(wikipediaGetArticle.format!(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining(RENDERED_TREE) }),
      ]),
    );
    expect(await read(1)).toMatchObject({ content: '| H |\n| --- |\n| X |', table_count: 1 });
    await expect(read(2)).rejects.toMatchObject({
      data: { reason: 'invalid_table', availableCount: 1 },
    });
  });
  it('normalizes index 19 through the service, both tools and verified redirects', async () => {
    const svc = service();
    const toc = {
      title: 'Carbon',
      pageid: 42,
      tocdata: {
        sections: [
          {
            index: '19',
            number: '4',
            hLevel: 2,
            line: 'CO<sub>2</sub> fertilization effect',
            anchor: 'CO2_fertilization_effect',
          },
        ],
      },
    };
    vi.spyOn(svc, 'actionGet').mockImplementation(async (_language, params) =>
      params.prop?.startsWith('tocdata')
        ? { parse: toc }
        : {
            parse: {
              title: 'Carbon',
              revid: 1375796469,
              text: '<h2>CO<sub>2</sub> fertilization effect</h2><p>Body.</p>',
            },
          },
    );
    const sections = await wikipediaGetSections.handler(
      wikipediaGetSections.input.parse({ title: 'Carbon' }),
      createMockContext({ errors: wikipediaGetSections.errors }),
    );
    expect(sections.sections[1]).toMatchObject({ index: 19, title: 'CO₂ fertilization effect' });
    expect(wikipediaGetSections.format!(sections)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('CO₂ fertilization effect'),
        }),
      ]),
    );
    const article = await wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: 'Carbon', section_index: 19 }),
      createMockContext({ errors: wikipediaGetArticle.errors }),
    );
    expect(article).toMatchObject({
      section_title: 'CO₂ fertilization effect',
      revision_id: '1375796469',
    });
    expect(wikipediaGetArticle.format!(article)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('CO₂ fertilization effect'),
        }),
      ]),
    );
    expect(redirectInfo([{ from: 'Alias', tofragment: 'CO2_fertilization_effect' }], toc)).toEqual({
      redirected_from: 'Alias',
      redirect_section: 'CO₂ fertilization effect',
      redirect_section_index: 19,
    });
  });

  it('indexes scientific overflow headings uniquely and retains citations on both surfaces', async () => {
    const svc = service();
    const toc = {
      title: 'Carbon',
      tocdata: {
        sections: [
          { index: '19', line: 'CO<sub>2</sub> fertilization effect' },
          { index: '20', line: 'N<sub>A</sub>' },
          { index: '21', line: 'N<sub>A</sub>' },
          { index: 'not numeric', line: 'x<sup>n</sup>' },
        ],
      },
    };
    const extract = `<h2>CO<sub>2</sub> fertilization effect</h2><p>${'body '.repeat(17000)}</p><h2>N<sub>A</sub></h2><p>A.</p><h2>x<sup>n</sup></h2><p>B.</p><h2>Absent<sub>2</sub></h2><p>C.</p>`;
    vi.spyOn(svc, 'actionGet').mockImplementation(async (_language, params) =>
      params.prop === 'tocdata'
        ? { parse: toc }
        : {
            query: {
              pages: [
                {
                  title: 'Carbon',
                  pageid: 42,
                  extract,
                  fullurl: 'https://en.wikipedia.org/wiki/Carbon',
                  revisions: [{ revid: 1375796469, timestamp: '2026-10-01T00:00:00Z' }],
                },
              ],
            },
          },
    );
    const result = await wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: 'Carbon' }),
      createMockContext({ errors: wikipediaGetArticle.errors }),
    );
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('(section_index: 19)');
    expect(result.content).toMatch(
      /^- CO₂ fertilization effect — \d+ bytes \(section_index: 19\)$/m,
    );
    for (const name of ['N_A', 'xⁿ', 'Absent₂'])
      expect(result.content).toContain(`- ${name} — 4 bytes\n`);
    expect(result).toMatchObject({
      revision_id: '1375796469',
      last_modified: '2026-10-01T00:00:00Z',
      url: 'https://en.wikipedia.org/wiki/Carbon',
    });
    const text = wikipediaGetArticle.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('CO₂ fertilization effect');
    expect(text).toContain('section\\_index: 19');
    expect(text).toContain('1375796469');
  });
});

describe('wikipediaGetArticle — disambiguation flag (issue #77)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const contentText = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('\n');
  const actionIs = (action: string) => (request: Request) =>
    new URL(request.url).searchParams.get('action') === action;
  const actions = (calls: readonly { request: Request }[]) =>
    calls.map((call) => new URL(call.request.url).searchParams.get('action'));

  const SECTION_PARSE = {
    parse: { title: 'Mercury', pageid: 19007, revid: 1376000001, text: '<p>Lead text.</p>' },
  };
  /** The section read HEAD returns for {@link SECTION_PARSE}: what every lookup outcome keeps. */
  const SECTION_READ = {
    title: 'Mercury',
    pageid: 19007,
    content: 'Lead text.',
    section_title: 'Introduction',
    content_type: 'section',
    truncated: false,
    revision_id: '1376000001',
    language: 'en',
  };
  const LOOKUP_UNAVAILABLE =
    'Whether this page is a disambiguation page could not be checked because the optional page-property lookup was unavailable. Call wikipedia_get_summary to check its page_type.';
  const FLAGGED = {
    query: { pages: [{ pageid: 19007, title: 'Mercury', pageprops: { disambiguation: '' } }] },
  };
  const UNFLAGGED = { query: { pages: [{ pageid: 19007, title: 'Mercury' }] } };

  /** A section read whose parse answers {@link SECTION_PARSE} and whose lookup answers `lookup`. */
  function sectionUpstream(
    lookup: Response | ((request: Request) => Response | Promise<Response>),
  ) {
    return createFetchMock([
      { match: actionIs('parse'), respond: Response.json(SECTION_PARSE) },
      { match: actionIs('query'), respond: lookup },
    ]);
  }

  it('characterizes the section read that a lookup outcome other than a flag leaves unchanged', async () => {
    const http = sectionUpstream(Response.json(UNFLAGGED));
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, {
        title: 'Mercury',
        section_index: 0,
      });
      expect(result.structuredContent).toEqual(SECTION_READ);
      expect(contentText(result)).not.toContain('disambiguation');
      expect(contentText(result)).not.toContain('Page type');
    } finally {
      http.restore();
    }
  });

  it('flags a section_index 0 read of a disambiguation page on both surfaces with one added request', async () => {
    const http = sectionUpstream(Response.json(FLAGGED));
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, {
        title: 'Mercury',
        section_index: 0,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ ...SECTION_READ, page_type: 'disambiguation' });
      const notice = String(structured.notice);
      expect(notice).toContain('disambiguation page');
      expect(notice).toContain('wikipedia_search_articles');
      const rendered = contentText(result);
      expect(rendered).toContain('**Page type:** disambiguation');
      expect(rendered).toContain(`> ${notice}`);
      expect(actions(http.calls)).toEqual(['parse', 'query']);
      expect(Object.fromEntries(new URL(http.calls[1]!.request.url).searchParams)).toMatchObject({
        titles: 'Mercury',
        prop: 'pageprops',
        ppprop: 'disambiguation',
      });
    } finally {
      http.restore();
    }
  });

  it('flags a table read through the same lookup', async () => {
    const http = createFetchMock([
      {
        match: actionIs('parse'),
        respond: Response.json({
          parse: {
            title: 'Mercury',
            revid: 42,
            text: '<table class="wikitable"><tr><th>Name</th></tr><tr><td>Planet</td></tr></table>',
          },
        }),
      },
      { match: actionIs('query'), respond: Response.json(FLAGGED) },
    ]);
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, {
        title: 'Mercury',
        section_index: 1,
        table_index: 1,
      });
      expect(result.structuredContent).toMatchObject({
        table_index: 1,
        content: '| Name |\n| --- |\n| Planet |',
        page_type: 'disambiguation',
      });
      expect(actions(http.calls)).toEqual(['parse', 'query']);
    } finally {
      http.restore();
    }
  });

  it('flags a full read from page props on its one request, and leaves an ordinary one unflagged', async () => {
    for (const [pageprops, flagged] of [
      [{ disambiguation: '' }, true],
      [undefined, false],
    ] as const) {
      const http = createFetchMock([
        {
          match: actionIs('query'),
          respond: Response.json({
            query: {
              pages: [
                {
                  pageid: 19007,
                  title: 'Mercury',
                  extract: '<p>Mercury most commonly refers to:</p>',
                  ...(pageprops && { pageprops }),
                },
              ],
            },
          }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(wikipediaGetArticle, { title: 'Mercury' });
        expect(http.calls).toHaveLength(1);
        const params = new URL(http.calls[0]!.request.url).searchParams;
        expect(params.get('prop')).toBe('extracts|info|revisions|pageprops');
        expect(params.get('ppprop')).toBe('disambiguation');
        const rendered = contentText(result);
        if (flagged) {
          expect(result.structuredContent).toMatchObject({
            content_type: 'full_article',
            page_type: 'disambiguation',
            notice: expect.stringContaining('disambiguation page'),
          });
          expect(rendered).toContain('**Page type:** disambiguation');
          expect(rendered).toContain('wikipedia_search_articles');
        } else {
          expect(result.structuredContent).not.toHaveProperty('page_type');
          expect(result.structuredContent).not.toHaveProperty('notice');
          expect(rendered).not.toContain('disambiguation');
        }
      } finally {
        http.restore();
      }
    }
  });

  it('joins the disambiguation notice with the TOC-unavailable notice on an outlined read', async () => {
    vi.useFakeTimers();
    const http = createFetchMock([
      {
        match: actionIs('query'),
        respond: Response.json({
          query: {
            pages: [
              {
                title: 'Mercury',
                pageprops: { disambiguation: '' },
                extract: `<p>${'Lead '.repeat(20000)}</p><h2>Places</h2><p>Body.</p>`,
              },
            ],
          },
        }),
      },
      {
        match: actionIs('parse'),
        respond: Response.json({ error: { code: 'ratelimited', info: 'Temporarily unavailable' } }),
      },
    ]);
    http.install();
    try {
      const pending = runToolContract(wikipediaGetArticle, { title: 'Mercury' });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        page_type: 'disambiguation',
      });
      const notice = String((result.structuredContent as Record<string, unknown>).notice);
      expect(notice).toContain('disambiguation page');
      expect(notice).toContain('optional table of contents lookup was unavailable');
      expect(contentText(result)).toContain(`> ${notice}`);
    } finally {
      http.restore();
    }
  });

  it.each([
    { failure: 'a 404', respond: () => new Response('Not Found', { status: 404 }) },
    { failure: 'a 403', respond: () => new Response('Forbidden', { status: 403 }) },
    {
      failure: 'a 429 with Retry-After',
      respond: () =>
        new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } }),
    },
    { failure: 'a 400', respond: () => new Response('Bad Request', { status: 400 }) },
    { failure: 'a 500', respond: () => new Response('Server Error', { status: 500 }) },
    { failure: 'a 503', respond: () => new Response('Unavailable', { status: 503 }) },
    {
      failure: 'an HTML body',
      respond: () =>
        new Response('<!DOCTYPE html><html><body>Wikimedia Error</body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    },
    { failure: 'a non-JSON body', respond: () => new Response('not json') },
    { failure: 'a JSON null', respond: () => Response.json(null) },
    { failure: 'a body with no pages', respond: () => Response.json({ batchcomplete: true }) },
    {
      failure: 'pages of the wrong type',
      respond: () => Response.json({ query: { pages: 'Mercury' } }),
    },
    {
      failure: 'page props of the wrong type',
      respond: () =>
        Response.json({ query: { pages: [{ title: 'Mercury', pageprops: 'disambiguation' }] } }),
    },
    {
      failure: 'an error envelope',
      respond: () =>
        Response.json({
          error: { code: 'internal_api_error_DBQueryError', info: 'Database error' },
        }),
    },
    {
      failure: 'a transient envelope',
      respond: () => Response.json({ error: { code: 'ratelimited', info: 'Slow down' } }),
    },
    {
      failure: 'a missing page',
      respond: () => Response.json({ query: { pages: [{ title: 'Mercury', missing: true }] } }),
    },
    {
      failure: 'a network failure',
      respond: (): Response => {
        throw new TypeError('fetch failed');
      },
    },
  ])(
    'returns the section read unflagged with the unavailability notice on $failure',
    async ({ respond }) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const http = sectionUpstream(respond);
      http.install();
      try {
        const pending = runToolContract(wikipediaGetArticle, {
          title: 'Mercury',
          section_index: 0,
        });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ ...SECTION_READ, notice: LOOKUP_UNAVAILABLE });
        const rendered = contentText(result);
        expect(rendered).toContain(`> ${LOOKUP_UNAVAILABLE}`);
        expect(rendered).not.toContain('Page type');
        // One attempt, no retry, and no wait: the read settles when the parse does.
        expect(actions(http.calls)).toEqual(['parse', 'query']);
        expect(Date.now() - startedAt).toBe(0);
      } finally {
        http.restore();
      }
    },
  );

  it('gives up on a stalled lookup at its own 5 s budget and returns the read unflagged', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let lookupSignal: AbortSignal | undefined;
    const http = sectionUpstream(
      (request) =>
        new Promise<Response>((_, reject) => {
          lookupSignal = request.signal;
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    );
    http.install();
    try {
      const pending = runToolContract(wikipediaGetArticle, { title: 'Mercury', section_index: 0 });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.structuredContent).toEqual({ ...SECTION_READ, notice: LOOKUP_UNAVAILABLE });
      // The parse answered at once; the read waited exactly the lookup's budget, well inside the
      // 15 s per-request timeout and the 30 s request deadline the parse runs under.
      expect(Date.now() - startedAt).toBe(5_000);
      expect(lookupSignal?.aborted).toBe(true);
      expect(actions(http.calls)).toEqual(['parse', 'query']);
    } finally {
      http.restore();
    }
  });

  it('propagates a caller cancellation that lands while the lookup is in flight', async () => {
    const caller = new AbortController();
    const http = createFetchMock([
      {
        match: actionIs('parse'),
        respond: (request) =>
          new Promise<Response>((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      },
      {
        match: actionIs('query'),
        respond: () => {
          caller.abort();
          throw new DOMException('Stop the lookup', 'AbortError');
        },
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(
        wikipediaGetArticle,
        { title: 'Mercury', section_index: 0 },
        { context: { signal: caller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RequestCancelled,
          message: expect.stringContaining('was aborted'),
        },
      });
      expect(contentText(result)).toContain('was aborted');
      expect(contentText(result)).not.toContain(LOOKUP_UNAVAILABLE);
      expect(actions(http.calls).sort()).toEqual(['parse', 'query']);
    } finally {
      http.restore();
    }
  });

  it('propagates a caller cancellation that lands in the parse while the lookup stalls', async () => {
    const caller = new AbortController();
    const http = createFetchMock([
      {
        match: actionIs('parse'),
        respond: () => {
          caller.abort();
          throw new DOMException('Stop the parse', 'AbortError');
        },
      },
      {
        match: actionIs('query'),
        respond: (request) =>
          new Promise<Response>((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(
        wikipediaGetArticle,
        { title: 'Mercury', section_index: 0 },
        { context: { signal: caller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RequestCancelled,
          message: expect.stringContaining('was aborted'),
        },
      });
      expect(contentText(result)).toContain('was aborted');
      expect(actions(http.calls).filter((action) => action === 'parse')).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

describe('wikipediaGetArticle — titles that name no page through the real service (issue #87)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService({} as AppConfig, fakeStorage(), 'test', 'https://en.wikipedia.org');
  });

  const MESSAGE =
    '"Special:Random" is not a valid Wikipedia page name. Special: and Media: titles, in any edition\'s spelling, name no page; a file\'s description page is in the File: namespace.';
  const RECOVERY =
    'Use wikipedia_search_articles to find the exact article title and pass it verbatim.';
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('');

  it.each([
    { read: 'a full read', input: { title: 'Special:Random' } },
    { read: 'a section read', input: { title: 'Special:Random', section_index: 1 } },
  ])(
    'refuses Special:Random on $read as invalid_title with the declared recovery',
    async ({ input }) => {
      // The live answers: `action=parse` refuses the namespace, `action=query` marks the entry special.
      const http = createFetchMock([
        {
          match: (request) => new URL(request.url).searchParams.get('action') === 'parse',
          respond: () =>
            Response.json({
              error: { code: 'pagecannotexist', info: "Namespace doesn't allow actual pages." },
            }),
        },
        {
          match: (request) => new URL(request.url).searchParams.get('action') === 'query',
          respond: () =>
            Response.json({
              query: { pages: [{ ns: -1, title: 'Special:Random', special: true }] },
            }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(wikipediaGetArticle, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            message: MESSAGE,
            data: {
              title: 'Special:Random',
              reason: 'invalid_title',
              recovery: { hint: RECOVERY },
            },
          },
        });
        expect(text(result)).toBe(
          `Error: ${MESSAGE}\n\nRecovery: ${RECOVERY}\n\n(reason invalid_title)`,
        );
      } finally {
        http.restore();
      }
    },
  );
});
