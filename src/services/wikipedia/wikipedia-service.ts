/**
 * @fileoverview Wikipedia service — wraps the MediaWiki REST API and Action API.
 * @module services/wikipedia/wikipedia-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import wtf from 'wtf_wikipedia';
import type {
  ActionExtractsRaw,
  ActionGeoSearchRaw,
  ActionLangLinksRaw,
  ActionSearchRaw,
  ActionSectionsRaw,
  ActionWikitextRaw,
  RestSummaryRaw,
} from './types.js';

// ---------------------------------------------------------------------------
// Wikitext stripping pipeline
// ---------------------------------------------------------------------------

/**
 * Matches a section-heading line in wikitext or a plain-text extract (`== Title ==`,
 * `=== Title ===`, up to level 6). Group 1 is the leading `=` run, group 2 the trimmed title.
 * Global + multiline; only ever consumed via `String.prototype.matchAll`, which clones the regex
 * internally, so sharing this single instance across call sites is safe (no `lastIndex` bleed).
 */
const HEADING_LINE = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;

/**
 * Strip MediaWiki markup from raw wikitext and return clean plain text.
 * Uses wtf_wikipedia for the heavy lifting, then applies heading-preservation
 * and blank-line normalization as a post-pass.
 */
function stripWikitext(wikitext: string): string {
  // wtf_wikipedia handles links, templates, refs, bold/italic
  const doc = wtf(wikitext);
  let text = doc.text();

  // Preserve section headings — wtf strips them, but we want structure.
  // Re-inject from the raw wikitext using a simple regex pass.
  const headings = [...wikitext.matchAll(HEADING_LINE)].flatMap((m) => {
    const level = m[1]?.length;
    const title = m[2];
    return level && title ? [{ level, title }] : [];
  });

  // Prepend headings as == Heading == markers when present and not already in text.
  if (headings[0] && !text.startsWith(headings[0].title)) {
    const headingMarkers = headings
      .map(({ level, title }) => `${'='.repeat(level)} ${title} ${'='.repeat(level)}`)
      .join('\n\n');
    text = `${headingMarkers}\n\n${text}`;
  }

  // Remove HTML comments that may have survived.
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Collapse multiple blank lines to a single blank line.
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Split a plain-text article extract into per-section parts on its preserved `== Heading ==`
 * markers (via the shared {@link HEADING_LINE}). Text before the first heading becomes the
 * `Introduction` lead; each subsequent heading opens a part whose body runs to the next heading.
 * Empty parts are dropped. Pure and exported — the overflow-outline pre-shaping in
 * `wikipedia_get_article` relies on it, and it is unit-tested directly.
 */
export function splitArticleIntoSections(
  content: string,
): Array<{ heading: string; body: string }> {
  const matches = [...content.matchAll(HEADING_LINE)];
  const parts: Array<{ heading: string; body: string }> = [];

  const firstStart = matches[0]?.index ?? content.length;
  const lead = content.slice(0, firstStart).trim();
  if (lead) parts.push({ heading: 'Introduction', body: lead });

  for (const [i, m] of matches.entries()) {
    const heading = m[2] ?? `Section ${i + 1}`;
    const bodyStart = (m.index ?? 0) + (m[0] ?? '').length;
    const bodyEnd = matches[i + 1]?.index ?? content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();
    parts.push({ heading, body });
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Strip HTML snippet markup from Action API search results
// ---------------------------------------------------------------------------

function stripSnippetHtml(html: string): string {
  const stripped = html.replace(/<[^>]+>/g, '');
  // Decode the most common HTML entities that the Action API leaves in snippets.
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

// ---------------------------------------------------------------------------
// Language code validation
// ---------------------------------------------------------------------------

/**
 * Known Wikipedia language edition codes (subdomains that exist as wikipedia.org editions).
 * Sourced from https://meta.wikimedia.org/wiki/List_of_Wikipedias — stable set of ~300 codes.
 * A structurally valid BCP 47 code that is NOT in this set will time out after 4 retries (~60s)
 * and leak the full API URL in the error message, so we validate eagerly.
 */
const KNOWN_WIKIPEDIA_EDITIONS = new Set([
  'en',
  'de',
  'fr',
  'ja',
  'es',
  'ru',
  'zh',
  'pt',
  'ar',
  'it',
  'fa',
  'pl',
  'nl',
  'uk',
  'he',
  'sv',
  'ko',
  'vi',
  'ca',
  'no',
  'fi',
  'cs',
  'hu',
  'ro',
  'tr',
  'id',
  'th',
  'sr',
  'ms',
  'eo',
  'eu',
  'da',
  'bg',
  'sk',
  'min',
  'hr',
  'et',
  'lt',
  'simple',
  'sl',
  'az',
  'la',
  'ur',
  'be',
  'ce',
  'nn',
  'cy',
  'hy',
  'ka',
  'el',
  'uz',
  'gl',
  'lv',
  'bn',
  'ta',
  'mk',
  'sh',
  'hi',
  'af',
  'bs',
  'kk',
  'war',
  'mg',
  'te',
  'sq',
  'oc',
  'mr',
  'tl',
  'ml',
  'ceb',
  'br',
  'ast',
  'be-tarask',
  'azb',
  'pa',
  'zh-yue',
  'an',
  'lb',
  'is',
  'ba',
  'my',
  'fy',
  'wuu',
  'sw',
  'yo',
  'ga',
  'new',
  'tt',
  'gu',
  'kn',
  'io',
  'ia',
  'or',
  'su',
  'ne',
  'ckb',
  'si',
  'cv',
  'ps',
  'fo',
  'scn',
  'nds',
  'bpy',
  'qu',
  'diq',
  'li',
  'bar',
  'als',
  'mn',
  'sa',
  'jv',
  'sco',
  'roa-tara',
  'as',
  'mzn',
  'nah',
  'ace',
  'pnb',
  'am',
  'wa',
  'lmo',
  'tg',
  'pms',
  'nds-nl',
  'ku',
  'ky',
  'vec',
  'sc',
  'os',
  'arz',
  'vls',
  'rue',
  'frr',
  'hif',
  'zh-min-nan',
  'crh',
  'sd',
  'bo',
  'vep',
  'hak',
  'hat',
  'se',
  'bcl',
  'km',
  'tk',
  'krc',
  'gag',
  'nso',
  'ab',
  'xmf',
  'sah',
  'map-bms',
  'mi',
  'hsb',
  'szl',
  'nrm',
  'pcd',
  'ksh',
  'lij',
  'mhr',
  'ug',
  'bxr',
  'glk',
  'zh-classical',
  'roa-rup',
  'stq',
  'co',
  'frp',
  'kv',
  'so',
  'kw',
  'mwl',
  'to',
  'csb',
  'myv',
  'lad',
  'rm',
  'ie',
  'bjn',
  'ln',
  'fur',
  'ang',
  'ext',
  'cbk-zam',
  'mt',
  'xh',
  'eml',
  'ilo',
  'wo',
  'sn',
  'za',
  'pfl',
  'gd',
  'nap',
  'ig',
  'tw',
  'tet',
  'fiu-vro',
  'ay',
  'got',
  'bm',
  'chy',
  'kl',
  'tpi',
  'bh',
  'aa',
  'ki',
  'ff',
  'cu',
  'sm',
  'gn',
  'ts',
  'tn',
  'cr',
  'sg',
  'ty',
  'ss',
  've',
  'iu',
  'ch',
  'st',
  'hz',
  'rw',
  'ee',
  'lg',
  'pi',
  'ii',
]);

/**
 * Resolve the base URL for MediaWiki API calls.
 *
 * With a single-instance override configured (`WIKIPEDIA_BASE_URL`), every call routes at that
 * fixed host and the per-call `language` no longer varies it — the mode for a private mirror or an
 * alternate MediaWiki instance, which may host any editions, so no Wikipedia-specific checks run.
 *
 * Without an override (the default), the host is composed per language as
 * `https://<language>.wikipedia.org` after validating the code's BCP 47 structure and that it names
 * an existing Wikipedia edition.
 *
 * Exported for unit testing. A pure utility — it cannot call `ctx.fail`, so tool handlers
 * pre-validate (structural check, plus `isUnknownEdition` in compose mode) via
 * `ctx.fail('invalid_language', ...)` to satisfy the typed contract; the throws here are the
 * defence-in-depth fallback for direct service callers.
 */
export function buildBaseUrl(language: string, baseUrlOverride?: string): string {
  // Single-instance override: fixed host, language is not used to construct it.
  if (baseUrlOverride) {
    return baseUrlOverride.replace(/\/+$/, '');
  }
  // Structure check — must look like a BCP 47 code.
  if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
    throw validationError(
      `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
      { recovery: { hint: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".' } },
    );
  }
  const normalized = language.toLowerCase();
  // Edition check — structurally valid codes may not correspond to an existing Wikipedia edition.
  // Without this check a non-existent subdomain causes 4 retries × 15s timeout and URL leakage.
  if (!KNOWN_WIKIPEDIA_EDITIONS.has(normalized)) {
    throw validationError(
      `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
      {
        language,
        recovery: {
          hint: 'Use a Wikipedia language code that has an active edition, such as "fr", "de", or "ja".',
        },
      },
    );
  }
  return `https://${normalized}.wikipedia.org`;
}

/**
 * Extract the Wikipedia edition subdomain (the first host label) from an article URL — the value a
 * caller passes as `language` to other tools. Degrades to the language code if the URL cannot be
 * parsed, so a single malformed langlink never fails the whole call.
 */
function editionCodeFromUrl(url: string, fallbackLang: string): string {
  try {
    return new URL(url).hostname.split('.')[0] || fallbackLang;
  } catch {
    return fallbackLang;
  }
}

// ---------------------------------------------------------------------------
// WikipediaService
// ---------------------------------------------------------------------------

export class WikipediaService {
  constructor(
    _config: AppConfig,
    _storage: StorageService,
    private readonly userAgent: string,
    /**
     * Optional single-instance base-URL override (`WIKIPEDIA_BASE_URL`). When set, every request
     * routes at this fixed host and the per-call `language` no longer varies it.
     */
    readonly baseUrl?: string,
  ) {}

  /** Shared fetch headers for all requests. */
  private headers(): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
  }

  /** GET from the REST API (`/api/rest_v1/`). */
  async restGet<T>(language: string, path: string, ctx: RequestContextLike): Promise<T> {
    const base = buildBaseUrl(language, this.baseUrl);
    const url = `${base}/api/rest_v1${path}`;
    const signal = (ctx as { signal?: AbortSignal }).signal;
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: this.headers(),
          ...(signal && { signal }),
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Wikipedia REST API returned HTML instead of JSON — likely rate-limited or under maintenance.',
          );
        }
        return JSON.parse(text) as T;
      },
      { operation: 'WikipediaService.restGet', context: ctx, baseDelayMs: 1000 },
    );
  }

  /** GET from the Action API (`/w/api.php`). */
  async actionGet<T>(
    language: string,
    params: Record<string, string>,
    ctx: RequestContextLike,
  ): Promise<T> {
    const base = buildBaseUrl(language, this.baseUrl);
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    const url = `${base}/w/api.php?${qs}`;
    const signal = (ctx as { signal?: AbortSignal }).signal;
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: this.headers(),
          ...(signal && { signal }),
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Wikipedia Action API returned HTML instead of JSON — likely rate-limited or under maintenance.',
          );
        }
        return JSON.parse(text) as T;
      },
      { operation: 'WikipediaService.actionGet', context: ctx, baseDelayMs: 1000 },
    );
  }

  // ---------------------------------------------------------------------------
  // Domain methods
  // ---------------------------------------------------------------------------

  /** Fetch the REST summary for an article. */
  async getSummary(
    title: string,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{
    title: string;
    pageType: string;
    pageid: number | undefined;
    wikidataQid: string | undefined;
    description: string | undefined;
    extract: string;
    thumbnailUrl: string | undefined;
  }> {
    const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));

    let raw: RestSummaryRaw;
    try {
      raw = await this.restGet<RestSummaryRaw>(language, `/page/summary/${encodedTitle}`, ctx);
    } catch (err: unknown) {
      // fetchWithTimeout throws a McpError with code NotFound for 404 responses.
      // Match by error code (reliable) rather than message text (fragile).
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(
          `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search to find the correct title.`,
          {
            title,
            language,
            recovery: { hint: 'Use wikipedia_search to find the correct article title.' },
          },
        );
      }
      throw err;
    }

    if (!raw.extract) {
      throw notFound(`Article "${title}" exists but has no readable content.`, { title, language });
    }

    return {
      title: raw.title ?? title,
      pageType: raw.type ?? 'article',
      pageid: raw.pageid,
      wikidataQid: raw.wikibase_item,
      description: raw.description,
      extract: raw.extract,
      thumbnailUrl: raw.thumbnail?.source,
    };
  }

  /**
   * Full-text search across Wikipedia articles.
   *
   * `offset` trails `ctx` with a default so existing four-argument callers keep working — the
   * pagination change stays additive at the call level. It maps to the Action API `sroffset`
   * (this server's own `Math.min(limit, 50)` page-size cap is orthogonal to it). `nextOffset`
   * echoes the API's own `continue.sroffset`, present only while more results remain.
   */
  async search(
    query: string,
    limit: number,
    language: string,
    ctx: RequestContextLike,
    offset = 0,
  ): Promise<{
    results: Array<{ title: string; pageid: number; snippet: string; wordcount: number }>;
    totalResults: number;
    nextOffset: number | undefined;
  }> {
    const raw = await this.actionGet<ActionSearchRaw>(
      language,
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(Math.min(limit, 50)),
        sroffset: String(offset),
        srprop: 'snippet|wordcount',
      },
      ctx,
    );

    const results =
      raw.query?.search?.map((r) => ({
        title: r.title,
        pageid: r.pageid,
        snippet: stripSnippetHtml(r.snippet),
        wordcount: r.wordcount ?? 0,
      })) ?? [];

    return {
      results,
      totalResults: raw.query?.searchinfo?.totalhits ?? results.length,
      nextOffset: raw.continue?.sroffset,
    };
  }

  /** Fetch full article plain text via Action API extracts. */
  async getArticleFull(
    title: string,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{ title: string; pageid: number | undefined; content: string }> {
    const raw = await this.actionGet<ActionExtractsRaw>(
      language,
      {
        action: 'query',
        titles: title,
        prop: 'extracts',
        explaintext: 'true',
        exsectionformat: 'wiki',
        // Resolve redirects server-side so aliases (e.g. "NYC" → "New York City") return the
        // target's content and pageid, matching getSummary's REST behavior.
        redirects: 'true',
      },
      ctx,
    );

    const pages = raw.query?.pages;
    // When `pages` is absent the API received an empty or invalid title rather than a valid
    // (but missing) article. Map this to not_found — same user-visible outcome.
    if (!pages) {
      throw notFound(
        `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search to find the correct title.`,
        { title, language },
      );
    }

    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) {
      throw notFound(
        `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search to find the correct title.`,
        { title, language },
      );
    }

    if (!page.extract) {
      throw notFound(`Article "${title}" exists but has no readable content.`, { title, language });
    }

    return {
      title: page.title ?? title,
      pageid: page.pageid,
      content: page.extract,
    };
  }

  /** Fetch a single section's wikitext and strip it to plain text. */
  async getArticleSection(
    title: string,
    sectionIndex: number,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{ title: string; pageid: number | undefined; sectionTitle: string; content: string }> {
    const raw = await this.actionGet<ActionWikitextRaw>(
      language,
      {
        action: 'parse',
        page: title,
        prop: 'wikitext',
        section: String(sectionIndex),
        // Resolve redirects so a section read on an alias (e.g. "NYC") targets the resolved
        // article; without it the alias stub has no sections and the API returns nosuchsection.
        redirects: 'true',
      },
      ctx,
    );

    if (raw.error) {
      const errCode = raw.error.code ?? '';
      if (errCode === 'nosuchsection') {
        throw validationError(
          `Section index ${sectionIndex} does not exist in "${title}". Call wikipedia_get_sections to get valid index values.`,
          {
            title,
            sectionIndex,
            recovery: { hint: 'Call wikipedia_get_sections to obtain valid section_index values.' },
          },
        );
      }
      if (errCode === 'missingtitle') {
        throw notFound(
          `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search to find the correct title.`,
          { title, language },
        );
      }
      throw serviceUnavailable(`Wikipedia API error: ${raw.error.info ?? errCode}`);
    }

    // formatversion=2: wikitext is a plain string, not { '*': string }.
    const wikitext = raw.parse?.wikitext ?? '';
    const content = stripWikitext(wikitext);

    // Derive section title from the first heading in the wikitext.
    const headingMatch = /^={2,6}\s*(.+?)\s*={2,6}/m.exec(wikitext);
    const sectionTitle = headingMatch?.[1] ?? `Section ${sectionIndex}`;

    return {
      title: raw.parse?.title ?? title,
      pageid: raw.parse?.pageid,
      sectionTitle,
      content,
    };
  }

  /** Fetch section table of contents for an article. */
  async getSections(
    title: string,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    sections: Array<{ index: number; number: string; title: string; level: number }>;
  }> {
    const raw = await this.actionGet<ActionSectionsRaw>(
      language,
      // prop=tocdata replaces the deprecated prop=sections (same data, renamed/renested fields).
      // redirects resolves aliases (e.g. "NYC" → "New York City") like the other read paths.
      { action: 'parse', page: title, prop: 'tocdata', redirects: 'true' },
      ctx,
    );

    if (raw.error) {
      const errCode = raw.error.code ?? '';
      if (errCode === 'missingtitle') {
        throw notFound(
          `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search to find the correct title.`,
          { title, language },
        );
      }
      throw serviceUnavailable(`Wikipedia API error: ${raw.error.info ?? errCode}`);
    }

    const resolvedTitle = raw.parse?.title ?? title;
    const rawSections = raw.parse?.tocdata?.sections ?? [];

    // Fallback: if tocdata has no sections, derive headers from full-article text.
    if (rawSections.length === 0) {
      const fullArticle = await this.getArticleFull(title, language, ctx);
      let idx = 0;
      const fallbackSections = [...fullArticle.content.matchAll(HEADING_LINE)].flatMap((m) => {
        const level = m[1]?.length;
        const headingTitle = m[2];
        if (!level || !headingTitle) return [];
        const i = ++idx;
        return [{ index: i, number: String(i), title: headingTitle, level }];
      });
      return { title: fullArticle.title, pageid: fullArticle.pageid, sections: fallbackSections };
    }

    const sections = rawSections
      .filter((s) => s.index !== undefined)
      .map((s) => ({
        index: parseInt(s.index ?? '0', 10),
        number: s.number ?? '',
        title: s.line ?? '',
        // hLevel is a number under tocdata (prop=sections' level was a string).
        level: s.hLevel ?? 2,
      }));

    return { title: resolvedTitle, pageid: raw.parse?.pageid, sections };
  }

  /** List language editions available for an article. */
  async getLanguages(
    title: string,
    sourceLanguage: string,
    ctx: RequestContextLike,
  ): Promise<{
    languages: Array<{ languageCode: string; editionCode: string; title: string; url: string }>;
  }> {
    const raw = await this.actionGet<ActionLangLinksRaw>(
      sourceLanguage,
      {
        action: 'query',
        titles: title,
        prop: 'langlinks',
        lllimit: '500',
        llprop: 'url',
      },
      ctx,
    );

    const pages = raw.query?.pages;
    if (!pages) throw serviceUnavailable('Unexpected response shape from Wikipedia langlinks API.');

    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) {
      throw notFound(
        `No Wikipedia article found for "${title}" in language "${sourceLanguage}". Use wikipedia_search to find the correct title.`,
        { title, language: sourceLanguage },
      );
    }

    const languages =
      page.langlinks?.map((ll) => {
        // url is populated because we pass llprop=url; compose a host only if the API omits it.
        const url =
          ll.url ??
          `https://${ll.lang}.wikipedia.org/wiki/${encodeURIComponent(ll.title.replace(/ /g, '_'))}`;
        return {
          languageCode: ll.lang,
          // The subdomain that actually serves the edition — the value usable as `language` on
          // other tools. Derived from the real host so it stays correct when the MediaWiki code and
          // the Wikipedia subdomain diverge (e.g. code "gsw" lives on subdomain "als").
          editionCode: editionCodeFromUrl(url, ll.lang),
          // formatversion=2: title is a plain key, not '*'.
          title: ll.title,
          url,
        };
      }) ?? [];

    return { languages };
  }

  /** Find geotagged Wikipedia articles near a coordinate. */
  async searchNearby(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    limit: number,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{
    results: Array<{
      title: string;
      pageid: number;
      latitude: number;
      longitude: number;
      distance_meters: number;
    }>;
  }> {
    const raw = await this.actionGet<ActionGeoSearchRaw>(
      language,
      {
        action: 'query',
        list: 'geosearch',
        gscoord: `${latitude}|${longitude}`,
        gsradius: String(Math.min(radiusMeters, 10_000)),
        gslimit: String(Math.min(limit, 50)),
      },
      ctx,
    );

    const results =
      raw.query?.geosearch?.map((r) => ({
        title: r.title,
        pageid: r.pageid,
        latitude: r.lat,
        longitude: r.lon,
        distance_meters: r.dist,
      })) ?? [];

    return { results };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: WikipediaService | undefined;

export function initWikipediaService(
  config: AppConfig,
  storage: StorageService,
  userAgent: string,
  baseUrl?: string,
): void {
  _service = new WikipediaService(config, storage, userAgent, baseUrl);
}

export function getWikipediaService(): WikipediaService {
  if (!_service) {
    throw new Error('WikipediaService not initialized — call initWikipediaService() in setup()');
  }
  return _service;
}

/**
 * Report whether `language` is a structurally-valid code that names no existing Wikipedia edition —
 * the signal a tool handler uses to reject it with the typed `invalid_language` contract before any
 * network call, mirroring how the structural BCP 47 check is already pre-validated in-handler.
 *
 * Returns `false` whenever a single-instance base-URL override is configured: that mode fixes the
 * host and may serve any editions, so the Wikipedia-specific edition list must not gate it.
 */
export function isUnknownEdition(language: string): boolean {
  if (_service?.baseUrl) return false;
  return !KNOWN_WIKIPEDIA_EDITIONS.has(language.toLowerCase());
}

/**
 * Report whether `title` is blank or whitespace-only — the signal a tool handler uses to reject it
 * with the typed `not_found` contract before any network call. A blank title otherwise leaks an
 * inconsistent generic upstream error that varies by endpoint (an absent `query` object, an
 * `invalidtitle` API error, or a 403 whose raw message carries the fetch URL); the pre-fetch guard
 * normalizes all of them to one typed result, mirroring how `isUnknownEdition` pre-validates
 * language codes in-handler.
 */
export function isBlankTitle(title: string): boolean {
  return !title.trim();
}
