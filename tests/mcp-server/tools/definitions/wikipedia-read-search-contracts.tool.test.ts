/** @fileoverview Contract regressions for summary, redirects, outlines, and search controls. */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import { wikipediaGetSections } from '@/mcp-server/tools/definitions/wikipedia-get-sections.tool.js';
import { wikipediaGetSummary } from '@/mcp-server/tools/definitions/wikipedia-get-summary.tool.js';
import { wikipediaSearchArticles } from '@/mcp-server/tools/definitions/wikipedia-search-articles.tool.js';
import { wikipediaSearchNearby } from '@/mcp-server/tools/definitions/wikipedia-search-nearby.tool.js';
import {
  getWikipediaService,
  initWikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';

beforeEach(() => {
  vi.restoreAllMocks();
  initWikipediaService({} as AppConfig, createInMemoryStorage(), 'test', 'https://example.org');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

function expectActionRequests(calls: readonly { request: Request }[], action: string): void {
  for (const { request } of calls) {
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.origin).toBe('https://example.org');
    expect(url.pathname).toBe('/w/api.php');
    expect(url.searchParams.get('action')).toBe(action);
    expect(request.headers.get('User-Agent')).toBe('test');
    expect(request.headers.get('accept')).toBe('application/json');
  }
}

const tableRequest = { title: 'Tables', language: 'en', section_index: 1, table_index: 1 };
const tableCursor = {
  kind: 'wikipedia_table_v1',
  title: 'Tables',
  language: 'en',
  sectionIndex: 1,
  tableIndex: 1,
  revisionId: 42,
  offset: 1,
  limit: 40000,
};

it('propagates caller cancellation through a pinned table fetch without restarting (#67)', async () => {
  const caller = new AbortController();
  const http = createFetchMock([
    {
      match: () => true,
      respond: () => {
        caller.abort();
        throw new DOMException('Stop table read', 'AbortError');
      },
    },
  ]);
  http.install();
  try {
    const result = await runToolContract(
      wikipediaGetArticle,
      { ...tableRequest, cursor: encodeCursor(tableCursor) },
      { context: { signal: caller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(text(result)).toContain('was aborted');
    expect(http.calls).toHaveLength(1);
    expectActionRequests(http.calls, 'parse');
    expect(new URL(http.calls[0]!.request.url).searchParams.get('oldid')).toBe('42');
  } finally {
    http.restore();
  }
});

it.each([
  { input: { title: 'Tables', table_index: 1 }, reason: 'invalid_table' },
  { input: { title: 'Tables', section_index: 1, cursor: 'bad' }, reason: 'invalid_table' },
  ...[
    'bad',
    encodeCursor({ ...tableCursor, offset: 1.5 }),
    encodeCursor({ ...tableCursor, revisionId: 0 }),
    encodeCursor({ ...tableCursor, title: 'Other' }),
    encodeCursor({ ...tableCursor, language: 'fr' }),
    encodeCursor({ ...tableCursor, sectionIndex: 2 }),
    encodeCursor({ ...tableCursor, tableIndex: 2 }),
    encodeCursor({ ...tableCursor, limit: 100 }),
    encodeCursor({ ...tableCursor, extra: true }),
  ].map((cursor) => ({ input: { ...tableRequest, cursor }, reason: 'invalid_cursor' })),
])('rejects $reason before any upstream call on both surfaces (#67)', async ({ input, reason }) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await runToolContract(wikipediaGetArticle, input);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ValidationError,
      data: { reason, recovery: { hint: expect.stringContaining('table_index') } },
    },
  });
  expect(text(result)).toContain(reason);
  expect(text(result)).toContain('table_index');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  {
    response: {
      parse: {
        title: 'Tables',
        revid: 42,
        text: '<table class="wikitable"><tr><th>H</th></tr></table>',
      },
    },
    input: { ...tableRequest, table_index: 2 },
    reason: 'invalid_table',
    code: JsonRpcErrorCode.ValidationError,
  },
  {
    response: {
      parse: {
        title: 'Tables',
        revid: 42,
        text: '<table class="wikitable"><tr><th>H</th></tr></table>',
      },
    },
    input: { ...tableRequest, cursor: encodeCursor({ ...tableCursor, offset: 999 }) },
    reason: 'invalid_cursor',
    code: JsonRpcErrorCode.ValidationError,
  },
  {
    response: { error: { code: 'nosuchrevid', info: 'missing' } },
    input: { ...tableRequest, cursor: encodeCursor(tableCursor) },
    reason: 'revision_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
  },
])(
  'renders service $reason with recovery on both surfaces (#67)',
  async ({ response, input, reason, code }) => {
    const http = createFetchMock([{ match: () => true, respond: () => Response.json(response) }]);
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code, data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(text(result)).toContain(reason);
      expect(text(result)).toContain('Recovery:');
      expect(http.calls).toHaveLength(1);
      expectActionRequests(http.calls, 'parse');
      expect(new URL(http.calls[0]!.request.url).searchParams.get('section')).toBe('1');
    } finally {
      http.restore();
    }
  },
);

