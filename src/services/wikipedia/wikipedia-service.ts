/**
 * @fileoverview Wikipedia service — wraps the MediaWiki REST API and Action API.
 * @module services/wikipedia/wikipedia-service
 */

import { z } from '@cyanheads/mcp-ts-core';
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
import {
  createPacer,
  decodeCursor,
  encodeCursor,
  fetchWithTimeout,
  logger,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { formatTablePage } from '@/mcp-server/tools/utils/escape-markdown.js';
import { fenceCodeBlock, listLine, tableDelimiterRow, tableRow } from './text-blocks.js';
import type {
  ActionApiErrorRaw,
  ActionExtractsRaw,
  ActionGeoSearchRaw,
  ActionInterwikiRaw,
  ActionLangLinksRaw,
  ActionPageMetaQueryRaw,
  ActionPageMetaRaw,
  ActionParseTextRaw,
  ActionRedirectRaw,
  ActionSearchRaw,
  ActionSectionsRaw,
  RestSummaryRaw,
  SiteMatrixLanguage,
  SiteMatrixRaw,
  UnnameablePageRaw,
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

/*
 * Every open-tag attribute rule in this file reads an attribute name only where whitespace precedes
 * it, `(?<=\s)class`. A `\b` boundary also matches after a hyphen, and MediaWiki passes an editor's
 * `data-*` attributes through, so `\bclass` or `\bstyle` would read a `data-x-class` or `data-x-style`
 * standing before the real attribute, or in place of it.
 */

/**
 * Open-tag test for any of the given class tokens, compiled once per rule. A token matches whole, so
 * `navbar` does not reach `navbar-ct-mini`, the title beside a navbar's edit links.
 */
function hasClass(...tokens: string[]): (openTag: string) => boolean {
  const re = new RegExp(
    `(?<=\\s)class\\s*=\\s*"(?:[^"]*\\s)?(?:${tokens.join('|')})(?=[\\s"])`,
    'i',
  );
  return (openTag) => re.test(openTag);
}

/**
 * `role="presentation"` is the parser's own marker for a table it lays content out in rather than
 * one holding data — set by `{{col-begin}}`, succession boxes, and the other layout templates — so
 * it tracks new layout templates instead of a hand-maintained class list.
 */
const PRESENTATION_ROLE = /(?<=\s)role\s*=\s*"presentation"/i;

/**
 * MediaWiki's marker for page furniture that is not article content. Maintenance banners
 * (`{{Update}}` and the rest of the ambox family) are `role="presentation"` tables carrying it, so
 * the marker is what separates a layout table wrapping real prose from one wrapping an editor
 * notice about the article.
 *
 * On its own it does not establish that an element is furniture — see {@link isFurniture}.
 */
const NOT_CONTENT = /(?<=\s)class\s*=\s*"[^"]*\bmetadata\b/i;

/** Whether a table lays out article content, and so must survive rather than be dropped. */
function isLayoutTable(openTag: string): boolean {
  return PRESENTATION_ROLE.test(openTag) && !NOT_CONTENT.test(openTag);
}

/** An open tag's `class` attribute value. */
const CLASS_ATTRIBUTE = /(?<=\s)class\s*=\s*"([^"]*)"/i;

/** Phylogenetic trees carry article content, independently of selectable data tables. */
const isClade = hasClass('clade');

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
const NAVIGATION_ROLE = /(?<=\s)role\s*=\s*"navigation"/i;

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
const FURNITURE_BOX = /(?<=\s)class\s*=\s*"[^"]*\b(?:side-box|ambox)\b/i;

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
const HIDDEN_BY_STYLE = /(?<=\s)style\s*=\s*"[^"]*display\s*:\s*none/i;

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
 * table ({@link dataTableKind}), which {@link renderDataTables} renders as rows, or a clade tree,
 * rendered as fenced branches. What remains are
 * navboxes, sidebars, and unclassed chart tables — page furniture, or a picture of numbers a
 * neighbouring data table carries. Inside a data table no table is dropped by this rule: the cell
 * holding it is flattened to text instead. `div.spoken-wikipedia` is `{{Spoken Wikipedia}}`, whose
 * body is a duration, the revision date the recording was read from, and a disclaimer that later
 * edits are not reflected — claims about the article rather than any of its content, and the audio
 * itself is not reachable from plain text. It carries neither the `metadata` marker nor `side-box`,
 * so {@link isFurniture} does not reach it. `div.infobox-caption` is an infobox image's or map's
 * caption, which a rendered infobox would otherwise print as a stray line between the title and the
 * first field — dropped for the same reason `figure` is: it describes a picture the text cannot carry.
 * `span.cs1-maint` and `span.cs1-hidden-error` are Citation Style 1's editor-facing messages
 * ("{{cite book}}: CS1 maint: ignored ISBN errors"), which the page hides through TemplateStyles CSS
 * rather than an inline style, so {@link HIDDEN_BY_STYLE} never sees them. `span.cs1-visible-error`
 * stays: readers see it.
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
  table: (openTag) =>
    !isClade(openTag) && !isLayoutTable(openTag) && dataTableKind(openTag) === undefined,
  div: hasClass('spoken-wikipedia', 'infobox-caption', 'preview-warning'),
  sup: hasClass('reference'),
  ol: hasClass('references'),
  span: hasClass('mw-ext-cite-error', 'cs1-maint', 'cs1-hidden-error'),
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
 *
 * The tag's own text stops at a `<` as well as at its `>`: the parser escapes both inside attribute
 * values (`alt="{\displaystyle H&gt;0}"`), so stopping there never cuts a real tag short.
 */
const MATH_FALLBACK_IMAGE =
  /<img\b[^<>]*(?<=\s)class\s*=\s*"[^"]*\bmwe-math-fallback-image-[^"]*"[^<>]*>/gi;

/** The `alt` attribute of a single tag, still HTML-escaped as the parser emitted it. */
const ALT_ATTRIBUTE = /(?<=\s)alt\s*=\s*"([^"]*)"/i;

/**
 * A MathML formula, visible — the form TextExtracts' HTML mode emits, with no fallback image and no
 * hidden twin. Group 1 is the open tag's attributes, whose `alttext` carries the TeX. The open tag is
 * read attribute by attribute because that TeX holds a literal `>` (`\varepsilon >0`), which would
 * end a `[^>]*` match mid-attribute and spill the rest of the formula into the text. A `<` ends the
 * open tag's scan, quoted or not: TextExtracts escapes it in an attribute (`0&lt;|x-p|`), so stopping
 * there never cuts a real tag short. The body cannot run
 * into another `<math`, so an unclosed formula swallows nothing past the next one.
 */
const MATH_ELEMENT = /<math\b((?:"[^"<]*"|'[^'<]*'|[^<>"'])*)>(?:(?!<math\b)[\s\S])*?<\/math\s*>/gi;

/** The `alttext` attribute of a `<math>` open tag, still HTML-escaped. */
const ALTTEXT_ATTRIBUTE = /(?<=\s)alttext\s*=\s*"([^"]*)"/i;

/**
 * A display formula's mark, on the fallback image (its `-display` class) or a visible `<math>` (its
 * `display="block"`). A browser lays a display formula out on a line of its own, so its TeX gets one.
 */
