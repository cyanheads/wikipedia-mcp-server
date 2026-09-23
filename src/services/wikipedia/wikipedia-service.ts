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
import { fenceCodeBlock, tableDelimiterRow, tableRow } from './text-blocks.js';
import type {
  ActionApiErrorRaw,
  ActionExtractsRaw,
  ActionGeoSearchRaw,
  ActionLangLinksRaw,
  ActionPageMetaQueryRaw,
  ActionPageMetaRaw,
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

/**
 * Open-tag test for any of the given class tokens, compiled once per rule. A token matches whole, so
 * `navbar` does not reach `navbar-ct-mini`, the title beside a navbar's edit links.
 */
function hasClass(...tokens: string[]): (openTag: string) => boolean {
  const re = new RegExp(`class\\s*=\\s*"(?:[^"]*\\s)?(?:${tokens.join('|')})(?=[\\s"])`, 'i');
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

/** An open tag's `class` attribute value. */
const CLASS_ATTRIBUTE = /\bclass\s*=\s*"([^"]*)"/i;

/**
 * How a table holding data is rendered: `grid` for a `wikitable`, as pipe rows; `infobox` as one
 * `label: value` line per row. Tested on whole class tokens, so `infobox-subbox` and the other
 * `infobox-*` parts an infobox is built from do not count as infoboxes of their own.
 *
 * A layout table is never a data table, whatever its classes: a standalone succession box is
 * `role="presentation" class="wikitable succession-box"`, and its cells are prose lines.
 */
