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
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, logger, withExtra, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  ActionExtractsRaw,
  ActionGeoSearchRaw,
  ActionLangLinksRaw,
  ActionParseTextRaw,
  ActionSearchRaw,
  ActionSectionsRaw,
  RestSummaryRaw,
  SiteMatrixLanguage,
  SiteMatrixRaw,
} from './types.js';

// ---------------------------------------------------------------------------
// Parser-HTML → plain-text pipeline
// ---------------------------------------------------------------------------

/**
 * Matches a section-heading line in wikitext or a plain-text extract (`== Title ==`,
 * `=== Title ===`, up to level 6). Group 1 is the leading `=` run, group 2 the trimmed title.
 * Global + multiline; only ever consumed via `String.prototype.matchAll`, which clones the regex
 * internally, so sharing this single instance across call sites is safe (no `lastIndex` bleed).
 */
const HEADING_LINE = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;

/** Open-tag test for one class token, compiled once per rule. */
function hasClass(token: string): (openTag: string) => boolean {
  const re = new RegExp(`class\\s*=\\s*"[^"]*\\b${token}\\b`, 'i');
  return (openTag) => re.test(openTag);
}

/**
 * `role="presentation"` is the parser's own marker for a table it lays content out in rather than
 * one holding data — set by `{{col-begin}}`, succession boxes, and the other layout templates — so
 * it tracks new layout templates instead of a hand-maintained class list.
 */
const PRESENTATION_ROLE = /\brole\s*=\s*"presentation"/i;

/**
 * MediaWiki's marker for page furniture that is not article content. Maintenance banners
 * (`{{Update}}` and the rest of the ambox family) are `role="presentation"` tables carrying it, so
 * the marker is what separates a layout table wrapping real prose from one wrapping an editor
 * notice about the article.
 *
 * On its own it does not establish that an element is furniture — see {@link isFurniture}.
 */
const NOT_CONTENT = /\bclass\s*=\s*"[^"]*\bmetadata\b/i;

/** Whether a table lays out article content, and so must survive rather than be dropped. */
function isLayoutTable(openTag: string): boolean {
  return PRESENTATION_ROLE.test(openTag) && !NOT_CONTENT.test(openTag);
}

/** The parser's marker for an element that points elsewhere rather than carrying prose. */
const NAVIGATION_ROLE = /\brole\s*=\s*"navigation"/i;

/**
 * Container families whose entire body is furniture, on whatever tag they are emitted.
 *
 * `side-box` is the `{{Side box}}` family — `{{Library resources box}}`, `{{Sister project links}}`,
 * `{{Portal}}` — a `<div>` the `<table>` rule never reaches. `ambox` is the maintenance-banner
 * family, which several editions emit as a `<div>` where English Wikipedia emits a
 * `role="presentation"` table the existing rule already drops.
 *
 * Both are read only together with {@link NOT_CONTENT}, which is what keeps `{{Listen}}` — a side box
 * without the marker — whose captions describe the recording in the article's own voice and are
 * prose, not chrome.
 */
const FURNITURE_BOX = /\bclass\s*=\s*"[^"]*\b(?:side-box|ambox)\b/i;

/**
 * Whether an element is page furniture, judged from its open tag whatever its tag name.
 *
 * {@link NOT_CONTENT} alone does not decide this. French Wikipedia's `{{Article détaillé}}` — the
 * pointer to the fuller article on a subtopic, the counterpart of English Wikipedia's `{{Main}}` — is
 * `<div class="bandeau-container bandeau-section metadata bandeau-niveau-information">`, so the marker
 * also sits on links a reader is meant to follow. `fr:Paris` carries 46 of those against 7
 * maintenance banners of the same `bandeau-container … metadata` shape, so dropping every element
 * carrying the marker deletes several times more content there than furniture.
 *
 * What the furniture has in common is that the marker sits on a self-contained box or bar rather than
 * on an inline pointer: one of the {@link FURNITURE_BOX} families, or an element the page marks
 * `role="navigation"` (`{{Portal bar}}`, `{{Sister bar}}`, the sister-project boxes). A hatnote is
 * `role="note"` and keeps its text either way.
 */
function isFurniture(openTag: string): boolean {
  return (
    NOT_CONTENT.test(openTag) && (FURNITURE_BOX.test(openTag) || NAVIGATION_ROLE.test(openTag))
  );
}

/** An element MediaWiki hides from the rendered page with an inline style. */
const HIDDEN_BY_STYLE = /\bstyle\s*=\s*"[^"]*display\s*:\s*none/i;