const DISPLAY_FORMULA = /\bmwe-math-fallback-image-display\b|(?<=\s)display\s*=\s*["']?block\b/i;

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
  const tagged = html.slice(0, html.lastIndexOf('>') + 1);
  let kept = '';
  let cursor = 0;
  for (let open = openTag.exec(tagged); open; open = openTag.exec(tagged)) {
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
  let previous: string;
  do {
    previous = text;
    const end = text.lastIndexOf('>') + 1;
    text = text.slice(0, end).replace(/<[^>]+>/g, '') + text.slice(end);
  } while (text !== previous);
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

  /**
   * Set `block` aside and return its placeholder, or an empty paragraph for an empty block — a tag,
   * since the prose passes read a raw line break as a space.
   */
  park(block: string): string {
    if (!block) return '<p></p>';
    this.blocks.push(block);
    return `\n\n${BLOCK_MARK}${this.blocks.length - 1}${BLOCK_MARK}\n\n`;
  }

  /** The block `line` is the placeholder of, or `undefined` for any other line. */
  blockAt(line: string): string | undefined {
    const index = /^￿(\d+)￿$/.exec(line)?.[1];
    return index === undefined ? undefined : this.blocks[Number(index)];
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
  if (!/<\/(?:sup|sub)\s*>/i.test(html)) return html;
  const render = (text: string, inAbbreviation: boolean): string => {
    const next = text.replace(SCRIPT_ELEMENT, (_match, tag: string, body: string) =>
      renderScript(tag.toLowerCase() === 'sup', body, inAbbreviation),
    );
    return next === text ? text : render(next, inAbbreviation);
  };
  const abbreviations = /<\/abbr\s*>/i.test(html)
    ? html.replace(ABBREVIATION_ELEMENT, (abbreviation) => render(abbreviation, true))
    : html;
  return render(abbreviations, false);
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
 * replaced by a `[table omitted: N rows (table T)]` marker, so the gap stays visible without one table
 * outweighing the rest of the section many times over.
 *
 * Sized from rendered tables: results and statistics tables run 1–5 KB, a US election's per-state
 * results 12 KB, the chemical elements 15 KB, and the Nobel physics laureates 37 KB, all of which
 * fit; the 500-row S&P 500 roster (64 KB) does not. At half the default 80 KB full-article budget, one
 * table never outweighs what a whole article may carry.
 */
export const DATA_TABLE_MAX_BYTES = 40_000;

/** Revision and row position bound to the exact selected-table request. */
const TableCursorSchema = z.strictObject({
  kind: z.literal('wikipedia_table_v1'),
  offset: z.number().int().positive(),
  limit: z.literal(DATA_TABLE_MAX_BYTES),
  title: z.string(),
  language: z.string(),
  sectionIndex: z.number().int().nonnegative(),
  tableIndex: z.number().int().positive(),
  revisionId: z.number().int().positive(),
});

type TableCursor = z.infer<typeof TableCursorSchema>;

/** A selected table and an already validated continuation, if present. */
export type ArticleTableRead = { index: number; continuation?: TableCursor };

/** Reject malformed cursors and request mismatches before any edition or article lookup. */
export function articleTableRead(
  title: string,
  language: string,
  sectionIndex: number | undefined,
  tableIndex: number | undefined,
  cursor: string | undefined,
  ctx: RequestContext,
): ArticleTableRead | undefined {
  if (tableIndex === undefined && !cursor) return;
  if (sectionIndex === undefined || tableIndex === undefined) {
    throw validationError(
      'Table reads require section_index; continuation also requires table_index.',
      {
        reason: 'invalid_table',
      },
    );
  }
  if (!cursor) return { index: tableIndex };
  let decoded: unknown;
  try {
    decoded = decodeCursor(cursor, ctx);
  } catch (error) {
    if (!(error instanceof McpError) || error.data?.reason !== 'invalid_cursor') throw error;
    throw validationError(
      'The table cursor is malformed. Pass the previous next_cursor unchanged.',
      { reason: 'invalid_cursor' },
      { cause: error },
    );
  }
  const parsed = TableCursorSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.title !== title ||
    parsed.data.language !== language ||
    parsed.data.sectionIndex !== sectionIndex ||
    parsed.data.tableIndex !== tableIndex
  ) {
    throw validationError(
      'The table cursor does not match this article, language, section, or table.',
      { reason: 'invalid_cursor' },
    );
  }
  return { index: tableIndex, continuation: parsed.data };
}

/**
 * Largest reference page, in UTF-8 bytes on each surface — the `structuredContent` JSON and the
 * `content[]` text. Pages hold whole entries, so the budget matches a table page's.
 */
export const REFERENCES_PAGE_MAX_BYTES = DATA_TABLE_MAX_BYTES;

/** Revision and entry position bound to the exact references request. */
const ReferencesCursorSchema = z.strictObject({
  kind: z.literal('wikipedia_references_v1'),
  offset: z.number().int().positive(),
  limit: z.literal(REFERENCES_PAGE_MAX_BYTES),
  title: z.string(),
  language: z.string(),
  revisionId: z.number().int().positive(),
});

/** A validated references continuation: the pinned revision and the first entry of the next page. */
export type ReferencesCursor = z.infer<typeof ReferencesCursorSchema>;

/**
 * Decode a references cursor, rejecting a malformed one or one minted for another title or language
 * before any edition or article lookup. An empty cursor is the first page.
 */
export function referencesContinuation(
  title: string,
  language: string,
  cursor: string | undefined,
  ctx: RequestContext,
): ReferencesCursor | undefined {
  if (!cursor) return;
  let decoded: unknown;
  try {
    decoded = decodeCursor(cursor, ctx);
  } catch (error) {
    if (!(error instanceof McpError) || error.data?.reason !== 'invalid_cursor') throw error;
    throw validationError(
      'The references cursor is malformed. Pass the previous next_cursor unchanged.',
      { reason: 'invalid_cursor' },
      { cause: error },
    );
  }
  const parsed = ReferencesCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.title !== title || parsed.data.language !== language) {
    throw validationError('The references cursor does not match this article or language.', {
      reason: 'invalid_cursor',
    });
  }
  return parsed.data;
}

/** The opaque `next_cursor` continuing a references read at `offset` of the pinned revision. */
export function referencesCursor(
  title: string,
  language: string,
  revisionId: number,
  offset: number,
): string {
  return encodeCursor({
    kind: 'wikipedia_references_v1',
    title,
    language,
    revisionId,
    offset,
    limit: REFERENCES_PAGE_MAX_BYTES,
  } satisfies ReferencesCursor);
}

/** Selected-table metadata; `truncated` remains reserved for full-article outlining. */
type TablePage = {
  table_index: number;
  table_count: number;
  table_rows: number;
  row_offset: number;
  rows_returned: number;
  table_continued: boolean;
  next_cursor?: string;
  oversized_row?: boolean;
};

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
  const value = Number(
    new RegExp(`(?<=\\s)${name}\\s*=\\s*"?(\\d+)`, 'i').exec(openTag)?.[1] ?? '1',
  );
  return Math.max(value, 1);
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
 * {@link DATA_TABLE_MAX_BYTES} is replaced by a one-line omission marker naming its selector.
 */
function renderTable(kind: 'grid' | 'infobox', body: string, index: number): string {
  const { caption, rows } = parseTable(body);
  const rendered = kind === 'infobox' ? infoboxLines(rows) : gridLines(rows);
  const table =
    new TextEncoder().encode(rendered).length > DATA_TABLE_MAX_BYTES
      ? `[table omitted: ${rows.length} rows (table ${index})]`
      : rendered;
  return [cellText(caption, ' '), table].filter(Boolean).join(kind === 'infobox' ? '\n' : '\n\n');
}

/** Page expanded rows without splitting a row or repeating the first page's caption/header. */
function pageTable(
  kind: 'grid' | 'infobox',
  body: string,
  offset: number,
): { content: string; nextOffset: number; total: number; oversized: boolean } {
  const parsed = parseTable(body);
  const caption = cellText(parsed.caption, ' ');
  const grid = kind === 'grid' ? tableGrid(parsed.rows) : undefined;
  const rows = grid
    ? grid.some((row) => row.some(Boolean))
      ? grid.map((row) => tableRow(row))
      : []
    : parsed.rows.map((row) => infoboxLines([row]));
  if (offset > 0 && offset >= rows.length) {
    throw validationError('The table cursor row offset is past the end of the pinned table.', {
      reason: 'invalid_cursor',
    });
  }
  if (!rows.length)
    return {
      content: caption,
      nextOffset: 0,
      total: 0,
      oversized: Buffer.byteLength(formatTablePage(caption, false)) > DATA_TABLE_MAX_BYTES,
    };
  const header = grid ? `${rows[0]}\n${tableDelimiterRow(grid[0]?.length ?? 0)}` : rows[0];
  const initial = caption ? `${caption}${grid ? '\n\n' : '\n'}${header}` : (header as string);
  const selected: string[] = [];
  let bytes = 0;
  let nextOffset = offset;
  for (; nextOffset < rows.length; nextOffset++) {
    const row = nextOffset === 0 ? initial : (rows[nextOffset] as string);
    const plainBytes = Buffer.byteLength(row);
    const markdownBytes = Buffer.byteLength(formatTablePage(row, offset > 0));
    const separatorBytes = selected.length ? (offset > 0 ? 3 : 1) : 0;
    const cost = Math.max(plainBytes, markdownBytes) + separatorBytes;
    if (selected.length && bytes + cost > DATA_TABLE_MAX_BYTES) break;
    selected.push(row);
    bytes += cost;
    if (bytes > DATA_TABLE_MAX_BYTES) {
      nextOffset++;
      break;
    }
  }
  return {
    content: selected.join('\n'),
    nextOffset,
    total: rows.length,
    oversized: bytes > DATA_TABLE_MAX_BYTES,
  };
}

/**
 * Render data tables and clade trees in `html` and park the result, so the prose passes
 * that follow cannot re-decode its text or strip a `<tag>` its cells quote. A data table nested in a
 * cell of another is flattened into that cell rather than rendered on its own. Only data tables
 * consume selector ordinals; a tree's nested tables belong to that tree.
 */
function renderDataTables(html: string, parked: ParkedBlocks, render: typeof renderTable): string {
  const openTag = /<table\b[^>]*>/gi;
  let rendered = '';
  let cursor = 0;
  let index = 0;
  for (let open = openTag.exec(html); open; open = openTag.exec(html)) {
    const kind = dataTableKind(open[0]);
    const clade = isClade(open[0]);
    if (!kind && !clade) continue;
    const bodyStart = open.index + open[0].length;
    const end = elementEnd(html, 'table', bodyStart);
    rendered +=
      html.slice(cursor, open.index) +
      parked.park(
        kind && !clade
          ? render(kind, html.slice(bodyStart, end), ++index)
          : renderClade(html.slice(bodyStart, end)),
      );
    cursor = end;
    openTag.lastIndex = end;
  }
  return rendered + html.slice(cursor);
}

/** A clade cell's own text and nested tables, excluding descendant text from that own text. */
type CladeCell = { html: string[]; children: CladeRow[][] };
type CladeRow = { label?: CladeCell; leaf?: CladeCell; secondary?: CladeCell };
type CladeFrame = { rows: CladeRow[]; row?: CladeRow; cell?: CladeCell };

/**
 * Parse all nested clades in one structural walk. Row ownership pairs a label with its leaf;
 * separate rows are siblings even when both labels occur in the same table. Empty secondary-label
 * rows are connector geometry. Unknown or incomplete structure gets an explicit omission marker.
 * Both parsing and output traversal use stacks so deeply nested forks do not consume the JS stack.
 */
function renderClade(body: string): string {
  const omitted = '[table omitted: unparseable clade]';
  const root: CladeFrame = { rows: [] };
  const frames = [root];
  const tag = new RegExp(TABLE_STRUCTURE_TAG.source, 'gi');
  let cursor = 0;
  let closed = false;
  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    const frame = frames.at(-1);
    if (!frame) return omitted;
    frame.cell?.html.push(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] as string).toLowerCase();
    if (name === 'table') {
      if (closing) {
        if (frame.row || frame.cell) return omitted;
        frames.pop();
        if (!frames.length) {
          closed = true;
          break;
        }
      } else {
        if (!isClade(match[0]) || !frame.cell || frame.cell !== frame.row?.leaf) return omitted;
        const child: CladeFrame = { rows: [] };
        frame.cell.children.push(child.rows);
        frames.push(child);
      }
    } else if (name === 'tr') {
      if (frame.cell || (closing ? !frame.row : frame.row)) return omitted;
      if (closing) delete frame.row;
      else {
        frame.row = {};
        frame.rows.push(frame.row);
      }
    } else if (name === 'td' || name === 'th') {
      if (!frame.row) return omitted;
      if (closing) {
        if (!frame.cell) return omitted;
        delete frame.cell;
      } else {
        if (frame.cell) return omitted;
        const classes = CLASS_ATTRIBUTE.exec(match[0])?.[1]?.split(/\s+/) ?? [];
        const role = classes.includes('clade-label')
          ? 'label'
          : classes.includes('clade-leaf')
            ? 'leaf'
            : classes.includes('clade-slabel')
              ? 'secondary'
              : undefined;
        if (!role || frame.row[role]) return omitted;
        frame.cell = { html: [], children: [] };
        frame.row[role] = frame.cell;
      }
    } else return omitted;
  }
  if (!closed || !root.rows.length) return omitted;

  const lines: string[] = [];
  const pending = root.rows.map((row) => ({ row, depth: 0 })).reverse();
  while (pending.length) {
    const { row, depth } = pending.pop() as { row: CladeRow; depth: number };
    if (row.secondary) {
      if (
        row.label ||
        row.leaf ||
        row.secondary.children.length ||
        cellText(row.secondary.html.join(''), ' ')
      )
        return omitted;
      continue;
    }
    if (!row.label || !row.leaf || row.label.children.length) return omitted;
    const label = cellText(row.label.html.join(''), ' ');
    const leaf = cellText(row.leaf.html.join(''), ' ');
    const children = row.leaf.children;
    if ((!leaf && !children.length) || (leaf && children.length)) return omitted;
    const indent = '  '.repeat(depth);
    lines.push(`${indent}-${label ? ` ${label}` : children.length ? '' : ` ${leaf}`}`);
    if (label && leaf) lines.push(`${indent}  - ${leaf}`);
    for (let table = children.length - 1; table >= 0; table--) {
      const rows = children[table] as CladeRow[];
      if (!rows.length) return omitted;
      for (let index = rows.length - 1; index >= 0; index--) {
        pending.push({ row: rows[index] as CladeRow, depth: depth + 1 });
      }
    }
  }
  return lines.length ? fenceCodeBlock(lines.join('\n')) : omitted;
}

/**
 * Convert article HTML into the plain-text shape every read path returns: `== Heading ==` markers in
 * document order, paragraphs separated by a blank line, list items as marked lines. It renders all three
 * HTML sources the read paths fetch — the parser's HTML for one section (`action=parse&prop=text`),
 * TextExtracts' HTML-mode full-article extract (`prop=extracts` without `explaintext`), and the REST
 * summary's `extract_html` — so a superscript, a formula, or a code sample reads the same on each.
 *
 * Sourcing section reads from rendered HTML rather than raw wikitext is what makes inline templates
 * survive — `{{code|if}}` reaches this function already expanded to `if`, where a wikitext stripper
 * has to re-implement the template grammar and drops what it cannot expand.
 *
 * Several constructs carry syntax of their own, written by `text-blocks.ts`. A `<pre>` sample becomes
 * a fenced code block that keeps its line breaks and indentation while everything around it is
 * collapsed, because in a code sample indentation is syntax. A data table becomes pipe rows, and an
 * infobox `label: value` lines. A clade tree uses a fence to preserve branch indentation on both
 * surfaces. A list keeps its markers and nesting: `- ` or `N.` item lines, two spaces deeper per
 * level ({@link renderLists}). Superscripts and subscripts stay distinct from their neighbours
 * ({@link renderScripts}).
 *
 * Pass order is what keeps each pass's input intact. Furniture, hidden elements, and footnote markers
 * go first, so no later pass renders them. Scripts render next, so a table cell or a heading reads
 * `10²³` the way prose does. Tables render before code is parked, so a `<pre>` inside a cell is
 * flattened onto that cell's line. Lists render after both, so a table or code sample inside an item
 * keeps its lines under the item's indent. All three are parked before the prose passes, which would
 * otherwise decode their text a second time and strip any tag it quotes. Unbalanced input — which
 * TextExtracts warns its HTML mode may emit — loses nothing for being unclosed beyond what a drop rule
 * selects: an unclosed table renders to the end of the input, an unclosed list closes where HTML
 * would close it, an unclosed heading, `<pre>`, `<sup>`, or `<math>` reads as ordinary text, and an
 * unclosed script cannot reach past a block boundary, nor an unclosed formula past the next formula,
 * to borrow a later close tag.
 *
 * Pure and exported for unit testing.
 */
export function htmlSectionToPlainText(html: string): string {
  return renderSectionHtml(html, renderTable);
}