it('carries paged rows, revision, cursor and oversize disclosure on both surfaces (#67)', async () => {
  const value = 'é_*'.repeat(7000);
  const html = `<table class="wikitable"><caption>Cap</caption><tr><th>H</th></tr><tr><td>${value}</td></tr><tr><td>tail</td></tr></table>`;
  const http = createFetchMock([
    {
      match: () => true,
      respond: () => Response.json({ parse: { title: 'Tables', revid: 42, text: html } }),
    },
  ]);
  http.install();
  try {
    const first = await runToolContract(wikipediaGetArticle, { ...tableRequest, cursor: '' });
    const page1 = wikipediaGetArticle.output.parse(first.structuredContent);
    expect(page1.content).toBe('Cap\n\n| H |\n| --- |');
    expect(page1.next_cursor).toBeTruthy();
    expect(text(first)).toContain(page1.next_cursor);
    const second = await runToolContract(wikipediaGetArticle, {
      ...tableRequest,
      cursor: page1.next_cursor,
    });
    const page2 = wikipediaGetArticle.output.parse(second.structuredContent);
    expect(page2.content).toBe(`| ${value} |`);
    expect(page2).toMatchObject({
      oversized_row: true,
      revision_id: '42',
      rows_returned: 1,
      row_offset: 1,
      table_continued: true,
      truncated: false,
    });
    expect(text(second)).toContain('**Oversized row:** true');
    expect(text(second)).toContain('**Revision ID:** 42');
    expect(text(second)).toContain(`\\| ${'é\\_\\*'.repeat(7000)} \\|`);
    expect(text(second)).toContain(page2.next_cursor);
    const last = await runToolContract(wikipediaGetArticle, {
      ...tableRequest,
      cursor: page2.next_cursor,
    });
    expect(last.structuredContent).toMatchObject({
      content: '| tail |',
      row_offset: 2,
      rows_returned: 1,
    });
    expect(last.structuredContent).not.toHaveProperty('next_cursor');
    expect(text(last)).toContain('\\| tail \\|');
    expect(http.calls).toHaveLength(3);
    expectActionRequests(http.calls, 'parse');
    expect(new URL(http.calls[0]!.request.url).searchParams.get('page')).toBe('Tables');
    for (const { request } of http.calls.slice(1)) {
      const params = new URL(request.url).searchParams;
      expect(params.get('oldid')).toBe('42');
      expect(params.has('page')).toBe(false);
      expect(params.get('section')).toBe('1');
    }
  } finally {
    http.restore();
  }
});

it('characterizes an empty valid regex search through the HTTP seam', async () => {
  const http = createFetchMock([
    {
      match: () => true,
      respond: () => Response.json({ query: { search: [], searchinfo: { totalhits: 0 } } }),
    },
  ]);
  http.install();
  try {
    const result = await runToolContract(wikipediaSearchArticles, {
      query: 'river intitle:/river/',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ results: [], totalCount: 0 });
    expect(text(result)).toContain('No Wikipedia articles found');
    expect(http.calls).toHaveLength(1);
    expectActionRequests(http.calls, 'query');
    expect(new URL(http.calls[0]!.request.url).searchParams.get('srsearch')).toBe(
      'river intitle:/river/',
    );
  } finally {
    http.restore();
  }
});

