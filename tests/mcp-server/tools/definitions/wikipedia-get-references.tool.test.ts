/**
 * @fileoverview Tests for wikipedia_get_references, run through the real service and renderer with
 * the network faked at the fetch seam.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-references.tool.test
 */

import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { wikipediaGetArticle } from '@/mcp-server/tools/definitions/wikipedia-get-article.tool.js';
import { wikipediaGetReferences } from '@/mcp-server/tools/definitions/wikipedia-get-references.tool.js';
import {
  getWikipediaService,
  initWikipediaService,
  REFERENCES_PAGE_MAX_BYTES,
} from '@/services/wikipedia/wikipedia-service.js';
import { parseInlineText, parseTargets } from '../../../helpers/commonmark.js';

/** A trimmed `action=parse` capture: `{ source, parse }` (see each file's `source` for URL and date). */
type Capture = {
  parse: { title: string; pageid: number; revid: number; text: string; redirects?: unknown[] };
};

function fixture(name: string): Capture {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/references/${name}.json`, import.meta.url), 'utf8'),
  ) as Capture;
}

const SEINE = fixture('seine');
const OBAMA = fixture('barack-obama');
const AUGUSTUS = fixture('augustus');
const HATHAWAY = fixture('anne-hathaway');
const FR_SEINE = fixture('fr-seine');
const SIMPLE_SEINE = fixture('simple-seine');
const ALGERIA = fixture('districts-of-algeria');

const EDITIONS = {
  en: 'https://en.wikipedia.org',
  fr: 'https://fr.wikipedia.org',
  simple: 'https://simple.wikipedia.org',
};

beforeEach(() => {
  vi.restoreAllMocks();
  initWikipediaService({} as AppConfig, createInMemoryStorage(), 'test');
  vi.spyOn(getWikipediaService(), 'fetchEditionIndex').mockResolvedValue({
    hosts: EDITIONS,
    fetchedAt: '2026-10-29T00:00:00.000Z',
  });
});

/**
 * Answer `action=parse` on `hostname` with `reply(params)`, routed by the request's own hostname and
 * path. Any other request fails the test.
 */
function stubParse(hostname: string, reply: (params: URLSearchParams) => unknown) {
  const http = createFetchMock([
    {
      match: (request) => {
        const url = new URL(request.url);
        return (
          url.hostname === hostname &&
          url.pathname === '/w/api.php' &&
          url.searchParams.get('action') === 'parse'
        );
      },
      respond: (request) => Response.json(reply(new URL(request.url).searchParams)),
    },
  ]);
  http.install();
  onTestFinished(() => {
    http.restore();
  });
  return http;
}

type Result = Awaited<ReturnType<typeof runToolContract>>;

function text(result: Result): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

type Page = {
  title: string;
  pageid?: number;
  url?: string;
  revision_id: string;
  redirected_from?: string;
  total_references: number;
  references: Array<{
    id: string;
    group?: string;
    label?: string;
    text: string;
    urls?: string[];
    dois?: string[];
    work_ids?: string[];
  }>;
  works: Array<{ id: string; text: string; urls?: string[]; dois?: string[] }>;
  next_cursor?: string;
  notice?: string;
};

function page(result: Result): Page {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Page;
}

const bytes = (value: string) => Buffer.byteLength(value);

/** Follow next_cursor from the first page to the end, returning every page's result. */
async function walk(title: string, language = 'en'): Promise<Result[]> {
  const pages: Result[] = [];
  let cursor: string | undefined;
  do {
    const result = await runToolContract(wikipediaGetReferences, {
      title,
      language,
      ...(cursor && { cursor }),
    });
    pages.push(result);
    cursor = page(result).next_cursor;
  } while (cursor);
  return pages;
}

/** Every request is a parse of the expected page or pinned revision, with furniture disabled. */
function expectParseRequests(
  http: ReturnType<typeof createFetchMock>,
  title: string,
  revid: number,
) {
  http.calls.forEach(({ request }, index) => {
    const params = new URL(request.url).searchParams;
    expect(params.get('prop')).toBe('text|revid');
    expect(params.get('redirects')).toBe('true');
    expect(params.get('disableeditsection')).toBe('true');
    expect(params.get('disabletoc')).toBe('true');
    expect(params.get('disablelimitreport')).toBe('true');
    expect(params.has('section')).toBe(false);
    if (index === 0) {
      expect(params.get('page')).toBe(title);
      expect(params.has('oldid')).toBe(false);
    } else {
      expect(params.get('oldid')).toBe(String(revid));
      expect(params.has('page')).toBe(false);
    }
  });
}

it('is registered with the server’s tools', () => {
  expect(allToolDefinitions.map((definition) => definition.name)).toContain(
    'wikipedia_get_references',
  );
});

describe('wikipedia_get_references — single-page articles', () => {
  it('returns Seine’s 57 ungrouped footnotes on one page, on both surfaces', async () => {
    const http = stubParse('en.wikipedia.org', () => SEINE);
    const result = await runToolContract(wikipediaGetReferences, { title: 'Seine' });
    const out = page(result);

    expect(out).toMatchObject({
      title: 'Seine',
      pageid: 54006,
      url: 'https://en.wikipedia.org/wiki/Seine',
      revision_id: '1381786474',
      total_references: 57,
      works: [],
    });
    expect(out.next_cursor).toBeUndefined();
    expect(out.references).toHaveLength(57);
    expect(out.references.every((entry) => entry.group === undefined)).toBe(true);
    const sandre = out.references.find((entry) => entry.id === 'cite_note-sandre-2');
    expect(sandre).toEqual({
      id: 'cite_note-sandre-2',
      label: '2',
      text: '"Fiche cours d\'eau - La Seine (----0010)". Sandre. Sandre----0010.',
      urls: ['https://id.eaufrance.fr/CoursEau_Carthage2017/----0010'],
    });

    const markdown = text(result);
    expect(markdown).toContain('# Seine');
    expect(markdown).toContain('**Revision ID:** 1381786474 | **Page ID:** 54006');
    expect(markdown).toContain(
      '**URL:** [en.wikipedia.org](<https://en.wikipedia.org/wiki/Seine>)',
    );
    expect(markdown).toContain('**Total references:** 57 (57 on this page)');
    // Ids and text escape; a URL is a link to itself, labelled with its host.
    expect(markdown).toContain(
      '- \\[2\\] cite\\_note-sandre-2\n  "Fiche cours d\'eau - La Seine (----0010)". Sandre. Sandre----0010.\n  URL: [id.eaufrance.fr](<https://id.eaufrance.fr/CoursEau_Carthage2017/----0010>)\n',
    );
    expect(markdown).not.toContain('Next cursor');
    expect(http.calls).toHaveLength(1);
    expectParseRequests(http, 'Seine', 1381786474);
  });

  it('reads the fr and simple editions from their own hosts', async () => {
    stubParse('fr.wikipedia.org', () => FR_SEINE);
    const fr = page(
      await runToolContract(wikipediaGetReferences, { title: 'Seine', language: 'fr' }),
    );
    expect(fr.total_references).toBe(98);
    expect(fr.url).toBe('https://fr.wikipedia.org/wiki/Seine');
    expect(fr.references.slice(0, 5).map((entry) => [entry.group, entry.label])).toEqual([
      ['N', 'N 1'],
      ['N', 'N 2'],
      ['N', 'N 3'],
      ['N', 'N 4'],
      ['N', 'N 5'],
    ]);
    expect(fr.references[5]).toMatchObject({ id: 'cite_note-sandre-1', label: '1' });
    expect(fr.references[5]?.group).toBeUndefined();

    stubParse('simple.wikipedia.org', () => SIMPLE_SEINE);
    const simple = page(
      await runToolContract(wikipediaGetReferences, { title: 'Seine', language: 'simple' }),
    );
    expect(simple.total_references).toBe(1);
    expect(simple.references[0]?.urls).toEqual([
      'https://web.archive.org/web/20141112043913/http://services.sandre.eaufrance.fr/Courdo/Fiche/client/fiche_courdo.php?CdSandre=----0010',
      'http://services.sandre.eaufrance.fr/Courdo/Fiche/client/fiche_courdo.php?CdSandre=----0010',
    ]);
  });

  it('keeps the inner labels of a note that cites other footnotes (Anne Hathaway)', async () => {
    stubParse('en.wikipedia.org', () => HATHAWAY);
    const out = page(await runToolContract(wikipediaGetReferences, { title: 'Anne Hathaway' }));
    expect(out.references[0]).toEqual({
      id: 'cite_note-4',
      group: 'lower-alpha',
      label: 'a',
      text: 'Attributed to multiple references:[1][2][3]',
    });
    expect(out.total_references).toBe(292);
  });

  it('leaves the hidden CS1 maintenance message out of the footnote that carries it (#75)', async () => {
    stubParse('en.wikipedia.org', () => HATHAWAY);
    // The capture's one `span.cs1-maint` ("CS1 maint: url-status") sits inside a cite web footnote.
    expect(HATHAWAY.parse.text).toContain('CS1 maint: url-status');
    const entries = (await walk('Anne Hathaway')).flatMap((result) => page(result).references);
    expect(entries).toHaveLength(292);
    expect(entries.filter((entry) => entry.text.includes('CS1 maint'))).toEqual([]);
    expect(entries.filter((entry) => entry.text.includes('{{cite web}}'))).toEqual([]);
  });

  it('follows a redirect and a #fragment to the article', async () => {
    const http = stubParse('en.wikipedia.org', (params) =>
      params.get('page') === 'Obama'
        ? { parse: { ...OBAMA.parse, redirects: [{ from: 'Obama', to: 'Barack Obama' }] } }
        : SEINE,
    );
    const redirected = page(await runToolContract(wikipediaGetReferences, { title: 'Obama' }));
    expect(redirected).toMatchObject({
      title: 'Barack Obama',
      redirected_from: 'Obama',
      url: 'https://en.wikipedia.org/wiki/Barack_Obama',
      revision_id: '1382497142',
      total_references: 458,
    });

    const fragment = page(
      await runToolContract(wikipediaGetReferences, { title: 'Seine#History' }),
    );
    expect(fragment).toMatchObject({ title: 'Seine', total_references: 57 });
    expect(new URL(http.calls[1]!.request.url).searchParams.get('page')).toBe('Seine#History');
  });

  it('returns an empty list and a notice, not an error, for an article without footnotes', async () => {
    stubParse('en.wikipedia.org', () => ALGERIA);
    const result = await runToolContract(wikipediaGetReferences, { title: 'Districts of Algeria' });
    const out = page(result);
    expect(out).toMatchObject({
      title: 'Districts of Algeria',
      revision_id: '1339511627',
      total_references: 0,
      references: [],
      works: [],
    });
    expect(out.next_cursor).toBeUndefined();
    expect(out.notice).toBe(
      'This article has no footnotes. A bibliography, further-reading, or external-links section is not a footnote list: find it with wikipedia_get_sections and read it with wikipedia_get_article.',
    );
    expect(text(result)).toContain('**Total references:** 0 (0 on this page)');
    // The notice is the server's own Markdown, so it renders as a block quote unescaped.
    expect(text(result)).toContain(`> ${out.notice}`);
  });
});

describe('wikipedia_get_references — paging (Barack Obama, 458 footnotes)', () => {
  it('walks every footnote exactly once, each page within budget on both surfaces', async () => {
    const http = stubParse('en.wikipedia.org', (params) => {
      if (params.has('oldid')) expect(params.get('oldid')).toBe('1382497142');
      return OBAMA;
    });
    const pages = await walk('Barack Obama');

    expect(pages.length).toBeGreaterThan(1);
    const ids = pages.flatMap((result) => page(result).references.map((entry) => entry.id));
    expect(ids).toHaveLength(458);
    expect(new Set(ids).size).toBe(458);
    expect(ids[0]).toBe('cite_note-2');
    expect(page(pages[0]!).references[0]).toMatchObject({ group: 'lower-alpha', label: 'a' });

    for (const result of pages) {
      const out = page(result);
      expect(out.total_references).toBe(458);
      expect(out.revision_id).toBe('1382497142');
      expect(bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        REFERENCES_PAGE_MAX_BYTES,
      );
      expect(bytes(text(result))).toBeLessThanOrEqual(REFERENCES_PAGE_MAX_BYTES);
    }
    expect(page(pages.at(-1)!).next_cursor).toBeUndefined();

    // One parse per page; continuations pin the first page's revision.
    expect(http.calls).toHaveLength(pages.length);
    expectParseRequests(http, 'Barack Obama', 1382497142);

    const doiPage = pages.find((result) =>
      page(result).references.some((entry) => entry.dois?.includes('10.1017/CBO9781316412299')),
    )!;
    const doi = page(doiPage).references.find((entry) =>
      entry.dois?.includes('10.1017/CBO9781316412299'),
    );
    expect(doi?.id).toBe('cite_note-232');
    expect(doi?.urls).toContain('https://doi.org/10.1017%2FCBO9781316412299');
    // A DOI opens its line, but its "10." is not escaped as an ordered-list marker.
    expect(text(doiPage)).toContain(
      '\n  URL: [doi.org](<https://doi.org/10.1017%2FCBO9781316412299>)\n',
    );
    expect(text(doiPage)).toContain('\n  DOI: 10.1017/CBO9781316412299\n');
    expect(text(doiPage)).not.toContain('10\\.1017');
  });

  it('cuts a page where the next whole footnote would exceed the budget', async () => {
    stubParse('en.wikipedia.org', () => OBAMA);
    const [first, second] = await walk('Barack Obama');
    const cut = page(first!);
    const next = page(second!).references[0]!;

    // The first page is short of the total, so the cut lands inside the list.
    expect(cut.references.length).toBeGreaterThan(1);
    expect(cut.references.length).toBeLessThan(458);
    // Adding the next footnote — with the cursor the larger page would still carry — breaks the
    // budget on at least one surface.
    const grown = { ...cut, references: [...cut.references, next] };
    const rendered = wikipediaGetReferences.format!(grown as never)
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(Math.max(bytes(JSON.stringify(grown)), bytes(rendered))).toBeGreaterThan(
      REFERENCES_PAGE_MAX_BYTES,
    );
  });

  it('reads the last footnote alone and rejects an offset past the end', async () => {
    stubParse('en.wikipedia.org', () => OBAMA);
    const cursor = (offset: number) =>
      encodeCursor({
        kind: 'wikipedia_references_v1',
        title: 'Barack Obama',
        language: 'en',
        revisionId: 1382497142,
        offset,
        limit: REFERENCES_PAGE_MAX_BYTES,
      });

    const last = page(
      await runToolContract(wikipediaGetReferences, { title: 'Barack Obama', cursor: cursor(457) }),
    );
    expect(last.references).toHaveLength(1);
    expect(last.next_cursor).toBeUndefined();

    const past = await runToolContract(wikipediaGetReferences, {
      title: 'Barack Obama',
      cursor: cursor(458),
    });
    expect(past.isError).toBe(true);
    expect(past.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_cursor' } },
    });
    expect(text(past)).toContain('omit cursor to start again');
  });

  it('returns an oversized footnote alone and keeps walking', async () => {
    const big = 'Long note. '.repeat(5000);
    const html = `<p><sup class="reference"><a href="#cite_note-1">[1]</a></sup><sup class="reference"><a href="#cite_note-2">[2]</a></sup><sup class="reference"><a href="#cite_note-3">[3]</a></sup></p><ol class="references"><li id="cite_note-1"><span class="reference-text">Small one.</span></li><li id="cite_note-2"><span class="reference-text">${big}</span></li><li id="cite_note-3"><span class="reference-text">Small three.</span></li></ol>`;
    stubParse('en.wikipedia.org', () => ({
      parse: { title: 'Big', pageid: 1, revid: 7, text: html },
    }));
    const pages = (await walk('Big')).map(page);
    expect(pages.map((out) => out.references.map((entry) => entry.label))).toEqual([
      ['1'],
      ['2'],
      ['3'],
    ]);
    expect(bytes(JSON.stringify(pages[1]))).toBeGreaterThan(REFERENCES_PAGE_MAX_BYTES);
  });
});

describe('wikipedia_get_references — short citations and works (Augustus, 711 footnotes)', () => {
  it('links each short citation to its full citation on the same page', async () => {
    stubParse('en.wikipedia.org', () => AUGUSTUS);
    const pages = (await walk('Augustus')).map(page);
    const entries = pages.flatMap((out) => out.references);
    expect(entries).toHaveLength(711);
    expect(entries.filter((entry) => entry.group === 'lower-alpha')).toHaveLength(46);
    expect(entries.filter((entry) => entry.group === undefined)).toHaveLength(665);

    const galinskyPage = pages.find((out) =>
      out.references.some((entry) => entry.id === 'cite_note-FOOTNOTEGalinsky201275–76-1'),
    )!;
    expect(
      galinskyPage.references.find((entry) => entry.id === 'cite_note-FOOTNOTEGalinsky201275–76-1'),
    ).toEqual({
      id: 'cite_note-FOOTNOTEGalinsky201275–76-1',
      label: '1',
      text: 'Galinsky 2012, pp. 75–76.',
      work_ids: ['CITEREFGalinsky2012'],
    });
    expect(galinskyPage.works.filter((work) => work.id === 'CITEREFGalinsky2012')).toEqual([
      {
        id: 'CITEREFGalinsky2012',
        text: 'Galinsky, Karl (2012). Augustus: Introduction to the Life of an Emperor. New York: Cambridge University Press. ISBN 978-0-521-74442-3.',
      },
    ]);
    expect(pages.indexOf(galinskyPage)).toBe(0);
    const markdown = text(await runToolContract(wikipediaGetReferences, { title: 'Augustus' }));
    expect(markdown).toContain(
      '- \\[1\\] cite\\_note-FOOTNOTEGalinsky201275–76-1\n  Galinsky 2012, pp. 75–76.\n  Work: CITEREFGalinsky2012',
    );
    expect(markdown).toContain('\n\n## Works\n- CITEREF');
    expect(markdown.indexOf('## Works')).toBeLessThan(
      markdown.indexOf(
        '\n- CITEREFGalinsky2012\n  Galinsky, Karl (2012). Augustus: Introduction to the Life of an Emperor.',
      ),
    );

    // Every page's works are exactly the works its own footnotes name, each once.
    for (const out of pages) {
      const named = new Set(out.references.flatMap((entry) => entry.work_ids ?? []));
      const listed = out.works.map((work) => work.id);
      expect(new Set(listed).size).toBe(listed.length);
      expect(new Set(listed)).toEqual(named);
    }
  });
});

describe('wikipedia_get_references — URLs read back exactly under CommonMark (#78)', () => {
  /** The Asterisk footnote `cite_note-:0-26`, whose `_-_` a bare URL line rendered as emphasis. */
  const ASTERISK_PDF =
    'http://d-scholarship.pitt.edu/20621/1/Star-Repair_in_Online_Discourse_-_Author_Accepted_Version.pdf';
  /** Each footnote link's `href` as the parser HTML-escapes it, beside the URL it decodes to. */
  const LINKS: Array<[href: string, url: string]> = [
    [ASTERISK_PDF, ASTERISK_PDF],
    [
      `https://web.archive.org/web/20170922010832/${ASTERISK_PDF}`,
      `https://web.archive.org/web/20170922010832/${ASTERISK_PDF}`,
    ],
    [
      'https://example.org/wiki/M*A*S*H_(TV_series)',
      'https://example.org/wiki/M*A*S*H_(TV_series)',
    ],
    ['https://example.org/a)b(c', 'https://example.org/a)b(c'],
    ['https://example.org/q?x=&lt;1&gt;', 'https://example.org/q?x=<1>'],
    ['https://example.org/q?x=%3C1%3E%28%29', 'https://example.org/q?x=%3C1%3E%28%29'],
    ['https://example.org/a?x=1&amp;y=2', 'https://example.org/a?x=1&y=2'],
    ['https://example.org/a?x=1&amp;copy;=2&amp;#65;', 'https://example.org/a?x=1&copy;=2&#65;'],
    ['https://example.org/a b', 'https://example.org/a b'],
    ['https://example.org/a\\_b\\\\c\\', 'https://example.org/a\\_b\\\\c\\'],
  ];
  const external = (href: string) => `<a rel="nofollow" class="external text" href="${href}">x</a>`;
  const html = [
    '<p><sup class="reference"><a href="#cite_note-:0-26">[26]</a></sup>',
    '<sup class="reference"><a href="#cite_note-2">[2]</a></sup>',
    '<sup class="reference"><a href="#cite_note-3">[3]</a></sup></p>',
    '<ol class="references">',
    `<li id="cite_note-:0-26"><span class="reference-text">${LINKS.map(([href]) => external(href)).join(' ')}</span></li>`,
    '<li id="cite_note-2"><span class="reference-text"><a href="#CITEREFStar2017">Star 2017</a>.</span></li>',
    `<li id="cite_note-3"><span class="reference-text">${external('//example.org/x_-_y')}</span></li>`,
    '</ol>',
    `<ul><li><cite id="CITEREFStar2017" class="citation">Star (2017). ${external(ASTERISK_PDF)}.</cite></li></ul>`,
  ].join('');

  it('links each URL to its structuredContent value byte for byte, labelled with its host', async () => {
    stubParse('en.wikipedia.org', () => ({
      parse: { title: 'M*A*S*H (TV series)', pageid: 1, revid: 7, text: html },
    }));
    const result = await runToolContract(wikipediaGetReferences, { title: 'M*A*S*H (TV series)' });
    const out = page(result);

    // structuredContent carries each URL as the page links it.
    expect(out.url).toBe('https://en.wikipedia.org/wiki/M*A*S*H_(TV_series)');
    expect(out.references.map((entry) => entry.urls)).toEqual([
      LINKS.map(([, url]) => url),
      undefined,
      ['//example.org/x_-_y'],
    ]);
    expect(out.works).toEqual([
      { id: 'CITEREFStar2017', text: 'Star (2017). x.', urls: [ASTERISK_PDF] },
    ]);

    // content[] links every absolute http(s) URL, in order, to exactly that URL.
    const markdown = text(result);
    const targets = parseTargets(markdown);
    expect(targets.map((target) => target.href)).toEqual([
      out.url,
      ...LINKS.map(([, url]) => url),
      ASTERISK_PDF,
    ]);
    expect(targets.every((target) => target.kind === 'link')).toBe(true);
    expect(targets.map((target) => target.text)).toEqual(
      targets.map((target) => new URL(target.href).hostname),
    );
    expect(markdown).toContain(
      '**URL:** [en.wikipedia.org](<https://en.wikipedia.org/wiki/M*A*S*H_(TV_series)>)',
    );
    expect(markdown).toContain(`\n  URL: [d-scholarship.pitt.edu](<${ASTERISK_PDF}>)\n`);
    // A protocol-relative URL cannot be a link destination; it stays text that reads back unchanged.
    expect(parseInlineText(markdown)).toContain('[3] cite_note-3\nx\nURL: //example.org/x_-_y');
  });
});