/**
 * Elements dropped whole from parser HTML, keyed by tag name. Each value tests the element's own
 * open tag, so a rule reaches only the elements carrying the artifact it is written for.
 *
 * `figure` goes because the plain-text conventions of the full-article extract path drop it too.
 * `table` goes unless {@link isLayoutTable} — a layout table wraps ordinary lists and paragraphs,
 * so dropping it takes real prose with it. `div.spoken-wikipedia` is `{{Spoken Wikipedia}}`, whose
 * body is a duration, the revision date the recording was read from, and a disclaimer that later
 * edits are not reflected — claims about the article rather than any of its content, and the audio
 * itself is not reachable from plain text. It carries neither the `metadata` marker nor `side-box`,
 * so {@link isFurniture} does not reach it.
 *
 * The rest are artifacts of asking the parser for one section in isolation: for a section that cites
 * something, `sup.reference` is the `[1]` footnote marker whose target is not in the payload,
 * `ol.references` is the reference list the parser appends after the content, and
 * `span.mw-ext-cite-error` is its complaint that the article's `<references/>` tag lives in a section
 * this payload does not contain. A section citing nothing carries none of the three.
 */
const DROP_RULES: Readonly<Record<string, (openTag: string) => boolean>> = {
  style: () => true,
  script: () => true,
  figure: () => true,
  table: (openTag) => !isLayoutTable(openTag),
  div: hasClass('spoken-wikipedia'),
  sup: hasClass('reference'),
  ol: hasClass('references'),
  span: hasClass('mw-ext-cite-error'),
};

/**
 * Tags with no end tag. A nesting walk started from one would find no close and consume the rest of
 * the payload, so they are never treated as containers — the generic tag strip removes them.
 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Any element's open tag; group 1 is the tag name. Held without the global flag and cloned per scan,
 * so no `lastIndex` from one document's walk can bleed into the next.
 */
const OPEN_TAG = /<([a-z][a-z0-9]*)\b[^>]*>/i;

/**
 * The Math extension's rendered formula: a `display:none` MathML twin for screen readers, then an
 * `<img>` whose `alt` carries the TeX the article itself stores. Dropping the hidden twin removes
 * the MathML leaf text that otherwise renders as a column of single glyphs; recovering the `alt`
 * keeps the formula, which lived only inside that twin's `<annotation>` before.
 */
const MATH_FALLBACK_IMAGE =
  /<img\b[^>]*\bclass\s*=\s*"[^"]*\bmwe-math-fallback-image-[^"]*"[^>]*>/gi;

/** The `alt` attribute of a single tag, still HTML-escaped as the parser emitted it. */
const ALT_ATTRIBUTE = /\balt\s*=\s*"([^"]*)"/i;

/** Named HTML entities the MediaWiki parser emits, beyond the numeric escapes handled generically. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** One entity: a decimal reference, a hex reference, or a name. */
const HTML_ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

/**
 * Index just past the end tag closing the `tagName` element whose body starts at `from`, honoring
 * nesting so an inner element of the same tag does not end the outer one — the ordinary case for
 * Wikipedia tables, where a non-greedy match would stop at an inner `</table>` and spill the outer
 * table's remaining cells into the text as prose. An unclosed element runs to the end of `html`.
 */