function dataTableKind(openTag: string): 'grid' | 'infobox' | undefined {
  if (isLayoutTable(openTag)) return;
  const tokens = CLASS_ATTRIBUTE.exec(openTag)?.[1]?.split(/\s+/) ?? [];
  if (tokens.includes('infobox')) return 'infobox';
  if (tokens.includes('wikitable')) return 'grid';
  return;
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
 * Links for editing the page or its Wikidata item rather than content: `Module:Navbar`'s `navbar`
 * (English "view · talk · edit", French "modifier") and the `wikidata-link` Spanish infoboxes close
 * with ("[editar datos en Wikidata]"). Named by class, not by `noprint`, which also marks content
 * inside infoboxes — an age, a date's "137 years ago", German coordinates.
 */
const isEditLinks = hasClass('navbar', 'wikidata-link');

/**
 * Elements dropped whole from parser HTML, keyed by tag name. Each value tests the element's own
 * open tag, so a rule reaches only the elements carrying the artifact it is written for.
 *
 * `figure` goes because the plain-text conventions of the full-article extract path drop it too.
 * `table` goes unless it is a layout table, which wraps ordinary lists and paragraphs, or a data
 * table ({@link dataTableKind}), which {@link renderDataTables} renders as rows. What remains are
 * navboxes, sidebars, and unclassed chart tables — page furniture, or a picture of numbers a
 * neighbouring data table carries. Inside a data table no table is dropped by this rule: the cell
 * holding it is flattened to text instead. `div.spoken-wikipedia` is `{{Spoken Wikipedia}}`, whose
 * body is a duration, the revision date the recording was read from, and a disclaimer that later
 * edits are not reflected — claims about the article rather than any of its content, and the audio
 * itself is not reachable from plain text. It carries neither the `metadata` marker nor `side-box`,
 * so {@link isFurniture} does not reach it. `div.infobox-caption` is an infobox image's or map's
 * caption, which a rendered infobox would otherwise print as a stray line between the title and the
 * first field — dropped for the same reason `figure` is: it describes a picture the text cannot carry.
 *
 * The rest are artifacts of asking the parser for one section in isolation: for a section that cites
 * something, `sup.reference` is the `[1]` footnote marker whose target is not in the payload,
 * `ol.references` is the reference list the parser appends after the content, and
 * `span.mw-ext-cite-error` is its complaint that the article's `<references/>` tag lives in a section
 * this payload does not contain. A section citing nothing carries none of the three.
 * `div.preview-warning` is the same kind of artifact. `action=parse` renders the section as an edit
 * preview, so templates emit editor-only notices ("Preview warning: Page using … with deprecated
 * parameter …") that the saved page never shows.
 */
const DROP_RULES: Readonly<Record<string, (openTag: string) => boolean>> = {
  style: () => true,
  script: () => true,
  figure: () => true,
  table: (openTag) => !isLayoutTable(openTag) && dataTableKind(openTag) === undefined,
  div: hasClass('spoken-wikipedia', 'infobox-caption', 'preview-warning'),
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

/**
 * A MathML formula, visible — the form TextExtracts' HTML mode emits, with no fallback image and no
 * hidden twin. Group 1 is the open tag's attributes, whose `alttext` carries the TeX. The open tag is
 * read attribute by attribute because that TeX holds a literal `>` (`\varepsilon >0`), which would
 * end a `[^>]*` match mid-attribute and spill the rest of the formula into the text. The body cannot
 * run into another `<math`, so an unclosed formula swallows nothing past the next one.
 */
const MATH_ELEMENT = /<math\b((?:"[^"]*"|'[^']*'|[^>"'])*)>(?:(?!<math\b)[\s\S])*?<\/math\s*>/gi;

/** The `alttext` attribute of a `<math>` open tag, still HTML-escaped. */
const ALTTEXT_ATTRIBUTE = /\balttext\s*=\s*"([^"]*)"/i;

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
 * render is not content. {@link isFurniture} and {@link isEditLinks} are tag-agnostic for the same
 * reason — the families they name are emitted as a `<div>` on one edition and a `<p>`, a `<td>`, or
 * a `<table>` on another. Inside a data table
 * the `table` rule is off: a table nested in a cell is part of that cell's text.
 */
function isDropped(openTag: string, tagName: string, insideDataTable: boolean): boolean {
  if (HIDDEN_BY_STYLE.test(openTag) || isFurniture(openTag) || isEditLinks(openTag)) return true;
  if (tagName === 'table' && insideDataTable) return false;
  return DROP_RULES[tagName]?.(openTag) ?? false;
}

/**
 * Remove every element {@link isDropped} selects, in one pass over `html`'s open tags.
 *
 * A selected element is removed with its whole subtree, so a nested selection inside it needs no
 * separate visit. An element that is *not* selected is walked into, so a navbox table nested in a
 * layout table still goes while the layout table's own content survives. A data table's body is
 * walked with `insideDataTable` set: hidden elements, furniture, and footnote markers still go from
 * its cells, but a table nested in a cell stays, to be flattened into that cell's text.
 */
function dropElements(html: string, insideDataTable = false): string {
  const openTag = new RegExp(OPEN_TAG.source, 'gi');
  let kept = '';
  let cursor = 0;
  for (let open = openTag.exec(html); open; open = openTag.exec(html)) {
    const tagName = (open[1] as string).toLowerCase();
    if (VOID_TAGS.has(tagName)) continue;
    const bodyStart = open.index + open[0].length;

    if (isDropped(open[0], tagName, insideDataTable)) {
      kept += html.slice(cursor, open.index);
      cursor = elementEnd(html, tagName, bodyStart);
    } else if (tagName === 'table' && !insideDataTable && dataTableKind(open[0])) {
      const end = elementEnd(html, tagName, bodyStart);
      kept += html.slice(cursor, bodyStart) + dropElements(html.slice(bodyStart, end), true);
      cursor = end;
    } else {
      continue;
    }
    openTag.lastIndex = cursor;
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
 * produce at all. An unrecognized name or an out-of-range code point keeps its escape as written, and
 * so does a reference to {@link BLOCK_MARK}: decoding one would let escaped prose spell out a parked
 * block's placeholder and pull that block into the middle of a sentence.
 */
function decodeEntities(text: string): string {
  return text.replace(
    HTML_ENTITY,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code = dec === undefined ? Number.parseInt(hex as string, 16) : Number(dec);
      return code <= 0x10ffff && code !== BLOCK_MARK_CODE ? String.fromCodePoint(code) : match;
    },
  );
}

/**
 * Strip every `<...>` construct from `html`, looping the removal to a fixed point rather than one
 * pass. A single pass can uncover a tag it did not remove — the outer bracket of `<scr<script>ipt>`
 * strips to leave `script>`, and the next pass removes what remains — so anything short of a fixed
 * point is an incomplete sanitizer against Wikipedia's own attacker-editable markup, and every call
 * site here quotes the result straight into a read path's output.
 */
function stripTags(html: string): string {
  let text = html;
  for (
    let next = text.replace(/<[^>]+>/g, '');
    next !== text;
    next = text.replace(/<[^>]+>/g, '')
  ) {
    text = next;
  }
  return text;
}

/**
 * Delimits a parked block's index while the surrounding text is whitespace-normalized. `U+FFFF` is a
 * permanent noncharacter, which MediaWiki's input normalization never lets into a page, and it is not
 * whitespace, so the collapsing passes leave it in place.
 */
const BLOCK_MARK = '\uFFFF';
const BLOCK_MARK_CODE = BLOCK_MARK.charCodeAt(0);

/** A parked block's placeholder: its index between two {@link BLOCK_MARK}s. */
const PARKED_BLOCK = /\uFFFF(\d+)\uFFFF/g;

/**
 * Text the prose passes must not touch — a fenced code sample, a rendered table — set aside behind a
 * placeholder and restored once the prose around it is normalized. The placeholder stands on its own
 * paragraph, so a block is never run into the sentence beside it.
 */
class ParkedBlocks {
  private readonly blocks: string[] = [];

  /** Set `block` aside and return its placeholder, or a bare paragraph break for an empty block. */
  park(block: string): string {
    if (!block) return '\n\n';
    this.blocks.push(block);
    return `\n\n${BLOCK_MARK}${this.blocks.length - 1}${BLOCK_MARK}\n\n`;
  }

  /** Put every parked block back in place of its placeholder. */
  restore(text: string): string {
    return text.replace(
      PARKED_BLOCK,
      (match, index: string) => this.blocks[Number(index)] ?? match,
    );
  }
}

/** Pair each character of `plain` with the character at the same position in `glyphs`. */
function glyphMap(plain: string, glyphs: string): ReadonlyMap<string, string> {
  const forms = [...glyphs];
  return new Map([...plain].map((char, i) => [char, forms[i] as string]));
}

/**
 * Unicode superscript and subscript forms, limited to the characters that have one in
 * general-purpose fonts. Both hyphen-minus and U+2212 MINUS SIGN map to the raised or lowered minus.
 */
const SUPERSCRIPT_GLYPHS = glyphMap('0123456789+-−=()ni', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ');
const SUBSCRIPT_GLYPHS = glyphMap('0123456789+-−=()', '₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎');

/** Block tags no inline element spans. */
const BLOCK_TAG = '(?:p|div|h[1-6]|ul|ol|li|dl|dd|dt|table|tr|td|th|pre|blockquote)';

/**
 * An innermost `<sup>` or `<sub>` element; group 1 is the tag name, group 2 its body. A script never
 * spans a block, so the body stops short of any block tag: an unclosed `<sup>` then reads as ordinary
 * text rather than reaching past a paragraph or heading to the next `</sup>` and folding a whole
 * section — heading included — into one superscript. The body holds no script of its own, so a nested
 * one is rendered first and its parent then sees `2ⁿ`, not a flattened `2n`.
 */
const SCRIPT_ELEMENT = new RegExp(
  `<(sup|sub)\\b[^>]*>((?:(?!<\\/?${BLOCK_TAG}\\b|<(?:sup|sub)\\b)[\\s\\S])*?)<\\/\\1\\s*>`,
  'gi',
);

/** An `<abbr>` element, bounded by blocks the way {@link SCRIPT_ELEMENT} is. */
const ABBREVIATION_ELEMENT = new RegExp(
  `<abbr\\b[^>]*>(?:(?!<\\/?${BLOCK_TAG}\\b|<abbr\\b)[\\s\\S])*?<\\/abbr\\s*>`,
  'gi',
);

/** A footnote-style marker rather than an exponent: `[citation needed]`, `[I]`, `[a]`. */
const BRACKETED = /^\[.*\]$/;

/** Text carrying a letter or digit — what an exponent or index has and `†` or `ⓘ` do not. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Render superscripts and subscripts so they stay distinct from the text beside them — flattened,
 * `6.02214076×10<sup>23</sup>` reads as the number `6.02214076×1023`.
 *
 * A script whose every character has a Unicode form becomes those characters (`10²³`, `mol⁻¹`,
 * `H₂O`). Any other script is marked the way plain-text math writes it — `^` for a superscript, `_`
 * for a subscript, with parentheses past one character (`e^x`, `19^(th)`, `N_A`) — except a
 * bracketed or letterless one (`[citation needed]`, `†`, `ⓘ`), which is a marker and keeps its text
 * as written. A marked body stays escaped, so the one decode pass later reads it exactly once.
 *
 * A script inside an `<abbr>` is part of an abbreviation, never an exponent, and keeps its text joined
 * the way the edition writes it in plain text. French Wikipedia wraps its ordinals and abbreviations
 * that way (`{{s|XIX}}`, `{{1er}}`, `{{Mme}}`, `{{n°}}`), and marked they read `XIX^e`, `1^(er)`,
 * `M^(me)`; in a live sample of five editions they were three in four of all marks. Whether the text
 * beside a script is a digit or a letter decides nothing: `2<sup>K</sup>` and `e<sup>x</sup>` are
 * exponents in the same shape.
 *
 * Runs after {@link dropElements}, which has already removed `sup.reference` footnote markers whole.
 */
function renderScripts(html: string): string {
  const render = (text: string, inAbbreviation: boolean): string => {
    const next = text.replace(SCRIPT_ELEMENT, (_match, tag: string, body: string) =>
      renderScript(tag.toLowerCase() === 'sup', body, inAbbreviation),
    );
    return next === text ? text : render(next, inAbbreviation);
  };
  return render(
    html.replace(ABBREVIATION_ELEMENT, (abbreviation) => render(abbreviation, true)),
    false,
  );
}

/** One script's body rendered as {@link renderScripts} describes. */
function renderScript(superscript: boolean, body: string, inAbbreviation: boolean): string {
  const escaped = stripTags(body).trim();
  const chars = [...decodeEntities(escaped)];
  if (chars.length === 0) return '';

  const glyphs = superscript ? SUPERSCRIPT_GLYPHS : SUBSCRIPT_GLYPHS;
  if (chars.every((c) => glyphs.has(c))) return chars.map((c) => glyphs.get(c)).join('');

  const text = chars.join('');
  if (inAbbreviation || BRACKETED.test(text) || !ALPHANUMERIC.test(text)) return escaped;
  const mark = superscript ? '^' : '_';
  return chars.length === 1 ? `${mark}${escaped}` : `${mark}(${escaped})`;
}

/**
 * Largest rendered data table, in UTF-8 bytes, that a section read carries in full. A larger one is
 * replaced by a `[table omitted: N rows]` marker, so the gap stays visible without one table
 * outweighing the rest of the section many times over.
 *
 * Sized from rendered tables: results and statistics tables run 1–5 KB, a US election's per-state
 * results 12 KB, the chemical elements 15 KB, and the Nobel physics laureates 37 KB, all of which
 * fit; the 500-row S&P 500 roster (64 KB) does not. At half the default 80 KB full-article budget, one
 * table never outweighs what a whole article may carry.
 */
export const DATA_TABLE_MAX_BYTES = 40_000;

/** A table cell as {@link parseTable} found it. */
type TableCell = { header: boolean; html: string; colspan: number; rowspan: number };

/** HTML's own ceiling on `colspan`. `rowspan` is bounded by the rows the table actually has. */
const MAX_COLSPAN = 1000;

/** A structural tag of a table; group 1 marks a close tag, group 2 is the tag name. */
const TABLE_STRUCTURE_TAG = /<(\/?)(table|caption|tr|td|th)\b[^>]*>/gi;

/** Tags that break a cell's text into separate lines: line breaks, lists, and nested blocks. */
const CELL_LINE_BREAK =
  /<br\s*\/?>|<\/?(?:p|div|ul|ol|li|dl|dd|dt|blockquote|pre|table|caption|tr|td|th|h[1-6])\b[^>]*>/gi;

/** A `colspan`/`rowspan` value; a missing, zero, or non-numeric one spans a single cell. */
function spanAttribute(openTag: string, name: 'colspan' | 'rowspan'): number {
  const value = Number(new RegExp(`\\b${name}\\s*=\\s*"?(\\d+)`, 'i').exec(openTag)?.[1]);
  return value >= 1 ? value : 1;
}

/**
 * A cell's text on one line: the inline pipeline — tags stripped, entities decoded once, whitespace
 * collapsed — with each line break or block inside the cell joined by `separator`. Code inside a cell
 * is flattened with the rest: a row holds one line, and a fence cannot sit inside one.
 */
function cellText(html: string, separator: string): string {
  return decodeEntities(stripTags(html.replace(/\s+/g, ' ').replace(CELL_LINE_BREAK, '\n')))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(separator);
}

/** A cell's text, joining a header cell's wrapped lines with spaces and a data cell's items with `; `. */
function cellLine(cell: TableCell): string {
  return cellText(cell.html, cell.header ? ' ' : '; ');
}

/**
 * Split a table's body — everything after its open tag — into its caption and rows.
 *
 * Only the outer table's own structure counts: tags of a table nested in a cell are kept in that
 * cell's HTML, and the outer table ends at the close tag that brings the nesting back to zero. A
 * missing end tag is inferred the way HTML does — a new cell ends the previous one, a new row ends
 * the previous row — and an unclosed table runs to the end of `body` with its last cell's text kept.
 */
function parseTable(body: string): { caption: string; rows: TableCell[][] } {
  const tag = new RegExp(TABLE_STRUCTURE_TAG.source, 'gi');
  const rows: TableCell[][] = [];
  let caption = '';
  let inCaption = false;
  let row: TableCell[] | undefined;
  let cell: TableCell | undefined;
  let depth = 0;
  let cursor = 0;
  const append = (html: string) => {
    if (cell) cell.html += html;
    else if (inCaption) caption += html;
  };

  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    append(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] as string).toLowerCase();

    if (name === 'table') {
      if (closing && depth === 0) return { caption, rows };
      depth += closing ? -1 : 1;
      append(match[0]);
    } else if (depth > 0) {
      append(match[0]);
    } else if (name === 'caption') {
      inCaption = !closing;
      cell = undefined;
    } else if (name === 'tr') {
      cell = undefined;
      row = closing ? undefined : [];
      if (row) rows.push(row);
    } else if (closing) {
      cell = undefined;
    } else {
      if (!row) {
        row = [];
        rows.push(row);
      }
      cell = {
        header: name === 'th',
        html: '',
        colspan: Math.min(spanAttribute(match[0], 'colspan'), MAX_COLSPAN),
        rowspan: spanAttribute(match[0], 'rowspan'),
      };
      row.push(cell);
    }
  }
  append(body.slice(cursor));
  return { caption, rows };
}

/**
 * Lay a table's rows out on a rectangular grid of cell text.
 *
 * A `rowspan` cell repeats down every row it covers, so each row reads on its own. A `colspan` cell
 * repeats across its columns only in a header row — there it names every column it heads (`Popular
 * vote` over `Count` and `Percentage`); in a body row it fills its first column and leaves the rest
 * blank, so a note spanning the whole table appears once rather than once per column. A header cell
 * alone on its row heads no columns — it is a title or a group label (`Group A`, `Season by season`)
 * — so it is written once too, where repeating it would fill a whole line with one phrase.
 */
function tableGrid(rows: readonly TableCell[][]): string[][] {
  const grid: string[][] = [];
  const carried: Array<{ text: string; rows: number } | undefined> = [];
  const takeCarried = (line: string[], column: number): boolean => {
    const carry = carried[column];
    if (!carry || carry.rows === 0) return false;
    line[column] = carry.text;
    carry.rows--;
    return true;
  };

  for (const row of rows) {
    const line: string[] = [];
    const headerRow = row.length > 1 && row.every((cell) => cell.header);
    let column = 0;
    for (const cell of row) {
      while (takeCarried(line, column)) column++;
      const text = cellLine(cell);
      for (let offset = 0; offset < cell.colspan; offset++, column++) {
        const value = offset === 0 || headerRow ? text : '';
        line[column] = value;
        carried[column] = cell.rowspan > 1 ? { text: value, rows: cell.rowspan - 1 } : undefined;
      }
    }
    for (; column < carried.length; column++) takeCarried(line, column);
    grid.push(line);
  }

  const width = grid.reduce((widest, line) => Math.max(widest, line.length), 0);
  return grid.map((line) => Array.from({ length: width }, (_, i) => line[i] ?? ''));
}

/** A `wikitable` as pipe rows: the first non-empty row, a delimiter row, then the rest. */
function gridLines(rows: readonly TableCell[][]): string {
  const [head, ...body] = tableGrid(rows).filter((line) => line.some(Boolean));
  if (!head) return '';
  return [
    tableRow(head),
    tableDelimiterRow(head.length),
    ...body.map((line) => tableRow(line)),
  ].join('\n');
}

/**
 * An infobox as one line per row: `label: value` where a header cell labels the data beside it, the
 * text alone for a title, section header, or full-width value. A label that ends in its own colon, as
 * Spanish taxoboxes write `Reino:`, loses it, so the line reads `Reino: Animalia`, not `Reino::`.
 */
function infoboxLines(rows: readonly TableCell[][]): string {
  return rows
    .map((row) => {
      const [label, ...values] = row;
      if (label?.header && values.length > 0 && values.every((cell) => !cell.header)) {
        const labelText = cellLine(label).replace(/\s*:$/, '');
        const valueText = values.map(cellLine).filter(Boolean).join('; ');
        return labelText && valueText ? `${labelText}: ${valueText}` : labelText || valueText;
      }
      return row.map(cellLine).filter(Boolean).join('; ');
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Render one data table from its body, caption first. A table whose rendering exceeds
 * {@link DATA_TABLE_MAX_BYTES} is replaced by a one-line `[table omitted: N rows]` marker.
 */
function renderTable(kind: 'grid' | 'infobox', body: string): string {
  const { caption, rows } = parseTable(body);
  const rendered = kind === 'infobox' ? infoboxLines(rows) : gridLines(rows);
  const table =
    new TextEncoder().encode(rendered).length > DATA_TABLE_MAX_BYTES
      ? `[table omitted: ${rows.length} rows]`
      : rendered;
  return [cellText(caption, ' '), table].filter(Boolean).join(kind === 'infobox' ? '\n' : '\n\n');
}

/**
 * Render every data table ({@link dataTableKind}) in `html` and park the result, so the prose passes
 * that follow cannot re-decode its text or strip a `<tag>` its cells quote. A data table nested in a
 * cell of another is flattened into that cell rather than rendered on its own.
 */
function renderDataTables(html: string, parked: ParkedBlocks): string {
  const openTag = /<table\b[^>]*>/gi;
  let rendered = '';
  let cursor = 0;
  for (let open = openTag.exec(html); open; open = openTag.exec(html)) {
    const kind = dataTableKind(open[0]);
    if (!kind) continue;
    const bodyStart = open.index + open[0].length;
    const end = elementEnd(html, 'table', bodyStart);
    rendered +=
      html.slice(cursor, open.index) + parked.park(renderTable(kind, html.slice(bodyStart, end)));
    cursor = end;
    openTag.lastIndex = end;
  }
  return rendered + html.slice(cursor);
}

/**
 * Convert article HTML into the plain-text shape every read path returns: `== Heading ==` markers in
 * document order, paragraphs separated by a blank line, list items one per line. It renders all three
 * HTML sources the read paths fetch — the parser's HTML for one section (`action=parse&prop=text`),
 * TextExtracts' HTML-mode full-article extract (`prop=extracts` without `explaintext`), and the REST
 * summary's `extract_html` — so a superscript, a formula, or a code sample reads the same on each.
 *
 * Sourcing section reads from rendered HTML rather than raw wikitext is what makes inline templates
 * survive — `{{code|if}}` reaches this function already expanded to `if`, where a wikitext stripper
 * has to re-implement the template grammar and drops what it cannot expand.
 *
 * Two constructs carry syntax of their own, written by `text-blocks.ts`. A `<pre>` sample becomes a
 * fenced code block that keeps its line breaks and indentation while everything around it is
 * collapsed, because in a code sample indentation is syntax. A data table becomes pipe rows, and an
 * infobox `label: value` lines. Superscripts and subscripts stay distinct from their neighbours
 * ({@link renderScripts}).
 *
 * Pass order is what keeps each pass's input intact. Furniture, hidden elements, and footnote markers
 * go first, so no later pass renders them. Scripts render next, so a table cell or a heading reads
 * `10²³` the way prose does. Tables render before code is parked, so a `<pre>` inside a cell is
 * flattened onto that cell's line. Both are parked before the prose passes, which would otherwise
 * decode their text a second time and strip any tag it quotes. Unbalanced input — which TextExtracts
 * warns its HTML mode may emit — loses nothing for being unclosed beyond what a drop rule selects: an
 * unclosed table renders to the end of the input, an unclosed `<pre>`, `<sup>`, or `<math>` reads as
 * ordinary text, and an unclosed script cannot reach past a block boundary, nor an unclosed formula
 * past the next formula, to borrow a later close tag.
 *
 * Pure and exported for unit testing.
 */
export function htmlSectionToPlainText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, '');

  // Lift each formula out of its `<img alt>` before anything is dropped, so the TeX survives the
  // removal of the hidden MathML twin that used to be its only carrier. A visible `<math>` — the
  // full-article extract's only form — becomes its `alttext` the same way; the hidden twin a section
  // read carries becomes its TeX too, and is then dropped whole with the element hiding it. Both are
  // inserted still escaped, so the single decode pass below reads each exactly once.
  text = text
    .replace(MATH_FALLBACK_IMAGE, (match) => ALT_ATTRIBUTE.exec(match)?.[1] ?? '')
    .replace(
      MATH_ELEMENT,
      (_match, attributes: string) => ALTTEXT_ATTRIBUTE.exec(attributes)?.[1] ?? '',
    );

  text = renderScripts(dropElements(text));

  const parked = new ParkedBlocks();
  text = renderDataTables(text, parked);

  // A table parked inside a `<pre>` is restored into the code before the fence is sized, so no
  // backtick run in it can close the fence early.
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, body: string) => {
    const code = parked
      .restore(decodeEntities(stripTags(body)))
      .replace(/[^\S\n]+$/gm, '')
      .replace(/^\n+|\n+$/g, '');
    return parked.park(code && fenceCodeBlock(code));
  });

  // Headings become the `== Heading ==` markers both read paths use for structure.
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_match, level: string, inner: string) => {
      const bar = '='.repeat(Math.max(2, Number(level)));
      return `\n\n${bar} ${stripTags(inner).trim()} ${bar}\n\n`;
    },
  );

  // A list item is one line; every other block boundary is a paragraph break. `tr`/`td`/`th` are
  // boundaries because a layout table's cells reach here — without them two columns of a
  // `{{col-begin}}` list concatenate into one line.
  text = decodeEntities(
    stripTags(
      text
        // Closing tag first, consuming the newline that follows it, so consecutive items land on
        // consecutive lines instead of being separated by a blank one.
        .replace(/<\/li\s*>\s*/gi, '')
        .replace(/<li\b[^>]*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|ul|ol|dl|dd|dt|blockquote|section|tr|td|th)\b[^>]*>/gi, '\n\n'),
    ),
  );

  text = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return parked.restore(text);
}

