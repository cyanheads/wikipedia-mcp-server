# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
