/**
 * @fileoverview Tests for the fenced-code and table-row grammar the article renderer writes and the
 * markdown escaper reads back.
 * @module tests/services/wikipedia/text-blocks.test
 */

import { describe, expect, it } from 'vitest';
import {
  fenceCodeBlock,
  parseTableRow,
  splitTextBlocks,
  tableDelimiterRow,
  tableRow,
} from '@/services/wikipedia/text-blocks.js';

/** Cell text an article can hold that sits close to the row syntax. */
const AWKWARD_CELLS = [
  'plain',
  '',
  'a | b',
  'a|b',
  '|leading',
  'trailing|',
  'x\\|y',
  'ends with backslash\\',
  '```',
  '<script>alert(1)</script>',
  '---',
  '| --- |',
];

describe('tableRow / parseTableRow', () => {
  it('reads back every cell it wrote, however close the cell sits to the row syntax', () => {
    for (const cell of AWKWARD_CELLS) {
      expect(parseTableRow(tableRow(['left', cell, 'right']))).toEqual(['left', cell, 'right']);
    }
    expect(parseTableRow(tableRow(AWKWARD_CELLS))).toEqual(AWKWARD_CELLS);
  });

  it('writes a single empty cell as a row, not as a bare pipe', () => {
    expect(tableRow([''])).toBe('|  |');
    expect(parseTableRow('|  |')).toEqual(['']);
  });

  it('rejects lines that are not rows', () => {
    for (const line of ['', '|', '| |', 'a | b', '| a', 'a |', '|a|']) {
      expect(parseTableRow(line)).toBeUndefined();
    }
  });

  it('writes a delimiter row of dashes', () => {
    expect(tableDelimiterRow(3)).toBe('| --- | --- | --- |');
  });
});

describe('fenceCodeBlock', () => {
  it('uses a three-backtick fence for code with no backticks', () => {
    expect(fenceCodeBlock('x = 1')).toBe('```\nx = 1\n```');
  });

  it('uses a fence longer than any backtick run in the code', () => {
    expect(fenceCodeBlock('a ``` b\n````')).toBe('`````\na ``` b\n````\n`````');
  });

  it('keeps the code, fence-like lines included, inside one block', () => {
    const code = 'first\n```\n| a | b |\n== Heading ==\n  ````\nlast';
    const blocks = splitTextBlocks(`Before.\n\n${fenceCodeBlock(code)}\n\nAfter.`);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'code', 'text']);
    expect(blocks[1]).toEqual({ kind: 'code', text: fenceCodeBlock(code) });
  });
});

describe('splitTextBlocks', () => {
  it('returns text with neither construct as one text block', () => {
    const text = 'Lead.\n\n== Heading ==\n\nBody with a | pipe and `ticks`.';
    expect(splitTextBlocks(text)).toEqual([{ kind: 'text', text }]);
  });

  it('separates a table into its rows and delimiter row', () => {
    const table = [tableRow(['A', 'B']), tableDelimiterRow(2), tableRow(['1', 'x | y'])].join('\n');
    expect(splitTextBlocks(`Caption\n\n${table}\n\nAfter.`)).toEqual([
      { kind: 'text', text: 'Caption\n' },
      { kind: 'row', cells: ['A', 'B'] },
      { kind: 'delimiter', text: '| --- | --- |' },
      { kind: 'row', cells: ['1', 'x | y'] },
      { kind: 'text', text: '\nAfter.' },
    ]);
  });

  it('reads an unclosed fence as text, so no block opens', () => {
    expect(splitTextBlocks('```\n<script>\nno close')).toEqual([
      { kind: 'text', text: '```\n<script>\nno close' },
    ]);
  });

  it('reads a fence with an info string as text — only a bare fence opens a block', () => {
    expect(splitTextBlocks('```js\ncode\n```')).toEqual([
      { kind: 'text', text: '```js\ncode\n```' },
    ]);
  });

  it('closes a block where CommonMark does: the first run at least as long, indented up to three', () => {
    expect(splitTextBlocks('```\ncode\n   `````  \nafter')).toEqual([
      { kind: 'code', text: '```\ncode\n   `````  ' },
      { kind: 'text', text: 'after' },
    ]);
    // Four spaces of indentation is code, not a closing fence.
    expect(splitTextBlocks('```\ncode\n    ```\n```')).toEqual([
      { kind: 'code', text: '```\ncode\n    ```\n```' },
    ]);
  });

  it('returns an empty text block for empty input', () => {
    expect(splitTextBlocks('')).toEqual([{ kind: 'text', text: '' }]);
  });
});