it.each(['cirrussearch-regex-syntax-error', 'cirrussearch-regex-too-complex-error'])(
  'renders %s as invalid_query with upstream code and recovery on both surfaces',
  async (upstreamCode) => {
    const http = createFetchMock([
      {
        match: () => true,
        respond: () => Response.json({ error: { code: upstreamCode, info: 'Regex refused.' } }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(wikipediaSearchArticles, {
        query: 'river insource:/[/',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_query',
            upstreamCode,
            recovery: { hint: expect.stringContaining('regex') },
          },
        },
      });
      expect(text(result)).toContain('invalid_query');
      expect(text(result)).toContain(upstreamCode);
      expect(text(result)).toContain('regex');
      expect(text(result)).toContain('remove');
      expect(http.calls).toHaveLength(1);
      expectActionRequests(http.calls, 'query');
      expect(new URL(http.calls[0]!.request.url).searchParams.get('srsearch')).toBe(
        'river insource:/[/',
      );
    } finally {
      http.restore();
    }
  },
);

it.each([
  {
    code: 'invalidtitle',
    title: `Seine${String.fromCharCode(1)}`,
    section_index: 0,
    reason: 'invalid_title',
    recovery: 'wikipedia_search_articles',
  },
  {
    code: 'nosuchsection',
    title: 'Seine',
    section_index: 99999,
    reason: 'invalid_section',
    recovery: 'wikipedia_get_sections',
  },
  {
    code: 'missingtitle',
    title: 'Missing article',
    section_index: 0,
    reason: 'not_found',
    recovery: 'wikipedia_search_articles',
  },
])(
  'preserves $reason from the section service on both surfaces',
  async ({ code, title, section_index, reason, recovery }) => {
    const http = createFetchMock([
      {
        match: () => true,
        respond: () => Response.json({ error: { code, info: 'Upstream refusal.' } }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(wikipediaGetArticle, { title, section_index });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.stringContaining(recovery) } } },
      });
      expect(text(result)).toContain(reason);
      expect(text(result)).toContain(recovery);
      if (reason === 'invalid_title') expect(text(result)).not.toContain('wikipedia_get_sections');
      expect(http.calls).toHaveLength(1);
      expectActionRequests(http.calls, 'parse');
      const params = new URL(http.calls[0]!.request.url).searchParams;
      expect(params.get('page')).toBe(title);
      expect(params.get('section')).toBe(String(section_index));
    } finally {
      http.restore();
    }
  },
);

it('passes an unrelated section ValidationError through without inventing a reason', async () => {
  const error = new McpError(JsonRpcErrorCode.ValidationError, 'Unrelated caller refusal.', {
    reason: 'another_input',
    recovery: { hint: 'Correct the unrelated input and try again.' },
  });
  vi.spyOn(getWikipediaService(), 'getArticleSection').mockRejectedValue(error);
  await expect(
    wikipediaGetArticle.handler(
      wikipediaGetArticle.input.parse({ title: 'Seine', section_index: 0 }),
      createMockContext({ errors: wikipediaGetArticle.errors }),
    ),
  ).rejects.toBe(error);
});

it('characterizes full reads and lead/child structure without a TOC lookup', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
    query: {
      pages: [
        {
          title: 'Target',
          pageid: 1,
          extract: '<p>Lead.</p><h2>Parent</h2><p>Body.</p><h3>Child</h3><p>Nested.</p>',
        },
      ],
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Target' });
  expect(result.structuredContent).toMatchObject({
    content: 'Lead.\n\n== Parent ==\n\nBody.\n\n=== Child ===\n\nNested.',
    truncated: false,
  });
  expect(text(result)).toContain('Nested.');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['standard', 'no-extract'])(
  'returns empty %s summaries with metadata and guidance',
  async (type) => {
    vi.spyOn(getWikipediaService(), 'restGet').mockResolvedValue({
      type,
      title: 'Category:Physics',
      pageid: 44,
      description: '',
      extract: '',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Category:Physics' } },
    });
    const result = await runToolContract(wikipediaGetSummary, { title: 'Category:Physics' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      title: 'Category:Physics',
      page_type: type,
      extract: '',
      pageid: 44,
    });
    expect(result.structuredContent).toHaveProperty('description', undefined);
    expect(result.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('section_index: 0'),
    );
    expect(text(result)).toContain('section_index: 0');
  },
);

it('preserves a multihop section redirect and resolves its anchor to a real index', async () => {
  vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
    parse: {
      title: 'Target',
      pageid: 1,
      redirects: [
        { from: 'Alias', to: 'Middle' },
        { from: 'Middle', to: 'Target', tofragment: 'Design_philosophy' },
      ],
      tocdata: {
        sections: [
          {
            line: 'Design philosophy',
            index: '7',
            anchor: 'Design_philosophy',
            number: '1',
            hLevel: 2,
          },
        ],
      },
    },
  });
  const result = await runToolContract(wikipediaGetSections, { title: 'Alias' });
  expect(result.structuredContent).toMatchObject({
    redirected_from: 'Alias',
    redirect_section: 'Design philosophy',
    redirect_section_index: 7,
  });
  expect(text(result)).toContain('Design philosophy');
  expect(text(result)).toContain('**Redirect section index:** 7');
});

