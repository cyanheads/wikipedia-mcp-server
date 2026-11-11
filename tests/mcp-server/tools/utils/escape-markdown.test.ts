/**
 * @fileoverview Tests for the shared markdown escape helper used by every tool's format().
 * @module tests/mcp-server/tools/utils/escape-markdown.test
 */

import { describe, expect, it } from 'vitest';
import {
  escapeMarkdown,
  escapeMarkdownOutsideBlocks,
  formatTablePage,
  quotedNotice,
  urlLink,
} from '@/mcp-server/tools/utils/escape-markdown.js';
import { htmlSectionToPlainText } from '@/services/wikipedia/wikipedia-service.js';
import { parseInlineText, parseTargets, readBackText } from '../../../helpers/commonmark.js';
import { expectLinearGrowth } from '../../../helpers/cpu-growth.js';

describe('escapeMarkdown', () => {
  it('backslash-escapes every inline markdown-active character', () => {
    // Backslash first: escaping it last would double-escape the backslashes added before it.
    expect(escapeMarkdown('\\')).toBe('\\\\');
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*');
    expect(escapeMarkdown('_word_')).toBe('\\_word\\_');
    expect(escapeMarkdown('[link]')).toBe('\\[link\\]');
    expect(escapeMarkdown('<script>')).toBe('\\<script\\>');
    expect(escapeMarkdown('A & B')).toBe('A \\& B');
    expect(escapeMarkdown('C#')).toBe('C\\#');
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
    expect(escapeMarkdown('~strike~')).toBe('\\~strike\\~');
  });

  it('escapes HTML entity syntax so it renders as written rather than decoding', () => {
    expect(escapeMarkdown('&lt;ref&gt;')).toBe('\\&lt;ref\\&gt;');
  });

  it('neutralizes line-leading block constructs on every line, not just the first', () => {
    expect(escapeMarkdown('# Heading')).toBe('\\# Heading');
    expect(escapeMarkdown('> Quote')).toBe('\\> Quote');
    expect(escapeMarkdown('- Item')).toBe('\\- Item');
    expect(escapeMarkdown('+ Item')).toBe('\\+ Item');
    expect(escapeMarkdown('1. Item')).toBe('1\\. Item');
    expect(escapeMarkdown('2) Item')).toBe('2\\) Item');
    expect(escapeMarkdown('Text\n## Later heading')).toBe('Text\n\\#\\# Later heading');
    expect(escapeMarkdown('Text\n- Later item')).toBe('Text\n\\- Later item');
  });

  it('neutralizes a thematic break and an indented block marker', () => {
    expect(escapeMarkdown('---')).toBe('\\---');
    expect(escapeMarkdown('   - Indented item')).toBe('   \\- Indented item');
  });

  it('leaves text with no markdown-active characters byte-identical', () => {
    const plain = 'Python is a high-level, general-purpose programming language.';
    expect(escapeMarkdown(plain)).toBe(plain);
  });

  it('leaves the alphanumeric sentinel the format-parity linter injects untouched', () => {
    expect(escapeMarkdown('SENTINEL0123456789')).toBe('SENTINEL0123456789');
  });

  it('renders every escape as its literal character under CommonMark backslash rules', () => {
    // Every escaped character is ASCII punctuation, which CommonMark permits escaping.
    const escaped = escapeMarkdown('\\`*_[]<>&#|~-+.)');
    expect(escaped.replace(/\\(.)/g, '$1')).toBe('\\`*_[]<>&#|~-+.)');
  });
});

