/**
 * @fileoverview Tests for the fenced-code, table-row, and list grammar the article renderer writes
 * and the markdown escaper reads back.
 * @module tests/services/wikipedia/text-blocks.test
 */

import { describe, expect, it } from 'vitest';
import {
  fenceCodeBlock,
  listLine,
  parseTableRow,
  splitTextBlocks,
  type TextBlock,
  tableDelimiterRow,
  tableRow,
} from '@/services/wikipedia/text-blocks.js';
import { expectLinearGrowth } from '../../helpers/cpu-growth.js';

/** The text `splitTextBlocks` read `blocks` from, rebuilt by its own `\n` join. */
function rejoin(blocks: readonly TextBlock[]): string {
  return blocks
    .map((block) => (block.kind === 'row' ? tableRow(block.cells) : block.text))
    .join('\n');
}

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

describe('listLine (#81)', () => {
  it('indents a line two spaces per level', () => {
    expect(listLine(0, '- Item')).toBe('- Item');
    expect(listLine(1, '3. Item')).toBe('  3. Item');
    expect(listLine(3, 'continued')).toBe('      continued');
  });
});

describe('splitTextBlocks — list blocks (#81)', () => {
  const nested = [listLine(0, '- a'), listLine(1, '1. b'), listLine(2, 'more of b')].join('\n');

  it.each<[string, string, TextBlock[]]>([
    [
      'a list holding an indented line, between paragraphs',
      `Intro:\n\n${nested}\n\nAfter.`,
      [
        { kind: 'text', text: 'Intro:\n' },
        { kind: 'list', text: nested },
        { kind: 'text', text: '\nAfter.' },
      ],
    ],
    [
      'a flat list, which stays prose',
      'Intro:\n\n- a\n- b\n10. c\n\nAfter.',
      [{ kind: 'text', text: 'Intro:\n\n- a\n- b\n10. c\n\nAfter.' }],
    ],
    [
      'two lists in a row, one at each edge of the text',
      `${nested}\n\n${nested}`,
      [
        { kind: 'list', text: nested },
        { kind: 'text', text: '' },
        { kind: 'list', text: nested },
      ],
    ],
    [
      'a paragraph any one of whose lines is indented, taken whole',
      'Lead line\n  indented\nlast\n\nNext.',
      [
        { kind: 'list', text: 'Lead line\n  indented\nlast' },
        { kind: 'text', text: '\nNext.' },
      ],
    ],
    ['a line indented with a tab', 'a\n\tb', [{ kind: 'list', text: 'a\n\tb' }]],
    [
      'a line of spaces alone, which is not a blank line',
      'a\n   \nb',
      [{ kind: 'list', text: 'a\n   \nb' }],
    ],
    [
      'a list beside a code block and a table row, no blank line between',
      '```\n  code\n```\n- a\n  b\n| x |',
      [
        { kind: 'code', text: '```\n  code\n```' },
        { kind: 'list', text: '- a\n  b' },
        { kind: 'row', cells: ['x'] },
      ],
    ],
    [
      'an indented fence inside a list, which opens no code block',
      '- a:\n  ```\n  code\n  ```\n- b',
      [{ kind: 'list', text: '- a:\n  ```\n  code\n  ```\n- b' }],
    ],
  ])('reads %s', (_name, text, blocks) => {
    expect(splitTextBlocks(text)).toEqual(blocks);
    expect(rejoin(blocks)).toBe(text);
  });

  // Every shape reaches a regex test per line, so each starts at 1,250 characters and its 64× span
  // ends at 80,000, below the size where Bun's regex engine changes mode.
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  it.each([
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    ['one indented paragraph', (n: number) => fill('- a\n  b\n', n)],
    ['alternating paragraphs', (n: number) => fill('- a\n  b\n\nc\n\n', n)],
    ['fence lines inside a list', (n: number) => fill('  ```\n', n)],
    ['fences throughout', (n: number) => fill('```\n  x\n', n)],
  ])('stays linear on %s', (_name, shape) => {
    expectLinearGrowth(splitTextBlocks, shape, 1_250);
  });
});