function elementEnd(html: string, tagName: string, from: number): number {
  const boundary = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');
  boundary.lastIndex = from;
  let depth = 1;
  for (let next = boundary.exec(html); next; next = boundary.exec(html)) {
    depth += next[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return next.index + next[0].length;
  }
  return html.length;
}

/**
 * Whether an element must be dropped whole, judged from its open tag alone.
 *
 * The hidden-element test comes first and is tag-agnostic: MediaWiki hides screen-reader MathML and
 * unrendered gadget chrome behind an inline `display:none` on whatever element wraps them, so an
 * enumeration of gadget class names would keep needing new entries. Whatever the page does not
 * render is not content. {@link isFurniture} is tag-agnostic for the same reason — the box families
 * it names are emitted as a `<div>` on one edition and a `<table>` on another.
 */
function isDropped(openTag: string, tagName: string): boolean {
  return (
    HIDDEN_BY_STYLE.test(openTag) ||
    isFurniture(openTag) ||
    (DROP_RULES[tagName]?.(openTag) ?? false)
  );
}

/**
 * Remove every element {@link isDropped} selects, in one pass over `html`'s open tags.
 *
 * A selected element is removed with its whole subtree, so a nested selection inside it needs no
 * separate visit. An element that is *not* selected is walked into, so a data table nested in a
 * layout table still goes while the layout table's own content survives.
 */
function dropElements(html: string): string {
  const openTag = new RegExp(OPEN_TAG.source, 'gi');
  let kept = '';
  let cursor = 0;
  for (let open = openTag.exec(html); open; open = openTag.exec(html)) {
    const tagName = (open[1] as string).toLowerCase();
    if (VOID_TAGS.has(tagName) || !isDropped(open[0], tagName)) continue;

    const end = elementEnd(html, tagName, open.index + open[0].length);
    kept += html.slice(cursor, open.index);
    cursor = end;
    openTag.lastIndex = end;
  }
  return kept + html.slice(cursor);
}

/**
 * Decode the HTML escapes the MediaWiki parser emits.
 *
 * One left-to-right pass, so a decoded ampersand is never re-read as the start of another entity:
 * an article that writes about a character reference reaches here as `&amp;#39;` and must decode to
 * the literal text `&#39;`, not to `'`. Chained passes cannot express that, and where the inner
 * reference is outside Unicode's range (`&amp;#1114112;`) the second pass has no character to
 * produce at all. An unrecognized name or an out-of-range code point keeps its escape as written.
 */
function decodeEntities(text: string): string {
  return text.replace(
    HTML_ENTITY,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code = dec === undefined ? Number.parseInt(hex as string, 16) : Number(dec);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/**
 * Sentinel wrapping a `<pre>` block's index while the surrounding text is whitespace-normalized.
 * `U+FFFF` is a permanent noncharacter, so no parser output can collide with it, and it is not
 * whitespace, so the collapsing passes leave it in place.
 */
const PRE_SENTINEL = /\uFFFF(\d+)\uFFFF/g;

/**
 * Convert the MediaWiki parser's HTML for one section (`action=parse&prop=text`) into the same
 * plain-text shape the full-article extract path returns: `== Heading ==` markers in document
 * order, paragraphs separated by a blank line, list items one per line.
 *
 * Sourcing section reads from rendered HTML rather than raw wikitext is what makes inline templates
 * survive — `{{code|if}}` reaches this function already expanded to `if`, where a wikitext stripper
 * has to re-implement the template grammar and drops what it cannot expand.
 *
 * `<pre>` blocks keep their internal line breaks and indentation while everything around them is
 * collapsed, because in a code sample indentation is syntax — an unindented Python listing reads as
 * valid code and is not, which is worse than omitting it.
 *
 * Pure and exported for unit testing.
 */
export function htmlSectionToPlainText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, '');

  // Lift each formula out of its `<img alt>` before anything is dropped, so the TeX survives the
  // removal of the hidden MathML twin that used to be its only carrier. The alt is inserted still
  // escaped, so the single decode pass below reads it exactly once.
  text = text.replace(MATH_FALLBACK_IMAGE, (match) => ALT_ATTRIBUTE.exec(match)?.[1] ?? '');

  text = dropElements(text);

  // Park preformatted blocks behind sentinels so the whitespace pass cannot flatten them.
  const preBlocks: string[] = [];
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, body: string) => {
    preBlocks.push(body);
    return `\n\n\uFFFF${preBlocks.length - 1}\uFFFF\n\n`;
  });

  // Headings become the `== Heading ==` markers both read paths use for structure.
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_match, level: string, inner: string) => {
      const bar = '='.repeat(Math.max(2, Number(level)));
      return `\n\n${bar} ${inner.replace(/<[^>]+>/g, '').trim()} ${bar}\n\n`;
    },
  );

  // A list item is one line; every other block boundary is a paragraph break. `tr`/`td`/`th` are
  // boundaries because a layout table's cells reach here — without them two columns of a
  // `{{col-begin}}` list concatenate into one line.
  text = decodeEntities(
    text
      // Closing tag first, consuming the newline that follows it, so consecutive items land on
      // consecutive lines instead of being separated by a blank one.
      .replace(/<\/li\s*>\s*/gi, '')
      .replace(/<li\b[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|ul|ol|dl|dd|dt|blockquote|section|tr|td|th)\b[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  );

  text = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.replace(PRE_SENTINEL, (match, index: string) => {
    const body = preBlocks[Number(index)];
    if (body === undefined) return match;
    return decodeEntities(body.replace(/<[^>]+>/g, ''))
      .replace(/[^\S\n]+$/gm, '')
      .replace(/^\n+|\n+$/g, '');
  });
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

/** Drop the `<span class="searchmatch">` highlight markup a snippet carries, then unescape it. */
function stripSnippetHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
}

// ---------------------------------------------------------------------------
// Language code validation
// ---------------------------------------------------------------------------

/**
 * Shape a `language` input must have before any edition lookup is attempted. The first subtag spans
 * BCP 47's full 2–8 character range for a language subtag, which is also what `simple`
 * (simple.wikipedia.org) needs — a real edition a 2–3 character bound rejects outright.
 */
const STRUCTURAL_LANGUAGE_RE = /^[a-z]{2,8}(-[a-z0-9]+)*$/i;

/**
 * Report whether `language` cannot name any edition on shape alone — the cheap check a tool handler
 * runs before {@link WikipediaService.isUnknownEdition} so a malformed code is rejected with the
 * typed `invalid_language` contract and a "not a valid code" message, distinct from the
 * "edition does not exist" message a well-formed but unknown code gets.
 */
export function isMalformedLanguage(language: string): boolean {
  return !STRUCTURAL_LANGUAGE_RE.test(language);
}

/**
 * Offline fallback edition subdomains — the hand-maintained allowlist this server shipped
 * before the sitematrix registry replaced it, used only while the live registry is unavailable.
 *
 * It is materially incomplete (Wikipedia runs ~360 editions), which is why it is no longer the
 * primary check. What it still buys on the degraded path is the guard's original purpose: a
 * structurally valid but nonexistent subdomain is rejected up front instead of burning four
 * retries and leaking the fetch URL in the error message.
 *
 * Entries are subdomains only. Editions whose MediaWiki language code differs from their
 * subdomain (`gsw` → `als.wikipedia.org`) appear on the subdomain side alone, so the language-code
 * spelling resolves only while the live registry is available.
 */
const FALLBACK_EDITION_SUBDOMAINS = [
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
] as const;

/** Fallback subdomain → canonical origin, for the degraded resolution path. */
const FALLBACK_EDITION_HOSTS: ReadonlyMap<string, string> = new Map(
  FALLBACK_EDITION_SUBDOMAINS.map((code) => [code, `https://${code}.wikipedia.org`]),
);

/**
 * Every Wikipedia edition indexed by each code a caller may legitimately pass: the edition's
 * subdomain, and its MediaWiki language code when the two differ. Both spellings map to the same
 * canonical origin, so `als` and `gsw` alike resolve to `https://als.wikipedia.org` — which is
 * what lets the langlinks host fallback compose a real host from a language code.
 */
export type EditionIndex = {
  /** Lowercased edition code → `https://<subdomain>.wikipedia.org`. */
  hosts: Record<string, string>;
  /** ISO timestamp the index was built from a sitematrix response. */
  fetchedAt: string;
};

/** How long a fetched edition index is trusted, in seconds. Editions are created rarely. */
const EDITION_INDEX_TTL_SECONDS = 86_400;

/**
 * How long a failed index build suppresses further attempts, in milliseconds. Without it a
 * Wikipedia outage would re-attempt the sitematrix fetch on every single call, so the guard meant
 * to make bad input fail fast would itself become the slow path.
 */
const EDITION_INDEX_RETRY_AFTER_FAILURE_MS = 60_000;

/** Storage key for the cached index. The framework key validator rejects `:` separators. */
const EDITION_INDEX_STORAGE_KEY = 'wikipedia/edition-index';

/** Host the sitematrix is always read from — the endpoint is replicated across every edition. */
const SITEMATRIX_HOST = 'https://en.wikipedia.org';

/**
 * Upstream ceiling for `list=geosearch`'s `gslimit`, per `action=paraminfo`. The module's
 * `highmax` of 5000 requires the `apihighlimits` right, which an anonymous caller never has, so
 * 500 is the real bound.
 */
export const GEOSEARCH_MAX_LIMIT = 500;

/**
 * Bounds `action=paraminfo` reports for `list=geosearch`'s `gsradius`. Below the floor upstream
 * answers `outofrange` rather than an empty result, so the floor is enforced at the tool's schema;
 * above the ceiling the radius is clamped, which keeps a working over-wide call working.
 */
export const GEOSEARCH_MIN_RADIUS_METERS = 10;
export const GEOSEARCH_MAX_RADIUS_METERS = 10_000;

function assertStructuralLanguage(language: string): void {
  if (isMalformedLanguage(language)) {
    throw validationError(
      `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
      { recovery: { hint: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".' } },
    );
  }
}

function unknownEditionError(language: string): McpError {
  return validationError(
    `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
    {
      language,
      recovery: {
        hint: 'Use a Wikipedia language code that has an active edition, such as "fr", "de", or "ja".',
      },
    },
  );
}

/**
 * Build an {@link EditionIndex} from an `action=sitematrix` response.
 *
 * Pure and exported for unit testing. Closed editions are kept: a closed wiki is read-only, not
 * gone — `aa.wikipedia.org` still answers, and dropping them would newly reject codes that work.
 * Subdomains are indexed first so a language code can never displace a real subdomain's host.
 */
export function parseSiteMatrix(raw: SiteMatrixRaw): EditionIndex {
  const editions: Array<{ subdomain: string; code: string | undefined; origin: string }> = [];

  for (const [key, value] of Object.entries(raw.sitematrix ?? {})) {
    // Languages live under numeric-string keys; `count` (a number) is a sibling of them.
    if (!/^\d+$/.test(key) || typeof value !== 'object' || value === null) continue;
    const language = value as SiteMatrixLanguage;
    const wiki = language.site?.find((site) => site.code === 'wiki');
    if (!wiki?.url) continue;
    try {
      const { origin, hostname } = new URL(wiki.url);
      const subdomain = hostname.split('.')[0];
      if (subdomain) editions.push({ subdomain, code: language.code, origin });
    } catch {
      // A malformed url for one language must not discard the rest of the matrix.
    }
  }

  const hosts: Record<string, string> = {};
  for (const { subdomain, origin } of editions) hosts[subdomain.toLowerCase()] = origin;
  for (const { code, origin } of editions) if (code) hosts[code.toLowerCase()] ??= origin;

  if (Object.keys(hosts).length === 0) {
    throw serviceUnavailable('Wikipedia sitematrix response listed no language editions.');
  }
  return { hosts, fetchedAt: new Date().toISOString() };
}

/**
 * Resolve the base URL for MediaWiki API calls from the offline fallback set.
 *
 * With a single-instance override configured (`WIKIPEDIA_BASE_URL`), every call routes at that
 * fixed host and the per-call `language` no longer varies it — the mode for a private mirror or an
 * alternate MediaWiki instance, which may host any editions, so no Wikipedia-specific checks run.
 *
 * Without an override this composes `https://<language>.wikipedia.org` after checking the code's
 * BCP 47 structure and its membership in {@link FALLBACK_EDITION_SUBDOMAINS}. It is the degraded
 * path only — {@link WikipediaService.resolveBaseUrl} consults the live sitematrix index first and
 * falls back here when that index cannot be built.
 *
 * Exported for unit testing. A pure utility — it cannot call `ctx.fail`, so tool handlers
 * pre-validate (structural check, plus `WikipediaService.isUnknownEdition` in compose mode) via
 * `ctx.fail('invalid_language', ...)` to satisfy the typed contract; the throws here are the
 * defence-in-depth fallback for direct service callers.
 */
export function buildBaseUrl(language: string, baseUrlOverride?: string): string {
  // Single-instance override: fixed host, language is not used to construct it.
  if (baseUrlOverride) {
    return baseUrlOverride.replace(/\/+$/, '');
  }
  assertStructuralLanguage(language);
  const host = FALLBACK_EDITION_HOSTS.get(language.toLowerCase());
  // Without this check a nonexistent subdomain causes 4 retries × 15s timeout and URL leakage.
  if (!host) throw unknownEditionError(language);
  return host;
}

/**
 * Extract the Wikipedia edition subdomain (the first host label) from an article URL — the value a
 * caller passes as `language` to other tools. Returns `undefined` for a URL that cannot be parsed,
 * so a single malformed langlink degrades to an omitted field rather than a guessed code.
 */
function editionCodeFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.split('.')[0] || undefined;
  } catch {
    return;
  }
}

