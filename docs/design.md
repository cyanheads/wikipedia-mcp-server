# wikipedia-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `wikipedia_search_articles` | Full-text search across articles. Returns ranked results with plain-text titles, short descriptions, Wikidata QIDs, snippets, and page IDs, plus Wikipedia's spelling suggestion when it has one. Use when the exact article title is unknown or to find multiple articles on a topic. | `query`, `limit`, `offset`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `empty_query` (ValidationError), `offset_too_large` (ValidationError), `invalid_language` (ValidationError) |
| `wikipedia_get_summary` | Fetch the short summary for an article — a truncated fragment from the start of the lead section, which answers "what is X?". Returns plain-text extract, Wikidata QID for cross-referencing, description, thumbnail URL, canonical article URL, the revision the extract was read from, and — for a geotagged article — coordinates that feed `wikipedia_search_nearby`. Handles disambiguation pages: returns `page_type: "disambiguation"` so the agent can detect and pivot to a more specific search. | `title`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_title` (ValidationError), `invalid_language` (ValidationError) |
| `wikipedia_get_article` | Fetch article content as clean plain text, with the canonical URL and the revision it was read from. Full-article path uses `action=query&prop=extracts\|info\|revisions` — TextExtracts' HTML mode rendered to plain text (40–100KB for major articles). Section-targeted path uses `action=parse&prop=text\|revid&section={index}`, rendering the parser's HTML for that section to plain text — use `section_index` (from `wikipedia_get_sections`) to retrieve a single section and its subsections, or `section_index: 0` for the lead. Prefer section targeting when only part of the article is needed. | `title`, `section_index`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_title` (ValidationError), `invalid_section` (ValidationError), `invalid_language` (ValidationError) |
| `wikipedia_get_sections` | Fetch the table of contents for an article — section titles, numbers, levels, and `section_index` values, led by the index-0 `Introduction` entry for the lead. Call this before `wikipedia_get_article` when only a specific section is needed. The returned `section_index` values are the identifiers for targeted section reads. | `title`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_title` (ValidationError), `no_sections` (NotFound), `invalid_language` (ValidationError) |
| `wikipedia_search_nearby` | Find Wikipedia articles about places near a geographic coordinate. Returns articles within a radius, sorted by distance, with short descriptions and Wikidata QIDs. Useful for "what's notable near X?" research. | `latitude`, `longitude`, `radius_meters`, `limit`, `language` | `readOnlyHint: true`, `openWorldHint: true` | `invalid_coordinates` (ValidationError), `invalid_language` (ValidationError) |
| `wikipedia_get_languages` | List the language editions available for an article. Returns each edition's language code, tool-usable subdomain code, article title, and URL. Pass `editions` to narrow the list to specific codes; unmatched ones come back under `missing`. Use for cross-language research or to find a non-English article title for a known concept. | `title`, `language`, `editions` | `readOnlyHint: true`, `openWorldHint: true` | `not_found` (NotFound), `invalid_title` (ValidationError), `no_other_languages` (NotFound), `invalid_language` (ValidationError) |

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
- Single-instance base-URL override (`WIKIPEDIA_BASE_URL`): unset, the host is composed per call from `language`; set, every call routes at one fixed host — a private mirror or an alternate MediaWiki instance. Selecting a WMF sibling project (Wikiquote, Wiktionary) per call remains out of scope

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WikipediaService` | MediaWiki REST API + Action API | All tools |

Single service — both APIs share the same base host and User-Agent; one client handles both. Two fetch methods internally: `restGet(path)` for REST API calls and `actionGet(params)` for Action API calls.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `WIKIPEDIA_BASE_URL` | No | Optional single-instance override. Unset (default): compose per-language hosts and let per-call `language` select the edition. Set to a full base URL (e.g. a private MediaWiki mirror) to route every call at that one fixed host — `language` no longer varies the host. |
| `WIKIPEDIA_USER_AGENT` | No | Override the User-Agent string. Defaults to a reasonable `wikipedia-mcp-server/VERSION (https://github.com/cyanheads/wikipedia-mcp-server)` value. |

No API key needed. By default, language is a per-call parameter on every tool (defaults to `en`), so one instance serves every edition; setting `WIKIPEDIA_BASE_URL` pins all calls to a single host for mirror or alternate-instance deployments.

## Implementation Order

1. `WikipediaService` — `restGet` + `actionGet` with retry/backoff, User-Agent header
2. HTML-to-plain-text utility (`htmlSectionToPlainText`) — renders the parser's section HTML, the HTML-mode full-article extract, and the summary's `extract_html` to plain text with headings kept inline; verify against real upstream HTML before proceeding
3. `wikipedia_get_summary` — REST API `/page/summary/{title}`, core "what is X?" tool
4. `wikipedia_search_articles` — Action API `action=query&list=search`, strip snippet HTML before returning; a best-effort `pageids=` follow-up adds each result's description and QID
5. `wikipedia_get_sections` — Action API `action=parse&prop=tocdata` (`line` rendered to plain text) with `== Title ==` fallback
6. `wikipedia_get_article` — full-article path (`action=query&prop=extracts`) and section path (`action=parse&prop=text` rendered to plain text)
7. `wikipedia_get_languages` — Action API `action=query&prop=langlinks`
8. `wikipedia_search_nearby` — Action API `action=query&list=geosearch`, with the same geosearch as a generator in the same request for descriptions and QIDs

Each step is independently testable.

---

## Design Decisions

### Tool count: 6 instead of 7

The idea doc proposed `wikipedia_random`. Deferred — random article retrieval has no agent workflow that justifies a dedicated tool. Agents exploring Wikipedia for research or testing can use `wikipedia_search_articles` with broad queries. The Action API has `action=query&list=random` if demand warrants it later.

### Summary vs. article: two tools with a clear contract

The core tension is granularity. Most "what is X?" queries need 2–4 paragraphs, not 30–100KB. Two tools with distinct contracts:

- `wikipedia_get_summary` — REST API `/page/summary/{title}`. Returns the start of the lead section as a plain-text extract rendered from the response's `extract_html`, plus description, thumbnail URL, and Wikidata QID. This is the right tool for 90% of agent lookups. The REST API's summary endpoint is purpose-built for this and returns consistent, clean data.
- `wikipedia_get_article` — Action API `action=query&prop=extracts|info|revisions`. Returns the full article as plain text rendered from TextExtracts' HTML mode (40–100KB for major articles). With `section_index` provided, uses `action=parse&prop=text|revid&section={index}` and renders the parser's HTML for that section to plain text. The full article path exists for agents that genuinely need depth; the section path exists for targeted reads.

This is cleaner than a single `wikipedia_get_article` tool with a `mode` switch — the two tools have meaningfully different call patterns, output sizes, and use cases.