it('adds verified indices to overflow outlines with one optional TOC request', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet');
  request.mockResolvedValueOnce({
    query: {
      pages: [
        { title: 'Target', extract: `<p>${'Lead '.repeat(20000)}</p><h2>Parent</h2><p>Body.</p>` },
      ],
    },
  });
  request.mockResolvedValueOnce({
    parse: {
      title: 'Target',
      tocdata: { sections: [{ line: 'Parent', index: '7', anchor: 'Parent' }] },
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Target' });
  expect(result.structuredContent).toMatchObject({
    truncated: true,
    content: expect.stringContaining('section_index: 0'),
  });
  expect(result.structuredContent).toHaveProperty(
    'content',
    expect.stringContaining('section_index: 7'),
  );
  expect(text(result)).toContain('section\\_index: 7');
  expect(request).toHaveBeenCalledTimes(2);
  vi.unstubAllEnvs();
});

it.each([
  'relevance',
  'last_edit_desc',
  'create_timestamp_desc',
  'incoming_links_desc',
  'title_natural_asc',
] as const)('forwards and echoes sort %s', async (sort) => {
  const request = vi
    .spyOn(getWikipediaService(), 'actionGet')
    .mockResolvedValue({ query: { search: [], searchinfo: { totalhits: 0 } } });
  const result = await runToolContract(wikipediaSearchArticles, {
    query: 'incategory:Physics',
    sort,
  });
  expect(request.mock.calls[0]?.[1]).toMatchObject({ srsort: sort });
  expect(result.structuredContent).toHaveProperty('sort', sort);
  expect(text(result)).toContain(sort);
});

it.each([49, 50, 51])(
  'applies the search limit %s with disclosed clamping only above 50',
  async (limit) => {
    const request = vi
      .spyOn(getWikipediaService(), 'actionGet')
      .mockResolvedValue({ query: { search: [] } });
    const result = await runToolContract(wikipediaSearchArticles, { query: 'Physics', limit });
    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ srlimit: String(Math.min(limit, 50)) });
    if (limit > 50)
      expect(result.structuredContent).toMatchObject({ requestedLimit: limit, appliedLimit: 50 });
    else {
      expect(result.structuredContent).not.toHaveProperty('requestedLimit');
      expect(result.structuredContent).not.toHaveProperty('appliedLimit');
    }
    if (limit > 50)
      expect(text(result)).toContain('Requested limit 51 was clamped to 50 results per page.');
  },
);

it.each([
  {
    fragment: 'Missing',
    rows: [{ line: 'Parent', anchor: 'Parent', index: '7' }],
    expected: 'Missing',
  },
  {
    fragment: 'Parent',
    rows: [
      { line: 'Parent', anchor: 'Parent', index: '7' },
      { line: 'Parent', anchor: 'Parent', index: '8' },
    ],
    expected: 'Parent',
  },
  {
    fragment: 'Template_heading',
    rows: [
      { line: 'Template heading', anchor: 'Template_heading' },
      { line: 'Other', index: '4', anchor: 'Other' },
    ],
    expected: 'Template heading',
  },
])(
  'keeps unmatched or ambiguous redirect fragments without a guessed index: $fragment',
  async ({ fragment, rows, expected }) => {
    vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
      parse: {
        title: 'Target',
        redirects: [{ from: 'Alias', to: 'Target', tofragment: fragment }],
        tocdata: { sections: rows },
      },
    });
    const result = await runToolContract(wikipediaGetSections, { title: 'Alias' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      redirected_from: 'Alias',
      redirect_section: expected,
    });
    expect(result.structuredContent).not.toHaveProperty('redirect_section_index');
    expect(text(result)).toContain(expected);
  },
);