// ---------------------------------------------------------------------------
// WikipediaService
// ---------------------------------------------------------------------------

/**
 * The context every service method takes: the canonical {@link RequestContext} the logger and
 * storage layer read, plus the live `AbortSignal` a handler context carries.
 *
 * `RequestContext` is closed and declares no `signal` — it is the serializable projection, and the
 * network helpers strip non-serializable fields from the context they are handed. Cancellation has
 * to be wired through `fetchWithTimeout`'s own `signal` option instead, so the type names the field
 * rather than casting to reach it. A caller holding only a plain `RequestContext` still satisfies
 * this: the request simply runs to its timeout with nothing to cancel it early.
 */
type ServiceContext = RequestContext & { signal?: AbortSignal };

export class WikipediaService {
  /** Process-local index cache, so a warm process never re-reads storage per call. */
  private indexMemo?: { index: EditionIndex; expiresAt: number };

  /** Shared in-flight build, so concurrent calls issue one sitematrix fetch between them. */
  private indexInFlight: Promise<EditionIndex | undefined> | undefined;

  /** Epoch ms until which a failed build suppresses further attempts. */
  private indexRetryAfter = 0;

  constructor(
    _config: AppConfig,
    private readonly storage: StorageService,
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

  /**
   * Fetch, JSON-parse, and retry one MediaWiki endpoint.
   *
   * MediaWiki serves an HTML error page under rate limiting and maintenance, so a leading
   * doctype is remapped to a retryable `serviceUnavailable` rather than a JSON parse failure.
   */
  private async apiGet<T>(
    url: string,
    operation: string,
    apiLabel: string,
    ctx: ServiceContext,
    options: { expectedStatuses?: number[]; timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<T> {
    const { signal } = ctx;
    return await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, options.timeoutMs ?? 15_000, ctx, {
          headers: this.headers(),
          ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
          ...(signal && { signal }),
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            `Wikipedia ${apiLabel} returned HTML instead of JSON — likely rate-limited or under maintenance.`,
          );
        }
        return JSON.parse(text) as T;
      },
      {
        operation,
        context: ctx,
        baseDelayMs: 1000,
        ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
      },
    );
  }

