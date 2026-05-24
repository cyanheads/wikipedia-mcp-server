# wikipedia-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `wikipedia_search` | Full-text search across articles. Returns ranked results with plain-text titles, snippets, and page IDs. Use when the exact article title is unknown or to find multiple articles on a topic. | `query`, `limit`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound), `invalid_language` (InvalidParams) |
| `wikipedia_get_summary` | Fetch the lead section summary for an article — the 2–4 paragraph intro that answers "what is X?". Returns plain-text extract, Wikidata QID for cross-referencing, description, and thumbnail URL. Handles disambiguation pages: returns `page_type: "disambiguation"` so the agent can detect and pivot to a more specific search. | `title`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_language` (InvalidParams) |
| `wikipedia_get_article` | Fetch article content as clean plain text. Full-article path uses `action=query&prop=extracts&explaintext=true` (40–100KB for major articles). Section-targeted path uses `action=parse&prop=wikitext&section={index}` with wikitext stripping applied — use `section_index` (from `wikipedia_get_sections`) to retrieve a single section. Prefer section targeting when only part of the article is needed. | `title`, `section_index`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_section` (InvalidParams), `invalid_language` (InvalidParams) |
| `wikipedia_get_sections` | Fetch the table of contents for an article — section titles, numbers, levels, and `section_index` values. Call this before `wikipedia_get_article` when only a specific section is needed. The returned `section_index` values are the identifiers for targeted section reads. | `title`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `no_sections` (NotFound), `invalid_language` (InvalidParams) |
| `wikipedia_search_nearby` | Find Wikipedia articles about places near a geographic coordinate. Returns articles within a radius, sorted by distance. Useful for "what's notable near X?" research. | `latitude`, `longitude`, `radius_meters`, `limit`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound), `invalid_coordinates` (InvalidParams), `invalid_language` (InvalidParams) |
| `wikipedia_get_languages` | List the language editions available for an article. Returns language codes, article titles in each language, and URLs. Use for cross-language research or to find a non-English article title for a known concept. | `title`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `no_other_languages` (NotFound), `invalid_language` (InvalidParams) |

### Resources

None. All data access flows through tools — resources don't add value here since Wikipedia articles aren't stable addressable objects that benefit from URI-based injection (content changes continuously, and summaries already cover the injectable-context use case via tools).

### Prompts

None. This is a pure data-access server.

---

## Overview

Wikipedia MCP server providing encyclopedic context to AI agents via the MediaWiki REST API (`/api/rest_v1/`) and Action API (`api.php`). Covers the dominant agent knowledge workflow — "what is X?" — plus targeted section reading, full-text search, geographic search, and cross-language lookup. No auth required; polite usage policy with a custom `User-Agent` header.

Complements `wikidata-mcp-server` (structured triples, SPARQL, entity properties) — this server provides the human-readable prose and narrative context that structured data can't.

## Requirements

- No API key — anonymous access with a descriptive `User-Agent` per Wikimedia policy (format: `tool-name/version (contact-url)`)
- No hard rate limits, but Wikimedia asks for polite usage: reasonable concurrency, retry on 429 with backoff
- Default language: `en` (English Wikipedia). Language is a per-call parameter — no session state
- Read-only surface throughout — no writes
- Disambiguation pages are not errors: surface `type: "disambiguation"` so the agent can detect and pivot to search
- Multi-wiki support (Wikiquote, Wiktionary, etc.) deferred — configure via base URL env var for future use

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WikipediaService` | MediaWiki REST API + Action API | All tools |

Single service — both APIs share the same base host and User-Agent; one client handles both. Two fetch methods internally: `restGet(path)` for REST API calls and `actionGet(params)` for Action API calls.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WIKIPEDIA_BASE_URL` | No | Override base URL (default: `https://en.wikipedia.org`). Language selection is a per-call parameter, not a global config. |
| `WIKIPEDIA_USER_AGENT` | No | Override the User-Agent string. Defaults to a reasonable `wikipedia-mcp-server/VERSION (https://github.com/cyanheads/wikipedia-mcp-server)` value. |

