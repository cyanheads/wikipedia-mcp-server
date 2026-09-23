/**
 * @fileoverview The two block constructs the plain-text article renderer emits — fenced code blocks
 * and pipe-delimited table rows — written and read back by one grammar.
 * @module services/wikipedia/text-blocks
 */

/**
 * The plain text a section read returns is prose plus two constructs whose syntax is load-bearing:
 * a `<pre>` sample as a backtick-fenced block, and a data table as pipe rows. Both reach
 * `structuredContent` as written here. The markdown render of the same text has to escape the prose
 * but leave that syntax intact, and all it has to go on is the string — so the renderer and the
 * escaper share this module rather than each carrying its own idea of what a fence or a row is.
 *
 * The contract for the escaper: no article text reaches the markdown unescaped except the body of a
 * block CommonMark itself renders as literal code. {@link splitTextBlocks} only ever reports a code
 * block CommonMark would also see (an opening fence line of bare backticks and the first closing line
 * CommonMark would accept), and a table row exposes only its delimiters — every cell is handed back
 * as text to escape.
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

/** One segment of rendered article text, in document order. */
export type TextBlock =
  /** Prose: consecutive lines that are neither a code block nor a table row. */
  | { kind: 'text'; text: string }
  /** A fenced code block, fence lines included. */
  | { kind: 'code'; text: string }
  /** A table row's cells, pipes restored. */
  | { kind: 'row'; cells: string[] }
  /** A table delimiter row, as written. */
  | { kind: 'delimiter'; text: string };

/** Index of the line that closes a fence of `length` backticks opened above `from`, or -1. */
function closingFenceIndex(lines: readonly string[], from: number, length: number): number {
  for (let i = from; i < lines.length; i++) {
    const run = CLOSING_FENCE.exec(lines[i] as string)?.[1];
    if (run && run.length >= length) return i;
  }
  return -1;
}

/**
 * Split rendered article text into prose, code blocks, and table rows, joined back by `\n`.
 *
 * A fence with no closing line is prose: CommonMark would run such a block to the end of the
 * document, but read as prose its backticks are escaped and no block opens at all, which is the
 * safer of the two readings to agree on.
 */
export function splitTextBlocks(text: string): TextBlock[] {
  const lines = text.split('\n');
  const blocks: TextBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) blocks.push({ kind: 'text', text: prose.join('\n') });
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