### Content format: plain text throughout

The API can return HTML, wikitext, or plain text. HTML carries citation markup, `<ref>` tags, infobox tables, and edit-section links — useful for rendering but noisy for agent comprehension. Wikitext is raw markup the agent can't easily parse. Every tool therefore returns plain text — but every read path fetches HTML and renders it to plain text itself, through one renderer (`htmlSectionToPlainText`), rather than taking the upstream plain-text form.

Upstream plain text was used first — `explaintext=true` on the full-article extract, the REST summary's `extract` — and dropped because it flattens markup that carries meaning: a superscript joins the digits beside it, so `6.02214076×10<sup>23</sup>` read as `6.02214076×1023`, `1.496×10⁸ km` as `1.496×108 km`, and `O(n²)` as `O(n2)`, with nothing marking the change. The HTML forms of the same responses keep it:

- **Full article:** `prop=extracts` without `explaintext` is TextExtracts' HTML mode. It strips the same infoboxes, tables, and navboxes the plain-text mode does, so across `United States`, `Python (programming language)`, `Avogadro constant`, `Sun`, `Quicksort`, and `Limit of a function` the rendered text splits into exactly the sections, in the same order, that the `explaintext` form did, and on `Sun` and `United States` a word-level diff against it differs only in superscripts. Headings arrive as bare `<hN>` and render to the `== Heading ==` markers the section split and the overflow outline read. Two things beyond superscripts change for the better: a `<pre>` sample, which `explaintext` passed through as unfenced lines, arrives fenced; and a formula, which `explaintext` rendered as a column of one MathML glyph per line followed by its TeX, arrives once, as its TeX (from the `<math alttext>`).
- **Summary:** the REST `extract_html` sits beside `extract` in the same response. Rendering it also keeps a disambiguation page's list apart from the sentence introducing it, which `extract` runs together (`refers to:Mercury (planet)`). The plain `extract` still decides whether there is readable content, and stands in when a payload carries no `extract_html`.

TextExtracts warns that its HTML "may be malformed and/or unbalanced". This server requests no `exchars`/`exsentences` truncation, and every full extract sampled was balanced; the renderer is still held to losing no text after an unclosed tag. An unclosed `<sup>` cannot reach past a block tag to a later `</sup>`, which would otherwise fold a heading into a superscript and drop it from the section split, and an unclosed `<math>` cannot reach past the next formula.

Whitespace normalization folds no-break spaces into ordinary ones, on the summary as on every other path, so `12 grams` reads with a plain space.

### Upstream text is escaped at the render boundary, not in the payload

Plain text is not inert text: an article about markup delivers literal `<script>` and an article about markdown delivers literal `_word_`, and every `format()` interpolates that into the markdown it builds for `content[]`. A client rendering that markdown then interprets it — tags become elements a sanitizer may drop, emphasis syntax italicizes the word it describes, and a line beginning `#`, `>`, `-`, or `1.` becomes a heading, quote, or list item.

