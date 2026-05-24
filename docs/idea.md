# wikipedia-mcp-server

MCP server for querying Wikipedia and other MediaWiki-powered wikis.

## Why

The single most common agent knowledge lookup is "what is X" — encyclopedic prose that contextualizes a topic, explains relationships, summarizes history. Wikidata (already hosted) provides structured triples and SPARQL; Wikipedia provides the human-readable explanations that agents need when reasoning about unfamiliar subjects.

## Source

- **API:** MediaWiki Action API (`api.php`) and REST API (`/api/rest_v1/`)
- **Auth:** None
- **Rate limits:** Polite usage policy — custom User-Agent required, no hard rate limit
- **Docs:** https://www.mediawiki.org/wiki/API:Main_page

## Scope

### Core tools

| Tool | Description |
|---|---|
| `wikipedia_search` | Full-text search across articles — returns titles, snippets, relevance scores |
| `wikipedia_get_summary` | Page summary/extract — lead section prose, thumbnail, coordinates, description |
| `wikipedia_get_article` | Full article content (parsed HTML or wikitext) with section navigation |
| `wikipedia_get_sections` | Table of contents for an article — section titles and IDs for targeted reading |
| `wikipedia_get_links` | Outgoing links, categories, and external links from an article |
| `wikipedia_get_languages` | Available language versions of an article — useful for cross-language lookups |
| `wikipedia_random` | Random article(s) — useful for exploration or testing |

### Potential additions

- **`wikipedia_get_revisions`** — edit history, recent changes to an article
- **`wikipedia_get_media`** — images and media files associated with an article (metadata only, not binary)
- **`wikipedia_search_nearby`** — geospatial search for articles near a coordinate
- Multi-wiki support (Wikiquote, Wiktionary, Wikisource) via configurable base URL

## Design notes

- The REST API (`/api/rest_v1/`) is cleaner for summaries and page content; the Action API (`api.php`) is more flexible for search and metadata queries. Use both as appropriate.
- Article content can be large — provide section-level reading via `wikipedia_get_sections` + section ID parameter on `wikipedia_get_article` to avoid dumping 100KB articles.
- HTML content from the API includes citation markup, infoboxes, and tables. Consider a text-extraction mode that strips to clean prose for agent consumption.
- Complement, don't replace, wikidata-mcp-server. Wikipedia is prose; Wikidata is structured data. Cross-reference via Wikidata QIDs when both are available.

## Prior art

- Existing `mcp-server-ideas/archive/` may have earlier spec stubs
- MediaWiki API is stable and well-documented — low implementation risk