  /**
   * GET from the REST API (`/api/rest_v1/`).
   *
   * `expectedStatuses` lists statuses the caller treats as an outcome rather than a failure — a
   * listed status logs at `debug` instead of `error` while the thrown, status-mapped `McpError`
   * is unchanged. `getSummary` passes `[404]` because it remaps a miss to a friendly `notFound`.
   */
  async restGet<T>(
    language: string,
    path: string,
    ctx: ServiceContext,
    options: { expectedStatuses?: number[] } = {},
  ): Promise<T> {
    const base = await this.resolveBaseUrl(language, ctx);
    return await this.apiGet<T>(
      `${base}/api/rest_v1${path}`,
      'WikipediaService.restGet',
      'REST API',
      ctx,
      options,
    );
  }

  /** GET from the Action API (`/w/api.php`). */
  async actionGet<T>(
    language: string,
    params: Record<string, string>,
    ctx: ServiceContext,
  ): Promise<T> {
    const base = await this.resolveBaseUrl(language, ctx);
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    return await this.apiGet<T>(
      `${base}/w/api.php?${qs}`,
      'WikipediaService.actionGet',
      'Action API',
      ctx,
    );
  }

  // ---------------------------------------------------------------------------
  // Edition registry
  // ---------------------------------------------------------------------------