it.each([undefined, 'Alias'])(
  'keeps ordinary reads and aliases free of section metadata (%s)',
  async (alias) => {
    const request = vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
      query: {
        redirects: alias ? [{ from: alias, to: 'Target' }] : [],
        pages: [{ title: 'Target', extract: '<p>Full content.</p>' }],
      },
    });
    const result = await runToolContract(wikipediaGetArticle, { title: alias ?? 'Target' });
    expect(result.structuredContent).toMatchObject({ content: 'Full content.', truncated: false });
    expect(
      wikipediaGetArticle.output.parse(result.structuredContent).redirect_section,
    ).toBeUndefined();
    if (alias) {
      expect(result.structuredContent).toHaveProperty('redirected_from', alias);
      expect(text(result)).toContain('Redirected from:** Alias');
    } else expect(result.structuredContent).not.toHaveProperty('redirected_from');
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each([0, 3])(
  'honors explicit section_index %s over redirect targets without a TOC lookup',
  async (sectionIndex) => {
    const request = vi.spyOn(getWikipediaService(), 'actionGet').mockResolvedValue({
      parse: {
        title: 'Target',
        redirects: [{ from: 'Alias', to: 'Target', tofragment: 'Other_heading' }],
        text: '<h2>Chosen</h2><p>Body.</p><h3>Child</h3><p>Nested.</p>',
      },
    });
    const result = await runToolContract(wikipediaGetArticle, {
      title: 'Alias',
      section_index: sectionIndex,
    });
    expect(result.structuredContent).toMatchObject({
      content_type: 'section',
      truncated: false,
      section_title: sectionIndex === 0 ? 'Introduction' : 'Chosen',
      redirected_from: 'Alias',
      redirect_section: 'Other_heading',
      content: '== Chosen ==\n\nBody.\n\n=== Child ===\n\nNested.',
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ section: String(sectionIndex) });
    expect(text(result)).toContain('Other\\_heading');
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('shares the TOC lookup between overflowing content and redirect guidance', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet');
  request.mockResolvedValueOnce({
    query: {
      redirects: [{ from: 'Alias', to: 'Target', tofragment: 'A_&_B' }],
      pages: [
        {
          title: 'Target',
          fullurl: 'https://en.wikipedia.org/wiki/Target',
          extract: `<p>${'Lead '.repeat(20000)}</p><h2>A &amp; B</h2><p>Body.</p>`,
        },
      ],
    },
  });
  request.mockResolvedValueOnce({
    parse: {
      title: 'Target',
      tocdata: { sections: [{ line: '<i>A</i> &amp; B', anchor: 'A_&_B', index: '9' }] },
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Alias' });
  expect(result.structuredContent).toMatchObject({
    redirected_from: 'Alias',
    redirect_section: 'A & B',
    notice: expect.stringContaining('section_index: 9'),
    url: 'https://en.wikipedia.org/wiki/Target',
    content: expect.stringContaining('section_index: 9'),
  });
  expect(text(result)).toContain('Redirect section:** A \\& B');
  expect(request).toHaveBeenCalledTimes(2);
});

it('leaves duplicate and template headings unindexed while preserving outline sizes and ordering', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet');
  request.mockResolvedValueOnce({
    query: {
      pages: [
        {
          title: 'Target',
          extract: `<p>${'Lead '.repeat(20000)}</p><h2>Repeated</h2><p>First.</p><h2>Repeated</h2><p>Second.</p><h2>Template</h2><p>Third.</p><h2>Missing</h2><p>Fourth.</p>`,
        },
      ],
    },
  });
  request.mockResolvedValueOnce({
    parse: {
      tocdata: {
        sections: [
          { line: 'Repeated', index: '3' },
          { line: 'Repeated', index: '4' },
          { line: 'Template' },
        ],
      },
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Target' });
  const content = wikipediaGetArticle.output.parse(result.structuredContent).content;
  expect(content).toContain('- Introduction — 100001 bytes (section_index: 0)');
  expect(content).toContain('- Repeated — 8 bytes\n');
  expect(content).toContain('- Repeated (2) — 9 bytes\n');
  expect(content).toContain('- Template — 8 bytes\n');
  expect(content).toContain('- Missing — 9 bytes\n');
  expect(content.indexOf('Repeated (2)')).toBeLessThan(content.indexOf('- Repeated —'));
});

it('discloses optional TOC failure after one HTTP attempt without retrying', async () => {
  vi.useFakeTimers();
  const http = createFetchMock([
    {
      match: () => true,
      respond: (request) =>
        new URL(request.url).searchParams.get('action') === 'query'
          ? Response.json({
              query: {
                pages: [
                  {
                    title: 'Target',
                    extract: `<p>${'Lead '.repeat(20000)}</p><h2>Parent</h2><p>Body.</p>`,
                  },
                ],
              },
            })
          : Response.json({ error: { code: 'ratelimited', info: 'Temporarily unavailable' } }),
    },
  ]);
  http.install();
  try {
    const pending = runToolContract(wikipediaGetArticle, { title: 'Target' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      notice: expect.stringContaining('unavailable'),
    });
    expect(text(result)).toContain('unavailable');
    expect(http.calls).toHaveLength(2);
  } finally {
    http.restore();
  }
});

it('propagates cancellation during optional TOC acquisition', async () => {
  const controller = new AbortController();
  const error = new McpError(JsonRpcErrorCode.RequestCancelled, 'Stop optional TOC acquisition');
  const request = vi.spyOn(getWikipediaService(), 'actionGet').mockImplementation(async () => {
    controller.abort();
    throw error;
  });
  await expect(
    getWikipediaService().getArticleToc(
      'Target',
      'en',
      createMockContext({ signal: controller.signal }),
    ),
  ).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});

it('returns cancellation on both surfaces without optional guidance after a TOC body abort', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const http = createFetchMock([
    {
      match: () => true,
      respond: (request) => {
        if (new URL(request.url).searchParams.get('action') === 'query')
          return Response.json({
            query: {
              pages: [
                {
                  title: 'Target',
                  extract: `<p>${'Lead '.repeat(20000)}</p><h2>Parent</h2><p>Body.</p>`,
                },
              ],
            },
          });
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                {
                  once: true,
                },
              );
              setTimeout(() => caller.abort(new Error('Caller stopped the read')), 1);
            },
          }),
        );
      },
    },
  ]);
  http.install();
  try {
    const pending = runToolContract(
      wikipediaGetArticle,
      { title: 'Target' },
      {
        context: { signal: caller.signal },
      },
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RequestCancelled,
        message: expect.stringContaining('was aborted'),
      },
    });
    expect(text(result)).toContain('was aborted');
    expect(text(result)).not.toContain('optional table of contents lookup was unavailable');
    expect(result.structuredContent).not.toHaveProperty('content');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(http.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    http.restore();
  }
});