/** Preserve formulas and scripts before any caller strips tags or decodes entities. */
function prepareInlineHtml(html: string): string {
  let text = dropComments(html);

  // Lift each formula out of its `<img alt>` before anything is dropped, so the TeX survives the
  // removal of the hidden MathML twin that used to be its only carrier. A visible `<math>` — the
  // full-article extract's only form — becomes its `alttext` the same way; the hidden twin a section
  // read carries becomes its TeX too, and is then dropped whole with the element hiding it. Both are
  // inserted still escaped, so the single decode pass below reads each exactly once. A display
  // formula's TeX sits between line breaks, an inline one's in its sentence.
  const formula = (tag: string, tex: string): string =>
    tex && DISPLAY_FORMULA.test(tag) ? `<br>${tex}<br>` : tex;
  const end = text.lastIndexOf('>') + 1;
  text =
    text
      .slice(0, end)
      .replace(MATH_FALLBACK_IMAGE, (match) => formula(match, ALT_ATTRIBUTE.exec(match)?.[1] ?? ''))
      .replace(MATH_ELEMENT, (_match, attributes: string) =>
        formula(attributes, ALTTEXT_ATTRIBUTE.exec(attributes)?.[1] ?? ''),
      ) + text.slice(end);

  return renderScripts(dropElements(text));
}

/** Share the preparation and table walk between inline rendering and selected-table reads. */
function renderSectionHtml(html: string, render: typeof renderTable): string {
  let text = prepareInlineHtml(html);

  const parked = new ParkedBlocks();
  text = renderDataTables(text, parked, render);

  // A table parked inside a `<pre>` is restored into the code before the fence is sized, so no
  // backtick run in it can close the fence early.
  text = replaceElements(text, 'pre', (_tagName, body) => {
    const code = parked
      .restore(decodeEntities(stripTags(body)))
      .replace(/[^\S\n]+$/gm, '')
      .replace(/^\n+|\n+$/g, '');
    return parked.park(code && fenceCodeBlock(code));
  });

  text = renderLists(text, parked);
  return parked.restore(renderProse(text));
}

/** A parked block's placeholder, captured, for splitting text around it. */
const PARKED_PLACEHOLDER = /(￿\d+￿)/;

/**
 * A source line break, with the spaces and tabs around it, between two wide East Asian characters
 * (Han, kana, CJK punctuation, fullwidth forms; Hangul excluded). A browser removes such a break
 * rather than showing it as a space (CSS Text's segment-break rule), so `ください。` and the next
 * line's `後述` read as one run.
 */
const WIDE_SEGMENT_BREAK =
  /(?<=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}　-〿！-｠￠-￦])[ \t\r]*\n[ \t\r\n]*(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}　-〿！-｠￠-￦])/gu;

/**
 * The prose passes, over HTML whose code samples, tables, and lists are parked. Every whitespace run
 * becomes one space first — a source line break inside a paragraph is a space, as a browser renders
 * it, except between two wide East Asian characters ({@link WIDE_SEGMENT_BREAK}), where it is
 * dropped — while each placeholder keeps a paragraph of its own. Then headings become `== Heading ==`
 * markers, `<br>` a line break, and every other block boundary a paragraph break; `tr`/`td`/`th` are
 * boundaries because a layout table's cells reach here, and without them two columns of a
 * `{{col-begin}}` list run into one line. Tags and entities go last.
 */
function renderProse(html: string): string {
  let text = html
    .split(PARKED_PLACEHOLDER)
    .map((part, i) =>
      i % 2 ? `\n\n${part}\n\n` : part.replace(WIDE_SEGMENT_BREAK, '').replace(/\s+/g, ' '),
    )
    .join('');
  text = replaceElements(text, 'h[1-6]', (tagName, inner) => {
    const bar = '='.repeat(Math.max(2, Number(tagName.slice(1))));
    return `\n\n${bar} ${stripTags(inner).trim()} ${bar}\n\n`;
  });
  const end = text.lastIndexOf('>') + 1;
  text =
    text
      .slice(0, end)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|ul|ol|dl|dd|dt|blockquote|section|tr|td|th)\b[^>]*>/gi, '\n\n') +
    text.slice(end);
  return decodeEntities(stripTags(text))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `html` without its comments. An unclosed `<!--` stays, as text, with everything after it. */
function dropComments(html: string): string {
  let kept = '';
  let cursor = 0;
  for (let open = html.indexOf('<!--'); open >= 0; open = html.indexOf('<!--', cursor)) {
    const close = html.indexOf('-->', open + 4);
    if (close < 0) break;
    kept += html.slice(cursor, open);
    cursor = close + 3;
  }
  return kept + html.slice(cursor);
}

/**
 * Replace each element of the tags `name` matches — a regex source such as `h[1-6]` — with
 * `replace(tagName, body)`, `tagName` lowercased. An open tag pairs with the first end tag of its own
 * name after it, its body is everything between the two, and an open tag with no such end tag stays
 * as text. Pairing resumes after each replaced element, so no open tag inside a body is paired again.
 */
function replaceElements(
  html: string,
  name: string,
  replace: (tagName: string, body: string) => string,
): string {
  // Each tag name's end tags in document order, and the first one an open tag can still pair with.
  const ends = new Map<string, { tags: RegExpExecArray[]; next: number }>();
  for (const tag of html.matchAll(new RegExp(`</(${name})\\s*>`, 'gi'))) {
    const tagName = (tag[1] as string).toLowerCase();
    const found = ends.get(tagName) ?? { tags: [], next: 0 };
    found.tags.push(tag);
    ends.set(tagName, found);
  }

  const open = new RegExp(`<(${name})\\b`, 'gi');
  let replaced = '';
  let cursor = 0;
  // The `>` ending the latest open tag, which also ends every open tag that starts before it.
  let bracket = -1;
  for (let tag = open.exec(html); tag; tag = open.exec(html)) {
    const attributes = tag.index + tag[0].length;
    if (bracket < attributes) bracket = html.indexOf('>', attributes);
    if (bracket < 0) break;
    const tagName = (tag[1] as string).toLowerCase();
    const end = ends.get(tagName);
    if (!end) continue;
    while ((end.tags[end.next]?.index ?? Number.POSITIVE_INFINITY) <= bracket) end.next++;
    const close = end.tags[end.next];
    if (!close) continue;
    replaced +=
      html.slice(cursor, tag.index) + replace(tagName, html.slice(bracket + 1, close.index));
    cursor = close.index + close[0].length;
    open.lastIndex = cursor;
  }
  return replaced + html.slice(cursor);
}

/** An item MediaWiki hides with CSS because it is empty: dropped, and not counted. */
const isEmptyItem = hasClass('mw-empty-elt');

/** An open tag's `start` or `value` attribute, quoted or bare, still unparsed. */
const START_ATTRIBUTE = /(?<=\s)start\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const VALUE_ATTRIBUTE = /(?<=\s)value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** An ordered list's `reversed` attribute. */
const REVERSED_ATTRIBUTE = /(?<=\s)reversed(?=[\s=/>])/i;

/**
 * An integer attribute read by HTML's rules for parsing integers — leading whitespace, a sign, then
 * digits, the rest ignored, so `14a` reads 14 — or `undefined` when it is absent, holds no integer, or
 * lies past the range a number carries exactly.
 */
function integerAttribute(openTag: string, attribute: RegExp): number | undefined {
  const match = attribute.exec(openTag);
  const digits = /^[\t\n\f\r ]*([+-]?\d+)/.exec(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')?.[1];
  const value = Number(digits);
  return digits !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

/** One item of a list, or an unmarked entry holding a list nested directly inside a list. */
type ListEntry = { marked: boolean; value?: number; content: Array<string | ListFrame> };

/** One list the walk read; its item count is known once it closes, before any line is written. */
type ListFrame = {
  ordered: boolean;
  reversed: boolean;
  start?: number;
  entries: ListEntry[];
  /** Marked items: where a reversed list without `start` counts down from. */
  items: number;
  /** The entry text and nested lists go to now; a hidden item's is never rendered. */
  open?: ListEntry;
  /** Block containers opened inside the list and not yet closed, by tag name. */
  containers: Map<string, number>;
};

/** The tags the list walk reads: lists and items, the blocks a list sits inside, and headings. */
const LIST_WALK_TAG =
  /<(\/?)(ul|ol|li|div|table|tr|td|th|blockquote|section|dl|dd|dt|h[1-6])\b[^>]*>/gi;

/** Deepest indentation level a list line takes; a list nested deeper is laid out at this level. */
const LIST_MAX_LEVEL = 16;

/**
 * Render every outermost list in `html` to its final lines and park it, in one walk over the tags.
 *
 * An item is `- text` in a `<ul>` and `N. text` in an `<ol>`, numbered as a browser numbers it: from
 * `start`, or a `reversed` list's item count, counting down in a reversed list, and from an item's own
 * `value`; the marker is decimal whatever `type` says. A nested list sits two spaces deeper than the
 * item holding it, and every other line of an item — a paragraph, a `<br>`, a definition line, a
 * parked table or code sample — two spaces deeper than its marker line, with no blank line anywhere
 * in a list. Each list is parked whole, so the whitespace passes never reach its indentation.
 *
 * Unbalanced input closes where HTML would close it: an item at the next item or its list's end, a
 * list at the end tag of a block it sits inside. A heading also ends every open list, and so does
 * text inside a list but outside any item, which is where a lost `</ul>` leaves the text after it, so
 * nothing past a list is swallowed into its last item. An item outside any list is a line break.
 */
function renderLists(html: string, parked: ParkedBlocks): string {
  const tag = new RegExp(LIST_WALK_TAG.source, 'gi');
  const tagged = taggedPrefix(html);
  const frames: ListFrame[] = [];
  const openLists = { ul: 0, ol: 0 };
  let rendered = '';
  let cursor = 0;

  const close = () => {
    const frame = frames.pop() as ListFrame;
    openLists[frame.ordered ? 'ol' : 'ul']--;
    if (!frames.length) rendered += parked.park(listText(frame, parked));
  };
  const addContent = (entry: ListEntry, part: string | ListFrame) => {
    const last = entry.content.length - 1;
    if (typeof part === 'string' && typeof entry.content[last] === 'string') {
      entry.content[last] += part;
    } else entry.content.push(part);
  };
  const append = (text: string) => {
    if (!text) return;
    while (frames.length && !frames.at(-1)?.open && /\S/.test(stripTags(text))) close();
    const frame = frames.at(-1);
    if (!frame) rendered += text;
    else if (frame.open) addContent(frame.open, text);
  };

  for (let match = tag.exec(tagged); match; match = tag.exec(tagged)) {
    append(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] as string).toLowerCase();
    const frame = frames.at(-1);

    if (name === 'ul' || name === 'ol') {
      if (!closing) {
        const start = name === 'ol' ? integerAttribute(match[0], START_ATTRIBUTE) : undefined;
        const list: ListFrame = {
          ordered: name === 'ol',
          reversed: name === 'ol' && REVERSED_ATTRIBUTE.test(match[0]),
          ...(start !== undefined && { start }),
          entries: [],
          items: 0,
          containers: new Map(),
        };
        if (frame) {
          if (!frame.open) {
            frame.open = { marked: false, content: [] };
            frame.entries.push(frame.open);
          }
          addContent(frame.open, list);
        }
        frames.push(list);
        openLists[name]++;
      } else if (openLists[name] > 0) {
        while ((frames.at(-1) as ListFrame).ordered !== (name === 'ol')) close();
        close();
      } else if (!frame) rendered += match[0];
    } else if (name === 'li') {
      if (!frame) rendered += closing ? '' : '<br>';
      else if (closing) delete frame.open;
      else if (isEmptyItem(match[0])) frame.open = { marked: false, content: [] };
      else {
        const value = frame.ordered ? integerAttribute(match[0], VALUE_ATTRIBUTE) : undefined;
        const item: ListEntry = {
          marked: true,
          ...(value !== undefined && { value }),
          content: [],
        };
        frame.open = item;
        frame.entries.push(item);
        frame.items++;
      }
    } else if (name.startsWith('h')) {
      if (!closing) while (frames.length) close();
      append(match[0]);
    } else if (!frame) {
      rendered += match[0];
    } else if (!closing) {
      frame.containers.set(name, (frame.containers.get(name) ?? 0) + 1);
      append(match[0]);
    } else {
      while (frames.length && !frames.at(-1)?.containers.get(name)) close();
      const holder = frames.at(-1);
      holder?.containers.set(name, (holder.containers.get(name) as number) - 1);
      append(match[0]);
    }
  }
  append(html.slice(cursor));
  while (frames.length) close();
  return rendered;
}

/** A closed list's lines. */
function listText(root: ListFrame, parked: ParkedBlocks): string {
  type Task =
    | { kind: 'list'; frame: ListFrame; level: number }
    | { kind: 'marker'; entry: ListEntry; marker: string; level: number }
    | { kind: 'text'; entry: ListEntry; html: string; level: number };
  const lines: string[] = [];
  // The marker line still waiting for its item's first line of text.
  let marker: { entry: ListEntry; line: number } | undefined;
  const emit = (level: number, text: string) => {
    lines.push(listLine(Math.min(level, LIST_MAX_LEVEL), text));
    marker = undefined;
  };

  const pending: Task[] = [{ kind: 'list', frame: root, level: 0 }];
  for (let task = pending.pop(); task; task = pending.pop()) {
    if (task.kind === 'marker') {
      emit(task.level, task.marker);
      marker = { entry: task.entry, line: lines.length - 1 };
    } else if (task.kind === 'text') {
      for (const line of renderProse(task.html).split('\n')) {
        if (!line) continue;
        const block = parked.blockAt(line);
        if (block !== undefined) {
          for (const blockLine of block.split('\n')) emit(task.level, blockLine);
        } else if (marker?.entry === task.entry) {
          lines[marker.line] += ` ${line}`;
          marker = undefined;
        } else emit(task.level, line);
      }
    } else {
      const { frame, level } = task;
      const tasks: Task[] = [];
      let ordinal = frame.start ?? (frame.reversed ? frame.items : 1);
      for (const entry of frame.entries) {
        if (entry.marked) {
          if (entry.value !== undefined) ordinal = entry.value;
          tasks.push({ kind: 'marker', entry, marker: frame.ordered ? `${ordinal}.` : '-', level });
          ordinal += frame.reversed ? -1 : 1;
        }
        for (const part of entry.content) {
          tasks.push(
            typeof part === 'string'
              ? { kind: 'text', entry, html: part, level: level + 1 }
              : { kind: 'list', frame: part, level: level + 1 },
          );
        }
      }
      for (let i = tasks.length - 1; i >= 0; i--) pending.push(tasks[i] as Task);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reference lists
// ---------------------------------------------------------------------------

/** One footnote of an article's reference lists, in the shape `wikipedia_get_references` returns. */
export type ReferenceEntry = {
  id: string;
  group?: string;
  label?: string;
  text: string;
  urls?: string[];
  dois?: string[];
  work_ids?: string[];
};

/** A full citation a short citation (`{{sfn}}`) links to through its `CITEREF…` anchor. */
export type ReferenceWork = { id: string; text: string; urls?: string[]; dois?: string[] };

/** An in-text footnote marker, `[2]`; the same class the renderer drops it by. */
const isFootnoteMarker = hasClass('reference');

/** A rendered reference list, `<references/>` or `{{reflist}}`. */
const isReferenceList = hasClass('references');

/** A list entry's citation body, without the backlinks beside it. */
const isReferenceText = hasClass('reference-text');

/** A link leaving the wiki: `external text`, `external free`, or `external autonumber`. */
const isExternalLink = hasClass('external');

/**
 * An open tag's `id`, `href`, and reference-list group attributes, still HTML-escaped. Each name
 * must follow whitespace: `\b` also matches after a hyphen, so `\bhref` would read the
 * `data-mw-original-href` that precedes `href` on a link the parser rewrote from http to https.
 */
const ID_ATTRIBUTE = /(?<=\s)id\s*=\s*"([^"]*)"/i;
const HREF_ATTRIBUTE = /(?<=\s)href\s*=\s*"([^"]*)"/i;
const GROUP_ATTRIBUTE = /(?<=\s)data-mw-group\s*=\s*"([^"]*)"/i;