A single helper (`src/mcp-server/tools/utils/escape-markdown.ts`) backslash-escapes the markdown-active set — `` \ ` * _ [ ] < > & # | ~ `` inline, plus line-leading bullet and ordered-list markers — and every `format()` runs its upstream-sourced strings through it. Three decisions hold it in place:

- **CommonMark escapes, not HTML entities.** `content[]` is read raw by a model far more often than it is rendered, and `\<script\>` stays legible raw while rendering as the literal characters; `&lt;script&gt;` is noise on both surfaces.
- **The render path only.** `structuredContent` carries the text exactly as the API returned it. The two surfaces disagree byte-for-byte on purpose — one is data, the other is a rendering of it.
- **URLs and edition codes are left alone.** A URL is not prose and escaping it breaks the link; edition codes render inside code spans, which suppress markdown on their own.

Line-leading `=` is deliberately not escaped: a line of only `=` would underline the paragraph above it as a heading, but the `== Heading ==` markers the article path emits are far more common and escaping them would mangle every one.

**The article renderer's own syntax is exempt, by one shared grammar.** The renderer writes two constructs whose syntax is load-bearing — a code sample as a backtick fence, on every read path, and a data table as pipe rows, on a section read (see [Section reads render parser HTML, not wikitext](#section-reads-render-parser-html-not-wikitext)) — and escaping them as prose turns `n < 0` into `n \< 0` and every `|` into `\|`. The `format()` of `wikipedia_get_article` and of `wikipedia_get_summary`, whose extract comes from the same renderer, therefore runs `escapeMarkdownOutsideBlocks`, which reads the text back through the same module that wrote it (`src/services/wikipedia/text-blocks.ts`) and exempts exactly two things: a code block, raw, and a table row's ` | ` delimiters, with every cell escaped inline. Decisions:

- **The fence and the rows live in `structuredContent` too.** `format()` receives only the schema-parsed output, so any boundary it needs must be in `content` itself; a fence and a pipe row are boundaries a raw reader and a markdown client read the same way, where offsets or private markers would be noise on one surface or unavailable on the other.
- **Only what CommonMark renders literally goes unescaped.** A code block is recognized only as a bare opening fence plus the first closing line CommonMark itself accepts, and a fence is one backtick longer than any run inside it, so code cannot close its own block. An unclosed fence reads as prose and its backticks are escaped. Prose shaped like a fence or a row can make text render as code or as a table, but never unescaped outside a code block: cells are always escaped.
- **Cells escape inline only.** A cell never starts a line, so the line-leading list-marker rule would only corrupt data — `49.80%` came out as `49\.80%` in field testing before this rule.

### Sections: TOC first, then targeted fetch

The idea doc proposed `wikipedia_get_sections` + section ID parameter on `wikipedia_get_article`. This is confirmed correct by the API. The flow:

1. `wikipedia_get_sections` — Action API `action=parse&prop=tocdata` returns `index`, `number` (e.g. "2.1"), `line` (the heading as rendered HTML), and `hLevel` (heading depth) for every section; `line` is stripped to plain text and whitespace-folded so it matches the `section_title` the article path reports for the same index
2. `wikipedia_get_article` with `section_index` — Action API `action=parse&prop=text&section={index}` returns the parser's HTML for just that section and its subsections; it is rendered to plain text before returning (see [Section reads render parser HTML, not wikitext](#section-reads-render-parser-html-not-wikitext))

**`prop=tocdata` and the fallback:** `prop=sections` is deprecated in favor of `prop=tocdata`, which the service reads (same data, renamed and re-nested fields). A fallback parses section headers (`== Title ==`) out of the full `action=query&prop=extracts` response whenever `tocdata` returns no sections, so `wikipedia_get_sections` keeps working for an article the parser reports no table of contents for.

### `wikipedia_get_article`: two distinct code paths

The tool has two meaningfully different implementations sharing one name:

- **Full article** — `action=query&prop=extracts|info|revisions&inprop=url&rvprop=ids|timestamp`. Returns TextExtracts' HTML-mode extract, rendered to plain text with `== Section ==` markers (see [Content format](#content-format-plain-text-throughout)), plus the citation fields below. Size: 40–100KB.
- **Section-targeted** — `action=parse&prop=text|revid&section={index}`. Returns the parser's HTML for that section and every subsection under it, converted to plain text before returning (see [Section reads render parser HTML, not wikitext](#section-reads-render-parser-html-not-wikitext)). Size: 1–15KB, much more manageable.

The two paths differ in: which API action is called, what their HTML carries (the extract has no tables or infoboxes), and the order-of-magnitude difference in output size. Both share the renderer. Document both code paths in the handler and in inline comments so maintainers don't assume the full-article path is reused for section reads.

### Article reads carry their citation fields

`wikipedia_get_article` returns optional `url`, `revision_id`, and `last_modified` — the names and descriptions `wikipedia_get_summary` uses — so text an agent quotes can be cited to the revision it was read from. Borrowing them from a summary call costs a second request that can land on a newer revision than the text. The fields render in `format()` and ride the overflow outline too, which describes the same revision.

- **Full reads add `info|revisions` to the existing request**, one round trip: `fullurl` → `url`, `revisions[0].revid` → `revision_id`, `revisions[0].timestamp` → `last_modified`. The timestamp is the revision's own, never `prop=info`'s `touched`, which is the page's cache-invalidation time and moves without an edit — on `Quicksort` it ran 12 days past the revision timestamp the summary reports.
- **Section reads add `revid` to `prop`** and compose `url`. `action=parse` has no URL or timestamp prop, and a second request is not worth `last_modified`, so a section read carries none. The URL is built from `parse.title` — the redirect-resolved title — with MediaWiki's own title encoding (`wfUrlencode`: `; @ $ ! * ( ) , / ~ :` literal, `'` escaped), so it is byte-identical to the `fullurl` a full read reports; unit cases pin it against live `fullurl` values for titles carrying `/`, `:`, `?`, `&`, `+`, `=`, `%`, `'`, and non-ASCII. This is not the raw title-plus-language composition rejected for the summary's `url`, which misencodes titles and guesses edition hosts: the title is the one MediaWiki resolved, and the host is the one the request already resolved through the edition registry.
- **Under `WIKIPEDIA_BASE_URL` a section read omits `url`.** A mirror's article path is not necessarily `/wiki/`, so composing one would guess; the full read's `fullurl` comes from the mirror itself and is kept.
- **Redirects report the target.** Both requests follow redirects, so `NYC` cites `New_York_City` at its revision.

### Wikitext stripping

> Superseded — see [Section reads render parser HTML, not wikitext](#section-reads-render-parser-html-not-wikitext). The wikitext pipeline below is the original design and no longer describes the implementation; it is kept for the reasoning that led there.

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

### Section reads render parser HTML, not wikitext

Section-targeted reads call `action=parse&prop=text&section={index}` and convert the parser's HTML for that section to plain text. This replaces the wikitext pipeline above, and the `wtf_wikipedia` dependency with it.

Two properties of the wikitext approach could not be fixed in place:

- **Templates.** A stripper outside the parser has to re-implement the template grammar, and drops what it cannot expand. Inline `{{code}}`/`{{mono}}` templates stripped to empty strings, rendering "The  statement, which conditionally executes a block of code, along with   and   (a contraction of  )". The parser expands templates before this server sees the content, so the same sentence arrives whole.
- **Heading placement.** Wikitext stripping removed headings, so they were re-injected as one block at the top — asserting a structure the undifferentiated prose below did not have. HTML carries each heading inline with its own body, so document order is preserved without reconstruction.

Two alternatives were measured against the live API and rejected:

- **Slicing the full-article extract at heading _N_.** Attractive because the extract already renders both correctly, but the index space does not survive: `prop=extracts` drops sections whose body is entirely citation-template lists, heading and all. On `Barack Obama` the extract carries 46 headings against tocdata's 49 (the missing three are `Bibliography`'s `Books`, `Audiobooks`, and `Articles`), so every index from 36 up would resolve to the wrong section — silently, with plausible content. `Winston Churchill` and `Pacific Ocean` each drop one the same way. Positional counting held on the other 86 of 89 articles sampled, which is what makes the failure dangerous rather than obvious.
- **Slicing the extract but resolving the target heading through tocdata instead of by position.** Fixes the count drift for headings the extract does carry, but a section the extract omits entirely has nothing to resolve to, so indices that work today would start failing.

Keeping `action=parse&section={index}` avoids the question: the index space, the "section plus all of its subsections" scope, and the out-of-range `nosuchsection` error are all the endpoint's own behavior and are unchanged. Only the rendering moved.

Six rendering conventions are deliberate:

- **Layout tables render as prose, data tables and infoboxes as rows, and the remaining tables and figures are dropped.** The original rule dropped every `<table>`, matching what the full-article extract path does, so that both paths rendered the same article the same way. That symmetry cost real content: MediaWiki also emits `<table>` for pure layout — `{{col-begin}}` and friends wrap ordinary `<ul>`/`<p>` content in one to arrange it in columns — so `Taylor Swift` / `Discography` came back as its heading plus a hatnote, 134 bytes against 526 with the lists kept, and the same shape emptied Filmography, Bibliography, and Works sections. A user-facing content regression outranks the symmetry preference, so a table marked `role="presentation"` — the parser's own discriminator for layout, which tracks new layout templates without a hand-maintained class list — is kept and its `<tbody>`/`<tr>`/`<td>` shell rendered as block boundaries. Maintenance banners are the one exception among layout tables — the ambox family is `role="presentation"` plus `class="metadata"`, MediaWiki's marker for page furniture, so the class is what separates a table wrapping article prose from one wrapping an editor notice about the article.

  Data tables were dropped whole at first, because cell-by-cell prose loses the row and column relationship that makes them data. That made results, statistics, and "key facts" sections come back as a heading and a sentence with nothing saying a table had been there — `2024 United States presidential election` §55 returned 288 bytes and §56 226, where the rendered tables carry every candidate's and every state's totals. An omission the caller cannot see is a wrong answer, so data tables now render in a shape that keeps the relationship:
  - **`wikitable` → pipe rows.** The first non-empty row, a `| --- |` delimiter row, then the rest, one line per `<tr>` — a GFM table in `content[]` and an unambiguous grid in `structuredContent`. A `rowspan` cell repeats down every row it covers, so each row reads on its own. A `colspan` cell repeats across its columns only in a header row, where it names every column it heads (`Popular vote` over `Count` and `Percentage`); in a body row it fills its first column and leaves the rest blank, so a note spanning the table appears once. A header cell alone on its row heads no columns — it is a title or a group label (`Group A`) — so it is written once too; repeated, it filled 8 of 674 rows in a live sample with one phrase per column. A caption becomes a line above the rows; a cell's `|` is written `\|`.
  - **`infobox` → `label: value` lines.** A header cell labels the data cells beside it; a title, section header, or full-width value is a line of its own. A label's own trailing colon is dropped, so Spanish taxoboxes read `Reino: Animalia`, not `Reino:: Animalia`. Two kinds of infobox line are chrome and dropped on any tag, by whole class token: an image or map caption (`infobox-caption`, English "Seen from the Champ de Mars, 2009"), which describes a picture the text cannot carry, as a `figure` caption does; and the edit links an infobox closes with — `Module:Navbar`'s `navbar` (English "view · talk · edit", French "modifier · modifier le code · modifier Wikidata") and Spanish `wikidata-link` ("[editar datos en Wikidata]"). The token match is whole because the title a navbar sits beside is `navbar-ct-mini`. `noprint` was measured and rejected as the discriminator: inside infoboxes it also marks an age, a date's "137 years ago", and German coordinates.
  - **Class tokens decide, and the layout role outranks them.** A standalone succession box is `role="presentation" class="wikitable succession-box"` and stays layout prose. Navboxes, sidebars, and unclassed chart tables (the bar boxes beside a results table picture numbers its data table already carries) are still dropped silently, as are furniture, hidden elements, and footnote markers inside a rendered table's cells.
  - **A table nested in a data cell is flattened into that cell**, with each line, list item, or nested row joined by `; `, so its rows cannot leak into the outer grid. Code in a cell is flattened the same way: a row is one line and cannot hold a fence.
  - **A per-table cap of 40,000 bytes, then a `[table omitted: N rows]` marker.** Measured on rendered tables: results and statistics tables run 1–5 KB, the election's per-state results 12 KB, the chemical elements 15 KB, the Nobel physics laureates 37 KB — all kept — and the 500-row S&P 500 roster 64 KB, replaced by the marker. At half the default 80 KB full-article budget, one table never outweighs what a whole article may carry, and the marker keeps the gap visible.

  The full-article path is unaffected: TextExtracts strips every table upstream in HTML mode as in plain-text mode, so a section read is the only way to reach table data.
- **Furniture boxes and bars are dropped on any tag, but the `metadata` marker alone does not select them.** The marker was originally tested only on `<table>`, so the `{{Side box}}` family — `{{Library resources box}}`, `{{Sister project links}}`, `{{Portal}}` — reached the caller as prose, because it is a `<div>`. Applying the test to every tag instead was measured against `action=parse&prop=text` for 46 articles across 12 editions (long and short, biography, science, geography, list-heavy, math-heavy): 144 elements carry `metadata`, and 47 of them are content. French Wikipedia's `{{Article détaillé}}`, the counterpart of English Wikipedia's `{{Main}}`, is `<div class="bandeau-container bandeau-section metadata bandeau-niveau-information">`, and `fr:Paris` alone carries 46 of those against 7 maintenance banners of the same shape — so a tag-agnostic `metadata` rule deletes several times more content than furniture on that edition, silently. What the furniture has in common instead is that the marker sits on a self-contained box or bar rather than on an inline pointer, so the rule pairs `metadata` with either a container class (`side-box`, `ambox`) or `role="navigation"` (`{{Portal bar}}`, `{{Sister bar}}`, the sister-project boxes). Pairing is also what keeps `{{Listen}}`, a `side-box` *without* the marker whose captions describe a recording in the article's own voice. Two other discriminators were measured and rejected: `noprint`, which MediaWiki puts on hatnotes across the Spanish, Italian, German, and Hebrew editions (108 of them in four articles), and the class-token exemption list an "every `metadata` element except hatnotes" rule needs, which only works where an edition happens to mark its pointers `hatnote` — French Wikipedia's does not. Known remaining leak: French maintenance banners, which are not separable from French hatnotes without enumerating that edition's `bandeau-niveau-*` levels. `{{Spoken Wikipedia}}` carries neither `metadata` nor `side-box` and needs its own entry; its body is a duration, the revision date the recording was read from, and a disclaimer that later edits are not reflected, none of which is reachable as audio from plain text.
- **Preview warnings are dropped (`div.preview-warning`).** `action=parse` renders a section as an edit preview, so templates emit editor-only notices that the saved page never shows. Settlement infoboxes emit several per lead: "Preview warning: Page using Template:Infobox settlement with deprecated parameter settlement_type".
- **A formula renders once, as its TeX.** A section read carries it twice — a hidden MathML twin and a fallback `<img>` whose `alt` is the TeX (next rule); the full-article extract carries only a visible `<math>`, whose `alttext` is the same TeX. Both carriers are lifted before anything else runs. The `<math>` open tag is matched attribute by attribute because the TeX in `alttext` holds a literal `>` (`\varepsilon >0`), which ends a naive open-tag match mid-attribute and spills the rest of the formula into the text.
- **Elements the page hides are dropped, judged from `display:none` in an inline style rather than a class list.** Tag stripping alone kept the text of markup MediaWiki never renders. The Math extension emits a screen-reader MathML twin behind `display:none`, so every formula rendered twice — once as a column of one glyph per source line, then again as the `{\displaystyle …}` TeX from the twin's `<annotation>`; `{{calculator}}` gadgets are hidden until their script runs, so button labels and widget state landed mid-section. The general rule was chosen over enumerating gadget class names because the hiding is what the shapes have in common and new gadgets would each need an entry. Since the TeX lived only inside the twin, the formula is recovered from `img.mwe-math-fallback-image-*`'s `alt` before anything is dropped.
- **`<pre>` blocks become fenced code blocks that keep their line breaks and indentation**, on the full-article path too, whose HTML extract carries them. In a code sample indentation is syntax; an unindented Python listing reads as valid code and is not, which is worse than omitting it. The fence is what lets `content[]` carry the code unescaped (see [Upstream text is escaped at the render boundary](#upstream-text-is-escaped-at-the-render-boundary-not-in-the-payload)); without it, `Quicksort` §3's pseudocode reached markdown readers as `A\[hi\]` and `\<=`.
- **Superscripts and subscripts stay distinct from the digits beside them**, on every read path — the full-article and summary paths render their HTML through this renderer for exactly this (see [Content format](#content-format-plain-text-throughout)). Flattened, `6.02214076×10²³` read as `6.02214076×1023`. A script whose every character has a Unicode form in general-purpose fonts (digits, `+ − = ( )`, and superscript `n`/`i`) becomes those characters — `10²³`, `mol⁻¹`, `H₂O` — which read correctly raw, rendered, and to a model. Anything else is marked the way plain-text math writes it: `^` or `_`, parenthesized past one character (`e^x`, `19^(th)`, `N_A`). A bracketed or letterless superscript (`[citation needed]`, `†`, the `ⓘ` pronunciation link) is a marker, not an exponent, and keeps its text as written. A nested script renders from the inside out, so `e<sup>−t<sup>2</sup></sup>` reads `e^(−t²)` rather than `e^(−t2)`. `sup.reference` footnote markers are still dropped whole before this rule runs.

  **A script inside an `<abbr>` keeps its text joined**, the way its edition writes it in plain text. French Wikipedia wraps its ordinals and abbreviations in `<abbr>` (`{{s|XIX}}`, `{{1er}}`, `{{Mme}}`, `{{n°}}`), and marked they read `XIX^e`, `1^(er)`, `M^(me)` — noise, and in headings too. On a random draw of 150 articles across English, French, Italian, Spanish, and German plus 27 math-, science-, and table-heavy ones, those were 490 of the 662 marks the renderer wrote; with the rule, 176 marks remain, 4 of them French ordinals written without `<abbr>`, and every English mark is an exponent or an index (`e^x`, `N_A`, `t_(1/2)`). Of the 554 letter-only French superscripts in the draw, 550 sat inside `<abbr>`. The alternative rules were rejected on the same draw: joining a letter-only superscript after a digit or a Roman numeral also joins `O(2<sup>K</sup>)` and the vector space `C<sup>k</sup>`, and joining one after a letter joins `e<sup>x</sup>` — exponents a reader could no longer tell from a product.

Blocks the prose passes must not touch — a fenced sample, a rendered table — are parked behind a `U+FFFF`-delimited index and restored after whitespace normalization. Entity decoding refuses to produce `U+FFFF` from a numeric reference, so article text cannot rebuild a placeholder and pull a parked block into a sentence.

### The lead section is index 0, listed and named

`action=parse&prop=text&section=0` renders the lead — the text above the first heading — like any other section, so the lead is read through the same path as everything else rather than through a second mechanism. Three consequences are deliberate:

- **`wikipedia_get_sections` lists it** as `{ index: 0, number: "0", title: "Introduction", level: 1 }`, ahead of the upstream table of contents, which starts at the first heading. Without the row, the section agents most often want is the one section the table of contents never names, and the two tools disagree about whether index 0 exists. The entry is added in the handler rather than the service so `no_sections` keeps meaning "no headed sections" — upstream's own table of contents is what that judges.
- **The lead's `section_title` is fixed to `Introduction`**, the label `splitArticleIntoSections` already prints in the overflow outline. The positional `Section 0` fallback named something no other surface reports, and a template-emitted heading inside a lead must not rename it either.
- **The overflow notice names `section_index 0`**, so an agent holding only the outline can reach the `Introduction` entry it lists.

Bounds on `section_index` (`int`, `≥ 0`) live on the Zod field rather than in the handler: they advertise themselves in `inputSchema`, and a schema rejection and a handler `ctx.fail` cannot both own the same bound — the schema wins, leaving the contract entry unreachable while still reading as covered. `invalid_section` stays for the out-of-range index only upstream can judge.

### Title validation at the handler edge, covering MediaWiki's whole page-name rule

A title MediaWiki cannot name a page with is refused before any network call, by a shared `isInvalidTitle` guard alongside `isBlankTitle`, on all four title-taking tools. The upstream shapes disagree — `invalid: true` on `action=query`, `invalidtitle` on `action=parse`, 403 or 500 on REST — and `|` produces no error at all, because it separates titles in the `titles` parameter and silently returns a different article. One pre-fetch check normalizes all four.

Three decisions inside it:

- **Coverage is the whole rule, not the characters that motivated it.** `%XX`, three or more tildes, and relative paths are `invalid: true` upstream exactly as `A<B` is; excluding them would leave the same wrong answer in place for `A%41B` and `./Cat`. A bare `%`, `~~`, `_`, `+`, and a leading `:` all name real pages and are admitted.
- **`#` is admitted.** MediaWiki strips the fragment before resolving, so `Python (programming language)#History` resolves on every read path; rejecting it would be a regression. Nothing strips it server-side — passing it through is what already works.
- **The constraint is not on the Zod `title` field.** A regex admitting `#`, a bare `%`, `_`, `+`, and a leading `:` while rejecting `%XX`, `~~~`, and relative paths is unreadable, and a schema rejection carries no `data.reason` and no recovery hint — so the contract entry that would document it could never fire. A declared `invalid_title` reason (ValidationError) on all four tools carries both, and `.describe()` states the rule so it is still visible before the call. `invalid_title` rather than the existing `not_found` because the two need different recoveries: a search for the right title, versus the title being unnameable at all.