  /**
   * Read the authoritative edition set from `action=sitematrix`.
   *
   * The network seam of the registry, kept public so tests can stub it without stubbing
   * `actionGet` (which routes through the registry itself). Always reads `en.wikipedia.org`: the
   * endpoint returns the whole matrix from any edition, and going through per-language resolution
   * would recurse. Retries once rather than the default three — a caller is waiting on a guard
   * whose value is failing fast, and the fallback set covers the miss.
   */
  async fetchEditionIndex(ctx: ServiceContext): Promise<EditionIndex> {
    const qs = new URLSearchParams({
      action: 'sitematrix',
      format: 'json',
      formatversion: '2',
      smtype: 'language',
      smsiteprop: 'url|code',
      smlangprop: 'code|site',
    }).toString();
    const raw = await this.apiGet<SiteMatrixRaw>(
      `${SITEMATRIX_HOST}/w/api.php?${qs}`,
      'WikipediaService.fetchEditionIndex',
      'sitematrix API',
      ctx,
      { timeoutMs: 10_000, maxRetries: 1 },
    );
    return parseSiteMatrix(raw);
  }

  /**
   * The live edition index, or `undefined` when it cannot be built.
   *
   * Reads the process memo, then the injected `StorageService`, then the sitematrix endpoint,
   * caching each success under {@link EDITION_INDEX_TTL_SECONDS}. An `undefined` return is the
   * signal to degrade to {@link FALLBACK_EDITION_SUBDOMAINS} — never to open the gate, and never
   * to fail a call that would otherwise have succeeded. Returns `undefined` immediately in
   * single-instance override mode: that host may serve any editions, so no Wikipedia edition set
   * describes it and no sitematrix fetch is warranted.
   */
  private async editionIndex(ctx: ServiceContext): Promise<EditionIndex | undefined> {
    if (this.baseUrl) return;

    const now = Date.now();
    if (this.indexMemo && this.indexMemo.expiresAt > now) return this.indexMemo.index;
    if (now < this.indexRetryAfter) return;
    this.indexInFlight ??= this.buildEditionIndex(ctx).finally(() => {
      this.indexInFlight = undefined;
    });
    return await this.indexInFlight;
  }