describe('wikipedia_get_references — errors', () => {
  const baseCursor = {
    kind: 'wikipedia_references_v1',
    title: 'Seine',
    language: 'en',
    revisionId: 1381786474,
    offset: 10,
    limit: REFERENCES_PAGE_MAX_BYTES,
  };

  it.each([
    { input: { title: '   ' }, reason: 'not_found', code: JsonRpcErrorCode.NotFound },
    { input: { title: 'A<B' }, reason: 'invalid_title', code: JsonRpcErrorCode.ValidationError },
    {
      input: { title: 'Seine', language: 'zz' },
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
    },
    {
      input: { title: 'Seine', language: 'en us' },
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
    },
    ...[
      'bad',
      encodeCursor({ ...baseCursor, title: 'Loire' }),
      encodeCursor({ ...baseCursor, language: 'fr' }),
      encodeCursor({ ...baseCursor, offset: 0 }),
      encodeCursor({ ...baseCursor, offset: 1.5 }),
      encodeCursor({ ...baseCursor, revisionId: 0 }),
      encodeCursor({ ...baseCursor, limit: 100 }),
      encodeCursor({ ...baseCursor, kind: 'wikipedia_table_v1' }),
      encodeCursor({ ...baseCursor, extra: true }),
    ].map((cursor) => ({
      input: { title: 'Seine', cursor },
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
    })),
  ])('fails $reason before any article fetch', async ({ input, reason, code }) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runToolContract(wikipediaGetReferences, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code, data: { reason } } });
    expect(text(result)).toContain(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps upstream missingtitle and invalidtitle envelopes to the declared reasons', async () => {
    stubParse('en.wikipedia.org', (params) =>
      params.get('page') === 'Zzxqv no such article 72'
        ? {
            error: {
              code: 'missingtitle',
              info: "The page you specified doesn't exist.",
            },
          }
        : { error: { code: 'invalidtitle', info: 'Bad title "Seine:". ' } },
    );
    const missing = await runToolContract(wikipediaGetReferences, {
      title: 'Zzxqv no such article 72',
    });
    expect(missing.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
    expect(text(missing)).toContain('wikipedia_search_articles');

    const invalid = await runToolContract(wikipediaGetReferences, { title: 'Seine:' });
    expect(invalid.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_title' } },
    });
  });

  it.each([
    {
      name: 'an error envelope',
      reply: { error: { code: 'nosuchrevid', info: 'There is no revision with ID 1381786474.' } },
    },
    { name: 'a different revision', reply: { parse: { ...SEINE.parse, revid: 1381786475 } } },
    { name: 'no HTML', reply: { parse: { title: 'Seine', revid: 1381786474 } } },
  ])('fails revision_unavailable when the pinned revision returns $name', async ({ reply }) => {
    const http = stubParse('en.wikipedia.org', () => reply);
    const result = await runToolContract(wikipediaGetReferences, {
      title: 'Seine',
      cursor: encodeCursor(baseCursor),
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'revision_unavailable' },
      },
    });
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.request.url).searchParams.get('oldid')).toBe('1381786474');
  });

  /** Retrying a cursor pinned to a gone or hidden revision never succeeds; a transient miss may. */
  const RETRY_OR_RESTART =
    'Retry the same cursor if the failure was transient; if the pinned revision no longer exists or is hidden, omit cursor to start over at the current revision.';

  it.each([
    // What the parse API answers for a nonexistent oldid and for a revision-deleted one.
    { upstreamCode: 'nosuchrevid', info: 'There is no revision with ID 1381786474.' },
    {
      upstreamCode: 'permissiondenied',
      info: "You don't have permission to view deleted text or changes between deleted revisions.",
    },
  ])(
    'tells the caller to start over, not retry, when the pinned revision is gone ($upstreamCode)',
    async ({ upstreamCode, info }) => {
      stubParse('en.wikipedia.org', (params) =>
        params.has('oldid') ? { error: { code: upstreamCode, info } } : SEINE,
      );
      const result = await runToolContract(wikipediaGetReferences, {
        title: 'Seine',
        cursor: encodeCursor(baseCursor),
      });
      const hint =
        'Omit cursor to start over at the current revision; retrying this cursor cannot succeed.';
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: `The references cursor is pinned to revision 1381786474, which no longer exists or is hidden (${upstreamCode}).`,
          data: {
            reason: 'revision_unavailable',
            revisionId: 1381786474,
            upstreamCode,
            recovery: { hint },
          },
        },
      });
      expect(text(result)).toContain(`Recovery: ${hint}`);
      expect(text(result)).not.toContain('Retry');

      // Following the hint works: the same title without the cursor reads the current revision.
      const restarted = page(await runToolContract(wikipediaGetReferences, { title: 'Seine' }));
      expect(restarted).toMatchObject({ revision_id: '1381786474', total_references: 57 });
    },
  );

  it.each([
    {
      name: 'another error envelope',
      reply: { error: { code: 'internal_api_error_DBQueryError', info: 'Database error' } },
      message:
        'The pinned references revision 1381786474 could not be read (internal_api_error_DBQueryError).',
      data: { revisionId: 1381786474, upstreamCode: 'internal_api_error_DBQueryError' },
    },
    {
      name: 'no HTML',
      reply: { parse: { title: 'Seine', revid: 1381786474 } },
      message:
        'The references response did not contain the requested revision and HTML. Retry the same request.',
      data: {},
    },
  ])(
    'keeps retry first when the pinned revision may still be readable ($name)',
    async ({ reply, message, data }) => {
      stubParse('en.wikipedia.org', () => reply);
      const result = await runToolContract(wikipediaGetReferences, {
        title: 'Seine',
        cursor: encodeCursor(baseCursor),
      });
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message,
          data: {
            reason: 'revision_unavailable',
            ...data,
            recovery: { hint: RETRY_OR_RESTART },
          },
        },
      });
      expect(text(result)).toContain(`Recovery: ${RETRY_OR_RESTART}`);
    },
  );

  it('declares revision_unavailable with a recovery true for both a gone and a transient revision', () => {
    expect(
      wikipediaGetReferences.errors?.find((entry) => entry.reason === 'revision_unavailable'),
    ).toMatchObject({
      when: 'The revision the cursor is pinned to no longer exists, is hidden, or cannot be read or verified.',
      recovery: RETRY_OR_RESTART,
    });
  });

  it('rethrows caller cancellation instead of returning a page', async () => {
    const caller = new AbortController();
    const http = createFetchMock([
      {
        match: (request) => new URL(request.url).hostname === 'en.wikipedia.org',
        respond: () => {
          caller.abort();
          throw new DOMException('Stop references read', 'AbortError');
        },
      },
    ]);
    http.install();
    onTestFinished(() => {
      http.restore();
    });
    const result = await runToolContract(
      wikipediaGetReferences,
      { title: 'Seine' },
      { context: { signal: caller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(text(result)).toContain('was aborted');
    expect(http.calls).toHaveLength(1);
  });
});

describe('wikipedia_get_article — section reads still drop footnotes (#72 regression)', () => {
  it('drops markers and reference lists from the same parser HTML the references read uses', async () => {
    stubParse('en.wikipedia.org', () => SEINE);
    const result = await runToolContract(wikipediaGetArticle, {
      title: 'Seine',
      section_index: 18,
    });
    const content = (result.structuredContent as { content: string }).content;
    expect(content).not.toMatch(/\[\d+\]/);
    expect(content).not.toContain('Fiche cours d');
    expect(content).not.toContain('eaufrance');
  });
});