The service also recognizes the shapes for callers that reach it directly: an `invalid: true` page entry in `getArticleFull`/`getLanguages` (the entry carries no `missing` key, so a `missing !== undefined` test read it as an existing, empty article) and the `invalidtitle` code on both parse paths.

### Search: refusals are failures, and the window is disclosed

`WikipediaService.search` reads the `error` envelope before the payload, so an upstream refusal fails the call instead of returning `totalCount: 0` in a success envelope. The four sibling Action API call sites (`getArticleFull`, `getLanguages`, `searchNearby`, `fetchEditionIndex`) read it the same way — the envelope is what those endpoints return, and leaving them unreconciled means the next input shape that slips past a handler guard reproduces the bug on a different tool.

- **An empty `query` and an `offset` at or past the window are refused at the handler edge**, with declared `empty_query` and `offset_too_large` reasons, before the fetch that would be refused anyway. A whitespace-only query is not in that class: `srsearch=%20` is a legitimate search that matches nothing, and rejecting it would be a regression. `offset_too_large`'s recovery says to narrow the query, not to page back — paging back is what the old end-of-results notice wrongly advised, and no offset reaches past the window.
- **A page ending at the window discloses it** through `ctx.enrich.truncated({ shown, cap: 10000 })` plus a notice naming the matches no offset reaches. The condition is `offset + shown >= 10000` with `totalCount` still higher; below the window nothing changes, so an ordinary page and a genuine last page are untouched. `truncated` and `cap` are optional enrichment fields, absent unless the window cut the page.
- **`limit` carries `.max(50)`**, so the advertised schema matches the cap the server enforces. This turns a silent clamp into a rejection for a caller passing a larger value. 50 is this server's page size, not an upstream ceiling — `action=paraminfo` reports `limit.max: 500` for an anonymous caller.
- **The spelling suggestion is surfaced, never applied.** `srinfo` already requests CirrusSearch's `suggestion` on every page, so it rides as optional enrichment whenever upstream sends one, and a zero-hit first page names it in the notice. Re-running with it server-side was rejected: it swaps the caller's query without asking, and the suggestion is sometimes partial.

