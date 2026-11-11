/**
 * @fileoverview Tests for wikipedia_get_sections tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-sections.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetSections } from '@/mcp-server/tools/definitions/wikipedia-get-sections.tool.js';
import { initWikipediaService } from '@/services/wikipedia/wikipedia-service.js';
import { parseInlineText } from '../../../helpers/commonmark.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

const mockSections = {
  title: 'Python (programming language)',
  pageid: 23862,
  sections: [
    { index: 1, number: '1', title: 'History', level: 2 },
    { index: 2, number: '2', title: 'Design philosophy', level: 2 },
    { index: 3, number: '2.1', title: 'Syntax', level: 3 },
  ],
  categories: [],
  disambiguation: false,
};

describe('wikipediaGetSections', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('returns sections for a valid article', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue(mockSections),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSections.handler(input, ctx);

    // The upstream table of contents, unchanged, behind the lead entry.
    expect(result.sections.slice(1)).toEqual(mockSections.sections);
    expect(result.total_sections).toBe(4);
    expect(result.pageid).toBe(23862);
  });

  it('lists the lead as index 0 so wikipedia_get_article can reach it (issue #40)', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue(mockSections),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSections.handler(input, ctx);

    // The two tools agree about the lead: the index reported here is the one the read path takes.
    expect(result.sections[0]).toEqual({
      index: 0,
      number: '0',
      title: 'Introduction',
      level: 1,
    });
    expect(result.total_sections).toBe(result.sections.length);

    const text = wikipediaGetSections.format!(wikipediaGetSections.output.parse(result))
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('Introduction');
    expect(text).toContain('index: 0');
  });

  it('refuses a title MediaWiki cannot name a page with, before any call (issue #42)', async () => {
    const getSectionsFn = vi.fn();
    mockWikipediaService({ getSections: getSectionsFn });

    for (const title of ['Cat|Dog', 'Foo[bar]', 'A{b}']) {
      const ctx = createMockContext({ errors: wikipediaGetSections.errors });
      const rejection = await Promise.resolve(
        wikipediaGetSections.handler(wikipediaGetSections.input.parse({ title }), ctx),
      ).then(
        () => undefined,
        (err: unknown) => err as { message: string; data: { reason: string } },
      );

      expect(rejection?.data.reason).toBe('invalid_title');
      expect(rejection?.message).not.toMatch(/https?:\/\//);
    }
    expect(getSectionsFn).not.toHaveBeenCalled();
  });

  it('accepts a fragment title and titles that only look illegal (issue #42)', async () => {
    const getSectionsFn = vi.fn().mockResolvedValue(mockSections);
    mockWikipediaService({ getSections: getSectionsFn });

    for (const title of ['Python (programming language)#History', '100% Cat', 'A_B', ':Cat']) {
      const ctx = createMockContext({ errors: wikipediaGetSections.errors });
      await wikipediaGetSections.handler(wikipediaGetSections.input.parse({ title }), ctx);
      expect(getSectionsFn).toHaveBeenCalledWith(title, 'en', ctx);
    }
  });

  it('carries a cleaned section title into structuredContent and content[] (issue #36)', async () => {
    // The service normalizes the tocdata `line` before the handler sees it; what this pins is that
    // the output schema passes the cleaned bytes through untouched and format() renders them as
    // themselves — markdown-escaped per issue #43, never re-encoded as an HTML entity.
    const cleaned = 'Siglo XVIII & pasos';
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue({
        title: 'Semana Santa en Sevilla',
        pageid: 1174639,
        sections: [{ index: 33, number: '5.2', title: cleaned, level: 3 }],
        categories: [],
        disambiguation: false,
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({
      title: 'Semana Santa en Sevilla',
      language: 'es',
    });
    // structuredContent is the parsed output, not the raw handler return.
    const structured = wikipediaGetSections.output.parse(
      await wikipediaGetSections.handler(input, ctx),
    );
    expect(structured.sections.find((s) => s.index === 33)?.title).toBe(cleaned);

    const text = wikipediaGetSections.format!(structured)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('Siglo XVIII \\& pasos');
    expect(text).not.toContain('&amp;');
    expect(text).not.toMatch(/[<> ]/);
  });

  it('throws no_sections when article has no sections', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue({ title: 'Stub Article', pageid: 1, sections: [] }),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Stub Article' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_sections' },
    });
  });

  it('format renders section indices, levels, and titles', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      sections: [
        { index: 1, number: '1', title: 'History', level: 2 },
        { index: 2, number: '2', title: 'Design', level: 2 },
      ],
      total_sections: 2,
      language: 'en',
      categories: [],
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('History');
    expect(text).toContain('Design');
    expect(text).toContain('index: 1');
    expect(text).toContain('index: 2');
    expect(text).toContain('2 sections');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python', language: 'INVALID!!' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python', language: 'zz' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws not_found with data.reason when article is missing (issue #12)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockWikipediaService({
      getSections: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found with data.reason for a blank title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: '' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found with data.reason for a whitespace-only title (issue #20)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: '   ' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('surfaces the redirect-resolved title in output (issue #19)', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue({
        title: 'New York City',
        pageid: 645042,
        sections: [{ index: 1, number: '1', title: 'Etymology', level: 2 }],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    // Caller passes the alias "NYC"; output should carry the resolved article title.
    const input = wikipediaGetSections.input.parse({ title: 'NYC' });
    const result = await wikipediaGetSections.handler(input, ctx);
    expect(result.title).toBe('New York City');
    // One heading upstream plus the lead entry.
    expect(result.total_sections).toBe(2);
  });

  it('passes non-default language to service', async () => {
    const getSectionsFn = vi.fn().mockResolvedValue({
      title: 'Python (langage)',
      pageid: 9999,
      sections: [{ index: 1, number: '1', title: 'Histoire', level: 2 }],
    });
    mockWikipediaService({
      getSections: getSectionsFn,
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetSections.handler(input, ctx);

    expect(getSectionsFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.language).toBe('fr');
  });

  it('total_sections matches sections array length', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockResolvedValue(mockSections),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSections.handler(input, ctx);

    expect(result.total_sections).toBe(result.sections.length);
  });

  it('format renders nested section hierarchy with indentation', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      sections: [
        { index: 1, number: '1', title: 'History', level: 2 },
        { index: 2, number: '2', title: 'Design', level: 2 },
        { index: 3, number: '2.1', title: 'Syntax', level: 3 },
      ],
      total_sections: 3,
      language: 'en',
      categories: [],
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Syntax');
    expect(text).toContain('2.1');
    expect(text).toContain('3 sections');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      title: 'Python',
      pageid: 1,
      sections: [{ index: 1, number: '1', title: 'Intro', level: 2 }],
      total_sections: 1,
      language: 'en',
      categories: [],
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('non-McpError from service propagates without wrapping', async () => {
    mockWikipediaService({
      getSections: vi.fn().mockRejectedValue(new Error('Network failure')),
    });

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toThrow('Network failure');
  });

  it('escapes markdown-active upstream titles in format() and leaves the structured values raw (issue #43)', () => {
    const output = {
      title: 'HTML <element>',
      pageid: 13782,
      sections: [
        { index: 0, number: '0', title: 'Introduction', level: 1 },
        { index: 1, number: '1', title: 'The <script> tag and _emphasis_', level: 2 },
      ],
      total_sections: 2,
      language: 'en',
      categories: [],
    };
    const text = wikipediaGetSections.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(text).toContain('HTML \\<element\\>');
    expect(text).toContain('The \\<script\\> tag and \\_emphasis\\_');
    expect(text).not.toContain('<script>');
    expect(output.sections[1]?.title).toBe('The <script> tag and _emphasis_');
  });
});

describe('wikipediaGetSections — categories and the disambiguation flag (issues #77, #83)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService(
      {} as AppConfig,
      createInMemoryStorage(),
      'test',
      'https://en.wikipedia.org',
    );
  });

  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? '').join('\n');
  const actionIs = (action: string) => (request: Request) =>
    new URL(request.url).searchParams.get('action') === action;

  /** A sections read answered by one `action=parse` body, plus a full read for the fallback. */
  function upstream(parse: Record<string, unknown>, extract?: string) {
    return createFetchMock([
      { match: actionIs('parse'), respond: Response.json({ parse }) },
      ...(extract === undefined
        ? []
        : [
            {
              match: actionIs('query'),
              respond: Response.json({
                query: { pages: [{ pageid: 1, title: String(parse.title), extract }] },
              }),
            },
          ]),
    ]);
  }

  const TOC = { sections: [{ hLevel: 2, line: 'Companies', number: '1', index: '1' }] };

  it('flags a disambiguation page and lists its visible categories on both surfaces', async () => {
    const http = upstream({
      title: 'Mercury',
      pageid: 19007,
      tocdata: TOC,
      categories: [
        { sortkey: '', category: 'All_disambiguation_pages', hidden: true },
        { sortkey: '', category: 'Disambiguation_pages' },
        { sortkey: '', category: 'Place_name_disambiguation_pages' },
      ],
      properties: { disambiguation: '', wikibase_item: 'Q48397' },
    });
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Mercury' });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        title: 'Mercury',
        page_type: 'disambiguation',
        categories: ['Disambiguation pages', 'Place name disambiguation pages'],
      });
      const notice = String(structured.notice);
      expect(notice).toContain('disambiguation page');
      expect(notice).toContain('wikipedia_search_articles');
      expect(notice).toContain('wikipedia_get_article');

      const rendered = text(result);
      expect(rendered).toContain('**Page type:** disambiguation');
      expect(rendered).toContain(`> ${notice}`);
      expect(parseInlineText(rendered)).toEqual(
        expect.arrayContaining(['Disambiguation pages', 'Place name disambiguation pages']),
      );
      expect(http.calls).toHaveLength(1);
      expect(new URL(http.calls[0]!.request.url).searchParams.get('prop')).toBe(
        'tocdata|categories|properties',
      );
    } finally {
      http.restore();
    }
  });

  it('leaves an ordinary article unflagged, with no notice, and still lists its categories', async () => {
    const http = upstream({
      title: 'Eiffel Tower',
      pageid: 9232,
      tocdata: TOC,
      categories: [
        { sortkey: '', category: 'Articles_with_short_description', hidden: true },
        { sortkey: '', category: 'Towers_in_Paris' },
      ],
      properties: { wikibase_item: 'Q243' },
    });
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Eiffel Tower' });
      expect(result.structuredContent).toMatchObject({ categories: ['Towers in Paris'] });
      expect(result.structuredContent).not.toHaveProperty('page_type');
      expect(result.structuredContent).not.toHaveProperty('notice');
      const rendered = text(result);
      expect(rendered).not.toContain('Page type');
      expect(rendered).not.toContain('disambiguation');
      expect(parseInlineText(rendered)).toContain('Towers in Paris');
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('returns categories: [] on both surfaces for an article that has none', async () => {
    const http = upstream({ title: 'Bare', tocdata: TOC });
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Bare' });
      expect(result.structuredContent).toMatchObject({ categories: [] });
      expect(text(result)).toContain('**Categories:** none');
    } finally {
      http.restore();
    }
  });

  it('reads category names with Markdown-significant characters back unchanged from content[]', async () => {
    const names = [
      '"Weird Al" Yankovic',
      'C*star* systems',
      'Lists of [bracketed] things',
      '`Backticked` things',
      '1. FC Köln players',
      '- Leading dash',
      'Christina, Queen of Sweden',
      'A & B <tags> #hash ~tilde |pipe \\backslash',
    ];
    const http = upstream({
      title: 'Punctuation',
      tocdata: TOC,
      categories: names.map((name) => ({ sortkey: '', category: name.replaceAll(' ', '_') })),
    });
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Punctuation' });
      expect(result.structuredContent).toMatchObject({ categories: names });
      const inline = parseInlineText(text(result));
      for (const name of names) expect(inline).toContain(name);
    } finally {
      http.restore();
    }
  });

  it('returns the redirect target’s categories for an alias', async () => {
    const http = upstream({
      title: 'New York City',
      pageid: 645042,
      redirects: [{ from: 'NYC', to: 'New York City' }],
      tocdata: TOC,
      categories: [{ sortkey: '', category: 'Cities_in_New_York_(state)' }],
      properties: {},
    });
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'NYC' });
      expect(result.structuredContent).toMatchObject({
        title: 'New York City',
        redirected_from: 'NYC',
        categories: ['Cities in New York (state)'],
      });
      expect(result.structuredContent).not.toHaveProperty('page_type');
    } finally {
      http.restore();
    }
  });

  it('names a headingless disambiguation page in no_sections and points to search (Libby Creek)', async () => {
    const http = upstream(
      {
        title: 'Libby Creek',
        pageid: 4567,
        tocdata: { sections: [] },
        categories: [{ sortkey: '', category: 'Disambiguation_pages' }],
        properties: { disambiguation: '' },
      },
      '<p>Libby Creek may refer to:</p><ul><li>Libby Creek (Wyoming)</li><li>Libby Creek (Washington)</li></ul>',
    );
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Libby Creek' });
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_sections',
          recovery: { hint: expect.stringContaining('wikipedia_search_articles') },
        },
      });
      expect(error.message).toContain('disambiguation page');
      expect(error.message).not.toContain('stub');
      const rendered = text(result);
      expect(rendered).toContain('disambiguation page');
      expect(rendered).toContain('wikipedia_search_articles');
      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });

  it('keeps the stub wording of no_sections for a headingless page that is not a disambiguation page', async () => {
    const http = upstream(
      { title: 'Stubby', pageid: 42, tocdata: { sections: [] } },
      '<p>A short article.</p>',
    );
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title: 'Stubby' });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'Article "Stubby" exists but has no sections. It may be a stub.',
          data: {
            reason: 'no_sections',
            recovery: {
              hint: 'Use wikipedia_get_article without section_index to read the full article content.',
            },
          },
        },
      });
    } finally {
      http.restore();
    }
  });

  it('declares no_sections for the headingless disambiguation page as well as the stub', () => {
    const entry = wikipediaGetSections.errors?.find((e) => e.reason === 'no_sections');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.when).toContain('disambiguation page');
    expect(entry?.recovery).toContain('wikipedia_search_articles');
  });
});

