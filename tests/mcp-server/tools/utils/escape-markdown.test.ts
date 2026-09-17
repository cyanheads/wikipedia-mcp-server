/**
 * @fileoverview Tests for the shared markdown escape helper used by every tool's format().
 * @module tests/mcp-server/tools/utils/escape-markdown.test
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from '@/mcp-server/tools/utils/escape-markdown.js';

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
