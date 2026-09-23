<div align="center">
  <h1>@cyanheads/wikipedia-mcp-server</h1>
  <p><b>Search Wikipedia articles, read summaries and full text, target sections, find nearby pages, and list language editions via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wikipedia-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wikipedia-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wikipedia-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wikipedia-mcp-server/releases/latest/download/wikipedia-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wikipedia-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd2lraXBlZGlhLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wikipedia-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwikipedia-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://wikipedia.caseyjhand.com/mcp](https://wikipedia.caseyjhand.com/mcp)

</div>

---

## Overview

Wikipedia content via the MediaWiki REST API and Action API. Search articles, read summaries or targeted sections, find geotagged pages near a coordinate, and list language editions from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `wikipedia_search_articles` | Full-text search across Wikipedia, returning ranked results with short descriptions, Wikidata QIDs, plain-text snippets, and page IDs, plus Wikipedia's spelling suggestion. |
| `wikipedia_get_summary` | Short summary for any article — plain text, Wikidata QID, description, thumbnail URL, page type, canonical URL, revision, and coordinates. |
| `wikipedia_get_article` | Full article or a targeted section as clean plain text, with section markers preserved, the canonical URL, and the revision it was read from. |
| `wikipedia_get_sections` | Table of contents with `section_index` values for targeted section reads. |
| `wikipedia_search_nearby` | Geotagged Wikipedia articles within a radius of a WGS 84 coordinate, sorted by distance, with short descriptions and Wikidata QIDs. |
| `wikipedia_get_languages` | All language editions available for an article, with titles and URLs, or just the editions you ask for. |

## Capability reference

### `wikipedia_search_articles` <sub>tool</sub>

- Free-text query, ranked by relevance; returns plain-text snippets (HTML stripped), page IDs, and word counts
- Each result carries the article's short `description` and Wikidata QID (`wikibase_item`) when it has them, from one follow-up lookup per page of results. That lookup is best-effort: if it fails, the results still come back without the two fields and the `notice` says so
- Enrichment `suggestion` carries Wikipedia's spelling correction whenever it has one (`einstien` → `einstein`), and a zero-hit first page names it in the `notice` — re-run with it as `query`
- `limit` is 1–50; `offset` pages further results — enrichment `nextOffset` signals more remain and is passed back as `offset`
- Wikipedia serves no result past the 10,000th for a query: an `offset` at or beyond it fails with `offset_too_large`, and a page ending on the window carries enrichment `truncated` naming the matches no offset reaches — narrow the query to bring them into range
- An empty `query` fails with `empty_query`; a whitespace-only query is a real search that simply matches nothing
- `language` selects any Wikipedia edition (default `en`)
- Best when the exact article title is unknown, or to discover multiple articles on a topic

---

### `wikipedia_get_summary` <sub>tool</sub>

- Returns the REST summary extract — a truncated fragment from the start of the lead, not the whole lead — plus the Wikidata QID (`wikibase_item`), short description, and thumbnail URL
- `url` is the canonical article URL, and `revision_id` / `last_modified` name the revision the extract was read from — `?oldid=<revision_id>` is a permanent link to it
- Superscripts and subscripts in the extract stay distinct from the digits beside them (`10²³`, `H₂O`), rendered the same way as on `wikipedia_get_article`
- `latitude` / `longitude` are present for a geotagged article and pass straight to `wikipedia_search_nearby`, whose inputs carry those names; both are absent otherwise
- For the lead section in full, call `wikipedia_get_article` with `section_index: 0`
- `page_type` discriminates `standard` / `disambiguation` / `no-extract` — on `disambiguation`, re-query with `wikipedia_search_articles` for a more specific title
- Redirect pages are followed automatically
- Right tool for most encyclopedic "what is X?" lookups; use `wikipedia_get_article` for full depth

---

### `wikipedia_get_article` <sub>tool</sub>

- Without `section_index`: full article with `== Section ==` markers, unless it exceeds `WIKIPEDIA_ARTICLE_OVERFLOW_BYTES` (default 80,000 bytes) — then returns a section outline (`truncated: true`) pointing to `wikipedia_get_sections` plus a targeted `section_index` read
- With `section_index` (from `wikipedia_get_sections`): returns that section plus every nested subsection, each heading above its own body
- `section_index: 0` is the lead section — the text above the first heading, returned under the title `Introduction`
- Both paths render code samples as fenced blocks with indentation intact and formulas as their TeX. Section reads also render data tables as pipe-delimited rows (header row, `| --- |`, then one line per row; `rowspan` cells repeated) and infoboxes as `label: value` lines; a table over 40,000 rendered bytes leaves a `[table omitted: N rows]` marker. The full-article path carries no tables or infoboxes — upstream extracts strip them — so read the section for those
- Layout-only tables (multi-column lists, succession boxes) keep their content as ordinary text
- Superscripts and subscripts stay distinct from the digits beside them: `10²³`, `mol⁻¹`, `H₂O`, or `^x` / `_x` where a character has no Unicode form. An abbreviation's superscript stays joined, as the edition writes it in plain text (French `XIXe siècle`, `1er`, `Mme`)
- Every read returns `url` (the canonical article URL) and `revision_id` (the revision the text was read from — `?oldid=<revision_id>` is a permanent link to it); a full read, outline included, also returns `last_modified`, that revision's timestamp. For a redirect, all three name the target article. With `WIKIPEDIA_BASE_URL` set, a section read omits `url`, since the mirror's article path is unknown
- Page furniture — maintenance banners, sister-project and library-resource boxes, portal bars, spoken-article notices — is stripped, as are the editor-only preview warnings a section render emits; hatnotes are kept
- Redirect pages are followed automatically

---

### `wikipedia_get_sections` <sub>tool</sub>