it('preserves internal failures before the optional TOC request is constructed', async () => {
  vi.useFakeTimers();
  const error = new Error('Internal edition resolver defect');
  vi.spyOn(getWikipediaService(), 'resolveBaseUrl').mockRejectedValue(error);
  const http = createFetchMock([{ match: () => true, respond: Response.json({}) }]);
  http.install();
  try {
    await expect(
      getWikipediaService().getArticleToc('Target', 'en', createMockContext()),
    ).rejects.toBe(error);
    expect(http.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    http.restore();
  }
});

it('propagates an upstream input refusal from the optional TOC request', async () => {
  vi.useFakeTimers();
  const http = createFetchMock([
    { match: () => true, respond: new Response('Bad request', { status: 400 }) },
  ]);
  http.install();
  try {
    await expect(
      getWikipediaService().getArticleToc('Target', 'en', createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(http.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    http.restore();
  }
});

it.each(['network', 'json', 'http'])(
  'keeps optional TOC %s unavailability best-effort without retrying',
  async (failure) => {
    vi.useFakeTimers();
    const http = createFetchMock([
      {
        match: () => true,
        respond: () => {
          if (failure === 'network') throw new TypeError('Network connection failed');
          return new Response(failure === 'json' ? 'broken JSON' : 'Unavailable', {
            status: failure === 'http' ? 503 : 200,
          });
        },
      },
    ]);
    http.install();
    try {
      await expect(
        getWikipediaService().getArticleToc('Target', 'en', createMockContext()),
      ).resolves.toBeUndefined();
      expect(http.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      http.restore();
    }
  },
);

it('bounds a delayed main body and stalled optional TOC body within the combined deadline', async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  let mainAttempts = 0;
  const http = createFetchMock([
    {
      match: () => true,
      respond: (request) => {
        const main = new URL(request.url).searchParams.get('action') === 'query';
        if (main && ++mainAttempts === 1)
          return new Response('Unavailable', { status: 503, headers: { 'Retry-After': '14' } });
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                {
                  once: true,
                },
              );
              if (main)
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({
                        query: {
                          pages: [
                            {
                              title: 'Target',
                              extract: `<p>${'Lead '.repeat(20000)}</p><h2>Parent</h2><p>Body.</p>`,
                            },
                          ],
                        },
                      }),
                    ),
                  );
                  controller.close();
                }, 14_000);
            },
          }),
        );
      },
    },
  ]);
  http.install();
  try {
    const pending = runToolContract(wikipediaGetArticle, { title: 'Target' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      title: 'Target',
      truncated: true,
      notice: expect.stringContaining('optional table of contents lookup was unavailable'),
    });
    expect(text(result)).toContain('optional table of contents lookup was unavailable');
    expect(http.calls).toHaveLength(3);
    expect(mainAttempts).toBe(2);
    expect(Date.now() - startedAt).toBe(33_000);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    http.restore();
  }
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'rejects invalid limits %s before HTTP',
  async (limit) => {
    vi.useFakeTimers();
    const http = createFetchMock([{ match: () => true, respond: Response.json({}) }]);
    http.install();
    try {
      for (const result of [
        await runToolContract(wikipediaSearchArticles, { query: 'Physics', limit }),
        await runToolContract(wikipediaSearchNearby, { latitude: 0, longitude: 0, limit }),
      ]) {
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
      }
      expect(http.calls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      http.restore();
    }
  },
);

