/**
 * @fileoverview Escape upstream-sourced text so it renders as written in a markdown client.
 * @module mcp-server/tools/utils/escape-markdown
 */

import { splitTextBlocks, tableRow } from '@/services/wikipedia/text-blocks.js';

/**
 * Characters that open a markdown or HTML construct anywhere in a line.
 *
 * `\` leads the class so it is consumed by the same pass: escaping it separately afterwards would
 * double-escape every backslash this pass just added. `&` is here because a decoded entity in
 * article prose (`&lt;ref&gt;` is real text in articles about markup) is re-read as an entity by a
 * renderer; `<` and `>` because Wikipedia prose quotes literal tags; `#` and `|` and `~` because
 * they are active inline as well as at a line or cell boundary.
 */
const INLINE_ACTIVE = /[\\`*_[\]<>&#|~]/g;

/** Escape only {@link INLINE_ACTIVE} — for text that can never begin a line, such as a table cell. */
function escapeInline(text: string): string {
  return text.replace(INLINE_ACTIVE, '\\$&');
}

/** A bullet or thematic-break marker, active only at the start of a line. */
const LINE_LEADING_BULLET = /^(\s*)([-+])/;

/** An ordered-list marker (`1.`, `2)`), active only at the start of a line. */
const LINE_LEADING_ORDERED = /^(\s*)(\d{1,9})([.)])/;

/**
 * Backslash-escape the markdown-active characters in upstream text.
 *
 * Every tool's `format()` runs its upstream-sourced strings — article content, extracts, search
 * snippets, descriptions, and titles — through this before interpolating them into the markdown it
 * builds. `structuredContent` is never touched: it carries the text as the API returned it, and the
 * render path is the only surface where a client re-interprets that text.
 *
 * CommonMark backslash escapes rather than HTML entities. `content[]` is read raw by a language
 * model far more often than it is rendered, and `\<script\>` or `\_word\_` stays legible raw while
 * rendering as the literal characters; `&lt;script&gt;` is noise on both surfaces.
 *
 * Every character escaped here is ASCII punctuation, which CommonMark permits escaping, so each
 * `\x` renders as the bare `x`. Line-leading `=` is deliberately left alone: a line of only `=`
 * would underline the paragraph above it as a heading, but the `== Heading ==` markers this
 * server's own article text carries are far more common and escaping them would mangle every one.
 */
export function escapeMarkdown(text: string): string {
  return escapeInline(text)
    .split('\n')
    .map((line) =>
      line.replace(LINE_LEADING_BULLET, '$1\\$2').replace(LINE_LEADING_ORDERED, '$1$2\\$3'),
    )
    .join('\n');
}

/**
 * {@link escapeMarkdown} for rendered article text, leaving intact the two constructs whose syntax
 * the article renderer wrote on purpose (see `text-blocks.ts`).
 *
 * A fenced code block passes through raw: inside a fence CommonMark reads nothing as markup, and a
 * backslash there would reach the reader as part of the code. A table row keeps its ` | ` delimiters
 * and escapes each cell inline — which also writes a cell's own `|` as the `\|` GFM reads as a
 * literal pipe — but not for line-leading markers, since a cell never starts a line and `49.80%`
 * must not come out as `49\.80%`. A delimiter row, dashes only, passes through. Everything else is
 * prose and escaped as usual.
 */
export function escapeMarkdownOutsideBlocks(text: string): string {
  return splitTextBlocks(text)
    .map((block) => {
      switch (block.kind) {
        case 'text':
          return escapeMarkdown(block.text);
        case 'row':
          return tableRow(block.cells, escapeInline);
        default:
          return block.text;
      }
    })
    .join('\n');
}