/** The id prefix CS1 and Harvard templates give a full citation that short citations link to. */
const WORK_ANCHOR_PREFIX = 'CITEREF';

/** Hosts whose path is a DOI: `{{doi}}` and CS1 `doi=` link `doi.org`; some editions `dx.doi.org`. */
const DOI_HOSTS: ReadonlySet<string> = new Set(['doi.org', 'dx.doi.org']);

/** `html` cut after its last `>`, so a tag scan never runs `[^>]*` off the end of the payload. */
function taggedPrefix(html: string): string {
  return html.slice(0, html.lastIndexOf('>') + 1);
}

/**
 * A footnote marker's visible text, `[2]` or `[N 1]`, read from its body, each whitespace run one
 * space. Untrimmed: an `{{rp}}` page number (`: 3–4`) ends in a hair space that separates it from
 * the next marker. A label trims it.
 */
function markerText(body: string): string {
  return decodeEntities(stripTags(body)).replace(/\s+/g, ' ');
}

/**
 * Turn every footnote marker in `html` into its visible text, so a note citing other notes keeps
 * them (`Attributed to multiple references:[1][2][3]`) instead of the renderer dropping them, and an
 * `{{rp}}` page number keeps the space after it (`[288]: 3–4 [289]`). The text goes back in
 * HTML-escaped, for the renderer's one decode pass.
 */
function markersToText(html: string): string {
  const tagged = taggedPrefix(html);
  const supTag = /<sup\b[^>]*>/gi;
  let kept = '';
  let cursor = 0;
  for (let open = supTag.exec(tagged); open; open = supTag.exec(tagged)) {
    if (!isFootnoteMarker(open[0])) continue;
    const bodyStart = open.index + open[0].length;
    const end = elementEnd(tagged, 'sup', bodyStart);
    const visible = markerText(tagged.slice(bodyStart, end))
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    kept += html.slice(cursor, open.index) + visible;
    cursor = end;
    supTag.lastIndex = end;
  }
  return kept + html.slice(cursor);
}

/** The DOI a `doi.org` link names, percent-decoded; `undefined` for any other URL. */
function doiOf(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (!parsed || !DOI_HOSTS.has(parsed.hostname)) return;
  const path = parsed.pathname.slice(1);
  if (!path) return;
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape cannot be decoded; the path as linked is still the DOI the page cites.
    return path;
  }
}

/**
 * A citation's rendered text, its external links (each once, verbatim, archive copies included), the
 * DOIs among them, and the `CITEREF…` anchors it links to.
 */
function citationParts(html: string): {
  text: string;
  urls: string[];
  dois: string[];
  workIds: string[];
} {
  const urls = new Set<string>();
  const workIds = new Set<string>();
  const linkTag = /<a\b[^>]*>/gi;
  const tagged = taggedPrefix(html);
  for (let open = linkTag.exec(tagged); open; open = linkTag.exec(tagged)) {
    const href = HREF_ATTRIBUTE.exec(open[0])?.[1];
    if (href === undefined) continue;
    const target = decodeEntities(href);
    if (isExternalLink(open[0])) urls.add(target);
    else if (target.startsWith(`#${WORK_ANCHOR_PREFIX}`)) workIds.add(target.slice(1));
  }
  const dois = new Set<string>();
  for (const url of urls) {
    const doi = doiOf(url);
    if (doi) dois.add(doi);
  }
  return {
    text: htmlSectionToPlainText(markersToText(html)),
    urls: [...urls],
    dois: [...dois],
    workIds: [...workIds],
  };
}

/** The body of the first `tagName` element in `html` its open tag passes `test` for. */
function firstElementBody(
  html: string,
  tagName: string,
  test: (openTag: string) => boolean,
): string | undefined {
  const tagged = taggedPrefix(html);
  const openTag = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (let open = openTag.exec(tagged); open; open = openTag.exec(tagged)) {
    if (!test(open[0])) continue;
    const bodyStart = open.index + open[0].length;
    return tagged.slice(bodyStart, elementEnd(tagged, tagName, bodyStart));
  }
  return;
}

/**
 * Every footnote in a page's parser HTML (`action=parse&prop=text` for the whole page), in document
 * order across its reference lists, plus the full citations its short citations link to.
 *
 * One walk over the open tags collects the three things a footnote is assembled from: each
 * `ol.references` list with its `data-mw-group`; the first in-text marker naming each footnote,
 * whose text is the footnote's label; and each element whose `id` is a `CITEREF…` anchor. List
 * entries are then read in order — the `id` decoded from the parser's entity-escaped form
 * (`cite&#95;note-sandre-2`), the citation body from `span.reference-text`, rendered through
 * {@link htmlSectionToPlainText} with any marker inside it kept as text. Only a work some entry links
 * to is rendered.
 *
 * Every scan jumps past the element it consumed and every tag scan stops at the last `>`, so the work
 * stays linear in the payload — up to 1.6 MB for the largest articles — whatever the nesting.
 */