- Returns section titles, heading levels, hierarchical numbering (e.g. `"2.1"`), and `section_index` values
- The first entry is the lead: `index: 0`, titled `Introduction` — Wikipedia's own table of contents starts at the first heading
- `section_index` is the integer to pass to `wikipedia_get_article` for a targeted read
- Fails with `no_sections` on a stub or very short article — read it with `wikipedia_get_article` instead
- Redirect pages are followed automatically

---

### `wikipedia_search_nearby` <sub>tool</sub>

- Returns geotagged articles sorted ascending by distance, with coordinates, `distance_meters`, and each article's short `description` and Wikidata QID (`wikibase_item`) when it has them
- `radius_meters`: 10–10,000 (default 1000); `limit`: 1–500 (default 10) — no pagination past `limit`, so raise it or sweep narrower radii for full coverage
- Only articles carrying their own coordinate tag (GeoData, set on the article — not the Wikidata item's coordinate) are returned, and that tag places and measures each result. An article with a wrong tag appears where the tag puts it; its `description` usually gives it away (`Palazzo Bernardo Nani` — "Palace on the Grand Canal, Venice" — 161 m from the Eiffel Tower)
- Enrichment `truncated` flags when more articles matched than `limit` allowed; at `limit: 500`, Wikipedia's ceiling, a full page reports `truncated` and the notice points to narrower sweeps rather than a higher limit

---

### `wikipedia_get_languages` <sub>tool</sub>

- Returns each edition's `language_code`, tool-usable `edition_code` (can differ, e.g. `gsw` vs `als`), article title, and URL
- Pass `edition_code` — not `language_code` — as the `language` parameter on other tools
- `editions` narrows the answer to the codes asked for, matched against both `edition_code` and `language_code`; requested codes with no article come back under `missing`, and `total_languages` stays the unfiltered count. A popular article lists hundreds of editions, so the filter is the difference between a 40 KB reply and a 1 KB one
- Fails with `no_other_languages` when the article has no translations — a filter that matches nothing is a normal response with an empty list, not a failure
- Redirect pages are followed automatically; `source_title` reports the resolved title

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Wikipedia-specific:

- Dual API integration — MediaWiki REST API (`/api/rest_v1/`) for summaries, Action API (`/w/api.php`) for search, full text, sections, geo search, and language links
- Retry and backoff on every required request (the best-effort description lookup on search results gets one short attempt); `User-Agent` header per Wikimedia API policy
- Every read path renders HTML through one renderer to the same plain-text shape — `== Heading ==` markers, one list item per line, superscripts kept, code fenced: the full article from the Action API's HTML extract, a section from the parser's own HTML for that section, the summary from the REST `extract_html`. A section read additionally carries data tables, infoboxes, and the lists inside layout tables, none of which the extract carries
- Per-call `language` parameter on every tool — all Wikipedia language editions accessible in a single session
- Language validation against a live edition registry built from the MediaWiki `action=sitematrix` endpoint (cached 24h) — catches structurally valid but nonexistent editions before they cause timeouts

Agent-friendly output:

- `page_type` on summaries discriminates `standard` / `disambiguation` / `no-extract` — no string parsing needed
- `wikibase_item` (Wikidata QID) on summaries and on search and nearby results enables direct cross-referencing with wikidata-mcp-server
- Article text, snippets, and titles are backslash-escaped on the way into the markdown `content[]` render, so an article that writes about markup or markdown syntax reads as itself instead of being interpreted by the client; `structuredContent` carries the same text unescaped. Fenced code blocks and table-row delimiters pass through unescaped, while table cells stay escaped
- `section_index` on table-of-contents entries links directly to the targeted-read parameter on `wikipedia_get_article`, index 0 included
- Titles MediaWiki cannot name a page with — `< > [ ] { }`, the `|` multi-title separator, percent escapes, magic tildes, relative paths — are refused before any request, with `invalid_title`; a trailing `#fragment` is accepted and resolves normally
- Recovery hints on every error type — callers get actionable next steps (e.g., "use `wikipedia_search_articles` to find the correct title")

## Getting started

### Public Hosted Instance

A public instance is available at `https://wikipedia.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "wikipedia-mcp-server": {
      "type": "streamable-http",
      "url": "https://wikipedia.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "wikipedia-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/wikipedia-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "wikipedia-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/wikipedia-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "wikipedia-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/wikipedia-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API keys required — Wikipedia's API is public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/wikipedia-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd wikipedia-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env if you want to customize WIKIPEDIA_USER_AGENT or logging
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `WIKIPEDIA_USER_AGENT` | User-Agent header sent with every Wikimedia API request. Customize for your deployment. | `wikipedia-mcp-server/0.2.4 (https://github.com/cyanheads/wikipedia-mcp-server)` |
| `WIKIPEDIA_BASE_URL` | Optional single-instance override. Unset (default): compose per-language hosts, `language` selects the edition per call. Set to a full base URL (e.g. a private MediaWiki mirror): route every call at that one fixed host — `language` no longer varies it. | *(unset)* |
| `WIKIPEDIA_ARTICLE_OVERFLOW_BYTES` | Byte budget above which a full-article read (`wikipedia_get_article` without `section_index`) returns a section outline instead of the full text. Tuned for this domain — ordinary articles stay whole; only genuine mega-articles (World War II ~86 KB, United States ~94 KB) outline. Section-targeted reads are never affected. | `80000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (which resolves to `stateful`). The Docker image ships `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t wikipedia-mcp-server .
docker run --rm -p 3010:3010 wikipedia-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/wikipedia-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the Wikipedia service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — one file per tool. |
| `src/services/wikipedia` | WikipediaService — REST API + Action API client with retry/backoff and language validation. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