No API key needed. Language is a per-call parameter on every tool (defaults to `en`), so the base URL stays language-agnostic for most users while still supporting cross-language calls.

## Implementation Order

1. `WikipediaService` — `restGet` + `actionGet` with retry/backoff, User-Agent header
2. Wikitext stripping utility — `wtf-wikipedia` integration + post-pass for heading markers and blank-line normalization; verify against real article wikitext before proceeding
3. `wikipedia_get_summary` — REST API `/page/summary/{title}`, core "what is X?" tool
4. `wikipedia_search` — Action API `action=query&list=search`, strip snippet HTML before returning
5. `wikipedia_get_sections` — Action API `action=parse&prop=sections` with `== Title ==` fallback
6. `wikipedia_get_article` — full-article path (`action=query&prop=extracts`) and section path (`action=parse&prop=wikitext` + stripping)
7. `wikipedia_get_languages` — Action API `action=query&prop=langlinks`
8. `wikipedia_search_nearby` — Action API `action=query&list=geosearch`

Each step is independently testable.

---

## Design Decisions

### Tool count: 6 instead of 7

The idea doc proposed `wikipedia_random`. Deferred — random article retrieval has no agent workflow that justifies a dedicated tool. Agents exploring Wikipedia for research or testing can use `wikipedia_search` with broad queries. The Action API has `action=query&list=random` if demand warrants it later.

### Summary vs. article: two tools with a clear contract

The core tension is granularity. Most "what is X?" queries need 2–4 paragraphs, not 30–100KB. Two tools with distinct contracts:

- `wikipedia_get_summary` — REST API `/page/summary/{title}`. Returns the lead section as a clean plain-text extract (already stripped of markup), plus description, thumbnail URL, and Wikidata QID. This is the right tool for 90% of agent lookups. The REST API's summary endpoint is purpose-built for this and returns consistent, clean data.
- `wikipedia_get_article` — Action API `action=query&prop=extracts&explaintext=true`. Returns the full article as plain text (40–100KB for major articles). With `section_index` provided, uses `action=parse&prop=wikitext&section={index}` to return just that section. The full article path exists for agents that genuinely need depth; the section path exists for targeted reads.

This is cleaner than a single `wikipedia_get_article` tool with a `mode` switch — the two tools have meaningfully different call patterns, output sizes, and use cases.

### Content format: plain text throughout

The API can return HTML, wikitext, or plain text. HTML carries citation markup, `<ref>` tags, infobox tables, and edit-section links — useful for rendering but noisy for agent comprehension. Wikitext is raw markup the agent can't easily parse. Plain text (via `explaintext=true` on the Action API, or `extract` from the REST summary) is consistently clean across both APIs.

For `wikipedia_get_article`, the Action API's `exsectionformat=wiki` with `explaintext=true` inserts `== Section Title ==` markers into the plain text, giving the agent section structure without HTML noise.

### Sections: TOC first, then targeted fetch

The idea doc proposed `wikipedia_get_sections` + section ID parameter on `wikipedia_get_article`. This is confirmed correct by the API. The flow:

1. `wikipedia_get_sections` — Action API `action=parse&prop=sections` returns `index` (integer), `number` (e.g. "2.1"), `line` (title), and `level` (heading depth) for every section
2. `wikipedia_get_article` with `section_index` — Action API `action=parse&prop=wikitext&section={index}` returns wikitext for just that section; wikitext stripping is then applied (see below)

**`prop=sections` mitigation:** The Action API notes `prop=sections` is deprecated in favor of `prop=tocdata`, but `tocdata` returned empty `entries: []` for live articles in testing. Chosen mitigation: use `prop=sections` as the primary path, and add a fallback that parses section headers (`== Title ==`) out of the full `action=query&prop=extracts` response if `prop=sections` ever returns empty. This keeps `wikipedia_get_sections` working even if Wikimedia flips the switch on `prop=sections`, without requiring a coordinated server update.

### `wikipedia_get_article`: two distinct code paths

The tool has two meaningfully different implementations sharing one name:

- **Full article** — `action=query&prop=extracts&explaintext=true` (optionally `&exsectionformat=wiki` to preserve `== Section == ` markers). Returns plain text directly — no markup stripping needed. Size: 40–100KB.
- **Section-targeted** — `action=parse&prop=wikitext&section={index}`. Returns raw wikitext for just that section. Wikitext must be stripped before returning (see wikitext stripping below). Size: 1–10KB, much more manageable.

The two paths differ in: which API action is called, whether stripping is needed, and the order-of-magnitude difference in output size. Document both code paths in the handler and in inline comments so maintainers don't assume the full-article path is reused for section reads.

### Wikitext stripping

Section-targeted reads via `action=parse&prop=wikitext` return raw MediaWiki markup. This must be stripped before returning — agents can't use wikitext directly and the markup is noise in LLM context. The stripping pipeline:

1. `[[Link|Display]]` → `Display` (or `Link` when no pipe)
2. `[[File:...]]`, `[[Image:...]]` → removed
3. `{{Template|args}}` → removed (infoboxes, citation templates, formatting templates)
4. `<ref>...</ref>`, `<ref/>` → removed
5. `<nowiki>...</nowiki>` → inner text preserved
6. `'''bold'''`, `''italic''` → inner text preserved
7. `== Section == ` heading markers → preserved as-is (gives structure)
8. HTML comments `<!-- -->` → removed
9. Multiple blank lines → collapsed to single blank line

Implementation: use `wtf_wikipedia` (npm: `wtf-wikipedia`) for the heavy lifting — it handles the recursive template and link grammar correctly. Regex alone is insufficient for nested templates. After `wtf_wikipedia` converts to plain text, apply the heading marker preservation and blank-line normalization as a post-pass. Verify output against real section wikitext from high-traffic articles (Python, United States, World War II) during implementation.

### Disambiguation handling

The REST API summary endpoint returns `"type": "disambiguation"` for disambiguation pages alongside a short extract like "Python may refer to:". This is not an error — surface it in the output schema with a `page_type` field (`"article" | "disambiguation" | "redirect"`). When the agent gets `page_type: "disambiguation"`, it should call `wikipedia_search` with a more specific query. Document this in the tool description.

### Language as a per-call parameter

Multi-language support is one parameter (`language`, default `"en"`) on every tool. This constructs the correct base URL for each call (e.g., `https://fr.wikipedia.org/...`). The alternative — a single global base URL config — forces users to run separate server instances per language, which is worse UX. Per-call language also enables cross-language workflows in a single session.

### Relationship to wikidata-mcp-server

Wikipedia provides prose; Wikidata provides structured facts. The `wikibase_item` field in `wikipedia_get_summary` returns the Wikidata QID (e.g., `Q28865` for Python). This is the bridge — an agent can look up the summary for prose context, then use the QID to query `wikidata-mcp-server` for structured properties without a separate title-to-QID lookup.

### What was cut

- **`wikipedia_get_links`** — outgoing links from an article were in the idea doc. Deferred. The use case ("how are X and Y related?") is better served by `wikipedia_get_article` with section targeting (read the "See also" or related sections) or by Wikidata SPARQL. A raw link dump (Wikipedia articles have hundreds of outgoing links) has poor signal-to-noise for agent use.
- **Media metadata** — `wikipedia_get_media` deferred. No clear agent workflow beyond aesthetic use cases.
- **`wikipedia_random`** — see above.

---

## API Reference

### REST API (`/api/rest_v1/`)

Base: `https://{lang}.wikipedia.org/api/rest_v1/`

| Endpoint | Used by |
|:---------|:--------|
| `GET /page/summary/{title}` | `wikipedia_get_summary` |

Response shape (summary):
```json
{
  "type": "standard | disambiguation | redirect",
  "title": "Python (programming language)",
  "pageid": 23862,
  "wikibase_item": "Q28865",
  "description": "General-purpose programming language",
  "extract": "Python is a high-level...",
  "thumbnail": { "source": "https://...", "width": 330, "height": 330 }
}
```

Error shape: `{ "status": 404, "type": "Internal error" }` — HTTP 404 for missing pages.

