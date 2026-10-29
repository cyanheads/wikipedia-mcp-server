/**
 * @fileoverview Test helper — read a `content[]` string back through a CommonMark parse.
 * @module tests/helpers/commonmark
 */

import MarkdownIt from 'markdown-it';

/**
 * A CommonMark parser that reports a link or image destination exactly as the parse reads it —
 * backslash escapes and entity references resolved, nothing else. markdown-it's default
 * `normalizeLink` percent-encodes the destination for an HTML `href`, which is a rendering step, not
 * what the Markdown says.
 */
const md = new MarkdownIt('commonmark');
md.normalizeLink = (url) => url;

/** A link or image in a parsed document: its destination and the text a reader sees for it. */
export type ParsedTarget = { kind: 'link' | 'image'; href: string; text: string };

/** Every link and image in `markdown`, in document order. */
export function parseTargets(markdown: string): ParsedTarget[] {
  const targets: ParsedTarget[] = [];
  for (const block of md.parse(markdown, {})) {
    const children = block.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const token = children[i]!;
      if (token.type === 'image') {
        // An image token's `content` is its raw label source; the alt text a reader gets is its
        // children's text, with escapes resolved.
        const alt = (token.children ?? []).map((child) => child.content).join('');
        targets.push({ kind: 'image', href: String(token.attrGet('src')), text: alt });
      } else if (token.type === 'link_open') {
        let text = '';
        for (i++; i < children.length && children[i]!.type !== 'link_close'; i++) {
          text += children[i]!.content;
        }
        targets.push({ kind: 'link', href: String(token.attrGet('href')), text });
      }
    }
  }
  return targets;
}

/** The visible text of `markdown`'s inline content, one string per paragraph or heading. */
export function parseInlineText(markdown: string): string[] {
  return md
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .map((child) =>
          child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content,
        )
        .join(''),
    );
}