### Search and nearby results carry a description and a Wikidata QID

A bare title list forced a `wikipedia_get_summary` call per result to tell same-named articles apart; each result now carries the short `description` and `wikibase_item`, the field names `wikipedia_get_summary` already uses. Both are absent when upstream has none — including an explicitly-empty short description, which the API returns as `""`.

- **Search uses a best-effort `pageids=` follow-up.** `list=search` cannot return page props, and `generator=search` drops `snippet` and `wordcount`. Running `list=search` and `generator=search` together in one request was measured and rejected: CirrusSearch runs the query twice, costing about what the follow-up does, and the two runs can rank different page sets, leaving some results bare (at 50 results, `python` and `river delta` each differ by a page). The follow-up is one request per page (`pageids` takes 50 values anonymously, matching the page cap), merged by pageid so the search ranking survives, skipped on an empty page, and given one 5 s attempt with no retries; it adds ≈200 ms to a search. A failure returns the results without the two fields and a notice segment — never a failed search — while a caller cancellation during it propagates like any other.
- **Nearby runs the same geosearch as a generator in the same request.** `list=geosearch` stays the source of the result set, its order, coordinates, and distances; `generator=geosearch` with identical parameters adds each page's props, merged by pageid. The generator alone was measured as the one-query alternative and rejected: it answers in pageid order, its `coordinates` prop rounds to eight decimals and needs `colimit=max` to report distances past the tenth page, and re-sorting by distance reorders equal-distance ties — near the Eiffel Tower at `limit: 10`, three articles tie at 365.7 m on the cap boundary, and the re-sorted generator keeps a different one than the list does. The price is the geosearch running twice upstream: ≈150 ms more at `limit: 10`, ≈300 ms more at 500.
- **Coordinates come from the article's own GeoData tag**, not Wikidata's P625, and the tool description says so. The description is what exposes a wrong tag: `Palazzo Bernardo Nani`, a Venice palace, appears 161 m from the Eiffel Tower.