describe('escapeMarkdownOutsideBlocks (issues #49, #50)', () => {
  it('keeps headerless continuation rows literal even when a data row resembles a delimiter (#67)', () => {
    expect(formatTablePage('| a \\| b | <script> |\n| --- | --- |\n| tail | value |', true)).toBe(
      '\\| a \\| b \\| \\<script\\> \\|  \n\\| --- \\| --- \\|  \n\\| tail \\| value \\|',
    );
  });
  it('matches escapeMarkdown on text with no code block or table row', () => {
    for (const text of [
      'Italic by _underscores_ and <b>tags</b>.\n# Not a heading\n- not a list',
      '== History ==\n\nPython 3.0 | released 2008',
      '```\nan unclosed fence stays text',
      '',
    ]) {
      expect(escapeMarkdownOutsideBlocks(text)).toBe(escapeMarkdown(text));
    }
  });

  it('leaves a fenced code block raw and escapes the prose around it', () => {
    const text = 'Program <main>:\n\n```\nif n < 0:\n    factorial *= i\n```\n\nAfter _that_.';
    expect(escapeMarkdownOutsideBlocks(text)).toBe(
      'Program \\<main\\>:\n\n```\nif n < 0:\n    factorial *= i\n```\n\nAfter \\_that\\_.',
    );
  });

  it('keeps a table row delimiters raw while escaping every cell', () => {
    const text = '| Name | Tag |\n| --- | --- |\n| <b>A</b> | a \\| b |\n| `x` | *y* |';
    expect(escapeMarkdownOutsideBlocks(text)).toBe(
      '| Name | Tag |\n| --- | --- |\n| \\<b\\>A\\</b\\> | a \\| b |\n| \\`x\\` | \\*y\\* |',
    );
  });

  it('leaves a cell that starts like a list marker alone — a cell never starts a line', () => {
    expect(escapeMarkdownOutsideBlocks('| 49.80% | - | + 3 | 2) |')).toBe(
      '| 49.80% | - | + 3 | 2) |',
    );
  });

  it('keeps a cell holding a fence or row syntax inert inside its row', () => {
    expect(escapeMarkdownOutsideBlocks('| ``` | \\| --- \\| |')).toBe(
      '| \\`\\`\\` | \\| --- \\| |',
    );
  });

  it('cannot be closed early by a shorter backtick run inside the code', () => {
    const text = '````\n```\n<script>\n````\n<b>after</b>';
    expect(escapeMarkdownOutsideBlocks(text)).toBe(
      '````\n```\n<script>\n````\n\\<b\\>after\\</b\\>',
    );
  });

  it('escapes a fence with no close, so the text after it never renders raw', () => {
    expect(escapeMarkdownOutsideBlocks('```\n<script>alert(1)</script>')).toBe(
      '\\`\\`\\`\n\\<script\\>alert(1)\\</script\\>',
    );
  });

  it('renders a code body and a table built from adversarial article HTML without letting either out', () => {
    const plain = htmlSectionToPlainText(
      '<p>Intro &lt;b&gt;</p><pre>```\n| &lt;i&gt; |\n```</pre><table class="wikitable"><tr><th>```</th><th>a | b</th></tr><tr><td>&lt;script&gt;</td><td>| --- |</td></tr></table>',
    );
    expect(plain).toBe(
      'Intro <b>\n\n````\n```\n| <i> |\n```\n````\n\n| ``` | a \\| b |\n| --- | --- |\n| <script> | \\| --- \\| |',
    );
    expect(escapeMarkdownOutsideBlocks(plain)).toBe(
      'Intro \\<b\\>\n\n````\n```\n| <i> |\n```\n````\n\n| \\`\\`\\` | a \\| b |\n| --- | --- |\n| \\<script\\> | \\| --- \\| |',
    );
  });
});

