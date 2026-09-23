/**
 * @fileoverview Tests for the shared markdown escape helper used by every tool's format().
 * @module tests/mcp-server/tools/utils/escape-markdown.test
 */

import { describe, expect, it } from 'vitest';
import {
  escapeMarkdown,
  escapeMarkdownOutsideBlocks,
} from '@/mcp-server/tools/utils/escape-markdown.js';
import { htmlSectionToPlainText } from '@/services/wikipedia/wikipedia-service.js';

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