### Action API (`/w/api.php`)

Base: `https://{lang}.wikipedia.org/w/api.php`

All requests: `format=json`

| Action + params | Used by |
|:----------------|:--------|
| `action=query&list=search&srsearch={q}&srlimit={n}&srprop=snippet` | `wikipedia_search` |
| `action=query&titles={t}&prop=extracts&explaintext=true&exintro=true` | `wikipedia_get_article` (intro) |
| `action=query&titles={t}&prop=extracts&explaintext=true&exsectionformat=wiki` | `wikipedia_get_article` (full) |
| `action=parse&page={t}&prop=sections` | `wikipedia_get_sections` |
| `action=parse&page={t}&prop=wikitext&section={index}` | `wikipedia_get_article` (section) |
| `action=query&titles={t}&prop=langlinks&lllimit=500` | `wikipedia_get_languages` |
| `action=query&list=geosearch&gscoord={lat}\|{lon}&gsradius={r}&gslimit={n}` | `wikipedia_search_nearby` |

Pagination: Action API uses `continue` objects in the response. Tools that paginate internally (langlinks) should set `lllimit=500` to minimize round-trips. Search and geosearch results are bounded by the `limit` parameter.

Snippet HTML: Search snippets include `<span class="searchmatch">` markup. Strip to plain text before returning. This is reflected in `wikipedia_search`'s output design — snippets are always plain text in the tool response.

### Rate limits and resilience

No enforced rate limits, but:
- Retry on 429 with backoff (1s base, 2 retries max)
- Retry on 503 (Wikimedia occasionally returns 503 under load)
- User-Agent is required — requests without it are deprioritized

---

## Tool Detail

### `wikipedia_search`

**Description:** Full-text search across Wikipedia articles. Returns ranked results with plain-text titles, snippets (search match highlighted terms stripped to plain text), and page IDs. Use when the exact article title is unknown or to discover multiple articles on a topic. The `pageid` values in results can be used to resolve article titles for subsequent calls.

**Input:**
- `query: string` — search query
- `limit?: number` — max results to return (default 10, max 50)
- `language?: string` — Wikipedia language edition code (default `"en"`); constructs the correct base URL per call

**Output:** Array of results, each with `title`, `pageid`, `snippet` (plain text, `<span class="searchmatch">` tags stripped), and `wordcount`. Includes `total_results` count — if the search returned zero results, the response indicates this directly.

