/**
 * @fileoverview Regression tests for the bundle agent-doc selector shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts`
 * (check 8). The MCP SDK ships runtime modules under `dist/ext/skills/`, which
 * the skills extension imports at boot; only `skills/`, `framework-skills/`,
 * `.claude/`, `.agents/` trees and `AGENTS.md`/`CLAUDE.md` files at a package's
 * own root, and stray `SKILL.md` files, are agent docs.
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as LINT_AGENT_DOC_ENTRY,
} from '../../scripts/lint-packaging.js';

/** Runtime entries a cleaned bundle must keep. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  // A nested install of the SDK under another package.
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/a/node_modules/b/node_modules/@modelcontextprotocol/core/dist/ext/skills/node.mjs',
  // Packages whose own name is `skills`, scoped and unscoped.
  'node_modules/@acme/skills/index.js',
  'node_modules/skills/lib/index.js',
  // A deeper `.claude/` or `framework-skills/` inside a package's own source is not its root.
  'node_modules/some-pkg/lib/.claude/loader.js',
  'node_modules/some-pkg/dist/framework-skills/index.js',
  // An `AGENTS.md` or `CLAUDE.md` below a package's root is not its root agent doc.
  'node_modules/some-pkg/docs/AGENTS.md',
  'node_modules/@scope/pkg/lib/CLAUDE.md',
  // The server's own published tree at the bundle root.
  'skills/wikipedia-guide/SKILL.md',
  'dist/index.js',
];

/** Dependency-shipped agent docs a cleaned bundle must not keep. */
const AGENT_DOC_ENTRIES = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenvx/references/usage.md',
  'node_modules/thread-stream/.claude/settings.local.json',
  'node_modules/some-pkg/.agents/skills/x/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/@scope/pkg/skills/guide/README.md',
  // Package roots below nested node_modules, scoped and unscoped.
  'node_modules/a/node_modules/@b/c/skills/x/README.md',
  'node_modules/a/node_modules/b/node_modules/c/.claude/settings.json',
  // Root agent-protocol files, scoped, unscoped, and nested.
  'node_modules/thread-stream/AGENTS.md',
  'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
  'node_modules/a/node_modules/@b/c/AGENTS.md',
  // A stray SKILL.md anywhere under node_modules, including a package root.
  'node_modules/some-pkg/SKILL.md',
  'node_modules/some-pkg/docs/agent/SKILL.md',
];

describe('scripts/clean-mcpb.ts agent-doc selector', () => {
  it.each(RUNTIME_ENTRIES)('keeps runtime entry %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each(AGENT_DOC_ENTRIES)('strips agent-doc entry %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });

  it('selects exactly the agent docs from a mixed listing', () => {
    const listing = [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES];
    expect(filterAgentDocEntries(listing)).toEqual(AGENT_DOC_ENTRIES);
  });
});

describe('scripts/lint-packaging.ts check 8 agent-doc selector', () => {
  it('matches the clean-mcpb.ts literal', () => {
    expect(LINT_AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(LINT_AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('passes a cleaned bundle that keeps the SDK skills runtime', () => {
    expect(checkBundleEntries(RUNTIME_ENTRIES, 'dist/wikipedia-mcp-server.mcpb')).toEqual([]);
  });

  it('flags a bundle that still holds dependency agent docs', () => {
    const errors = checkBundleEntries(
      [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES],
      'dist/wikipedia-mcp-server.mcpb',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      `contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`,
    );
  });
});