At `limit: 500` — the ceiling — nearby's truncation notice drops the "raise limit" advice and points only to narrower sweeps; `truncated` is still `true` on a full page there, because no probe past the cap is possible.

### Disambiguation handling

The REST API summary endpoint returns `"type": "disambiguation"` for disambiguation pages alongside a short extract like "Python may refer to:". This is not an error — surface it in the output schema with a `page_type` field (`"article" | "disambiguation" | "redirect"`). When the agent gets `page_type: "disambiguation"`, it should call `wikipedia_search_articles` with a more specific query. Document this in the tool description.

### Language as a per-call parameter

Multi-language support is one parameter (`language`, default `"en"`) on every tool. By default this constructs the correct base URL for each call (e.g., `https://fr.wikipedia.org/...`), so one instance serves every edition and cross-language workflows run in a single session. A single global base URL is available as an opt-in (`WIKIPEDIA_BASE_URL`) for deployments that must pin all traffic to one host — a private mirror or an alternate MediaWiki instance — at the cost of per-call language selection; it is deliberately not the default.

### Relationship to wikidata-mcp-server

Wikipedia provides prose; Wikidata provides structured facts. The `wikibase_item` field in `wikipedia_get_summary`, and on each `wikipedia_search_articles` and `wikipedia_search_nearby` result, returns the Wikidata QID (e.g., `Q28865` for Python). This is the bridge — an agent can look up the summary for prose context, then use the QID to query `wikidata-mcp-server` for structured properties without a separate title-to-QID lookup.

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
  "extract_html": "<p><b>Python</b> is a high-level...</p>",
  "thumbnail": { "source": "https://...", "width": 330, "height": 330 }
}
```

Error shape: `{ "status": 404, "type": "Internal error" }` — HTTP 404 for missing pages.

### Action API (`/w/api.php`)

Base: `https://{lang}.wikipedia.org/w/api.php`

All requests: `format=json`

| Action + params | Used by |
|:----------------|:--------|
| `action=query&list=search&srsearch={q}&srlimit={n}&sroffset={o}&srprop=snippet\|wordcount` | `wikipedia_search_articles` |
| `action=query&pageids={id\|…}&prop=description\|pageprops&ppprop=wikibase_item` | `wikipedia_search_articles` (best-effort description + QID follow-up) |
| `action=query&titles={t}&prop=extracts\|info\|revisions&inprop=url&rvprop=ids\|timestamp&redirects=true` | `wikipedia_get_article` (full), and the heading fallback of `wikipedia_get_sections` |
| `action=parse&page={t}&prop=tocdata` | `wikipedia_get_sections` |
| `action=parse&page={t}&prop=text\|revid&section={index}` | `wikipedia_get_article` (section) |
| `action=query&titles={t}&prop=langlinks&lllimit=500` | `wikipedia_get_languages` |
| `action=query&list=geosearch&gscoord={lat}\|{lon}&gsradius={r}&gslimit={n}&generator=geosearch&ggscoord={lat}\|{lon}&ggsradius={r}&ggslimit={n}&prop=description\|pageprops&ppprop=wikibase_item` | `wikipedia_search_nearby` |

Pagination: Action API uses `continue` objects in the response. Tools that paginate internally (langlinks) should set `lllimit=500` to minimize round-trips. Geosearch results are bounded by the `limit` parameter alone — the module has no `offset` or `continue`. Search pages with `sroffset`, bounded by CirrusSearch's 10,000-result window: `sroffset >= 10000` is refused outright, and a page crossing the window is cut at the 10,000th result rather than refused, so the window's edge is shaped exactly like the end of the result set and has to be disclosed from `totalCount` against the offset reached.

Errors: the Action API returns its refusals as a top-level `error` object inside an **HTTP 200** body, so status-code mapping never sees them. Every raw response type declares `error` and every call site reads it before the payload; skipping that check renders an upstream refusal as an empty success. The transient codes are the exception: `apiGet` classifies them once, inside the retry, before any call site sees the body (see Rate limits and resilience).

Snippet HTML: Search snippets include `<span class="searchmatch">` markup. Strip to plain text before returning. This is reflected in `wikipedia_search_articles`'s output design — snippets are always plain text in the tool response.

### Rate limits and resilience

