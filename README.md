<div align="center">
  <h1>@cyanheads/wikipedia-mcp-server</h1>
  <p><b>Search Wikipedia articles, read summaries and full text, target sections, find nearby pages, and list language editions via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/wikipedia-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wikipedia-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wikipedia-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wikipedia-mcp-server/releases/latest/download/wikipedia-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wikipedia-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd2lraXBlZGlhLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wikipedia-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwikipedia-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Six tools for working with Wikipedia across all language editions:

| Tool | Description |
|:---|:---|
| `wikipedia_search` | Full-text search across Wikipedia, returning ranked results with plain-text snippets and page IDs. |
| `wikipedia_get_summary` | Lead-section summary for any article — plain text, Wikidata QID, description, thumbnail URL, and page type. |
| `wikipedia_get_article` | Full article or a targeted section as clean plain text, with section markers preserved. |
| `wikipedia_get_sections` | Table of contents with `section_index` values for targeted section reads. |
| `wikipedia_search_nearby` | Geotagged Wikipedia articles within a radius of a WGS 84 coordinate, sorted by distance. |
| `wikipedia_get_languages` | All language editions available for an article, with titles and URLs. |

### `wikipedia_search`

Search Wikipedia articles by full-text query.

- Returns ranked results with plain-text snippets (HTML stripped), page IDs, and word counts
- Use when the exact article title is unknown or to discover multiple articles on a topic
- Supports all Wikipedia language editions via the `language` parameter

---

### `wikipedia_get_summary`

Fetch the lead-section summary for a Wikipedia article.

- Returns the 2–4 paragraph intro, Wikidata QID for cross-referencing, short description, and thumbnail URL
- Surfaces `page_type: "disambiguation"` — a signal to follow up with `wikipedia_search` using a more specific query
- Redirect pages followed automatically
- Right tool for 90% of encyclopedic lookups

---

### `wikipedia_get_article`

Fetch article content as clean plain text.

- Without `section_index`: returns the full article (40–100 KB for major articles) with `== Section ==` markers
- With `section_index` (from `wikipedia_get_sections`): returns just that section (1–10 KB)
- Section path uses wikitext stripping via `wtf_wikipedia`

---

### `wikipedia_get_sections`

Fetch the table of contents for a Wikipedia article.

- Returns section titles, heading levels, section numbering (e.g. "2.1"), and `section_index` values
- `section_index` is the integer to pass to `wikipedia_get_article` for targeted reads
- Call this before `wikipedia_get_article` when only a specific section is needed

---

### `wikipedia_search_nearby`

Find Wikipedia articles about places near a geographic coordinate.

- Results sorted ascending by distance in meters
- Only articles with geographic coordinates in their Wikidata record are returned
- Radius capped at 10,000 meters; up to 50 results per call

---

### `wikipedia_get_languages`

List language editions available for a Wikipedia article.

- Returns language codes, article titles in each language, and full URLs
- Use for cross-language research or to discover a non-English title before switching editions

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Wikipedia-specific:

- Dual API integration — MediaWiki REST API (`/api/rest_v1/`) for summaries, Action API (`/w/api.php`) for search, full text, sections, geo search, and language links
- Retry and backoff on all requests; `User-Agent` header per Wikimedia API policy
- Wikitext stripping pipeline via `wtf_wikipedia` — handles links, templates, refs, bold/italic; re-injects section headings for structure
- Per-call `language` parameter on every tool — all Wikipedia language editions accessible in a single session
- Language validation against ~250 known Wikipedia edition codes — catches structurally valid but nonexistent editions before they cause timeouts

Agent-friendly output:

- `page_type` field on summaries discriminates article / disambiguation / redirect — no string parsing needed
- `wikibase_item` (Wikidata QID) on summaries enables direct cross-referencing with wikidata-mcp-server
- `section_index` on table-of-contents entries links directly to the targeted-read parameter on `wikipedia_get_article`
- Recovery hints on every error type — callers get actionable next steps (e.g., "use `wikipedia_search` to find the correct title")

## Getting started

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
| `WIKIPEDIA_USER_AGENT` | User-Agent header sent with every Wikimedia API request. Customize for your deployment. | `wikipedia-mcp-server/0.1.7 (https://github.com/cyanheads/wikipedia-mcp-server)` |
| `WIKIPEDIA_BASE_URL` | Base Wikipedia URL. Language selection is per-call — not a global language setting. | `https://en.wikipedia.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
