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

/** Action API parse/sections response. */
export type ActionSectionsRaw = {
  parse?: {
    title?: string;
    pageid?: number;
    sections?: Array<{
      toclevel?: number;
      level?: string;
      line?: string;
      number?: string;
      index?: string;
      fromtitle?: string;
      byteoffset?: number | null;
      anchor?: string;
    }>;
  };
  error?: { code?: string; info?: string };
};

/** Action API parse/wikitext response. */
export type ActionWikitextRaw = {
  parse?: {
    title?: string;
    pageid?: number;
    wikitext?: { '*'?: string };
  };
  error?: { code?: string; info?: string };
};

/** Action API langlinks response. */
export type ActionLangLinksRaw = {
  query?: {
    pages?: Record<
      string,
      {
        pageid?: number;
        title?: string;
        missing?: string;
        langlinks?: Array<{
          lang: string;
          url: string;
          '*': string;
        }>;
      }
    >;
  };
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
