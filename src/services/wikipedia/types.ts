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

/** Redirect hops in traversal order, including an optional destination fragment. */
export type ActionRedirectRaw = { from?: string; to?: string; tofragment?: string };

/**
 * The flags an `action=query` page entry carries for a title that can name no page. A
 * `missing !== undefined` test alone reads either kind as an existing, empty page.
 */
export type UnnameablePageRaw = {
  /**
   * A title MediaWiki cannot name a page with (`Foo[bar]`, `A<B`, `Talk:`), with `invalidreason`
   * saying why. The entry carries no `missing` key.
   */
  invalid?: boolean;
  invalidreason?: string;
  /**
   * A title in a namespace that holds no pages: Special: (ns −1) or Media: (ns −2), under any of
   * the edition's names for them. `missing` rides beside it when the special page or file does
   * not exist.
   */
  special?: boolean;
};

/**
 * One `query.interwiki` entry: a title whose prefix links to another wiki (`wikt:cat`, `fr:Chat`).
 * The API lists such a title here instead of returning a page entry for it.
 */
export type ActionInterwikiRaw = { title?: string; iw?: string };

/** REST API summary response shape (partial — only fields we use). */
export type RestSummaryRaw = {
  type?: string;
  title?: string;
  pageid?: number;
  wikibase_item?: string;
  description?: string;
  /** Plain-text extract. Superscripts and subscripts are flattened into the text beside them. */
  extract?: string;
  /** The same extract as HTML, with `<sup>`/`<sub>` and list structure intact. */
  extract_html?: string;
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
    searchinfo?: {
      totalhits?: number;
      /**
       * CirrusSearch's spelling correction for the query (`srinfo` defaults to include it). Arrives
       * on non-empty pages too, and is absent when the query has no near-miss.
       */
      suggestion?: string;
    };
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

/**
 * Action API full-read response:
 * `prop=extracts|info|revisions|pageprops&inprop=url&rvprop=ids|timestamp&ppprop=disambiguation`.
 *
 * Without `explaintext`, `extract` is TextExtracts' HTML mode — bare `<hN>` headings, inline
 * formatting and `<sup>`/`<sub>` kept, tables and infoboxes already stripped upstream — which the
 * API itself warns "may be malformed and/or unbalanced".
 */
export type ActionExtractsRaw = {
  query?: {
    redirects?: ActionRedirectRaw[];
    interwiki?: ActionInterwikiRaw[];
    pages?: Record<
      string,
      UnnameablePageRaw & {
        pageid?: number;
        title?: string;
        extract?: string;
        missing?: string;
        /** `prop=info&inprop=url`: the canonical article URL. */
        fullurl?: string;
        /**
         * `prop=revisions` with no `rvlimit` on a single title: the current revision alone. Its
         * `timestamp` is when that revision was saved — unlike `prop=info`'s `touched`, which is a
         * cache-invalidation time and moves without an edit.
         */
        revisions?: Array<{ revid?: number; timestamp?: string }>;
        /**
         * `prop=pageprops&ppprop=disambiguation`: present, as `{ disambiguation: "" }`, only on a
         * page carrying the `disambiguation` page property — the one the REST summary's `type`
         * reads. Every other page has no `pageprops` key at all.
         */
        pageprops?: { disambiguation?: string };
      }
    >;
  };
  error?: ActionApiErrorRaw;
};

/**
 * Action API parse response for the table of contents (`prop=tocdata`), with the page's
 * categories and page properties when the request adds `categories|properties`.
 *
 * Replaces the deprecated `prop=sections`, whose entries lived at `parse.sections[]`. `tocdata`
 * nests them under `parse.tocdata.sections[]` and renames several fields: `toclevel`→`tocLevel`,
 * `level`→`hLevel` (now a number, previously a string), `byteoffset`→`codepointOffset`,
 * `fromtitle`→`fromTitle`. `line`, `number`, `index`, and `anchor` are unchanged.
 */
export type ActionSectionsRaw = {
  parse?: {
    redirects?: ActionRedirectRaw[];
    title?: string;
    pageid?: number;
    /**
     * `prop=categories`, hidden maintenance categories included. `category` is the database key —
     * no namespace prefix, underscores for spaces (`1648_treaties`); `hidden: true` appears only on
     * a hidden category, and a visible one carries no `hidden` key.
     */
    categories?: Array<{ sortkey?: string; category?: string; hidden?: boolean }>;
    /**
     * `prop=properties` (formatversion=2: an object). `disambiguation` is present, as `""`, only on
     * a page MediaWiki marks as a disambiguation page.
     */
    properties?: { disambiguation?: string };
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
    redirects?: ActionRedirectRaw[];
    title?: string;
    pageid?: number;
    /** `prop=revid`: the revision the text was parsed from. `action=parse` has no timestamp prop. */
    revid?: number;
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
    interwiki?: ActionInterwikiRaw[];
    pages?: Record<
      string,
      UnnameablePageRaw & {
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

/**
 * One page's `prop=description|pageprops&ppprop=wikibase_item` entry (formatversion=2).
 *
 * `description` is the local short description, falling back to Wikidata's. A page whose short
 * description is explicitly "none" carries it as an empty string, and a page with no Wikidata item
 * has no `pageprops` at all. A requested page that no longer exists arrives as `missing: true` with
 * neither.
 */
export type ActionPageMetaRaw = {
  pageid?: number;
  title?: string;
  missing?: boolean;
  description?: string;
  pageprops?: { wikibase_item?: string };
};

/** `action=query&pageids=…&prop=description|pageprops` response — the search follow-up lookup. */
export type ActionPageMetaQueryRaw = {
  query?: { pages?: ActionPageMetaRaw[] };
  error?: ActionApiErrorRaw;
};

/**
 * Action API geosearch response.
 *
 * `geosearch` is `list=geosearch`: the distance-ordered result set, with each article's own
 * GeoData coordinate and its distance. `pages` is the same geosearch run as a generator in the
 * same request, carrying each page's description and Wikidata QID in pageid order.
 */
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
    pages?: ActionPageMetaRaw[];
  };
  error?: ActionApiErrorRaw;
};