/**
 * The lead section — the text above the first heading — under the one label every surface uses for
 * it: the overflow outline's entry, `wikipedia_get_sections`' index-0 row, and the `section_title`
 * a `section_index: 0` read reports. The lead carries no heading of its own upstream, so without a
 * fixed label the read path falls back to `Section 0` and names something the outline never listed.
 */
export const LEAD_SECTION_TITLE = 'Introduction';

/** The section index that reads {@link LEAD_SECTION_TITLE} through `action=parse&section=0`. */
export const LEAD_SECTION_INDEX = 0;

/**
 * Split a plain-text article extract into per-section parts on its preserved `== Heading ==`
 * markers (via the shared {@link HEADING_LINE}). Text before the first heading becomes the
 * {@link LEAD_SECTION_TITLE} lead; each subsequent heading opens a part whose body runs to the next
 * heading. Empty parts are dropped. Pure and exported — the overflow-outline pre-shaping in
 * `wikipedia_get_article` relies on it, and it is unit-tested directly.
 */
export function splitArticleIntoSections(
  content: string,
): Array<{ heading: string; body: string }> {
  const matches = [...content.matchAll(HEADING_LINE)];
  const parts: Array<{ heading: string; body: string }> = [];

  const firstStart = matches[0]?.index ?? content.length;
  const lead = content.slice(0, firstStart).trim();
  if (lead) parts.push({ heading: LEAD_SECTION_TITLE, body: lead });

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
// Strip HTML markup from Action API text fields
// ---------------------------------------------------------------------------

/**
 * Drop the markup an Action API text field carries, then unescape it.
 *
 * Tags go before entities are decoded, which is what keeps a decoded `<` from being read as the
 * start of a tag: an article writing about markup reaches here as `&amp;lt;ref&amp;gt;` and must
 * come out as the literal text `&lt;ref&gt;`. {@link decodeEntities} makes that one left-to-right
 * pass; a chained per-name replace would decode it twice.
 */
function stripMarkup(html: string): string {
  return decodeEntities(stripTags(html)).trim();
}

/**
 * Render a `prop=tocdata` section `line` — rendered HTML, not plain text — as the same plain text
 * the article read path reports for that section.
 *
 * Headings built from inline templates arrive wrapped (`Siglo<span>XVIII</span>` from the Spanish
 * edition's Roman-numeral templates), and a heading whose wikitext used `&nbsp;` arrives carrying a
 * literal U+00A0. {@link htmlSectionToPlainText} folds both away on the article path — its
 * whitespace pass matches `\s`, which includes U+00A0 — so the same fold here is what makes
 * `wikipedia_get_sections`' `title` and `wikipedia_get_article`'s `section_title` byte-identical for
 * one index. `stripMarkup` has already trimmed, so the collapse cannot leave an edge space behind.
 */
function tocLineToPlainText(line: string): string {
  return stripMarkup(line).replace(/\s+/g, ' ');
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

/**
 * This server's own page size for `list=search`. Upstream reports `limit.max: 500` for an anonymous
 * caller, so the cap is a payload-size choice rather than an API ceiling.
 */
export const SEARCH_MAX_LIMIT = 50;

/**
 * The deep-paging window CirrusSearch enforces on `sroffset`. At or past it the API refuses the
 * request outright (`cirrussearch-offset-too-large`); below it, a page that would cross the window
 * is silently cut at the 10,000th result instead. Matches beyond it have no continuation — a
 * narrower query is the only way to reach them.
 */
export const SEARCH_RESULT_WINDOW = 10_000;

/** {@link SEARCH_RESULT_WINDOW} written the way every user-facing message spells it. */
const SEARCH_RESULT_WINDOW_LABEL = SEARCH_RESULT_WINDOW.toLocaleString('en-US');

/**
 * Per-request timeout for the search results' description lookup. The lookup is best-effort and
 * runs after the search has already succeeded, so it gets one short attempt rather than the default
 * 15 s with retries — a stalled lookup must not hold back results that are ready.
 */
const PAGE_META_TIMEOUT_MS = 5_000;

/** A result's short description and Wikidata QID, each present only when upstream has one. */
type PageMeta = { description?: string; wikibase_item?: string };

/**
 * Index `prop=description|pageprops` entries by pageid.
 *
 * An empty `description` is how upstream reports a short description explicitly set to "none"
 * (`List of Python software`), so it maps to an absent field rather than an empty one.
 */
function pageMetaById(pages: ActionPageMetaRaw[] | undefined): Map<number, PageMeta> {
  const byId = new Map<number, PageMeta>();
  for (const page of pages ?? []) {
    if (page.pageid === undefined) continue;
    const qid = page.pageprops?.wikibase_item;
    byId.set(page.pageid, {
      ...(page.description && { description: page.description }),
      ...(qid && { wikibase_item: qid }),
    });
  }
  return byId;
}

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

/** The miss every read path reports the same way, whichever endpoint discovered it. */
function articleNotFoundError(title: string, language: string): McpError {
  return notFound(
    `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search_articles to find the correct title.`,
    {
      title,
      language,
      recovery: { hint: 'Use wikipedia_search_articles to find the correct article title.' },
    },
  );
}

/**
 * A title MediaWiki cannot name a page with. Carries the `invalid_title` reason the four
 * title-taking tools declare, so a refusal raised here — from an `invalid: true` page entry or an
 * `invalidtitle` parse error — reaches the client with the same typed contract as the handler-edge
 * guard, instead of an untyped upstream message asserting the article exists.
 */
function invalidTitleError(title: string, upstreamReason?: string): McpError {
  return validationError(
    `"${title}" is not a valid Wikipedia page name.${upstreamReason ? ` ${upstreamReason}` : ''}`,
    {
      title,
      reason: 'invalid_title',
      recovery: {
        hint: 'Use wikipedia_search_articles to find the exact article title and pass it verbatim.',
      },
    },
  );
}

/** An `offset` at or past {@link SEARCH_RESULT_WINDOW}, where no continuation exists. */
function searchWindowError(offset: number): McpError {
  return validationError(
    `Offset ${offset} is at or past Wikipedia's ${SEARCH_RESULT_WINDOW_LABEL}-result search window, which has no continuation. Narrow the query instead of paging further.`,
    {
      offset,
      reason: 'offset_too_large',
      recovery: {
        hint: `Narrow the query with more specific terms — results past ${SEARCH_RESULT_WINDOW_LABEL} are not reachable by paging.`,
      },
    },
  );
}

/**
 * Translate the Action API's top-level `error` envelope into this server's typed failures.
 *
 * `title` is passed by the page-addressed endpoints, whose `missingtitle` and `invalidtitle` codes
 * map onto declared tool contracts; anything else is upstream's own refusal and surfaces as a
 * service failure carrying the API's `info` text.
 */
function actionApiError(error: ActionApiErrorRaw, language: string, title?: string): McpError {
  const code = error.code ?? '';
  if (title !== undefined) {
    if (code === 'missingtitle') return articleNotFoundError(title, language);
    if (code === 'invalidtitle') return invalidTitleError(title, error.info);
  }
  return serviceUnavailable(`Wikipedia API error: ${error.info ?? code}`);
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

/** Escapes `encodeURIComponent` writes that MediaWiki's `wfUrlencode` leaves literal in a title. */
const LITERAL_IN_TITLE_PATH = /%(?:3B|40|24|2C|2F|3A)/g;

/**
 * The canonical URL of the article `title` on the edition served from `origin`, encoded the way
 * MediaWiki encodes its own `fullurl`: spaces become underscores, `wfUrlencode` percent-encodes the
 * rest but leaves `; @ $ ! * ( ) , / ~ :` literal, and `'` is escaped. The result is byte-identical to
 * the `fullurl` `prop=info&inprop=url` reports for the same title — `AC/DC` stays
 * `/wiki/AC/DC` and `C++` becomes `/wiki/C%2B%2B` — so a section read cites the same URL a full read
 * does.
 *
 * `title` must be the title MediaWiki resolved (`parse.title`), not the caller's input: a redirect
 * alias or a lowercase first letter names a different URL than the article's own.
 */
export function articleUrl(origin: string, title: string): string {
  const path = encodeURIComponent(title.replaceAll(' ', '_'))
    .replaceAll("'", '%27')
    .replace(LITERAL_IN_TITLE_PATH, decodeURIComponent);
  return `${origin}/wiki/${path}`;
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

  /**
   * GET from the Action API (`/w/api.php`). `options` narrows the per-attempt timeout and retry
   * count for a best-effort call; omitted, the request gets the defaults every other call uses.
   */
  async actionGet<T>(
    language: string,
    params: Record<string, string>,
    ctx: ServiceContext,
    options: { timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<T> {
    const base = await this.resolveBaseUrl(language, ctx);
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
    return await this.apiGet<T>(
      `${base}/w/api.php?${qs}`,
      'WikipediaService.actionGet',
      'Action API',
      ctx,
      options,
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
    if (raw.error) throw actionApiError(raw.error, 'en');
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

  /**
   * Fetch the REST summary for an article.
   *
   * The extract is rendered from `extract_html` through {@link htmlSectionToPlainText}, the renderer
   * every read path shares. The plain `extract` flattens superscripts into the digits beside them —
   * `6.02214076×10<sup>23</sup>` reads as `6.02214076×1023` — and runs a disambiguation page's list
   * into the sentence introducing it. The plain `extract` is still what decides whether the article
   * has readable content, and stands in for a payload that carries no `extract_html`.
   *
   * `latitude`/`longitude` come from the response's `coordinates`, which a non-geotagged article
   * carries as an explicit `null` rather than omitting — both are left undefined for that, for an
   * absent key, and for a partial pair, so a caller never reads half a coordinate as a location.
   */
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
    latitude: number | undefined;
    longitude: number | undefined;
    url: string | undefined;
    revisionId: string | undefined;
    lastModified: string | undefined;
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
          `No Wikipedia article found for "${title}" in language "${language}". Use wikipedia_search_articles to find the correct title.`,
          {
            title,
            language,
            recovery: { hint: 'Use wikipedia_search_articles to find the correct article title.' },
          },
        );
      }
      throw err;
    }

    if (!raw.extract) {
      throw notFound(`Article "${title}" exists but has no readable content.`, { title, language });
    }

    const { lat, lon } = raw.coordinates ?? {};
    const geotagged = typeof lat === 'number' && typeof lon === 'number';

    return {
      title: raw.title ?? title,
      pageType: raw.type ?? 'article',
      pageid: raw.pageid,
      wikidataQid: raw.wikibase_item,
      description: raw.description,
      extract: (raw.extract_html && htmlSectionToPlainText(raw.extract_html)) || raw.extract,
      thumbnailUrl: raw.thumbnail?.source,
      latitude: geotagged ? lat : undefined,
      longitude: geotagged ? lon : undefined,
      url: raw.content_urls?.desktop?.page,
      revisionId: raw.revision,
      lastModified: raw.timestamp,
    };
  }

  /**
   * Full-text search across Wikipedia articles.
   *
   * `offset` trails `ctx` with a default so existing four-argument callers keep working — the
   * pagination change stays additive at the call level. It maps to the Action API `sroffset`
   * (this server's own {@link SEARCH_MAX_LIMIT} page-size cap is orthogonal to it). `nextOffset`
   * echoes the API's own `continue.sroffset`, present only while more results remain.
   *
   * The `error` envelope is read before the payload: it arrives on HTTP 200, so reading
   * `raw.query` first renders an upstream refusal — an unset `srsearch`, an offset past the search
   * window — as a successful empty result indistinguishable from a real answer.
   *
   * `suggestion` is CirrusSearch's spelling correction, which `srinfo`'s default already requests
   * on every page — empty or not. Each result's `description` and `wikibase_item` come from a
   * separate {@link lookupPageMeta} call, because `list=search` cannot return page props and
   * `generator=search` drops `snippet` and `wordcount`. `descriptionsUnavailable` is true only when
   * that lookup was attempted and failed; the results are returned either way.
   */
  async search(
    query: string,
    limit: number,
    language: string,
    ctx: ServiceContext,
    offset = 0,
  ): Promise<{
    results: Array<
      { title: string; pageid: number; snippet: string; wordcount: number } & PageMeta
    >;
    totalResults: number;
    nextOffset: number | undefined;
    suggestion?: string;
    descriptionsUnavailable: boolean;
  }> {
    const raw = await this.actionGet<ActionSearchRaw>(
      language,
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(Math.min(limit, SEARCH_MAX_LIMIT)),
        sroffset: String(offset),
        srprop: 'snippet|wordcount',
      },
      ctx,
    );

    if (raw.error) {
      if (raw.error.code === 'cirrussearch-offset-too-large') throw searchWindowError(offset);
      throw actionApiError(raw.error, language);
    }

    const results =
      raw.query?.search?.map((r) => ({
        title: r.title,
        pageid: r.pageid,
        snippet: stripMarkup(r.snippet),
        wordcount: r.wordcount ?? 0,
      })) ?? [];

    const meta =
      results.length > 0
        ? await this.lookupPageMeta(
            results.map((r) => r.pageid),
            language,
            ctx,
          )
        : new Map<number, PageMeta>();
    const suggestion = raw.query?.searchinfo?.suggestion;

    return {
      // Merged by pageid: the lookup answers in pageid order, and the search ranking must survive.
      results: meta ? results.map((r) => ({ ...r, ...meta.get(r.pageid) })) : results,
      totalResults: raw.query?.searchinfo?.totalhits ?? results.length,
      nextOffset: raw.continue?.sroffset,
      ...(suggestion && { suggestion }),
      descriptionsUnavailable: meta === undefined,
    };
  }

  /**
   * Best-effort short description and Wikidata QID for a page of search results, keyed by pageid.
   *
   * One request covers a full page: `pageids` accepts 50 values from an anonymous caller, which is
   * {@link SEARCH_MAX_LIMIT}. It runs once with a short timeout and no retries, and returns
   * `undefined` on any failure — a transport error or an Action API `error` envelope — so a
   * degraded lookup costs the caller the two fields, never the search. A caller cancellation is
   * not a lookup failure: it propagates, as it would from the search request itself.
   */
  private async lookupPageMeta(
    pageids: number[],
    language: string,
    ctx: ServiceContext,
  ): Promise<Map<number, PageMeta> | undefined> {
    const degrade = (detail: string): undefined => {
      logger.warning(
        'Wikipedia description lookup failed; returning search results without descriptions.',
        withExtra(ctx, { error: detail }),
      );
      return;
    };

    let raw: ActionPageMetaQueryRaw;
    try {
      raw = await this.actionGet<ActionPageMetaQueryRaw>(
        language,
        {
          action: 'query',
          pageids: pageids.join('|'),
          prop: 'description|pageprops',
          ppprop: 'wikibase_item',
        },
        ctx,
        { timeoutMs: PAGE_META_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      return degrade(err instanceof Error ? err.message : String(err));
    }
    if (raw.error) return degrade(raw.error.info ?? raw.error.code ?? 'unknown API error');
    return pageMetaById(raw.query?.pages);
  }

  /**
   * Fetch the full article as plain text, with the revision it was read from and its canonical URL,
   * in one Action API request.
   *
   * The extract is TextExtracts' HTML mode rendered through {@link htmlSectionToPlainText} rather
   * than `explaintext`, which flattens superscripts into the digits beside them. Both modes strip the
   * same infoboxes, tables, and navboxes upstream, so the rendered text carries the same sections
   * under the same `== Heading ==` markers; beyond superscripts it differs only where the HTML says
   * more — a `<pre>` sample arrives fenced, and a formula arrives once, as its TeX.
   *
   * `lastModified` is the revision's own timestamp (`revisions[0]`), never `prop=info`'s `touched`,
   * which is a cache-invalidation time that moves without an edit.
   */
  async getArticleFull(
    title: string,
    language: string,
    ctx: ServiceContext,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    content: string;
    revisionId: string | undefined;
    lastModified: string | undefined;
    url: string | undefined;
  }> {
    const raw = await this.actionGet<ActionExtractsRaw>(
      language,
      {
        action: 'query',
        titles: title,
        prop: 'extracts|info|revisions',
        inprop: 'url',
        rvprop: 'ids|timestamp',
        // Resolve redirects server-side so aliases (e.g. "NYC" → "New York City") return the
        // target's content, pageid, revision, and URL, matching getSummary's REST behavior.
        redirects: 'true',
      },
      ctx,
    );

    if (raw.error) throw actionApiError(raw.error, language, title);

    const pages = raw.query?.pages;
    // When `pages` is absent the API received an empty or invalid title rather than a valid
    // (but missing) article. Map this to not_found — same user-visible outcome.
    if (!pages) throw articleNotFoundError(title, language);

    const page = Object.values(pages)[0];
    if (!page) throw articleNotFoundError(title, language);

    // An unnameable title arrives as `invalid` with no `missing` key, so this has to be tested
    // separately or the entry falls through into "exists but has no readable content".
    if (page.invalid) throw invalidTitleError(title, page.invalidreason);
    if (page.missing !== undefined) throw articleNotFoundError(title, language);

    // An extract of only empty paragraphs renders to nothing, which is no more readable than none.
    const content = htmlSectionToPlainText(page.extract ?? '');
    if (!content) {
      throw notFound(`Article "${title}" exists but has no readable content.`, { title, language });
    }

    const revision = page.revisions?.[0];
    return {
      title: page.title ?? title,
      pageid: page.pageid,
      content,
      revisionId: revision?.revid?.toString(),
      lastModified: revision?.timestamp,
      url: page.fullurl,
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
   *
   * `prop=revid` names the revision the text was parsed from. `action=parse` offers no URL and no
   * revision timestamp, so `url` is composed from the resolved `parse.title` with {@link articleUrl}
   * — byte-identical to the full read's `fullurl` — and the section read carries no `lastModified`,
   * which would cost a second request. Under a single-instance override the host's article path is
   * unknown, so `url` is omitted rather than guessed.
   */
  async getArticleSection(
    title: string,
    sectionIndex: number,
    language: string,
    ctx: ServiceContext,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    sectionTitle: string;
    content: string;
    revisionId: string | undefined;
    url: string | undefined;
  }> {
    const raw = await this.actionGet<ActionParseTextRaw>(
      language,
      {
        action: 'parse',
        page: title,
        prop: 'text|revid',
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
      if (raw.error.code === 'nosuchsection') {
        throw validationError(
          `Section index ${sectionIndex} does not exist in "${title}". Call wikipedia_get_sections to get valid index values.`,
          {
            title,
            sectionIndex,
            recovery: { hint: 'Call wikipedia_get_sections to obtain valid section_index values.' },
          },
        );
      }
      throw actionApiError(raw.error, language, title);
    }

    // formatversion=2: text is a plain string, not { '*': string }.
    const content = htmlSectionToPlainText(raw.parse?.text ?? '');

    // The lead carries no heading of its own, so it takes the label every other surface prints for
    // it rather than the positional fallback. A heading inside a lead — a template can emit one —
    // must not rename it either, or the read reports a title the section list never offered.
    // Every other section's own heading opens its rendered text; markup inside it is already
    // stripped, so a heading like `<i>Pax Romana</i>` reports as `Pax Romana`.
    const sectionTitle =
      sectionIndex === LEAD_SECTION_INDEX
        ? LEAD_SECTION_TITLE
        : ([...content.matchAll(HEADING_LINE)][0]?.[2] ?? `Section ${sectionIndex}`);

    const resolvedTitle = raw.parse?.title;
    return {
      title: resolvedTitle ?? title,
      pageid: raw.parse?.pageid,
      sectionTitle,
      content,
      revisionId: raw.parse?.revid?.toString(),
      // Only the title MediaWiki resolved names the article's URL — the caller's input may be an alias.
      url:
        resolvedTitle && !this.baseUrl
          ? articleUrl(await this.resolveBaseUrl(language, ctx), resolvedTitle)
          : undefined,
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

    if (raw.error) throw actionApiError(raw.error, language, title);

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
        // `line` is rendered HTML — see tocLineToPlainText for why it is normalized here.
        title: tocLineToPlainText(s.line ?? ''),
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

    if (raw.error) throw actionApiError(raw.error, sourceLanguage, title);

    const pages = raw.query?.pages;
    if (!pages) throw serviceUnavailable('Unexpected response shape from Wikipedia langlinks API.');

    const page = Object.values(pages)[0];
    if (!page) throw articleNotFoundError(title, sourceLanguage);

    // An unnameable title arrives as `invalid` with no `missing` key, so this has to be tested
    // separately or the entry falls through into "has no other language editions".
    if (page.invalid) throw invalidTitleError(title, page.invalidreason);
    if (page.missing !== undefined) throw articleNotFoundError(title, sourceLanguage);

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
   *
   * Coordinates and distances are the GeoData tag set on each article itself, not Wikidata's
   * coordinate. Each result's `description` and `wikibase_item` come from the same geosearch run
   * again as a generator in this one request, merged by pageid. The list stays the source of the
   * result set: the generator alone answers in pageid order, and its `coordinates` prop rounds to
   * eight decimals and needs `colimit=max` to report a distance past the tenth page — re-sorting it
   * reproduces the distances but reorders equal-distance ties, which changes which tied article
   * survives the cap.
   */
  async searchNearby(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    limit: number,
    language: string,
    ctx: ServiceContext,
  ): Promise<{
    results: Array<
      {
        title: string;
        pageid: number;
        latitude: number;
        longitude: number;
        distance_meters: number;
      } & PageMeta
    >;
    truncated: boolean;
  }> {
    const cap = Math.min(Math.max(limit, 1), GEOSEARCH_MAX_LIMIT);
    const probe = Math.min(cap + 1, GEOSEARCH_MAX_LIMIT);
    const coord = `${latitude}|${longitude}`;
    const radius = String(Math.min(radiusMeters, GEOSEARCH_MAX_RADIUS_METERS));

    const raw = await this.actionGet<ActionGeoSearchRaw>(
      language,
      {
        action: 'query',
        list: 'geosearch',
        gscoord: coord,
        gsradius: radius,
        gslimit: String(probe),
        // The same search again as a generator, selecting the list's page set with its props. A
        // page the generator does not return simply carries neither field.
        generator: 'geosearch',
        ggscoord: coord,
        ggsradius: radius,
        ggslimit: String(probe),
        prop: 'description|pageprops',
        ppprop: 'wikibase_item',
      },
      ctx,
    );

    if (raw.error) throw actionApiError(raw.error, language);

    const meta = pageMetaById(raw.query?.pages);
    const matches =
      raw.query?.geosearch?.map((r) => ({
        title: r.title,
        pageid: r.pageid,
        latitude: r.lat,
        longitude: r.lon,
        distance_meters: r.dist,
        ...meta.get(r.pageid),
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

/**
 * Characters MediaWiki's `$wgLegalTitleChars` excludes, minus `#`: the fragment is stripped before
 * the title is resolved, so `Python (programming language)#History` names a real page on every
 * read path and rejecting it would be a regression.
 */
const ILLEGAL_TITLE_CHARS = /[<>[\]{}]/;

/**
 * `|` separates titles in the Action API's `titles` parameter, so `Cat|Dog` is two lookups rather
 * than one bad title: the request succeeds and the reader takes the first page, answering about
 * `Cat` a question that was asked about neither article.
 */
const MULTI_TITLE_SEPARATOR = '|';

/** A percent escape, which MediaWiki decodes rather than reads — a bare `%` stays legal. */
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;

/** Three or more tildes, MediaWiki's signature magic. Two are legal. */
const MAGIC_TILDES = /~~~/;

/** The relative-path segments MediaWiki refuses: a leading, embedded, or trailing `.` or `..`. */
const RELATIVE_PATH_SEGMENT = /^\.{1,2}(?:\/|$)|\/\.{1,2}(?:\/|$)/;

/**
 * Report whether `title` names no page MediaWiki can address — the signal a tool handler uses to
 * reject it with the typed `invalid_title` contract before any network call, alongside
 * {@link isBlankTitle}.
 *
 * The guard runs at the handler edge because the upstream shapes disagree: `action=query` answers
 * with an `invalid: true` page entry, `action=parse` with an `invalidtitle` error code, and REST
 * with a 403 or a 500 — while `|` produces no error at all and silently returns a different
 * article. One pre-fetch check normalizes all four.
 *
 * Coverage is MediaWiki's whole page-name rule, not only the characters that motivated it: percent
 * escapes, magic tildes, and relative paths are `invalid: true` upstream exactly as `A<B` is, so
 * excluding them would leave the same "exists but has no readable content" claim in place for
 * `A%41B` and `./Cat`.
 */
export function isInvalidTitle(title: string): boolean {
  return (
    ILLEGAL_TITLE_CHARS.test(title) ||
    title.includes(MULTI_TITLE_SEPARATOR) ||
    PERCENT_ESCAPE.test(title) ||
    MAGIC_TILDES.test(title) ||
    RELATIVE_PATH_SEGMENT.test(title)
  );
}
