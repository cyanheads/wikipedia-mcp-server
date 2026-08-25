# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-08-25

Adopt mcp-ts-core 0.12.3's MCP SDK v2 migration (strict tool inputs, outputSchema error envelope, JSON Schema 2020-12); settle MCP_SESSION_MODE on stateless; bump Bun to 1.4.0

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-07-29

Section-targeted reads no longer render sister-project, library-resource, portal-bar, and spoken-article boxes as prose

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-07-29

Section-targeted reads now render the parser's HTML instead of wikitext, fixing hoisted headings, dropped inline templates, emptied layout-table sections, and duplicated math formulas; drops the wtf_wikipedia dependency

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-07-29

Replace the hardcoded 227-code edition allowlist with a live sitematrix registry, fixing wrong-host langlinks, unresolved redirects in get_languages, and simple.wikipedia.org rejection; raise search_nearby limits to upstream bounds

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-16

Add wikipedia_search offset pagination and wikipedia_get_article overflow-outline (WIKIPEDIA_ARTICLE_OVERFLOW_BYTES); fix pageid field wording that implied page IDs are tool inputs

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-16

Resolve redirects in get_article/get_sections like get_summary; migrate get_sections to prop=tocdata; reject blank titles with typed not_found across four tools

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-16

Wire WIKIPEDIA_BASE_URL as an optional single-instance override; add edition_code to wikipedia_get_languages; populate invalid_language data.reason for nonexistent editions; adopt mcp-ts-core ^0.10.14

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9; sync framework devcheck scripts and vendored skills — plugin-manifest packaging lint and a floating-dependency-specifier guard

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6; truncation disclosure in wikipedia_search_nearby; MCPB bundle cleaner and packaging-lint guards; explicit createApp identity; Docker healthcheck

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-04

Fix invalid_section contract not populated when section_index exceeds article section count

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-02

mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, fetchWithTimeout secret-stripping, withRetry fail-fast on non-retryable errors; skill sync (api-mirror, orchestrations, 8 updated); release:github script; README client-config key renamed to package name

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-30

enrichment on wikipedia_search and wikipedia_search_nearby: query/filter echoes, result totals, and empty-result guidance in a typed enrichment block reaching both structuredContent and content[]; mcp-ts-core ^0.9.13 → ^0.9.16

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: HTTP body cap, session-init gate, quieter auth-error logs, GET /mcp keywords; error code corrections; dep refresh

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-24

Drop tsx, align all scripts to bun-native execution; add funding block

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-24

Field-test fixes: not_found propagation, invalid section_index guard, negative/float input validation, tool-description improvements, service simplification.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-24

Fix npm package scope to @cyanheads/wikipedia-mcp-server.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-24

Launch release — full implementation of 6 Wikipedia tools, 41 tests, field-test fixes, and pre-launch polish.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-24

Initial release — 6 tools for Wikipedia search, summaries, article reading, section targeting, geo search, and language links.
