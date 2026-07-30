/**
 * @fileoverview Domain types for the Wikipedia service layer.
 * @module services/wikipedia/types
 */

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
};

/** Action API extracts response (for full article text). */
export type ActionExtractsRaw = {
  query?: {
    pages?: Record<
      string,
      {
        pageid?: number;
        title?: string;
        extract?: string;
        missing?: string;
      }
    >;
  };
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
  error?: { code?: string; info?: string };
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
  error?: { code?: string; info?: string };
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
      {
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
};
