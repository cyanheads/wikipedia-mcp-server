/**
 * @fileoverview Test helper — stub `getWikipediaService()` for tool-handler tests.
 * @module tests/helpers/wikipedia-service-mock
 */

import { vi } from 'vitest';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

/**
 * Editions the stubbed registry knows. `ht` and `bat-smg` are real editions the hand-maintained
 * allowlist rejected; `gsw` is a MediaWiki language code whose edition lives on `als`.
 */
const TEST_EDITIONS = new Set([
  'en',
  'fr',
  'de',
  'ja',
  'es',
  'simple',
  'ht',
  'als',
  'gsw',
  'bat-smg',
]);

/**
 * Replace `getWikipediaService()` with a stub built from `methods`.
 *
 * The edition guard every tool handler calls pre-fetch is defaulted to a lookup over
 * {@link TEST_EDITIONS}, so no tool test reaches the live sitematrix endpoint. Pass
 * `isUnknownEdition` in `methods` to override it.
 */
export function mockWikipediaService(methods: Record<string, unknown> = {}): void {
  vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
    isUnknownEdition: async (language: string) => !TEST_EDITIONS.has(language.toLowerCase()),
    ...methods,
  } as unknown as svcModule.WikipediaService);
}