**Errors:**
- `no_results` (NotFound) — search returned zero results. Recovery: broaden the query or try different keywords.
- `invalid_language` (InvalidParams) — unrecognized language code. Recovery: use a valid BCP 47 language code (e.g., `"fr"`, `"de"`, `"ja"`).

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_summary`

**Description:** Fetch the lead-section summary for a Wikipedia article — the 2–4 paragraph intro that answers "what is X?". Returns a clean plain-text extract, Wikidata QID (`wikibase_item`) for cross-referencing with `wikidata-mcp-server`, description, and thumbnail URL. Disamb pages return `page_type: "disambiguation"` — not an error, but a signal to call `wikipedia_search` with a more specific query. Redirect pages are followed automatically; `page_type: "redirect"` is returned with the resolved title.

**Input:**
- `title: string` — article title (URL-decoded; e.g., `"Python (programming language)"`)
- `language?: string` — language edition code (default `"en"`)

**Output:** `{ title, page_type, pageid, wikibase_item, description, extract, thumbnail_url }`. `page_type` is one of `"article" | "disambiguation" | "redirect"`. `wikibase_item` is the Wikidata QID (e.g., `"Q28865"`) — use to chain into `wikidata-mcp-server` without a separate title-to-QID lookup.

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search` to find the correct title.
- `invalid_language` (InvalidParams) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_article`

**Description:** Fetch article content as clean plain text. Two code paths depending on whether `section_index` is provided. Without `section_index`: returns the full article via `action=query&prop=extracts&explaintext=true` — 40–100KB for major articles, with `== Section == ` markers preserved for structure. With `section_index` (from `wikipedia_get_sections`): returns just that section via `action=parse&prop=wikitext`, with wikitext markup stripped to plain text. Prefer section targeting when the full article exceeds what is needed.

**Input:**
- `title: string` — article title
- `section_index?: number` — section index from `wikipedia_get_sections`. Omit for the full article.
- `language?: string` — language edition code (default `"en"`)

**Output:** `{ title, pageid, content, section_title?, content_type }`. `content` is always plain text. `content_type` is `"full_article"` or `"section"`. For section reads, `section_title` is included. For full articles, `content` includes `== Section ==` markers.

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search` to find the correct title.
- `invalid_section` (InvalidParams) — `section_index` is out of range. Recovery: call `wikipedia_get_sections` first to obtain valid index values.
- `invalid_language` (InvalidParams) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_sections`

**Description:** Fetch the table of contents for a Wikipedia article. Returns section titles, heading levels, numbering (e.g., "2.1"), and `section_index` values. The `section_index` is the identifier for targeted section reads via `wikipedia_get_article`. Call this before `wikipedia_get_article` when the specific section to read is not known, or to enumerate article structure.

**Input:**
- `title: string` — article title
- `language?: string` — language edition code (default `"en"`)

**Output:** Array of section entries: `{ index, number, title, level }`. `index` is the integer to pass as `section_index` in `wikipedia_get_article`. `level` is heading depth (2 = `==`, 3 = `===`).

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search` to find the correct title.
- `no_sections` (NotFound) — article exists but has no sections (stub or very short article). Recovery: use `wikipedia_get_article` without `section_index` to read the full content.
- `invalid_language` (InvalidParams) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_search_nearby`

**Description:** Find Wikipedia articles about places near a geographic coordinate. Returns articles sorted by distance from the query point, with titles, page IDs, coordinates, and distance in meters. Useful for "what's notable near X?" research workflows. Only articles with geographic coordinates in their Wikidata record are returned.

**Input:**
- `latitude: number` — WGS 84 latitude (−90 to 90)
- `longitude: number` — WGS 84 longitude (−180 to 180)
- `radius_meters?: number` — search radius in meters (default 1000, max 10000)
- `limit?: number` — max results (default 10, max 50)
- `language?: string` — language edition code (default `"en"`)

**Output:** Array of results: `{ title, pageid, latitude, longitude, distance_meters }`, sorted ascending by `distance_meters`. Includes `total_results` count.

**Errors:**
- `no_results` (NotFound) — no geotagged articles within the radius. Recovery: increase `radius_meters` or check that the coordinates are correct.
- `invalid_coordinates` (InvalidParams) — latitude or longitude out of range.
- `invalid_language` (InvalidParams) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_languages`

**Description:** List the language editions available for a Wikipedia article. Returns language codes, the article title in each language, and the full URL. Use for cross-language research or to find a non-English article title before switching language editions. The source article's `language` parameter specifies which edition to query from.

**Input:**
- `title: string` — article title
- `language?: string` — language edition to query from (default `"en"`)

**Output:** Array of language entries: `{ language_code, title, url }`. The source language is not included — only other editions. Includes `total_languages` count.

**Errors:**
- `not_found` (NotFound) — no article exists for the title in the specified language. Recovery: use `wikipedia_search` to find the correct title.
- `no_other_languages` (NotFound) — article exists but has no other language editions. Recovery: the article may be too new or too regional to have been translated yet.
- `invalid_language` (InvalidParams) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

## Known Limitations

- **Article size**: Full plaintext extracts for major articles are 40–100KB. `wikipedia_get_article` without `section_index` returns large payloads — the tool description prominently recommends section targeting when only part of the article is needed.
- **`prop=sections` deprecation**: Mitigated — see Design Decisions. The fallback (parsing `== Title ==` headers from full-article text) keeps `wikipedia_get_sections` functional if `prop=sections` is disabled.
- **REST `related` endpoint**: The `/api/rest_v1/page/related/{title}` endpoint returned empty results during testing. Not used.
- **Disambiguation**: The agent must handle `page_type: "disambiguation"` as a signal to refine the query, not as an error. Surfaced via `page_type` field in `wikipedia_get_summary` output.