  private async buildEditionIndex(ctx: ServiceContext): Promise<EditionIndex | undefined> {
    try {
      const cached = await this.storage.get<EditionIndex>(EDITION_INDEX_STORAGE_KEY, ctx);
      if (cached?.hosts && Object.keys(cached.hosts).length > 0) {
        this.memoize(cached);
        return cached;
      }
    } catch (err) {
      logger.warning(
        'Wikipedia edition index unreadable from storage; refetching.',
        withExtra(ctx, { error: err instanceof Error ? err.message : String(err) }),
      );
    }

    try {
      const index = await this.fetchEditionIndex(ctx);
      this.memoize(index);
      await this.storage
        .set(EDITION_INDEX_STORAGE_KEY, index, ctx, { ttl: EDITION_INDEX_TTL_SECONDS })
        .catch((err: unknown) => {
          logger.warning(
            'Wikipedia edition index could not be persisted; memo only.',
            withExtra(ctx, { error: err instanceof Error ? err.message : String(err) }),
          );
        });
      return index;
    } catch (err) {
      this.indexRetryAfter = Date.now() + EDITION_INDEX_RETRY_AFTER_FAILURE_MS;
      logger.warning(
        'Wikipedia sitematrix unavailable; falling back to the offline edition set, which rejects some real editions.',
        withExtra(ctx, { error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
  }

  private memoize(index: EditionIndex): void {
    this.indexMemo = { index, expiresAt: Date.now() + EDITION_INDEX_TTL_SECONDS * 1000 };
    this.indexRetryAfter = 0;
  }

  /**
   * Report whether `language` names no existing Wikipedia edition — the signal a tool handler uses
   * to reject it with the typed `invalid_language` contract before any network call, mirroring how
   * the structural BCP 47 check is already pre-validated in-handler.
   *
   * An edition answers to either spelling the registry indexes: the subdomain a caller reads off
   * `wikipedia_get_languages`' `edition_code`, or its MediaWiki language code.
   *
   * Always `false` in single-instance override mode: that host may serve any editions, so the
   * Wikipedia-specific edition set must not gate it.
   */
  async isUnknownEdition(language: string, ctx: ServiceContext): Promise<boolean> {
    if (this.baseUrl) return false;
    if (isMalformedLanguage(language)) return true;
    const normalized = language.toLowerCase();
    const index = await this.editionIndex(ctx);
    return index ? !(normalized in index.hosts) : !FALLBACK_EDITION_HOSTS.has(normalized);
  }

  /**
   * The canonical origin serving `code`, or `undefined` when no edition is known for it — the
   * lookup that lets a langlinks entry missing its `url` resolve a real host from its language
   * code instead of interpolating one that may not exist.
   */
  async editionHost(code: string, ctx: ServiceContext): Promise<string | undefined> {
    const index = await this.editionIndex(ctx);
    return index?.hosts[code.toLowerCase()];
  }

  /**
   * The base URL every request for `language` routes at: the override when configured, otherwise
   * the origin the live registry maps the code to, falling back to {@link buildBaseUrl}'s offline
   * set when the registry is unavailable. Throws `invalid_language`-shaped validation errors,
   * which tool handlers pre-empt with their own typed `ctx.fail`.
   */
  private async resolveBaseUrl(language: string, ctx: ServiceContext): Promise<string> {
    if (this.baseUrl) return this.baseUrl.replace(/\/+$/, '');
    assertStructuralLanguage(language);
    const index = await this.editionIndex(ctx);
    if (!index) return buildBaseUrl(language);
    const host = index.hosts[language.toLowerCase()];
    if (!host) throw unknownEditionError(language);
    return host;
  }

  // ---------------------------------------------------------------------------
  // Domain methods
  // ---------------------------------------------------------------------------

  /** Fetch the REST summary for an article. */
  async getSummary(
    title: string,
    language: string,
    ctx: ServiceContext,
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
      // A 404 is an outcome here, not a failure — remapped below to a friendly notFound. Listing
      // it drops the framework's error-level log line for every article miss to debug.
      raw = await this.restGet<RestSummaryRaw>(language, `/page/summary/${encodedTitle}`, ctx, {
        expectedStatuses: [404],
      });
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
    ctx: ServiceContext,
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
    ctx: ServiceContext,
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

  /**
   * Fetch a single section as plain text, rendered from the parser's HTML for that section.
   *
   * `section=N` returns the requested section together with every subsection nested under it, and
   * the same index space `getSections` reports — both properties of the endpoint, not of this
   * method. An out-of-range index is the API's own `nosuchsection`, so no separate bounds check
   * against the section list is needed.
   *
   * `prop=text` rather than `prop=wikitext`: the parser expands templates and emits headings inline,
   * so inline `{{code}}`-style templates survive and each subsection heading stays attached to its
   * own body. See {@link htmlSectionToPlainText}.
   */
  async getArticleSection(
    title: string,
    sectionIndex: number,
    language: string,
    ctx: ServiceContext,
  ): Promise<{ title: string; pageid: number | undefined; sectionTitle: string; content: string }> {
    const raw = await this.actionGet<ActionParseTextRaw>(
      language,
      {
        action: 'parse',
        page: title,
        prop: 'text',
        section: String(sectionIndex),
        // Suppress the edit links, table of contents, and parser report — page furniture that
        // would only be stripped again on the way to plain text.
        disableeditsection: 'true',
        disabletoc: 'true',
        disablelimitreport: 'true',
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

    // formatversion=2: text is a plain string, not { '*': string }.
    const content = htmlSectionToPlainText(raw.parse?.text ?? '');

    // The section's own heading opens its rendered text; markup inside it is already stripped, so
    // a heading like `<i>Pax Romana</i>` reports as `Pax Romana`.
    const sectionTitle = [...content.matchAll(HEADING_LINE)][0]?.[2] ?? `Section ${sectionIndex}`;

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
    ctx: ServiceContext,
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

  /**
   * List language editions available for an article.
   *
   * `redirects` resolves aliases like the other read paths, so an alias returns the target's
   * interwiki links instead of a redirect stub's empty set, and `title` reports the article the
   * links actually belong to.
   *
   * `url` and `editionCode` are omitted for an entry whose host cannot be established — the API
   * left `url` out and the edition registry knows no host for that language code. The subdomain
   * genuinely is not recoverable from the language code for mismatch editions (`gsw` lives on
   * `als`), so an interpolated `https://<code>.wikipedia.org` would be a fabricated host.
   */
  async getLanguages(
    title: string,
    sourceLanguage: string,
    ctx: ServiceContext,
  ): Promise<{
    title: string;
    languages: Array<{
      languageCode: string;
      editionCode?: string;
      title: string;
      url?: string;
    }>;
  }> {
    const raw = await this.actionGet<ActionLangLinksRaw>(
      sourceLanguage,
      {
        action: 'query',
        titles: title,
        prop: 'langlinks',
        lllimit: '500',
        llprop: 'url',
        redirects: 'true',
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

    const langlinks = page.langlinks ?? [];
    // llprop=url normally populates every url, so the registry is consulted only on the rare miss.
    const index = langlinks.some((ll) => !ll.url) ? await this.editionIndex(ctx) : undefined;

    const languages = langlinks.map((ll) => {
      const host = index?.hosts[ll.lang.toLowerCase()];
      const url =
        ll.url ??
        (host ? `${host}/wiki/${encodeURIComponent(ll.title.replace(/ /g, '_'))}` : undefined);
      // The subdomain that actually serves the edition — the value usable as `language` on other
      // tools. Derived from the real host so it stays correct when the MediaWiki code and the
      // Wikipedia subdomain diverge (e.g. code "gsw" lives on subdomain "als").
      const editionCode = url ? editionCodeFromUrl(url) : undefined;
      return {
        languageCode: ll.lang,
        ...(editionCode && { editionCode }),
        // formatversion=2: title is a plain key, not '*'.
        title: ll.title,
        ...(url && { url }),
      };
    });

    return { title: page.title ?? title, languages };
  }

  /**
   * Find geotagged Wikipedia articles near a coordinate.
   *
   * `limit` is clamped to {@link GEOSEARCH_MAX_LIMIT}, the ceiling `action=paraminfo` reports for
   * `gslimit` and the ceiling an anonymous caller actually gets — geosearch's `highmax` of 5000
   * needs `apihighlimits`, which this server never holds. Geosearch has no `offset` or `continue`,
   * so the clamp is the entire reachable set.
   *
   * `truncated` is established by requesting one result past the clamp and reporting the overflow,
   * so a match count landing exactly on `limit` is not misreported as truncated. At the upstream
   * ceiling there is no room to probe, and a full page is reported as truncated — nothing further
   * is retrievable there either way.
   */
  async searchNearby(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    limit: number,
    language: string,
    ctx: ServiceContext,
  ): Promise<{
    results: Array<{
      title: string;
      pageid: number;
      latitude: number;
      longitude: number;
      distance_meters: number;
    }>;
    truncated: boolean;
  }> {
    const cap = Math.min(Math.max(limit, 1), GEOSEARCH_MAX_LIMIT);
    const probe = Math.min(cap + 1, GEOSEARCH_MAX_LIMIT);

    const raw = await this.actionGet<ActionGeoSearchRaw>(
      language,
      {
        action: 'query',
        list: 'geosearch',
        gscoord: `${latitude}|${longitude}`,
        gsradius: String(Math.min(radiusMeters, GEOSEARCH_MAX_RADIUS_METERS)),
        gslimit: String(probe),
      },
      ctx,
    );

    const matches =
      raw.query?.geosearch?.map((r) => ({
        title: r.title,
        pageid: r.pageid,
        latitude: r.lat,
        longitude: r.lon,
        distance_meters: r.dist,
      })) ?? [];

    return {
      results: matches.slice(0, cap),
      // Filling the probe means more may exist. At the ceiling the probe equals the cap, so a full
      // page reports truncated — correct either way, since nothing past it is retrievable.
      truncated: matches.length >= probe,
    };
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
 * Report whether `title` is blank or whitespace-only — the signal a tool handler uses to reject it
 * with the typed `not_found` contract before any network call. A blank title otherwise leaks an
 * inconsistent generic upstream error that varies by endpoint (an absent `query` object, an
 * `invalidtitle` API error, or a 403 whose raw message carries the fetch URL); the pre-fetch guard
 * normalizes all of them to one typed result, mirroring how `WikipediaService.isUnknownEdition`
 * pre-validates language codes in-handler.
 */
export function isBlankTitle(title: string): boolean {
  return !title.trim();
}