describe('wikipediaGetSections — titles that name no page through the real service (issue #87)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initWikipediaService(
      {} as AppConfig,
      createInMemoryStorage(),
      'test',
      'https://de.wikipedia.org',
    );
  });

  it('refuses Spezial:Zufällige Seite as invalid_title with the declared recovery', async () => {
    const title = 'Spezial:Zufällige Seite';
    const message = `"${title}" is not a valid Wikipedia page name. Special: and Media: titles, in any edition's spelling, name no page; a file's description page is in the File: namespace.`;
    const recovery =
      'Use wikipedia_search_articles to find the exact article title and pass it verbatim.';
    // The live answer on every edition: `action=parse` refuses the namespace outright.
    const http = createFetchMock([
      {
        match: (request) => new URL(request.url).searchParams.get('action') === 'parse',
        respond: () =>
          Response.json({
            error: { code: 'pagecannotexist', info: "Namespace doesn't allow actual pages." },
          }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(wikipediaGetSections, { title, language: 'de' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { title, reason: 'invalid_title', recovery: { hint: recovery } },
        },
      });
      expect(result.content.map((block) => ('text' in block ? block.text : '')).join('')).toBe(
        `Error: ${message}\n\nRecovery: ${recovery}\n\n(reason invalid_title)`,
      );
    } finally {
      http.restore();
    }
  });
});