No enforced rate limits, but:
- Every request runs under `withRetry`: a 429, a 5xx, a timeout, or an HTML error page is retried with exponential backoff (1 s base, ±25% jitter, 3 retries — 4 attempts). A `Retry-After` of 30 s or less is waited out instead of the backoff; a longer one fails the call at once
- Transient Action API refusals arrive as an HTTP 200 `error` envelope, not a 429 or 503: `ratelimited`, `readonly`, and CirrusSearch's full-pool-counter refusals `cirrussearch-too-busy-error` and `cirrussearch-regex-too-busy-error`. `apiGet` throws these inside the retry, with `Retry-After` taken from the 200 response when present, so every Action API call site gets the backoff a 503 gets. Every other code is returned to its call site on the first response and mapped there — the contract codes (`missingtitle`, `invalidtitle`, `nosuchsection`, `cirrussearch-offset-too-large`) and any code not known to clear on retry, `cirrussearch-backend-error` included, since it also covers backend failures. An exhausted ladder surfaces the envelope's message with `(failed after 4 attempts)` appended
- Each request's whole ladder is bounded at 30 s (`deadlineMs`), each attempt's timeout shrinking to the time left. Unbounded, four 15 s attempts ran to ≈67 s and three honored 30 s `Retry-After` waits to 90 s — past a client's usual 60 s request timeout, which would report a transport timeout instead of this server's error. The backoff alone adds at most ≈8.75 s. An expired budget fails with `Timeout` and `data.reason: 'retry_deadline_exceeded'`; an honored `Retry-After` that would outlast it fails at once with the envelope's error and `data.retryAfter`
- A caller's cancellation ends a backoff as well as a request in flight
- The search description lookup is the exception: best-effort, one attempt with a 5 s timeout, so a transient envelope there drops the descriptions instead of retrying. The sitematrix fetch behind the edition registry retries once, with a 10 s per-attempt timeout
- User-Agent is required — requests without it are deprioritized

---

## Tool Detail

### `wikipedia_search_articles`

**Description:** Full-text search across Wikipedia articles. Returns ranked results with plain-text titles, short descriptions, Wikidata QIDs, snippets (search match highlighted terms stripped to plain text), and page IDs, plus Wikipedia's spelling suggestion when it has one. Use when the exact article title is unknown or to discover multiple articles on a topic. The `pageid` values in results can be used to resolve article titles for subsequent calls.

**Input:**
- `query: string` — search query; an empty string is refused before the fetch (whitespace is a legitimate search upstream and is not)
- `limit?: number` — max results per page (default 10, max 50 — enforced by the schema, so a larger value is rejected rather than silently clamped)
- `offset?: number` — result offset (default 0); at or past the 10,000-result search window the call is refused, since nothing past it is retrievable
- `language?: string` — Wikipedia language edition code (default `"en"`); constructs the correct base URL per call

**Output:** Array of results, each with `title`, `pageid`, `snippet` (plain text, `<span class="searchmatch">` tags stripped), `wordcount`, and — when the article has them — `description` and `wikibase_item`. Enrichment carries `effectiveQuery`, `totalCount`, `offset`, `shown`, `nextOffset` while more results remain, `suggestion` whenever upstream has a spelling correction, and — on a page that ends at the search window — `truncated`, `cap`, and a notice naming the matches no offset reaches. The notice is one string built from every applicable segment: the zero-hit first page (naming the suggestion), the end of results past offset 0, the window cut, and a failed description lookup.

**Errors:**
- `empty_query` (ValidationError) — the query is an empty string, which Wikipedia reads as a missing parameter. Recovery: supply search terms.
- `offset_too_large` (ValidationError) — the offset is at or past the 10,000-result search window. Recovery: narrow the query rather than paging further.
- `invalid_language` (ValidationError) — unrecognized language code. Recovery: use a valid BCP 47 language code (e.g., `"fr"`, `"de"`, `"ja"`).

A search that matches nothing is a successful empty result with a notice, not an error.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_summary`

**Description:** Fetch the short summary for a Wikipedia article — the REST extract, a truncated fragment from the start of the lead section, which answers "what is X?". Returns a plain-text extract rendered from `extract_html`, superscripts kept, Wikidata QID (`wikibase_item`) for cross-referencing with `wikidata-mcp-server`, description, and thumbnail URL. The full lead is a different call: `wikipedia_get_article` with `section_index: 0`. Disamb pages return `page_type: "disambiguation"` — not an error, but a signal to call `wikipedia_search_articles` with a more specific query. Redirect pages are followed automatically; `page_type: "redirect"` is returned with the resolved title.

**Input:**
- `title: string` — article title (URL-decoded; e.g., `"Python (programming language)"`); a trailing `#fragment` is accepted, and a title MediaWiki cannot name a page with is refused before the fetch
- `language?: string` — language edition code (default `"en"`)

**Output:** `{ title, page_type, pageid, wikibase_item, description, extract, thumbnail_url, latitude?, longitude?, url?, revision_id?, last_modified? }`. `page_type` is one of `"article" | "disambiguation" | "redirect"`. `wikibase_item` is the Wikidata QID (e.g., `"Q28865"`) — use to chain into `wikidata-mcp-server` without a separate title-to-QID lookup. `latitude` / `longitude` are the REST `coordinates`, present only for a geotagged article (the payload carries an explicit `null` otherwise) and named to pass straight into `wikipedia_search_nearby`. `url` is the canonical desktop page URL, and `revision_id` / `last_modified` name the revision the extract was read from, so `?oldid=<revision_id>` cites exactly that version.

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search_articles` to find the correct title.
- `invalid_title` (ValidationError) — the title contains characters MediaWiki cannot name a page with. Recovery: use `wikipedia_search_articles` to find the exact title.
- `invalid_language` (ValidationError) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_article`

**Description:** Fetch article content as clean plain text. Two code paths depending on whether `section_index` is provided. Without `section_index`: returns the full article via `action=query&prop=extracts|info|revisions`, the HTML extract rendered to plain text — 40–100KB for major articles, with `== Section == ` markers preserved for structure. With `section_index` (from `wikipedia_get_sections`): returns that section and its subsections via `action=parse&prop=text|revid`, with the parser's HTML rendered to plain text. Prefer section targeting when the full article exceeds what is needed.

**Input:**
- `title: string` — article title; a trailing `#fragment` is accepted, and a title MediaWiki cannot name a page with is refused before the fetch
- `section_index?: integer ≥ 0` — section index from `wikipedia_get_sections`; `0` reads the lead. Omit for the full article. A negative or fractional value is a schema rejection, so it never reaches upstream.
- `language?: string` — language edition code (default `"en"`)

