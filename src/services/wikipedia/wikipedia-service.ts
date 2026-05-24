/**
 * @fileoverview Wikipedia service — wraps the MediaWiki REST API and Action API.
 * @module services/wikipedia/wikipedia-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
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
  const headingPattern = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  const headings: Array<{ level: number; title: string; position: number }> = [];
  for (const m of wikitext.matchAll(headingPattern)) {
    const eqMarker = m[1];
    const headingTitle = m[2];
    if (eqMarker && headingTitle) {
      headings.push({ level: eqMarker.length, title: headingTitle, position: m.index ?? 0 });
    }
  }

  // Prepend headings as == Heading == markers when present and not already in text.
  const firstHeading = headings[0];
  if (firstHeading && !text.startsWith(firstHeading.title)) {
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

// ---------------------------------------------------------------------------
// Strip HTML snippet markup from Action API search results
// ---------------------------------------------------------------------------

function stripSnippetHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ---------------------------------------------------------------------------
// Language code validation (BCP 47 basic check)
// ---------------------------------------------------------------------------

function buildBaseUrl(language: string): string {
  // Language codes are 2-3 chars (ISO 639-1/639-2) with optional subtags.
  if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
    throw validationError(
      `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
      { recovery: { hint: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".' } },
    );
  }
  return `https://${language.toLowerCase()}.wikipedia.org`;
}

// ---------------------------------------------------------------------------
// WikipediaService
// ---------------------------------------------------------------------------

export class WikipediaService {
  constructor(
    _config: AppConfig,
    _storage: StorageService,
    private readonly userAgent: string,
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
    const base = buildBaseUrl(language);
    const url = `${base}/api/rest_v1${path}`;
    const signal = (ctx as { signal?: AbortSignal }).signal;
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: this.headers(),
          ...(signal ? { signal } : {}),
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
    const base = buildBaseUrl(language);
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    const url = `${base}/w/api.php?${qs}`;
    const signal = (ctx as { signal?: AbortSignal }).signal;
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx, {
          headers: this.headers(),
          ...(signal ? { signal } : {}),
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
      // fetchWithTimeout maps 404 → NotFound McpError; re-throw with domain message.
      if (
        err instanceof Error &&
        (err.message.includes('status code 404') || err.message.includes('NotFound'))
      ) {
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

  /** Full-text search across Wikipedia articles. */
  async search(
    query: string,
    limit: number,
    language: string,
    ctx: RequestContextLike,
  ): Promise<{
    results: Array<{ title: string; pageid: number; snippet: string; wordcount: number }>;
    totalResults: number;
  }> {
    const raw = await this.actionGet<ActionSearchRaw>(
      language,
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(Math.min(limit, 50)),
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
      },
      ctx,
    );

    const pages = raw.query?.pages;
    if (!pages) throw serviceUnavailable('Unexpected response shape from Wikipedia extracts API.');

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

    const wikitext = raw.parse?.wikitext?.['*'] ?? '';
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
    pageid: number | undefined;
    sections: Array<{ index: number; number: string; title: string; level: number }>;
  }> {
    const raw = await this.actionGet<ActionSectionsRaw>(
      language,
      { action: 'parse', page: title, prop: 'sections' },
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

    const rawSections = raw.parse?.sections ?? [];

    // Fallback: if sections is empty, parse == headers from full-article text.
    if (rawSections.length === 0) {
      const fullArticle = await this.getArticleFull(title, language, ctx);
      const headerPattern = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
      const fallbackSections: Array<{
        index: number;
        number: string;
        title: string;
        level: number;
      }> = [];
      let idx = 1;
      for (const m of fullArticle.content.matchAll(headerPattern)) {
        const eqMarker = m[1];
        const hdrTitle = m[2];
        if (eqMarker && hdrTitle) {
          const currentIdx = idx++;
          fallbackSections.push({
            index: currentIdx,
            number: String(currentIdx),
            title: hdrTitle,
            level: eqMarker.length,
          });
        }
      }
      return { pageid: fullArticle.pageid, sections: fallbackSections };
    }

    const sections = rawSections
      .filter((s) => s.index !== undefined)
      .map((s) => ({
        index: parseInt(s.index ?? '0', 10),
        number: s.number ?? '',
        title: s.line ?? '',
        level: parseInt(s.level ?? '2', 10),
      }));

    return { pageid: raw.parse?.pageid, sections };
  }

  /** List language editions available for an article. */
  async getLanguages(
    title: string,
    sourceLanguage: string,
    ctx: RequestContextLike,
  ): Promise<{
    languages: Array<{ languageCode: string; title: string; url: string }>;
  }> {
    const raw = await this.actionGet<ActionLangLinksRaw>(
      sourceLanguage,
      {
        action: 'query',
        titles: title,
        prop: 'langlinks',
        lllimit: '500',
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
      page.langlinks?.map((ll) => ({
        languageCode: ll.lang,
        title: ll['*'],
        url: ll.url,
      })) ?? [];

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
): void {
  _service = new WikipediaService(config, storage, userAgent);
}

export function getWikipediaService(): WikipediaService {
  if (!_service) {
    throw new Error('WikipediaService not initialized — call initWikipediaService() in setup()');
  }
  return _service;
}
