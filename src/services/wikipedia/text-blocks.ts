/**
 * @fileoverview The three block constructs the plain-text article renderer emits — fenced code
 * blocks, pipe-delimited table rows, and indented lists — written and read back by one grammar.
 * @module services/wikipedia/text-blocks
 */

/**
 * The plain text a section read returns is prose plus three constructs whose syntax is load-bearing:
 * a `<pre>` sample as a backtick-fenced block, a data table as pipe rows, and a list as marker lines
 * indented two spaces per level. All three reach `structuredContent` as written here. The markdown
 * render of the same text has to escape the prose but leave that syntax intact, and all it has to go
 * on is the string — so the renderer and the escaper share this module rather than each carrying its
 * own idea of what a fence, a row, or a list is.
 *
 * The contract for the escaper: no article text reaches the markdown unescaped except the body of a
 * block CommonMark itself renders as literal code. {@link splitTextBlocks} only ever reports a code
 * block CommonMark would also see (an opening fence line of bare backticks and the first closing line
 * CommonMark would accept), a table row exposes only its delimiters — every cell is handed back as
 * text to escape — and a list block is handed back whole, for the escaper to fence: CommonMark strips
 * a paragraph line's leading spaces, so an indent survives a markdown read only inside a code block.
 */

/** Longest run of consecutive backticks in `text`, 0 when there is none. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

/**
 * Fence a code sample. The fence is one backtick longer than any run inside the body (and at least
 * three), so no line of the code can close it early: CommonMark ends a fence only at a run at least
 * as long as the one that opened it.
 */
export function fenceCodeBlock(code: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
  return `${fence}\n${code}\n${fence}`;
}

/** A literal pipe inside a cell, written as GFM's `\|` so it cannot end the cell. */
function escapeCellPipes(cell: string): string {
  return cell.replaceAll('|', '\\|');
}

/**
 * One table row: `| a | b |`. Each cell is single-line text with no edge whitespace, so the
 * ` | ` between cells is never ambiguous with a cell's own content once `escapeCell` has marked its
 * pipes. The default marks only the pipes; a markdown renderer passes its full escaper, which
 * covers pipes along with the rest of the markdown-active set.
 */
export function tableRow(
  cells: readonly string[],
  escapeCell: (cell: string) => string = escapeCellPipes,
): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

/** The GFM delimiter row that turns the row above it into a table header. */
export function tableDelimiterRow(columns: number): string {
  return tableRow(Array.from({ length: columns }, () => '---'));
}

/** A delimiter-row cell: dashes only. */
const DELIMITER_CELL = /^-{3,}$/;

/**
 * Read a line back into the cells {@link tableRow} wrote, or `undefined` when it is not a row.
 * A cell's `\|` is restored to `|`; every other character is returned as written.
 */
export function parseTableRow(line: string): string[] | undefined {
  if (line.length < 4 || !line.startsWith('| ') || !line.endsWith(' |')) return;
  return line
    .slice(2, -2)
    .split(' | ')
    .map((cell) => cell.replaceAll('\\|', '|'));
}

/** An opening fence as {@link fenceCodeBlock} writes it: bare backticks, no info string. */
const OPENING_FENCE = /^`{3,}$/;

/**
 * A line CommonMark accepts as the close of a backtick fence: up to three spaces of indentation, a
 * backtick run, then only spaces or tabs. It closes a block only when the run is at least as long
 * as the opener's.
 */
const CLOSING_FENCE = /^ {0,3}(`{3,})[ \t]*$/;

/** Indentation per list nesting level. */
const LIST_INDENT = '  ';

/**
 * One line of a rendered list: `level` steps of indentation, then `text` — an item's marker line
 * (`- Item`, `3. Item`) at its list's level, or a line continuing an item one level past its marker
 * line. Renderer prose never starts with whitespace, so an indented line is what marks a list block;
 * a flat list, every item one line, carries none and reads as prose.
 */
export function listLine(level: number, text: string): string {
  return `${LIST_INDENT.repeat(level)}${text}`;
}

/** A line starting with the indentation CommonMark strips from a paragraph line. */
const INDENTED_LINE = /^[ \t]/;

/** Whether any of `lines[start]` up to `lines[end]` (exclusive) is indented. */
function hasIndentedLine(lines: readonly string[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (INDENTED_LINE.test(lines[i] as string)) return true;
  return false;
}

/** One segment of rendered article text, in document order. */
export type TextBlock =
  /** Prose: consecutive lines that are neither a code block, a table row, nor a list block. */
  | { kind: 'text'; text: string }
  /** A fenced code block, fence lines included. */
  | { kind: 'code'; text: string }
  /** A table row's cells, pipes restored. */
  | { kind: 'row'; cells: string[] }
  /** A table delimiter row, as written. */
  | { kind: 'delimiter'; text: string }
  /** A blank-line-delimited run of prose lines, one of them indented ({@link listLine}), as written. */
  | { kind: 'list'; text: string };

/** Index of the line that closes a fence of `length` backticks opened above `from`, or -1. */
function closingFenceIndex(lines: readonly string[], from: number, length: number): number {
  for (let i = from; i < lines.length; i++) {
    const run = CLOSING_FENCE.exec(lines[i] as string)?.[1];
    if (run && run.length >= length) return i;
  }
  return -1;
}

/**
 * Split rendered article text into prose, code blocks, table rows, and list blocks, joined back by
 * `\n`.
 *
 * A fence with no closing line is prose: CommonMark would run such a block to the end of the
 * document, but read as prose its backticks are escaped and no block opens at all, which is the
 * safer of the two readings to agree on.
 *
 * Among the prose, a paragraph — the lines between two empty ones — holding an indented line is a
 * list block, whole. Only an empty line ends one: a line of spaces is indented, not blank, so it is
 * kept in the block it sits in rather than read as the break CommonMark would make of it.
 */
export function splitTextBlocks(text: string): TextBlock[] {
  const lines = text.split('\n');
  const blocks: TextBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    let emitted = 0;
    let start = 0;
    for (let end = 0; end <= prose.length; end++) {
      if (end < prose.length && prose[end] !== '') continue;
      if (hasIndentedLine(prose, start, end)) {
        if (start > emitted) {
          blocks.push({ kind: 'text', text: prose.slice(emitted, start).join('\n') });
        }
        blocks.push({ kind: 'list', text: prose.slice(start, end).join('\n') });
        emitted = end;
      }
      start = end + 1;
    }
    if (emitted < prose.length) {
      blocks.push({ kind: 'text', text: prose.slice(emitted).join('\n') });
    }
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (OPENING_FENCE.test(line)) {
      const close = closingFenceIndex(lines, i + 1, line.length);
      if (close !== -1) {
        flushProse();
        blocks.push({ kind: 'code', text: lines.slice(i, close + 1).join('\n') });
        i = close;
        continue;
      }
    }

    const cells = parseTableRow(line);
    if (cells) {
      flushProse();
      blocks.push(
        cells.every((cell) => DELIMITER_CELL.test(cell))
          ? { kind: 'delimiter', text: line }
          : { kind: 'row', cells },
      );
      continue;
    }

    prose.push(line);
  }
  flushProse();
  return blocks;
}