**Output:** `{ title, pageid, content, section_title?, content_type, truncated, original_length?, sections_suggested?, url?, revision_id?, last_modified? }`. `content` is plain text with superscripts kept and code samples as fenced blocks; a section read's also carries data tables as pipe rows and infoboxes as `label: value` lines. `content_type` is `"full_article"` or `"section"`. For section reads, `section_title` is included — `"Introduction"` for the lead, which carries no heading of its own. For full articles, `content` includes `== Section ==` markers. `url` and `revision_id` cite the article and the revision read on every path; `last_modified`, that revision's timestamp, is on full reads and the overflow outline only (see [Article reads carry their citation fields](#article-reads-carry-their-citation-fields)).

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search_articles` to find the correct title.
- `invalid_title` (ValidationError) — the title contains characters MediaWiki cannot name a page with. Recovery: use `wikipedia_search_articles` to find the exact title.
- `invalid_section` (ValidationError) — `section_index` is out of range. Recovery: call `wikipedia_get_sections` first to obtain valid index values.
- `invalid_language` (ValidationError) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_sections`

**Description:** Fetch the table of contents for a Wikipedia article. Returns section titles, heading levels, numbering (e.g., "2.1"), and `section_index` values. The `section_index` is the identifier for targeted section reads via `wikipedia_get_article`. Call this before `wikipedia_get_article` when the specific section to read is not known, or to enumerate article structure.

**Input:**
- `title: string` — article title; a trailing `#fragment` is accepted, and a title MediaWiki cannot name a page with is refused before the fetch
- `language?: string` — language edition code (default `"en"`)

**Output:** Array of section entries: `{ index, number, title, level }`, led by the lead entry `{ index: 0, number: "0", title: "Introduction", level: 1 }`. `index` is the integer to pass as `section_index` in `wikipedia_get_article`. `level` is heading depth (2 = `==`, 3 = `===`); the lead reports 1, where the page's own title sits.

**Errors:**
- `not_found` (NotFound) — no article exists for the title. Recovery: use `wikipedia_search_articles` to find the correct title.
- `invalid_title` (ValidationError) — the title contains characters MediaWiki cannot name a page with. Recovery: use `wikipedia_search_articles` to find the exact title.
- `no_sections` (NotFound) — article exists but has no headed sections (stub or very short article). Recovery: use `wikipedia_get_article` without `section_index` to read the full content.
- `invalid_language` (ValidationError) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_search_nearby`

**Description:** Find Wikipedia articles about places near a geographic coordinate. Returns articles sorted by distance from the query point, with titles, short descriptions, Wikidata QIDs, page IDs, coordinates, and distance in meters. Useful for "what's notable near X?" research workflows. Only articles carrying their own GeoData coordinate tag are returned, and that tag — not the Wikidata item's P625 — places and measures each result.

**Input:**
- `latitude: number` — WGS 84 latitude (−90 to 90)
- `longitude: number` — WGS 84 longitude (−180 to 180)
- `radius_meters?: number` — search radius in meters (default 1000, min 10, max 10000 — the `gsradius` bounds `action=paraminfo` reports)
- `limit?: number` — max results (default 10, max 500 — the `gslimit` ceiling an anonymous caller gets). Geosearch has no `offset`/`continue`, so this is the whole reachable set
- `language?: string` — language edition code (default `"en"`)

**Output:** Array of results: `{ title, pageid, latitude, longitude, distance_meters, description?, wikibase_item? }`, sorted ascending by `distance_meters`. Enrichment echoes the query point and effective radius, and carries `truncated`, `shown`, and `cap`. A truncation notice advises a higher `limit` below the 500 ceiling and only narrower sweeps at it.

**Errors:**
- `invalid_coordinates` (ValidationError) — latitude or longitude out of range.
- `invalid_language` (ValidationError) — unrecognized language code.

No geotagged articles within the radius is a successful empty result with a notice suggesting a wider radius, not an error.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `wikipedia_get_languages`

**Description:** List the language editions available for a Wikipedia article. Returns language codes, the article title in each language, and the full URL. Use for cross-language research or to find a non-English article title before switching language editions. The source article's `language` parameter specifies which edition to query from.

**Input:**
- `title: string` — article title; a trailing `#fragment` is accepted, and a title MediaWiki cannot name a page with is refused before the fetch
- `language?: string` — language edition to query from (default `"en"`)
- `editions?: string[]` — edition codes to keep (at least one). Matched case-insensitively against both `edition_code` and `language_code`, so either spelling of a mismatch edition finds it. Filtering happens locally against the single `lllimit=500` fetch — the Action API's `lllang` is single-valued, so there is no per-code request to make

**Output:** Array of language entries: `{ language_code, edition_code?, title, url }`. `edition_code` is the Wikipedia subdomain (derived from the article URL host) to pass as `language` to other tools — it can differ from `language_code` for some editions (e.g. `gsw` → `als`). `edition_code` and `url` are both omitted when the serving host cannot be established, rather than composed from `language_code`, which is not the subdomain for mismatch editions. Redirect titles are resolved, and `source_title` reports the resolved article. The source language is not included — only other editions. Includes `total_languages`, which is always the unfiltered count. When `editions` was passed, `missing` lists the requested codes with no article, echoed as they were passed, and is present even when empty; a request whose codes all miss is a normal response with an empty `languages`, since `no_other_languages` gates on the unfiltered count.

**Errors:**
- `not_found` (NotFound) — no article exists for the title in the specified language. Recovery: use `wikipedia_search_articles` to find the correct title.
- `invalid_title` (ValidationError) — the title contains characters MediaWiki cannot name a page with. Recovery: use `wikipedia_search_articles` to find the exact title.
- `no_other_languages` (NotFound) — article exists but has no other language editions. Recovery: the article may be too new or too regional to have been translated yet.
- `invalid_language` (ValidationError) — unrecognized language code.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

## Known Limitations

- **Article size**: Full plaintext extracts for major articles are 40–100KB. `wikipedia_get_article` without `section_index` returns large payloads — the tool description prominently recommends section targeting when only part of the article is needed.
- **`prop=sections` deprecation**: The service reads its replacement, `prop=tocdata`; the fallback (parsing `== Title ==` headers from full-article text) covers an article whose `tocdata` comes back empty.
- **REST `related` endpoint**: The `/api/rest_v1/page/related/{title}` endpoint returned empty results during testing. Not used.
- **Disambiguation**: The agent must handle `page_type: "disambiguation"` as a signal to refine the query, not as an error. Surfaced via `page_type` field in `wikipedia_get_summary` output.
- **Search depth**: CirrusSearch serves no result past the 10,000th for a query, and offers no continuation past it. `wikipedia_search_articles` refuses an offset at or beyond the window and discloses a page that ends on it; matches beyond are reachable only by narrowing the query.
- **Summary extract length**: the REST `extract` is a truncated fragment of the lead, not the lead — between a tenth and a half of it across sampled articles, and a single sentence on some. `wikipedia_get_article` with `section_index: 0` returns the lead in full.