describe('escapeMarkdownOutsideBlocks — list blocks (#81)', () => {
  it('fences a list holding an indented line and escapes nothing inside the fence', () => {
    expect(escapeMarkdownOutsideBlocks('Intro <b>:\n\n- a *b*\n  1. c_d\n\nAfter _e_.')).toBe(
      'Intro \\<b\\>:\n\n```\n- a *b*\n  1. c_d\n```\n\nAfter \\_e\\_.',
    );
  });

  it('escapes a flat list like any other line-leading text', () => {
    expect(escapeMarkdownOutsideBlocks('- Mercury (planet)\n10. Ten\n0. Zero\n-1. Past zero')).toBe(
      '\\- Mercury (planet)\n10\\. Ten\n0\\. Zero\n\\-1. Past zero',
    );
  });

  it('opens the fence longer than any backtick run in the list, a fenced sample included', () => {
    const list = '- Run:\n  ````\n  code ```\n  ````\n- `inline`';
    expect(escapeMarkdownOutsideBlocks(list)).toBe(`\`\`\`\`\`\n${list}\n\`\`\`\`\``);
  });

  const FIVE_LEVELS = '- One\n  1. Two\n    - Three\n      3. Four\n        - Five\n- Back';
  it.each([
    ['a flat bulleted list', 'Mercury may refer to:\n\n- Mercury (planet)\n- Mercury (element)'],
    ['a flat numbered list past nine', '9. Nine\n10. Ten\n11. Eleven'],
    ['a reversed list counting past zero', '1. One\n0. Zero\n-1. Past zero'],
    ['a list five levels deep', `Intro:\n\n${FIVE_LEVELS}\n\nAfter.`],
    ['continuation lines', '1. Lead\n  Paragraph two\n  N: node\n2. Next'],
    ['a code sample inside an item', '- Run:\n  ````\n  x = 1\n    y ```\n  ````\n  then'],
    [
      'a table inside an item',
      '- Results:\n  | A | B |\n  | --- | --- |\n  | 1 | x \\| y |\n- Next',
    ],
    ['markup characters inside an item', '- *a* _b_ <c> & [d](e) `f` \\g\n  # not a heading'],
    ['a list at each edge of the text', `${FIVE_LEVELS}\n\nMiddle.\n\n${FIVE_LEVELS}`],
    ['a line of spaces alone', 'a\n   \nb'],
  ])('reads %s back exactly under CommonMark', (_name, text) => {
    expect(readBackText(escapeMarkdownOutsideBlocks(text))).toBe(text);
  });

  it('reads back a list rendered from article HTML holding a code sample and backtick runs', () => {
    const plain = htmlSectionToPlainText(
      '<ul><li>Run <code>```</code>:<pre>````\nx</pre></li><li>Next<ul><li>`deep`</li></ul></li></ul>',
    );
    expect(plain).toBe('- Run ```:\n  `````\n  ````\n  x\n  `````\n- Next\n  - `deep`');
    expect(escapeMarkdownOutsideBlocks(plain)).toBe(`\`\`\`\`\`\`\n${plain}\n\`\`\`\`\`\``);
    expect(readBackText(escapeMarkdownOutsideBlocks(plain))).toBe(plain);
  });

  // Every shape reaches a regex scan, so each starts at 1,250 characters and its 64× span ends at
  // 80,000, below the size where Bun's regex engine changes mode.
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  it.each([
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    ['one indented list', (n: number) => fill('- a\n  b\n', n)],
    ['many short lists', (n: number) => fill('- a\n  b\n\n', n)],
    ['a list of backtick runs', (n: number) => `- a\n${fill('  `', n)}`],
    ['a flat list', (n: number) => fill('- a *b*\n', n)],
  ])('stays linear on %s', (_name, shape) => {
    expectLinearGrowth(escapeMarkdownOutsideBlocks, shape, 1_250);
  });
});

describe('quotedNotice', () => {
  it('quotes each line and reads back as the notice it was given', () => {
    const notice = 'Section *Seine* _flood_ [1](x) `code` <b>\n# Aftermath';
    expect(quotedNotice('*a*')).toBe('> \\*a\\*');
    expect(
      quotedNotice(notice)
        .split('\n')
        .every((line) => line.startsWith('> ')),
    ).toBe(true);
    expect(readBackText(quotedNotice(notice))).toBe(notice);
  });

  // A notice can quote a caller's query or an upstream heading of any length.
  const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  it.each([
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    ['tag text', (n: number) => fill('<a', n)],
    ['emphasis and code text', (n: number) => fill('`[*_', n)],
    ['heading text', (n: number) => `x ${fill('#', n)}\ny`],
  ])('stays linear on %s', (_name, shape) => {
    expectLinearGrowth(quotedNotice, shape, 1_250);
  });
});

describe('urlLink (#78)', () => {
  it('links an absolute http(s) URL under its host, read back byte for byte', () => {
    const url = 'https://example.org/a_-_b*c*(d <e> \\f &copy;';
    expect(urlLink(url)).toBe(
      '[example.org](<https://example.org/a_-_b*c*(d \\<e\\> \\\\f \\&copy;>)',
    );
    expect(parseTargets(urlLink(url))).toEqual([{ kind: 'link', href: url, text: 'example.org' }]);
  });

  it.each([
    'ftp://example.org/a_-_b_c',
    'mailto:a_b_c@example.org',
    '//example.org/a_-_b_c',
    'https://example.org/a_b\nc_d',
    'not a url *at* all',
  ])('writes %j, which cannot be a link destination, as text that reads back unchanged', (url) => {
    expect(parseTargets(urlLink(url))).toEqual([]);
    expect(parseInlineText(urlLink(url))).toEqual([url]);
  });
});
