/**
 * @fileoverview Domain types for the Wikipedia service layer.
 * @module services/wikipedia/types
 */

/**
 * The Action API's top-level error envelope.
 *
 * It arrives on HTTP 200 — `format=json` carries a refusal in the body rather than in the status —
 * so nothing in the transport layer intercepts it. Every raw Action API response type below
 * declares it, and every call site reads it before trusting the payload; a response shape that
 * omits it renders an upstream refusal as an empty success.
 */
export type ActionApiErrorRaw = { code?: string; info?: string };

/**
 * An `action=query` page entry for a title MediaWiki cannot name a page with (`Foo[bar]`, `A<B`).
 * The entry carries `invalid` with no `missing` key, so a `missing !== undefined` test alone reads
 * it as an existing page and reports it as empty rather than as unnameable.
 */
export type InvalidPageRaw = {
  invalid?: boolean;
  invalidreason?: string;
};

/** REST API summary response shape (partial — only fields we use). */
export type RestSummaryRaw = {
  type?: string;
  title?: string;
  pageid?: number;
  wikibase_item?: string;
  description?: string;
  extract?: string;
  thumbnail?: {
    source?: string;
    width?: number;
    height?: number;
  };
  /**
   * Geographic coordinate of the article subject, present only for a geotagged article.
   *
   * A non-geotagged article carries the key with an explicit `null` rather than omitting it, so
   * the type is nullable and the mapping treats `null` the same as absent.
   */
  coordinates?: { lat?: number; lon?: number } | null;
  /** Canonical article URLs per rendering; `desktop.page` is the citable article URL. */
  content_urls?: { desktop?: { page?: string } };
  /** Revision ID the extract was taken from, serialized as a string. */
  revision?: string;
  /** ISO 8601 timestamp of that revision. */
  timestamp?: string;
};

/** Action API search result entry. */
export type ActionSearchResult = {
  title: string;
  pageid: number;
  snippet: string;
  wordcount?: number;
};

/** Action API search query response. */
export type ActionSearchRaw = {
  query?: {
    searchinfo?: { totalhits?: number };
    search?: ActionSearchResult[];
  };
  /**
   * Present exactly when more results remain past the current page; `sroffset` is the offset to
   * request next. Absent at the end of the result set. The tool derives `nextOffset` from this
   * upstream signal rather than computing `offset + limit`.
   */
  continue?: { sroffset?: number };
  error?: ActionApiErrorRaw;
};

/** Action API extracts response (for full article text). */
export type ActionExtractsRaw = {
  query?: {
    pages?: Record<
      string,
      InvalidPageRaw & {
        pageid?: number;
        title?: string;
        extract?: string;
        missing?: string;
      }
    >;
  };
  error?: ActionApiErrorRaw;
};

/**
 * Action API parse response for the table of contents (`prop=tocdata`).
 *
 * Replaces the deprecated `prop=sections`, whose entries lived at `parse.sections[]`. `tocdata`
 * nests them under `parse.tocdata.sections[]` and renames several fields: `toclevel`→`tocLevel`,
 * `level`→`hLevel` (now a number, previously a string), `byteoffset`→`codepointOffset`,
 * `fromtitle`→`fromTitle`. `line`, `number`, `index`, and `anchor` are unchanged.
 */
export type ActionSectionsRaw = {
  parse?: {
    title?: string;
    pageid?: number;
    tocdata?: {
      sections?: Array<{
        tocLevel?: number;
        hLevel?: number;
        line?: string;
        number?: string;
        index?: string;
        fromTitle?: string;
        codepointOffset?: number | null;
        anchor?: string;
      }>;
    };
  };
  error?: ActionApiErrorRaw;
};

/**
 * Action API parse response for rendered section HTML (`prop=text`, formatversion=2 shape).
 *
 * With `section=N` the payload is that section plus every subsection nested under it, and an
 * out-of-range index arrives as `error.code === 'nosuchsection'` rather than an empty body.
 */
export type ActionParseTextRaw = {
  parse?: {
    title?: string;
    pageid?: number;
    /** formatversion=2: plain string. formatversion=1 used `{ '*': string }` — no longer used. */
    text?: string;
  };
  error?: ActionApiErrorRaw;
};

/**
 * Action API langlinks response (formatversion=2 shape, llprop=url).
 *
 * With `redirects=true` the page entry is the redirect *target*, so `pages[].title` is the
 * resolved article title rather than the requested alias.
 */
export type ActionLangLinksRaw = {
  query?: {
    pages?: Record<
      string,
      InvalidPageRaw & {
        pageid?: number;
        /** Resolved article title — the redirect target when the request followed one. */
        title?: string;
        missing?: string;
        langlinks?: Array<{
          lang: string;
          /** formatversion=2: plain key. formatversion=1 used `'*'` — no longer used. */
          title: string;
          /** Present when llprop=url is passed. */
          url?: string;
        }>;
      }
    >;
  };
  error?: ActionApiErrorRaw;
};

/**
 * One language's row in an `action=sitematrix` response.
 *
 * `site[]` lists every project for that language; the Wikipedia edition is the entry whose
 * `code` is `wiki`. `closed` marks a read-only edition — the host still answers, so a closed
 * edition is a valid `language` input.
 */
export type SiteMatrixLanguage = {
  code?: string;
  site?: Array<{
    url?: string;
    code?: string;
    closed?: boolean;
  }>;
};

/**
 * `action=sitematrix` response (formatversion=2, `smtype=language`).
 *
 * `sitematrix` is an object, not an array: every language sits under a numeric-string key
 * (`"0"`, `"1"`, …) alongside a `count` number. `specials` — the non-language wikis, whose
 * `wikipedia.org` members are ArbCom, test, anniversary, and archive hosts rather than any
 * language edition — is omitted by `smtype=language`, so nothing here reads it.
 *
 * `simple` (Simple English) is a language row like any other, not a special.
 */
export type SiteMatrixRaw = {
  /** Values are {@link SiteMatrixLanguage} under numeric keys and a number under `count`. */
  sitematrix?: Record<string, unknown>;
  error?: ActionApiErrorRaw;
};

/** Action API geosearch response. */
export type ActionGeoSearchRaw = {
  query?: {
    geosearch?: Array<{
      pageid: number;
      ns: number;
      title: string;
      lat: number;
      lon: number;
      dist: number;
    }>;
  };
  error?: ActionApiErrorRaw;
};
