---
name: wikipedia-guide
description: Gates and identifier chains for the wikipedia_* tools. Covers switching language editions without reusing titles, disambiguation pages the article tools don't flag, section numbers versus section_index, coverage that differs by edition, and the checks to run before calling something absent or sourced. Use when a wikipedia_* task crosses editions, reads past the summary, quotes a section, or has to cite or conclude absence.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Wikipedia prose in every language edition: full-text search, summaries, section and full-article reads, geotagged articles near a coordinate, an article's interlanguage links, and the footnotes it cites. Keyless and read-only.

Each call reads one edition. No tool searches several editions at once, and none covers Wikidata statements, page history, or other Wikimedia projects. For structured facts, or to turn a QID into titles, hand the `wikibase_item` QID to a Wikidata tool.

## Identifiers

| Identifier | Where it comes from | What to know |
|:--|:--|:--|
| Title | Search results, the resolved `title` of any read, `languages[].title` from wikipedia_get_languages | Belongs to one edition. The same spelling can name a different subject elsewhere: `Gift` is the present article on en (Q184303) and the poison article on de (Q40867) |
| Edition (`language`) | `edition_code` from wikipedia_get_languages | Simple English is `simple` |
| `section_index` | `index` from wikipedia_get_sections, or the `(section_index: N)` labels on an outlined full read | Not the `number` column. On `Seine`, index 10 is section number "6" |
| QID (`wikibase_item`) | wikipedia_get_summary, plus every search and nearby result | The same across editions (`Seine` is Q1471 on en, fr, and simple). Output only: as a title it fails `not_found`, and as a query it matches nothing |
| Coordinates | `latitude`/`longitude` on wikipedia_get_summary | Geotags belong to each edition's article. `Seine` has them on en but not on fr |

## Gates

**Never carry a title across editions.** Get the target edition's title from wikipedia_get_languages. If you found it by searching that edition instead, check that its `wikibase_item` matches the source article's before treating it as the same subject.

**Check `page_type` before reading an ambiguous title in depth.** Only wikipedia_get_summary flags a disambiguation page. wikipedia_get_sections and wikipedia_get_article read one as if it were an article: `Mercury` returns dozens of "sections" (Companies, Computing, Film and television …) with no flag. To pick the intended article:
- Read the disambiguation page's sections. They list one candidate per line, title first ("Mercury Drug, a Philippine pharmacy chain").
- Or search. On en, the disambiguation page's own result carries the description "Topics referred to by the same term", and the other results' descriptions separate the candidates.

Confirm your pick with wikipedia_get_summary.

**Treat "section N" as a number, not an index.** When a user or a source names "section 6" or "§4.1", find the row whose `number` matches in wikipedia_get_sections and pass that row's `index`.

**Run these checks before reporting something absent:**
- *From Wikipedia:* a `not_found` on a guessed title only means that title doesn't exist, so search next. Then search the edition of the subject's own language, because coverage differs by edition. `Place de la Mairie (Rennes)` has a fr article but no en one, and an en search for it returns only other pages, such as `Rennes` and `Hôtel de Ville, Rennes`.
- *From a language edition:* wikipedia_get_languages lists the queried edition itself under `missing` when you include it in `editions` (`Python (programming language)` on en with `editions: ["en"]` gives `missing: ["en"]`). The queried edition is never in `languages`.
- *From an article:* a full read leaves out infoboxes, data tables, and some lists. On `Seine`, the full read has no infobox (its length and basin size are only in section 0), and the "In art" section read lists 27 artists where the full read lists none. Read the section before saying the article doesn't state something, and read section 0 for the infobox.
- *Near a point:* geotags differ by edition. Within 500 m of central Rennes, fr returns more than twice as many geotagged articles as en. Search the local edition before calling an area thin.

**Don't attribute a claim to a source until you have matched it.** Section and full reads drop the reference markers, and a "References" section reads as its heading alone. wikipedia_get_references lists the footnotes the article cites, with citation text, `urls`, and `dois`, in pages of whole footnotes: follow `next_cursor` with the same title and language until it is absent. A short citation such as "Galinsky 2012, pp. 75–76" carries `work_ids`, and `works` on that page holds the full citation. Bibliography entries no footnote points to are not listed, so read that section with wikipedia_get_article. The tool doesn't say which passage cites which source, so match the claim to an entry by its content, and check that its `revision_id` equals the revision of the text you quoted.

**Don't report `totalCount` as the number of articles on a topic.** It counts full-text matches: a search for `Mercury` reports tens of thousands.

## Workflows

### Reading another edition's article

1. Call wikipedia_get_languages with the source title and `editions` set to the target code. Take the target `title` and `edition_code` from it.
2. Call wikipedia_get_sections, then wikipedia_get_article with a `section_index`, both in that edition. Headings come back in that edition's language, except the lead entry, which is always "Introduction".
3. Cite the edition you read. The permalink host is that edition's, never en's.

If the target code comes back under `missing`, search the target edition before you report that it has no article. Then apply the QID check to any match.

### Checking a claim against an article

Find the section with wikipedia_get_sections and read it. If the article has no section on the topic, read the lead (section 0) or narrow with search. Quote the text and cite the permalink of that read. To check the source behind it, follow the matching gate above with wikipedia_get_references. If no entry clearly supports the claim, say so rather than picking the nearest one.

### Narrowing a search

Operators combine with AND in one query:
- `intitle:bridge incategory:"Bridges in Paris"` matches only titles containing "bridge" in that category.
- `prefix:` matches the start of a title, but punctuation is matched loosely: `prefix:Seine-` returns Seine-Saint-Denis and Seine-Maritime, and also "Seine fishing".
- Quote an exact phrase, and put `-` before a term to exclude it: adding `-Paris` to `"flood of 1910"` drops the matches that mention Paris.

`deepcat:` searches a category together with its subcategories, and it works on a small tree: `deepcat:"Bridges in Paris"` returns Paris bridges, led by Pont Neuf. On a large tree it fails silently and gives no notice: `deepcat:"Rivers of France"` returned tens of thousands of matches led by "Karl Marx". If the top results don't fit the operator, drop it. `incategory:` on the same category returns its rivers, led by the Rhine, Seine, and Rhône.
