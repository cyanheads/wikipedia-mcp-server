/**
 * @fileoverview Test helper — upstream HTML captured from English Wikipedia reads that carry lists.
 * @module tests/helpers/list-fixtures
 */

import { readFileSync } from 'node:fs';

/**
 * Each fixture is an upstream payload captured on 2026-11-11, stored as served: an HTML payload as
 * the `html` string of a JSON file beside its `source`, so no formatter or linter reaches the markup.
 *
 * | Fixture | Source | Revision |
 * |:--|:--|:--|
 * | `twelve-step-program-s3` | `action=parse&prop=text`, `Twelve-step program` section 3 | 1383900751 |
 * | `outline-of-geography-s8` | `action=parse&prop=text`, `Outline of geography` section 8 | 1384573655 |
 * | `outline-of-geography-extract` | `prop=extracts` (HTML mode), `Outline of geography` | 1384573655 |
 * | `late-show-top-ten-list-s2` | `action=parse&prop=text`, `Late Show Top Ten List` section 2 | 1384250696 |
 * | `multiple-sclerosis-s22` | `action=parse&prop=text`, `Multiple sclerosis` section 22 | 1382784939 |
 * | `messiah-handel-s14` | `action=parse&prop=text`, `Messiah (Handel)` section 14 | 1383942369 |
 * | `world-heritage-site-s6` | `action=parse&prop=text`, `World Heritage Site` section 6 | 1383353293 |
 * | `tree-traversal-s3` | `action=parse&prop=text`, `Tree traversal` section 3 | 1379688139 |
 * | `tree-traversal-s10` | `action=parse&prop=text`, `Tree traversal` section 10 | 1379688139 |
 * | `mercury-summary` | REST `page/summary/Mercury` | 1380113383 |
 */
export type ListFixture =
  | 'twelve-step-program-s3'
  | 'outline-of-geography-s8'
  | 'outline-of-geography-extract'
  | 'late-show-top-ten-list-s2'
  | 'multiple-sclerosis-s22'
  | 'messiah-handel-s14'
  | 'world-heritage-site-s6'
  | 'tree-traversal-s3'
  | 'tree-traversal-s10';

/** A captured HTML payload, as served. */
export function listFixture(name: ListFixture): string {
  const fixture = JSON.parse(
    readFileSync(new URL(`../fixtures/lists/${name}.json`, import.meta.url), 'utf8'),
  ) as { html: string };
  return fixture.html;
}

/** The captured REST summary of the `Mercury` disambiguation page, as served. */
export function mercurySummary(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL('../fixtures/lists/mercury-summary.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}