export function extractReferences(html: string): {
  references: ReferenceEntry[];
  works: Map<string, ReferenceWork>;
} {
  const tagged = taggedPrefix(html);
  const labels = new Map<string, string>();
  const anchors = new Map<string, string>();
  const lists: Array<{ body: string; group?: string }> = [];

  const openTag = new RegExp(OPEN_TAG.source, 'gi');
  let listEnd = 0;
  for (let open = openTag.exec(tagged); open; open = openTag.exec(tagged)) {
    const tagName = (open[1] as string).toLowerCase();
    if (VOID_TAGS.has(tagName)) continue;
    const bodyStart = open.index + open[0].length;

    if (tagName === 'sup' && isFootnoteMarker(open[0])) {
      const end = elementEnd(tagged, 'sup', bodyStart);
      const body = tagged.slice(bodyStart, end);
      const href = HREF_ATTRIBUTE.exec(body)?.[1];
      const target = href?.startsWith('#') ? decodeEntities(href.slice(1)) : undefined;
      if (target !== undefined && !labels.has(target)) {
        labels.set(
          target,
          markerText(body)
            .trim()
            .replace(/^\[([\s\S]*)\]$/, '$1'),
        );
      }
      openTag.lastIndex = end;
      continue;
    }

    if (tagName === 'ol' && open.index >= listEnd && isReferenceList(open[0])) {
      listEnd = elementEnd(tagged, 'ol', bodyStart);
      const group = GROUP_ATTRIBUTE.exec(open[0])?.[1];
      lists.push({
        body: tagged.slice(bodyStart, listEnd),
        ...(group && { group: decodeEntities(group) }),
      });
      continue;
    }

    const rawId = ID_ATTRIBUTE.exec(open[0])?.[1];
    const id = rawId === undefined ? undefined : decodeEntities(rawId);
    if (id?.startsWith(WORK_ANCHOR_PREFIX)) {
      const end = elementEnd(tagged, tagName, bodyStart);
      if (!anchors.has(id)) anchors.set(id, tagged.slice(bodyStart, end));
      openTag.lastIndex = end;
    }
  }

  const references: ReferenceEntry[] = [];
  const linked = new Set<string>();
  for (const list of lists) {
    const itemTag = /<li\b[^>]*>/gi;
    for (let open = itemTag.exec(list.body); open; open = itemTag.exec(list.body)) {
      const bodyStart = open.index + open[0].length;
      const end = elementEnd(list.body, 'li', bodyStart);
      itemTag.lastIndex = end;
      const rawId = ID_ATTRIBUTE.exec(open[0])?.[1];
      if (rawId === undefined) continue;
      const id = decodeEntities(rawId);
      const item = list.body.slice(bodyStart, end);
      const parts = citationParts(firstElementBody(item, 'span', isReferenceText) ?? item);
      for (const workId of parts.workIds) linked.add(workId);
      const label = labels.get(id);
      references.push({
        id,
        ...(list.group && { group: list.group }),
        ...(label && { label }),
        text: parts.text,
        ...(parts.urls.length && { urls: parts.urls }),
        ...(parts.dois.length && { dois: parts.dois }),
        ...(parts.workIds.length && { work_ids: parts.workIds }),
      });
    }
  }

  const works = new Map<string, ReferenceWork>();
  for (const id of linked) {
    const body = anchors.get(id);
    if (body === undefined) continue;
    const parts = citationParts(body);
    works.set(id, {
      id,
      text: parts.text,
      ...(parts.urls.length && { urls: parts.urls }),
      ...(parts.dois.length && { dois: parts.dois }),
    });
  }
  return { references, works };
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
export function tocLineToPlainText(line: string): string {
  return stripMarkup(prepareInlineHtml(line)).replace(/\s+/g, ' ');
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

/**
 * Legacy language codes the sitematrix no longer lists, each with the edition it names. Wikipedia's
 * interwiki map still routes all three to that edition, and `nb` is the code langlinks reports for
 * no.wikipedia.org, so a caller can pass back a code `wikipedia_get_languages` handed it. `zh-cn`
 * and `zh-tw` stay out: the interwiki map routes them to zh.wikipedia.org, but they name script
 * variants of one edition, not editions.
 */
const LEGACY_EDITION_CODES: ReadonlyMap<string, string> = new Map([
  ['nb', 'no'],
  ['be-x-old', 'be-tarask'],
  ['egl', 'eml'],
]);

/**
 * The origin `hosts` maps `code` to, matched case-insensitively. Own keys only, since `code` is
 * caller input and a plain object answers `constructor` from its prototype.
 */
function indexedHost(hosts: Readonly<Record<string, string>>, code: string): string | undefined {
  const key = code.toLowerCase();
  return Object.hasOwn(hosts, key) ? hosts[key] : undefined;
}

/**
 * `hosts` with each {@link LEGACY_EDITION_CODES} entry keyed to the origin of the edition it names,
 * wherever that edition is indexed — never over a code the index already holds.
 */
function withLegacyCodes(hosts: Readonly<Record<string, string>>): Record<string, string> {
  const keyed = { ...hosts };
  for (const [legacy, edition] of LEGACY_EDITION_CODES) {
    const origin = indexedHost(hosts, edition);
    if (origin && !Object.hasOwn(keyed, legacy)) keyed[legacy] = origin;
  }
  return keyed;
}

/**
 * Fallback code → canonical origin, for the degraded resolution path: every fallback subdomain,
 * plus the legacy codes naming one of them, as the live index keys them.
 */
const FALLBACK_EDITION_HOSTS: ReadonlyMap<string, string> = new Map(
  Object.entries(
    withLegacyCodes(
      Object.fromEntries(
        FALLBACK_EDITION_SUBDOMAINS.map((code) => [code, `https://${code}.wikipedia.org`]),
      ),
    ),
  ),
);

/**
 * Every Wikipedia edition indexed by each code a caller may legitimately pass: the edition's
 * subdomain, its MediaWiki language code when the two differ, and any legacy code naming it
 * ({@link LEGACY_EDITION_CODES}). Every spelling maps to the same canonical origin, so `als` and
 * `gsw` alike resolve to `https://als.wikipedia.org` — which is what lets the langlinks host
 * fallback compose a real host from a language code.
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
 * Upstream ceiling for `list=search`'s `srlimit`, per `action=paraminfo`. The module's `highmax` of
 * 5000 requires the `apihighlimits` right, which an anonymous caller never has, so 500 is the real
 * bound. A page past {@link PAGE_META_CHUNK_SIZE} results has its metadata looked up in chunks.
 */
export const SEARCH_MAX_LIMIT = 500;

/** Supported upstream search orders. */
export const SEARCH_SORTS = [
  'relevance',
  'last_edit_desc',
  'create_timestamp_desc',
  'incoming_links_desc',
  'title_natural_asc',
] as const;

/** Redirect origin and target fragment, with an index only after TOC verification. */
export type RedirectInfo = {
  redirected_from?: string;
  redirect_section?: string;
  redirect_section_index?: number;
};

/** Resolve a redirect chain's final fragment against actual upstream anchors. */
export function redirectInfo(
  redirects: ActionRedirectRaw[] | undefined,
  toc?: ActionSectionsRaw['parse'],
): RedirectInfo {
  if (!redirects?.length) return {};
  let fragment: string | undefined;
  for (const hop of redirects) if (hop.tofragment) fragment = hop.tofragment;
  const origin = redirects[0]?.from;
  const info: RedirectInfo = { ...(origin && { redirected_from: origin }) };
  if (!fragment) return info;
  const normalized = fragment.replaceAll('_', ' ');
  const matches = (toc?.tocdata?.sections ?? []).filter(
    (section) => section.anchor?.replaceAll('_', ' ') === normalized,
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  const index =
    match?.index === undefined || match.index.trim() === '' ? undefined : Number(match.index);
  return {
    ...info,
    redirect_section: match?.line ? tocLineToPlainText(match.line) : fragment,
    ...(Number.isSafeInteger(index) &&
      index !== undefined &&
      String(index) === match?.index &&
      index >= 0 && { redirect_section_index: index }),
  };
}

/**
 * What a summary's redirect lookup established: the title needed no redirect, the redirect REST
 * followed, or nothing, because the lookup failed or answered for another page.
 */
type SummaryRedirect =
  | { kind: 'none' }
  | { kind: 'followed'; info: RedirectInfo }
  | { kind: 'unchecked' };

/**
 * MediaWiki's title whitespace, which a page title folds in runs to one space. Narrower than `\s`
 * on purpose: a BOM is not whitespace to MediaWiki, so a title holding one names a different page.
 */
const TITLE_WHITESPACE = /[ _\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/;

/**
 * Whether `input`, normalized as MediaWiki normalizes a page title, already is `resolvedTitle` — so
 * the REST summary reached it without a redirect and the redirect lookup is not needed.
 *
 * The `#fragment` is dropped, the text NFC-normalized, and each run of title whitespace (underscore
 * included) folded to one space with none left at either end. The first letter matches as written or
 * uppercased, the uppercase trusted only when it is one code point: MediaWiki titlecases rather than
 * uppercases (`ǆ` → `ǅ`, `ﬀ` → `Ff`) and keeps `ß`, so a title opening on such a letter pays the
 * lookup unless upstream kept it as written. A `false` for a title that needed no redirect costs one
 * request and reports nothing. A `true` can hide a redirect only where an edition capitalizes a first
 * letter other than to its uppercase — not at all, or Turkish `i` → `İ` — and the alias differs from
 * its target in exactly that letter.
 */
export function resolvesWithoutRedirect(input: string, resolvedTitle: string): boolean {
  const name = (input.split('#', 1)[0] ?? '')
    .normalize('NFC')
    .split(TITLE_WHITESPACE)
    .filter(Boolean)
    .join(' ');
  if (name === resolvedTitle) return true;
  const first = name.codePointAt(0);
  if (first === undefined) return false;
  const letter = String.fromCodePoint(first);
  const upper = letter.toUpperCase();
  return [...upper].length === 1 && upper + name.slice(letter.length) === resolvedTitle;
}

/**
 * The part of a TOC lookup a summary reads: the page it resolved to, the redirect chain, and the
 * anchors that index a section target. Parsed rather than cast, so a malformed body leaves the
 * redirect unchecked instead of failing a summary that already answered.
 */
const SummaryLookupSchema = z.object({
  title: z.string(),
  redirects: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().exactOptional(),
        tofragment: z.string().exactOptional(),
      }),
    )
    .exactOptional(),
  tocdata: z
    .object({
      sections: z
        .array(
          z.object({
            line: z.string().exactOptional(),
            index: z.string().exactOptional(),
            anchor: z.string().exactOptional(),
          }),
        )
        .exactOptional(),
    })
    .exactOptional(),
});

/**
 * The optional TOC lookup's whole `prop=tocdata` response, parsed rather than cast: an error
 * envelope, or a `parse` carrying the {@link SummaryLookupSchema} fields, whose `title` only the
 * summary requires. A body of any other shape is an unavailable lookup, never a failed read.
 */
const ArticleTocLookupSchema = z.object({
  error: z.object({ code: z.string().optional(), info: z.string().optional() }).optional(),
  parse: SummaryLookupSchema.extend({ title: z.string().exactOptional() }).optional(),
});

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
 * Short budget for a best-effort read beside a primary answer that is already in hand: the whole of
 * a search page's description lookup — every chunk, queue wait included, no retries — and the one
 * attempt of each other side lookup. A stalled lookup must not hold back an answer that is ready.
 */
const PAGE_META_TIMEOUT_MS = 5_000;

/**
 * Pageids one `prop=description|pageprops` request takes from an anonymous caller: `action=paraminfo`
 * reports `pageids` limit 50, and its `highlimit` of 500 requires `apihighlimits`.
 */
const PAGE_META_CHUNK_SIZE = 50;

/**
 * Description lookups in flight at once across every call this process serves. A module-level
 * queue rather than a per-call pool: one hosted process answers many callers at a time.
 */
const pageMetaPacer = createPacer({ name: 'wikipedia-page-meta', maxConcurrent: 4 });

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
 * A title that can name no page. Carries the `invalid_title` reason the five title-taking read
 * tools declare, so a refusal raised here reaches the client with the same typed contract as the
 * handler-edge guard, instead of an untyped upstream message or a claim that the article exists.
 * `detail` says why: the API's own `invalidreason` or `info`, {@link NO_PAGE_NAMESPACE_DETAIL}, which
 * reads the same on every read path, or {@link INTERWIKI_DETAIL} on the `action=query` paths — a
 * parse refuses an interwiki title through `invalidtitle` and its `info`.
 */
function invalidTitleError(title: string, detail?: string): McpError {
  return validationError(
    `"${title}" is not a valid Wikipedia page name.${detail ? ` ${detail}` : ''}`,
    { title, reason: 'invalid_title' },
  );
}

/**
 * Why a Special: or Media: title names no page — `action=parse`'s `pagecannotexist` and an
 * `action=query` page entry marked `special` alike. The namespace names are localized
 * (`Spezial:`, `特別:`), which is why the refusal keys on those upstream signals, not on a prefix.
 */
const NO_PAGE_NAMESPACE_DETAIL =
  "Special: and Media: titles, in any edition's spelling, name no page; a file's description page is in the File: namespace.";

/** Why an interwiki-prefixed title (`wikt:cat`, `fr:Chat`) names no page on this edition. */
const INTERWIKI_DETAIL =
  "It begins with an interwiki prefix, which links to another wiki. For another Wikipedia edition, pass the title without the prefix and the edition's code as language.";

/**
 * The first page entry of an `action=query` answer for one title, after refusing a title that can
 * name no page with {@link invalidTitleError}; `undefined` when the answer carries no entry.
 *
 * Read in the order that keeps each answer true: an interwiki title arrives under
 * `query.interwiki` with no page entry at all; an unnameable title as `invalid` with no `missing`
 * key; and a Special: or Media: title as `special`, beside `missing` when that special page or file
 * does not exist, so `special` is read before the caller tests `missing`. An ordinary entry,
 * present or missing, is returned for the caller to read.
 */
function nameablePageEntry<P extends UnnameablePageRaw>(
  title: string,
  query:
    | {
        interwiki?: readonly ActionInterwikiRaw[];
        pages?: Readonly<Record<string, P>> | readonly P[];
      }
    | undefined,
): P | undefined {
  if (query?.interwiki?.length) throw invalidTitleError(title, INTERWIKI_DETAIL);
  const page = query?.pages && Object.values(query.pages)[0];
  if (page?.invalid) throw invalidTitleError(title, page.invalidreason);
  if (page?.special) throw invalidTitleError(title, NO_PAGE_NAMESPACE_DETAIL);
  return page;
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
 * `title` is passed by the page-addressed endpoints, whose `missingtitle`, `invalidtitle`, and
 * `pagecannotexist` codes map onto declared tool contracts — the last is `action=parse`'s answer
 * for a Special: or Media: title, on every edition. Regex syntax and complexity refusals are
 * invalid queries; other codes surface as service failures carrying the API's `info` text. The
 * {@link TRANSIENT_ENVELOPE_CODES} never reach here unless their retries ran out —
 * {@link transientEnvelopeError} throws them inside the retry.
 */
function actionApiError(error: ActionApiErrorRaw, language: string, title?: string): McpError {
  const code = error.code ?? '';
  if (
    code === 'cirrussearch-regex-syntax-error' ||
    code === 'cirrussearch-regex-too-complex-error'
  ) {
    return validationError(`Wikipedia API error (${code}): ${error.info ?? code}`, {
      reason: 'invalid_query',
      upstreamCode: code,
      recovery: {
        hint: 'Correct or simplify the regex, or remove the insource:/…/ or intitle:/…/ operator and try again.',
      },
    });
  }
  if (title !== undefined) {
    if (code === 'missingtitle') return articleNotFoundError(title, language);
    if (code === 'invalidtitle') return invalidTitleError(title, error.info);
    if (code === 'pagecannotexist') return invalidTitleError(title, NO_PAGE_NAMESPACE_DETAIL);
  }
  return serviceUnavailable(`Wikipedia API error: ${error.info ?? code}`);
}

/**
 * Action API codes for a pinned `oldid` that will never be readable again: `nosuchrevid` for a
 * revision that does not exist (its page was deleted, or it never did) and `permissiondenied` for
 * one whose text was hidden by revision deletion.
 */
const REVISION_GONE_CODES: ReadonlySet<string> = new Set(['nosuchrevid', 'permissiondenied']);

/**
 * The `revision_unavailable` failure for an error envelope answering a continuation's pinned
 * `oldid`, with the envelope's code as `upstreamCode`. A gone or hidden revision carries its own
 * recovery, since retrying the cursor cannot succeed; any other envelope leaves the tool's declared
 * recovery, which tries the cursor again first.
 */
function pinnedRevisionError(
  cursorKind: 'table' | 'references',
  revisionId: number,
  error: ActionApiErrorRaw,
): McpError {
  const upstreamCode = error.code;
  if (upstreamCode && REVISION_GONE_CODES.has(upstreamCode)) {
    return serviceUnavailable(
      `The ${cursorKind} cursor is pinned to revision ${revisionId}, which no longer exists or is hidden (${upstreamCode}).`,
      {
        reason: 'revision_unavailable',
        revisionId,
        upstreamCode,
        recovery: {
          hint: 'Omit cursor to start over at the current revision; retrying this cursor cannot succeed.',
        },
      },
    );
  }
  return serviceUnavailable(
    `The pinned ${cursorKind} revision ${revisionId} could not be read${upstreamCode ? ` (${upstreamCode})` : ''}.`,
    { reason: 'revision_unavailable', revisionId, ...(upstreamCode && { upstreamCode }) },
  );
}

/**
 * Action API error codes for a condition that clears on its own, which the API reports inside an
 * HTTP 200 body rather than as a 429 or 503. `ratelimited` and `readonly` are MediaWiki core's codes;
 * the two CirrusSearch codes are its search pool counter's queue being full — the regex variant is
 * the same refusal for a query using `insource:/…/`. `cirrussearch-backend-error` stays out: it also
 * covers backend failures a retry does not clear.
 */
const TRANSIENT_ENVELOPE_CODES: ReadonlySet<string> = new Set([
  'ratelimited',
  'readonly',
  'cirrussearch-too-busy-error',
  'cirrussearch-regex-too-busy-error',
]);

/**
 * The retryable failure for a parsed body carrying a {@link TRANSIENT_ENVELOPE_CODES} envelope, or
 * `undefined` for every other body — including every other envelope, which each call site maps
 * after the retry returns. The message is the one {@link actionApiError} gives the same envelope,
 * and a `Retry-After` header on the 200 response rides as `data.retryAfter`, the field `withRetry`
 * reads its wait from.
 */
function transientEnvelopeError(body: unknown, response: Response): McpError | undefined {
  const error = (body as { error?: ActionApiErrorRaw } | null)?.error;
  if (!error?.code || !TRANSIENT_ENVELOPE_CODES.has(error.code)) return;
  const retryAfter = response.headers.get('retry-after');
  return serviceUnavailable(`Wikipedia API error: ${error.info ?? error.code}`, {
    ...(retryAfter !== null && { retryAfter }),
  });
}

/**
 * Wall-clock budget for one request's whole retry ladder — every attempt, backoff, and honored
 * `Retry-After`. Without it the default ladder runs four 15 s attempts past a client's 60 s request
 * timeout, and three honored `Retry-After` waits of up to 30 s each reach 90 s, so the caller would
 * see a transport timeout instead of this server's classified error.
 */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * Per-attempt timeout for a references read, which parses the whole page on every call. A cold parse
 * of a large article runs past the default 15 s (Barack Obama at an unparsed revision took 13.9 s),
 * so the one attempt that can finish gets most of {@link REQUEST_DEADLINE_MS}; the deadline still
 * bounds the attempt and any retry together.
 */
const REFERENCES_PARSE_TIMEOUT_MS = 25_000;

/**
 * Build an {@link EditionIndex} from an `action=sitematrix` response.
 *
 * Pure and exported for unit testing. Closed editions are kept: a closed wiki is read-only, not
 * gone — `aa.wikipedia.org` still answers, and dropping them would newly reject codes that work.
 * Subdomains are indexed first so a language code can never displace a real subdomain's host, and
 * legacy codes last, so neither can be displaced by one.
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
  return { hosts: withLegacyCodes(hosts), fetchedAt: new Date().toISOString() };
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
  // Without this check a nonexistent subdomain burns the whole retry ladder and leaks the URL.
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

/**
 * The section read's `prop=pageprops&ppprop=disambiguation` response, parsed rather than cast: a
 * body of any other shape is an unavailable lookup, never an unflagged page.
 */
const PagePropsLookupSchema = z.object({
  error: z.object({ code: z.string().optional(), info: z.string().optional() }).optional(),
  query: z
    .object({
      pages: z.array(
        z.object({
          missing: z.boolean().optional(),
          invalid: z.boolean().optional(),
          pageprops: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    })
    .optional(),
});

/**
 * The summary pre-check's `action=query&titles=…` response: the flags {@link nameablePageEntry}
 * reads, parsed rather than cast, so a body of any other shape leaves the title to REST.
 */
const TitleCheckSchema = z.object({
  query: z.object({
    interwiki: z
      .array(z.object({ title: z.string().exactOptional(), iw: z.string().exactOptional() }))
      .exactOptional(),
    pages: z
      .array(
        z.object({
          invalid: z.boolean().exactOptional(),
          invalidreason: z.string().exactOptional(),
          special: z.boolean().exactOptional(),
        }),
      )
      .exactOptional(),
  }),
});

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
   * Fetch, JSON-parse, and retry one MediaWiki endpoint, the whole ladder bounded by
   * {@link REQUEST_DEADLINE_MS}.
   *
   * MediaWiki serves an HTML error page under rate limiting and maintenance, so a 2xx body that is
   * not a JSON object — that page, an XML body, a `null`, anything else — is a retryable
   * `serviceUnavailable` with one fixed message carrying none of the body; a parse error rides as
   * its `cause`, for the logs. Every endpoint this server reads answers with an object.
   * The Action API reports its own transient refusals inside an HTTP 200 body, so those are thrown
   * here, inside the retry, and every caller gets the same backoff a 503 gets; every other body is
   * returned, `error` envelope and all, for the caller to map. The caller's signal ends a backoff
   * as well as a request in flight.
   */
  private async apiGet<T>(
    url: string,
    operation: string,
    apiLabel: string,
    ctx: ServiceContext,
    options: { expectedStatuses?: number[]; timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    return await withRetry(
      async ({ signal, remainingMs }) => {
        const response = await fetchWithTimeout(url, Math.min(timeoutMs, remainingMs), ctx, {
          headers: this.headers(),
          ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
          signal,
        });
        const text = await response.text();
        const unusable = (options?: { cause: unknown }) =>
          serviceUnavailable(
            `Wikipedia ${apiLabel} returned a response that is not a JSON object — likely rate-limited or under maintenance.`,
            undefined,
            options,
          );
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw unusable({ cause: err });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw unusable();
        const transient = transientEnvelopeError(body, response);
        if (transient) throw transient;
        return body as T;
      },
      {
        operation,
        context: ctx,
        baseDelayMs: 1000,
        deadlineMs: REQUEST_DEADLINE_MS,
        ...(ctx.signal && { signal: ctx.signal }),
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
   *
   * Concurrent callers share one build, which therefore runs on its own deadline and never on a
   * caller's signal: one caller's cancellation must neither abort the request the others are
   * waiting on nor read as an outage that arms the back-off for all of them. A cancelled caller's
   * own await rejects with its signal's reason; the build carries on for everyone else.
   */
  private async editionIndex(ctx: ServiceContext): Promise<EditionIndex | undefined> {
    if (this.baseUrl) return;

    const now = Date.now();
    if (this.indexMemo && this.indexMemo.expiresAt > now) return this.indexMemo.index;
    if (now < this.indexRetryAfter) return;
    const { signal, ...buildCtx } = ctx;
    signal?.throwIfAborted();
    this.indexInFlight ??= this.buildEditionIndex(buildCtx).finally(() => {
      this.indexInFlight = undefined;
    });
    const build = this.indexInFlight;
    if (!signal) return await build;

    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([build, cancelled.promise]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async buildEditionIndex(ctx: ServiceContext): Promise<EditionIndex | undefined> {
    try {
      const cached = await this.storage.get<EditionIndex>(EDITION_INDEX_STORAGE_KEY, ctx);
      if (cached?.hosts && Object.keys(cached.hosts).length > 0) {
        // An index persisted before a legacy code was keyed answers for it without a rebuild.
        const index = { ...cached, hosts: withLegacyCodes(cached.hosts) };
        this.memoize(index);
        return index;
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
   * An edition answers to every spelling the registry indexes: the subdomain a caller reads off
   * `wikipedia_get_languages`' `edition_code`, its MediaWiki language code, and a legacy code
   * naming it (`nb` for `no`).
   *
   * Always `false` in single-instance override mode: that host may serve any editions, so the
   * Wikipedia-specific edition set must not gate it.
   */
  async isUnknownEdition(language: string, ctx: ServiceContext): Promise<boolean> {
    if (this.baseUrl) return false;
    if (isMalformedLanguage(language)) return true;
    const index = await this.editionIndex(ctx);
    return index
      ? indexedHost(index.hosts, language) === undefined
      : !FALLBACK_EDITION_HOSTS.has(language.toLowerCase());
  }

  /**
   * The canonical origin serving `code`, or `undefined` when no edition is known for it — the
   * lookup that lets a langlinks entry missing its `url` resolve a real host from its language
   * code instead of interpolating one that may not exist, and that tells two spellings of one
   * edition apart from two editions. Always `undefined` in single-instance override mode and while
   * the registry is unavailable.
   */
  async editionHost(code: string, ctx: ServiceContext): Promise<string | undefined> {
    const index = await this.editionIndex(ctx);
    return index ? indexedHost(index.hosts, code) : undefined;
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
    const host = indexedHost(index.hosts, language);
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
   * into the sentence introducing it, where the rendered list keeps a `- ` line per entry. The plain
   * `extract` stands in for a payload without `extract_html`. An existing page without either
   * extract still returns its metadata and an empty string.
   *
   * `latitude`/`longitude` come from the response's `coordinates`, which a non-geotagged article
   * carries as an explicit `null` rather than omitting — both are left undefined for that, for an
   * absent key, and for a partial pair, so a caller never reads half a coordinate as a location.
   *
   * REST answers a redirect with its target and no record of the alias, so a title that is not
   * already the one REST resolved ({@link resolvesWithoutRedirect}) gets one best-effort lookup,
   * {@link summaryRedirect}, after the summary is in hand; a title that is costs no request.
   *
   * REST carries no signal for a title that can name no page, so a title containing `:` — which
   * every namespace and interwiki prefix needs — is first checked by {@link refuseUnnameableTitle};
   * a title without one costs no request.
   *
   * `url` is composed from the resolved title by {@link articleUrl}, as the other reads cite it:
   * REST's `content_urls` encodes with `encodeURIComponent`, escaping the `/ , : @` MediaWiki's own
   * `fullurl` leaves literal and leaving the `'` it escapes. It is present whenever REST gave a page
   * URL, and under a single-instance override, whose article path is unknown, is that URL as given.
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
    redirect: SummaryRedirect;
  }> {
    if (title.includes(':')) await this.refuseUnnameableTitle(title, language, ctx);

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

    const { lat, lon } = raw.coordinates ?? {};
    const geotagged = typeof lat === 'number' && typeof lon === 'number';
    const pageUrl = raw.content_urls?.desktop?.page;
    const url =
      pageUrl && raw.title && !this.baseUrl
        ? articleUrl(await this.resolveBaseUrl(language, ctx), raw.title)
        : pageUrl;
    const redirect: SummaryRedirect =
      raw.title === undefined || resolvesWithoutRedirect(title, raw.title)
        ? { kind: 'none' }
        : await this.summaryRedirect(title, raw.title, language, ctx);

    return {
      title: raw.title ?? title,
      pageType: raw.type ?? 'article',
      pageid: raw.pageid,
      wikidataQid: raw.wikibase_item,
      description: raw.description || undefined,
      extract: (raw.extract_html && htmlSectionToPlainText(raw.extract_html)) || raw.extract || '',
      thumbnailUrl: raw.thumbnail?.source,
      latitude: geotagged ? lat : undefined,
      longitude: geotagged ? lon : undefined,
      url,
      revisionId: raw.revision,
      lastModified: raw.timestamp,
      redirect,
    };
  }

  /**
   * Refuse a summary title that can name no page, before the REST request: REST answers a
   * Special: title with 404, a Media: title with a 500, and an interwiki title with 504, none of
   * which says why.
   *
   * One `action=query` request for the title as written, read by {@link nameablePageEntry} — no
   * `redirects`, since REST follows those itself, and a `missing` entry is left to REST to report.
   * Best effort, under the side-lookup bound of one {@link PAGE_META_TIMEOUT_MS} attempt and no
   * retries: a refusal of any status, a timeout, an HTML or malformed body, or an error envelope
   * leaves the title to REST exactly as before. Only the caller's cancellation propagates.
   */
  private async refuseUnnameableTitle(
    title: string,
    language: string,
    ctx: ServiceContext,
  ): Promise<void> {
    const proceed = (detail: string): void => {
      logger.warning(
        'Summary title check failed; the summary is read without it.',
        withExtra(ctx, { error: detail }),
      );
    };

    let body: unknown;
    try {
      body = await this.actionGet<unknown>(language, { action: 'query', titles: title }, ctx, {
        timeoutMs: PAGE_META_TIMEOUT_MS,
        maxRetries: 0,
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (err instanceof McpError) return proceed(err.message);
      throw err;
    }

    const parsed = TitleCheckSchema.safeParse(body);
    if (!parsed.success) return proceed('The title check response had an unexpected shape.');
    nameablePageEntry(title, parsed.data.query);
  }

  /**
   * How the REST summary for `title` reached `resolvedTitle`, read from one {@link getArticleToc}
   * request, which carries the redirect chain and the anchors that index a section target together.
   *
   * The summary has already answered, so the lookup runs under that helper's own bound — one
   * {@link PAGE_META_TIMEOUT_MS} attempt, no retries — and no upstream failure fails the summary:
   * {@link getArticleToc} returns `undefined` for every one, and that, a body without the summary's
   * fields, or an answer for a page other than `resolvedTitle` is `unchecked`. The caller's
   * cancellation and this server's own failures propagate.
   */
  private async summaryRedirect(
    title: string,
    resolvedTitle: string,
    language: string,
    ctx: ServiceContext,
  ): Promise<SummaryRedirect> {
    const toc = await this.getArticleToc(title, language, ctx);
    const lookup = SummaryLookupSchema.safeParse(toc);
    if (!lookup.success || lookup.data.title !== resolvedTitle) return { kind: 'unchecked' };
    const info = redirectInfo(lookup.data.redirects, lookup.data);
    return info.redirected_from ? { kind: 'followed', info } : { kind: 'none' };
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
   * `generator=search` drops `snippet` and `wordcount`. `metaUnavailableCount` counts the results
   * that lookup failed for, which carry neither field; the results are returned either way.
   */
  async search(
    query: string,
    limit: number,
    language: string,
    ctx: ServiceContext,
    offset = 0,
    sort: (typeof SEARCH_SORTS)[number] = 'relevance',
  ): Promise<{
    results: Array<
      { title: string; pageid: number; snippet: string; wordcount: number } & PageMeta
    >;
    totalResults: number;
    nextOffset: number | undefined;
    suggestion?: string;
    metaUnavailableCount: number;
  }> {
    const raw = await this.actionGet<ActionSearchRaw>(
      language,
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srsort: sort,
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

    const { meta, unavailable } =
      results.length > 0
        ? await this.lookupPageMeta(
            results.map((r) => r.pageid),
            language,
            ctx,
          )
        : { meta: new Map<number, PageMeta>(), unavailable: 0 };
    const suggestion = raw.query?.searchinfo?.suggestion;

    return {
      // Merged by pageid: the lookup answers in pageid order, and the search ranking must survive.
      results: results.map((r) => ({ ...r, ...meta.get(r.pageid) })),
      totalResults: raw.query?.searchinfo?.totalhits ?? results.length,
      nextOffset: raw.continue?.sroffset,
      ...(suggestion && { suggestion }),
      metaUnavailableCount: unavailable,
    };
  }

  /**
   * Best-effort short description and Wikidata QID for a page of search results, keyed by pageid.
   *
   * The page is looked up in {@link PAGE_META_CHUNK_SIZE}-id chunks queued on
   * {@link pageMetaPacer}, all under one {@link PAGE_META_TIMEOUT_MS} budget that starts before the
   * first chunk queues, so queue wait counts against it. Nothing retries. A chunk that fails — a
   * transport error, an Action API `error` envelope, or the budget running out while it is queued
   * or in flight — costs only its own results the two fields, and `unavailable` counts those
   * results; a lookup never delays the search past the budget or fails it. A caller cancellation
   * is not a lookup failure: it propagates, as it would from the search request itself.
   */
  private async lookupPageMeta(
    pageids: number[],
    language: string,
    ctx: ServiceContext,
  ): Promise<{ meta: Map<number, PageMeta>; unavailable: number }> {
    const budget = new AbortController();
    const timer = setTimeout(() => {
      budget.abort(
        new DOMException(
          `Search description lookup ran past its ${PAGE_META_TIMEOUT_MS} ms budget.`,
          'TimeoutError',
        ),
      );
    }, PAGE_META_TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget.signal]) : budget.signal;

    const lookupChunk = async (
      chunk: number[],
    ): Promise<{ meta: Map<number, PageMeta> } | { failed: number; reason: string }> => {
      try {
        const raw = await pageMetaPacer.run(
          (slotSignal) =>
            this.actionGet<ActionPageMetaQueryRaw>(
              language,
              {
                action: 'query',
                pageids: chunk.join('|'),
                prop: 'description|pageprops',
                ppprop: 'wikibase_item',
              },
              { ...ctx, signal: slotSignal },
              { maxRetries: 0 },
            ),
          { signal },
        );
        if (raw.error) {
          const reason = raw.error.info ?? raw.error.code ?? 'unknown API error';
          return { failed: chunk.length, reason };
        }
        return { meta: pageMetaById(raw.query?.pages) };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        return { failed: chunk.length, reason: err instanceof Error ? err.message : String(err) };
      }
    };

    const chunks: number[][] = [];
    for (let i = 0; i < pageids.length; i += PAGE_META_CHUNK_SIZE) {
      chunks.push(pageids.slice(i, i + PAGE_META_CHUNK_SIZE));
    }
    const outcomes = await Promise.allSettled(chunks.map(lookupChunk));
    clearTimeout(timer);

    const meta = new Map<number, PageMeta>();
    const reasons = new Set<string>();
    let unavailable = 0;
    for (const outcome of outcomes) {
      // Only a caller cancellation rejects, and every chunk has settled, so none is left running.
      if (outcome.status === 'rejected') throw outcome.reason;
      if ('meta' in outcome.value) {
        for (const [pageid, entry] of outcome.value.meta) meta.set(pageid, entry);
      } else {
        unavailable += outcome.value.failed;
        reasons.add(outcome.value.reason);
      }
    }
    if (unavailable > 0) {
      logger.warning(
        'Wikipedia description lookup failed; returning those search results without descriptions.',
        withExtra(ctx, { unavailable, results: pageids.length, errors: [...reasons] }),
      );
    }
    return { meta, unavailable };
  }

  /**
   * Fetch the full article as plain text, with the revision it was read from and its canonical URL,
   * in one Action API request.
   *
   * The extract is TextExtracts' HTML mode rendered through {@link htmlSectionToPlainText} rather
   * than `explaintext`, which flattens superscripts into the digits beside them. Both modes strip the
   * same infoboxes, tables, and navboxes upstream, so the rendered text carries the same sections
   * under the same `== Heading ==` markers; beyond superscripts it differs only where the HTML says
   * more — a `<pre>` sample arrives fenced, a list keeps its markers and nesting, and a formula
   * arrives once, as its TeX.
   *
   * `lastModified` is the revision's own timestamp (`revisions[0]`), never `prop=info`'s `touched`,
   * which is a cache-invalidation time that moves without an edit.
   *
   * `disambiguation` is the page's `disambiguation` page property, the one the REST summary's
   * `type` reads, riding the same request as `prop=pageprops&ppprop=disambiguation`.
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
    disambiguation: boolean;
    redirect?: RedirectInfo;
    redirects?: ActionRedirectRaw[];
  }> {
    const raw = await this.actionGet<ActionExtractsRaw>(
      language,
      {
        action: 'query',
        titles: title,
        prop: 'extracts|info|revisions|pageprops',
        inprop: 'url',
        rvprop: 'ids|timestamp',
        ppprop: 'disambiguation',
        // Resolve redirects server-side so aliases (e.g. "NYC" → "New York City") return the
        // target's content, pageid, revision, and URL, matching getSummary's REST behavior.
        redirects: 'true',
      },
      ctx,
    );

    if (raw.error) throw actionApiError(raw.error, language, title);

    // Refused before `missing` is read, or the entry falls through into "exists but has no
    // readable content". No entry at all is a title the API could not look up rather than a
    // valid (but missing) article — mapped to not_found, the same user-visible outcome.
    const page = nameablePageEntry(title, raw.query);
    if (!page || page.missing !== undefined) throw articleNotFoundError(title, language);

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
      disambiguation: page.pageprops?.disambiguation !== undefined,
      ...(raw.query?.redirects?.length && {
        redirect: redirectInfo(raw.query.redirects),
        redirects: raw.query.redirects,
      }),
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
   *
   * A section parse carries no page properties, so `disambiguation` comes from
   * {@link lookupDisambiguation}, sent beside the parse rather than after it. The parse's error
   * envelope is mapped inside its own promise, so a failed parse settles the read without waiting on
   * the lookup, and the `finally` stops a lookup nothing will read.
   */
  async getArticleSection(
    title: string,
    sectionIndex: number,
    language: string,
    ctx: ServiceContext,
    tableRead?: ArticleTableRead,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    sectionTitle: string;
    content: string;
    revisionId: string | undefined;
    url: string | undefined;
    redirect?: RedirectInfo;
    tablePage?: TablePage;
    /** Whether the page is a disambiguation page; `undefined` when that could not be checked. */
    disambiguation: boolean | undefined;
  }> {
    const stopLookup = new AbortController();
    let raw: ActionParseTextRaw;
    let disambiguation: boolean | undefined;
    try {
      [raw, disambiguation] = await Promise.all([
        this.actionGet<ActionParseTextRaw>(
          language,
          {
            action: 'parse',
            ...(tableRead?.continuation
              ? { oldid: String(tableRead.continuation.revisionId) }
              : { page: title }),
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
        ).then((body) => {
          if (!body.error) return body;
          if (tableRead?.continuation) {
            throw pinnedRevisionError('table', tableRead.continuation.revisionId, body.error);
          }
          if (body.error.code === 'nosuchsection') {
            throw validationError(
              `Section index ${sectionIndex} does not exist in "${title}". Call wikipedia_get_sections to get valid index values.`,
              {
                title,
                sectionIndex,
                reason: 'invalid_section',
                recovery: {
                  hint: 'Call wikipedia_get_sections to obtain valid section_index values.',
                },
              },
            );
          }
          throw actionApiError(body.error, language, title);
        }),
        this.lookupDisambiguation(title, language, ctx, stopLookup.signal),
      ]);
    } finally {
      stopLookup.abort();
    }

    // formatversion=2: text is a plain string, not { '*': string }.
    if (
      tableRead &&
      (!raw.parse?.revid ||
        typeof raw.parse.text !== 'string' ||
        (tableRead.continuation && raw.parse.revid !== tableRead.continuation.revisionId))
    ) {
      throw serviceUnavailable(
        'The table response did not contain the requested revision and HTML. Retry the same request.',
        { reason: 'revision_unavailable' },
      );
    }
    let selected: { kind: 'grid' | 'infobox'; body: string } | undefined;
    let tableCount = 0;
    const sectionContent = tableRead
      ? renderSectionHtml(raw.parse?.text ?? '', (kind, body, index) => {
          tableCount = index;
          if (index === tableRead.index) selected = { kind, body };
          return '';
        })
      : htmlSectionToPlainText(raw.parse?.text ?? '');
    let content = sectionContent;
    let tablePage: TablePage | undefined;
    if (tableRead) {
      if (!selected)
        throw validationError(
          `Table index ${tableRead.index} does not exist; this section has ${tableCount} available tables.`,
          { reason: 'invalid_table', availableCount: tableCount },
        );
      const offset = tableRead.continuation?.offset ?? 0;
      const page = pageTable(selected.kind, selected.body, offset);
      content = page.content;
      tablePage = {
        table_index: tableRead.index,
        table_count: tableCount,
        table_rows: page.total,
        row_offset: offset,
        rows_returned: page.nextOffset - offset,
        table_continued: offset > 0,
        ...(page.oversized && { oversized_row: true }),
        ...(page.nextOffset < page.total && {
          next_cursor: encodeCursor({
            kind: 'wikipedia_table_v1',
            title,
            language,
            sectionIndex,
            tableIndex: tableRead.index,
            revisionId: raw.parse?.revid,
            offset: page.nextOffset,
            limit: DATA_TABLE_MAX_BYTES,
          }),
        }),
      };
    }

    // The lead carries no heading of its own, so it takes the label every other surface prints for
    // it rather than the positional fallback. A heading inside a lead — a template can emit one —
    // must not rename it either, or the read reports a title the section list never offered.
    // Every other section's own heading opens its rendered text; markup inside it is already
    // stripped, so a heading like `<i>Pax Romana</i>` reports as `Pax Romana`.
    const sectionTitle =
      sectionIndex === LEAD_SECTION_INDEX
        ? LEAD_SECTION_TITLE
        : ([...sectionContent.matchAll(HEADING_LINE)][0]?.[2] ?? `Section ${sectionIndex}`);

    const resolvedTitle = raw.parse?.title;
    return {
      title: resolvedTitle ?? title,
      pageid: raw.parse?.pageid,
      sectionTitle,
      content,
      ...(tablePage && { tablePage }),
      revisionId: raw.parse?.revid?.toString(),
      ...(raw.parse?.redirects?.length && { redirect: redirectInfo(raw.parse.redirects) }),
      // Only the title MediaWiki resolved names the article's URL — the caller's input may be an alias.
      url:
        resolvedTitle && !this.baseUrl
          ? articleUrl(await this.resolveBaseUrl(language, ctx), resolvedTitle)
          : undefined,
      disambiguation,
    };
  }

  /**
   * Best-effort `disambiguation` page property for a section read: `true` or `false`, or
   * `undefined` when the lookup was unavailable.
   *
   * A `section=N` parse cannot answer it — the property comes from a template at the foot of the
   * page, which only a whole-page parse or the stored page props see — so this asks the stored page
   * props for the same title, redirects followed as the parse follows them. One attempt under
   * {@link PAGE_META_TIMEOUT_MS} and no retries; an upstream failure of any shape (a status, a
   * timeout, an HTML or malformed body, an error envelope, a page reported missing) returns
   * `undefined`, so the read never fails on the lookup or waits past that budget for it. A caller
   * cancellation propagates, and `stop` ends a lookup whose read has already settled.
   */
  private async lookupDisambiguation(
    title: string,
    language: string,
    ctx: ServiceContext,
    stop: AbortSignal,
  ): Promise<boolean | undefined> {
    const degrade = (detail: string): undefined => {
      logger.warning(
        'Wikipedia page-property lookup failed; returning the section without the disambiguation flag.',
        withExtra(ctx, { error: detail }),
      );
      return;
    };

    let body: unknown;
    try {
      body = await this.actionGet<unknown>(
        language,
        {
          action: 'query',
          titles: title,
          prop: 'pageprops',
          ppprop: 'disambiguation',
          redirects: 'true',
        },
        { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, stop]) : stop },
        { timeoutMs: PAGE_META_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (stop.aborted) return;
      // apiGet reports every upstream failure, a body that is not JSON included, as an McpError.
      if (err instanceof McpError) return degrade(err.message);
      throw err;
    }

    const parsed = PagePropsLookupSchema.safeParse(body);
    if (!parsed.success) return degrade('The lookup response had an unexpected shape.');
    const { error, query } = parsed.data;
    if (error) return degrade(error.info ?? error.code ?? 'unknown API error');
    const page = query?.pages[0];
    if (!page || page.missing || page.invalid) return degrade('The lookup returned no page.');
    return page.pageprops?.disambiguation !== undefined;
  }

  /**
   * Read an article's footnotes from one full-page parse ({@link extractReferences}).
   *
   * A section parse cannot stand in: it renumbers footnote anchors and reports a footnote defined in
   * another section as a cite error. A continuation reads the cursor's pinned revision by `oldid`, so
   * an edit between pages cannot shift entries across a page boundary; a revision that cannot be
   * read or does not match fails as `revision_unavailable` rather than falling back to the current
   * text, and an offset past the revision's last entry fails as `invalid_cursor`. Nothing is cached
   * between pages — each one repeats the parse, under {@link REFERENCES_PARSE_TIMEOUT_MS}.
   */
  async getReferences(
    title: string,
    language: string,
    ctx: ServiceContext,
    continuation?: ReferencesCursor,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    revisionId: number;
    url: string | undefined;
    redirect?: RedirectInfo;
    references: ReferenceEntry[];
    works: Map<string, ReferenceWork>;
  }> {
    const raw = await this.actionGet<ActionParseTextRaw>(
      language,
      {
        action: 'parse',
        ...(continuation ? { oldid: String(continuation.revisionId) } : { page: title }),
        prop: 'text|revid',
        disableeditsection: 'true',
        disabletoc: 'true',
        disablelimitreport: 'true',
        redirects: 'true',
      },
      ctx,
      { timeoutMs: REFERENCES_PARSE_TIMEOUT_MS },
    );

    if (raw.error) {
      if (continuation) throw pinnedRevisionError('references', continuation.revisionId, raw.error);
      throw actionApiError(raw.error, language, title);
    }

    const revisionId = raw.parse?.revid;
    const html = raw.parse?.text;
    if (
      !revisionId ||
      typeof html !== 'string' ||
      (continuation && revisionId !== continuation.revisionId)
    ) {
      throw serviceUnavailable(
        'The references response did not contain the requested revision and HTML. Retry the same request.',
        { reason: 'revision_unavailable' },
      );
    }

    const { references, works } = extractReferences(html);
    if (continuation && continuation.offset >= references.length) {
      throw validationError(
        'The references cursor offset is past the last entry of the pinned revision.',
        { reason: 'invalid_cursor' },
      );
    }

    const resolvedTitle = raw.parse?.title;
    return {
      title: resolvedTitle ?? title,
      pageid: raw.parse?.pageid,
      revisionId,
      url:
        resolvedTitle && !this.baseUrl
          ? articleUrl(await this.resolveBaseUrl(language, ctx), resolvedTitle)
          : undefined,
      ...(raw.parse?.redirects?.length && { redirect: redirectInfo(raw.parse.redirects) }),
      references,
      works,
    };
  }

  /**
   * An article's table of contents and redirect chain from one `prop=tocdata` parse, for the reads
   * it only enriches: a full read's outline indices and redirect section, a summary's redirect.
   *
   * Optional by contract, without the section-list fallback: one attempt under
   * {@link PAGE_META_TIMEOUT_MS} and no retries, and every upstream failure — any status, a timeout,
   * a body that is not JSON, an error envelope, a body of another shape — returns `undefined`, so
   * the read it serves answers as it does without it. A caller cancellation propagates, and so does
   * a failure of this server's own.
   */
  async getArticleToc(
    title: string,
    language: string,
    ctx: ServiceContext,
  ): Promise<ActionSectionsRaw['parse'] | undefined> {
    const degrade = (detail: string): undefined => {
      logger.warning(
        'Wikipedia table-of-contents lookup failed; continuing without it.',
        withExtra(ctx, { error: detail }),
      );
      return;
    };

    let body: unknown;
    try {
      body = await this.actionGet<unknown>(
        language,
        { action: 'parse', page: title, prop: 'tocdata', redirects: 'true' },
        ctx,
        { timeoutMs: PAGE_META_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (err) {
      if (ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      // apiGet reports every upstream failure as an McpError; anything else is this server's own.
      if (err instanceof McpError) return degrade(err.message);
      throw err;
    }

    const parsed = ArticleTocLookupSchema.safeParse(body);
    if (!parsed.success) return degrade('The lookup response had an unexpected shape.');
    const { error, parse } = parsed.data;
    if (error) return degrade(error.info ?? error.code ?? 'unknown API error');
    if (!parse) return degrade('The lookup returned no parse.');
    return parse;
  }

  /**
   * Fetch an article's table of contents, its visible categories, and whether it is a disambiguation
   * page, all from one parse request.
   *
   * `categories` keeps upstream order and drops the hidden maintenance categories; each name is the
   * database key with underscores turned back into spaces, which is how `incategory:` and every
   * other title surface writes it. `disambiguation` is the page's `disambiguation` property, the one
   * the REST summary's `type` reads. Both come from the first response on the fallback path too.
   */
  async getSections(
    title: string,
    language: string,
    ctx: ServiceContext,
  ): Promise<{
    title: string;
    pageid: number | undefined;
    sections: Array<{ index: number; number: string; title: string; level: number }>;
    categories: string[];
    disambiguation: boolean;
    redirect?: RedirectInfo;
  }> {
    const raw = await this.actionGet<ActionSectionsRaw>(
      language,
      // prop=tocdata replaces the deprecated prop=sections (same data, renamed/renested fields).
      // redirects resolves aliases (e.g. "NYC" → "New York City") like the other read paths.
      { action: 'parse', page: title, prop: 'tocdata|categories|properties', redirects: 'true' },
      ctx,
    );

    if (raw.error) throw actionApiError(raw.error, language, title);

    const resolvedTitle = raw.parse?.title ?? title;
    const rawSections = raw.parse?.tocdata?.sections ?? [];
    const pageFacts = {
      categories: (raw.parse?.categories ?? []).flatMap(({ category, hidden }) =>
        category && !hidden ? [category.replaceAll('_', ' ')] : [],
      ),
      disambiguation: raw.parse?.properties?.disambiguation !== undefined,
    };

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
      return {
        title: fullArticle.title,
        pageid: fullArticle.pageid,
        sections: fallbackSections,
        ...pageFacts,
        ...(raw.parse?.redirects?.length && {
          redirect: redirectInfo(raw.parse.redirects, raw.parse),
        }),
      };
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

    return {
      title: resolvedTitle,
      pageid: raw.parse?.pageid,
      sections,
      ...pageFacts,
      ...(raw.parse?.redirects?.length && {
        redirect: redirectInfo(raw.parse.redirects, raw.parse),
      }),
    };
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

    // Refused before the shape check, since an interwiki title carries no `pages`, and before
    // `missing`, or the entry falls through into "has no other language editions".
    const page = nameablePageEntry(title, raw.query);
    if (!raw.query?.pages) {
      throw serviceUnavailable('Unexpected response shape from Wikipedia langlinks API.');
    }
    if (!page || page.missing !== undefined) throw articleNotFoundError(title, sourceLanguage);

    const langlinks = page.langlinks ?? [];
    // llprop=url normally populates every url, so the registry is consulted only on the rare miss.
    const index = langlinks.some((ll) => !ll.url) ? await this.editionIndex(ctx) : undefined;

    const languages = langlinks.map((ll) => {
      // Own keys only: `ll.lang` is upstream text, and `constructor` would read the prototype.
      const host = index ? indexedHost(index.hosts, ll.lang) : undefined;
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