it('rejects an invalid sort and out-of-range coordinates before HTTP', async () => {
  vi.useFakeTimers();
  const http = createFetchMock([{ match: () => true, respond: Response.json({}) }]);
  http.install();
  try {
    expect(
      wikipediaSearchArticles.input.safeParse({ query: 'Physics', sort: 'random' }).success,
    ).toBe(false);
    for (const point of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
    ]) {
      const result = await runToolContract(wikipediaSearchNearby, point);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
    expect(http.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    http.restore();
  }
});

it('keeps upstream ranking and query/sort across successive pages and a past-end read', async () => {
  const request = vi
    .spyOn(getWikipediaService(), 'actionGet')
    .mockImplementation(async (_language, params) => {
      if (params.pageids)
        return {
          query: {
            pages: [
              { pageid: 1, description: 'First ID' },
              { pageid: 3, description: 'Third ID' },
            ],
          },
        };
      if (params.sroffset === '0')
        return {
          query: {
            searchinfo: { totalhits: 3 },
            search: [
              { title: 'Third', pageid: 3, snippet: '3', wordcount: 3 },
              { title: 'First', pageid: 1, snippet: '1', wordcount: 1 },
            ],
          },
          continue: { sroffset: 2 },
        };
      if (params.sroffset === '2')
        return {
          query: {
            searchinfo: { totalhits: 3 },
            search: [{ title: 'Last', pageid: 4, snippet: '4', wordcount: 4 }],
          },
        };
      return { query: { searchinfo: { totalhits: 3 }, search: [] } };
    });
  const first = await runToolContract(wikipediaSearchArticles, {
    query: 'incategory:Physics',
    sort: 'last_edit_desc',
    limit: 2,
  });
  expect(first.structuredContent).toMatchObject({
    results: [
      { title: 'Third', description: 'Third ID' },
      { title: 'First', description: 'First ID' },
    ],
    nextOffset: 2,
  });
  expect(text(first).indexOf('### Third')).toBeLessThan(text(first).indexOf('### First'));
  const second = await runToolContract(wikipediaSearchArticles, {
    query: 'incategory:Physics',
    sort: 'last_edit_desc',
    offset: 2,
    limit: 2,
  });
  expect(second.structuredContent).toMatchObject({ results: [{ title: 'Last' }], shown: 1 });
  expect(second.structuredContent).not.toHaveProperty('nextOffset');
  const end = await runToolContract(wikipediaSearchArticles, {
    query: 'incategory:Physics',
    sort: 'last_edit_desc',
    offset: 999,
    limit: 2,
  });
  expect(end.structuredContent).toMatchObject({
    results: [],
    notice: expect.stringContaining('end of the result set'),
  });
  expect(text(end)).toContain('end of the result set');
  expect(
    request.mock.calls.filter((call) => call[1].list === 'search').map((call) => call[1]),
  ).toEqual([
    expect.objectContaining({
      srsearch: 'incategory:Physics',
      srsort: 'last_edit_desc',
      sroffset: '0',
      srlimit: '2',
    }),
    expect.objectContaining({
      srsearch: 'incategory:Physics',
      srsort: 'last_edit_desc',
      sroffset: '2',
      srlimit: '2',
    }),
    expect.objectContaining({
      srsearch: 'incategory:Physics',
      srsort: 'last_edit_desc',
      sroffset: '999',
      srlimit: '2',
    }),
  ]);
});

it('composes search clamp, unavailable metadata, and window disclosure on both surfaces', async () => {
  vi.spyOn(getWikipediaService(), 'actionGet').mockImplementation(async (_language, params) => {
    if (params.pageids) throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Unavailable');
    return {
      query: {
        searchinfo: { totalhits: 11000 },
        search: [{ title: 'Last reachable', pageid: 1, snippet: '', wordcount: 4 }],
      },
    };
  });
  const result = await runToolContract(wikipediaSearchArticles, {
    query: 'Physics',
    limit: 51,
    offset: 9999,
  });
  expect(result.structuredContent).toMatchObject({
    requestedLimit: 51,
    appliedLimit: 50,
    truncated: true,
    cap: 10000,
  });
  for (const segment of ['51', 'clamped', 'Descriptions and Wikidata', '10,000']) {
    expect(result.structuredContent).toHaveProperty('notice', expect.stringContaining(segment));
    expect(text(result)).toContain(segment);
  }
});

it('uses the applied nearby ceiling for probing, cap, and composed guidance', async () => {
  const rows = Array.from({ length: 500 }, (_, pageid) => ({
    pageid,
    ns: 0,
    title: `Place ${pageid}`,
    lat: 0,
    lon: 0,
    dist: pageid,
  }));
  const request = vi
    .spyOn(getWikipediaService(), 'actionGet')
    .mockResolvedValue({ query: { geosearch: rows } });
  const result = await runToolContract(wikipediaSearchNearby, {
    latitude: -90,
    longitude: 180,
    limit: 501,
  });
  expect(request.mock.calls[0]?.[1]).toMatchObject({ gslimit: '500', ggslimit: '500' });
  expect(result.structuredContent).toMatchObject({
    requestedLimit: 501,
    appliedLimit: 500,
    cap: 500,
    truncated: true,
    shown: 500,
  });
  expect(result.structuredContent).toHaveProperty('notice', expect.stringContaining('clamped'));
  expect(text(result)).toContain('Reduce radius_meters');
  expect(text(result)).not.toContain('Raise limit');
});

it('retains real suffixed headings beside duplicate headings in an overflow outline', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet');
  request.mockResolvedValueOnce({
    query: {
      pages: [
        {
          title: 'Target',
          extract: `<p>${'Lead '.repeat(20000)}</p><h2>Foo</h2><p>One.</p><h2>Foo</h2><p>Two.</p><h2>Foo (2)</h2><p>Three.</p>`,
        },
      ],
    },
  });
  request.mockResolvedValueOnce({
    parse: {
      tocdata: {
        sections: [
          { line: 'Foo', index: '1' },
          { line: 'Foo', index: '2' },
          { line: 'Foo (2)', index: '3' },
        ],
      },
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Target' });
  const content = wikipediaGetArticle.output.parse(result.structuredContent).content;
  expect(content).toContain('across 4 sections');
  expect(content).toContain('- Foo — 6 bytes');
  expect(content).toContain('- Foo (3) — 6 bytes');
  expect(content).toContain('- Foo (2) — 8 bytes (section_index: 3)');
});

it('matches whitespace-normalized rendered headings without changing their visible text', async () => {
  const request = vi.spyOn(getWikipediaService(), 'actionGet');
  request.mockResolvedValueOnce({
    query: {
      pages: [
        {
          title: 'Target',
          extract: `<p>${'Lead '.repeat(20000)}</p><h2>A\t &amp;\u00a0 B</h2><p>Body.</p><h2>Literal &lt;element&gt;</h2><p>Other.</p>`,
        },
      ],
    },
  });
  request.mockResolvedValueOnce({
    parse: {
      tocdata: {
        sections: [
          { line: '<i>A</i> &amp;\u00a0 B', index: '7' },
          { line: 'Literal &lt;element&gt;', index: '8' },
        ],
      },
    },
  });
  const result = await runToolContract(wikipediaGetArticle, { title: 'Target' });
  const content = wikipediaGetArticle.output.parse(result.structuredContent).content;
  expect(content).toContain('- A & B — 7 bytes (section_index: 7)');
  expect(content).toContain('- Literal <element> — 8 bytes (section_index: 8)');
});

it.each([499, 500, 501])(
  'applies nearby limit %s with disclosed clamping only above 500',
  async (limit) => {
    const request = vi
      .spyOn(getWikipediaService(), 'actionGet')
      .mockResolvedValue({ query: { geosearch: [] } });
    const result = await runToolContract(wikipediaSearchNearby, {
      latitude: 90,
      longitude: -180,
      limit,
    });
    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ gslimit: '500' });
    if (limit > 500)
      expect(result.structuredContent).toMatchObject({ requestedLimit: limit, appliedLimit: 500 });
    else {
      expect(result.structuredContent).not.toHaveProperty('requestedLimit');
      expect(result.structuredContent).not.toHaveProperty('appliedLimit');
    }
    if (limit > 500) {
      expect(text(result)).toContain('Requested limit 501 was clamped to 500.');
      expect(text(result)).toContain('No geotagged');
    }
  },
);
