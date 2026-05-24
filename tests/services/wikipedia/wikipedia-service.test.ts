/**
 * @fileoverview Tests for WikipediaService initialization, language validation, and wikitext stripping.
 * @module tests/services/wikipedia/wikipedia-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getWikipediaService,
  initWikipediaService,
  WikipediaService,
} from '@/services/wikipedia/wikipedia-service.js';

const mockConfig = {} as AppConfig;
const mockStorage = {} as StorageService;
const TEST_USER_AGENT =
  'wikipedia-mcp-server/test (https://github.com/cyanheads/wikipedia-mcp-server)';

describe('WikipediaService init/accessor', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('getWikipediaService returns the initialized instance', () => {
    const svc = getWikipediaService();
    expect(svc).toBeInstanceOf(WikipediaService);
  });
});

describe('WikipediaService language validation', () => {
  beforeEach(() => {
    initWikipediaService(mockConfig, mockStorage, TEST_USER_AGENT);
  });

  it('rejects an invalid language code with ValidationError', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // buildBaseUrl is called internally by restGet; invalid code triggers throw.
    await expect(
      svc.restGet('not_a_valid_BCP47!!!', '/page/summary/Test', ctx),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid language code') });
  });

  it('accepts valid 2-char language codes', async () => {
    const svc = getWikipediaService();
    const ctx = createMockContext();

    // 'fr' is valid — buildBaseUrl should not throw. The call may resolve (live
    // network) or reject with a network/API error, but never with a language
    // validation error. Use Promise.allSettled to inspect the outcome either way.
    const [result] = await Promise.allSettled([svc.restGet('fr', '/page/summary/Python', ctx)]);
    if (result.status === 'rejected') {
      expect(result.reason).not.toMatchObject({
        message: expect.stringContaining('Invalid language code'),
      });
    }
    // If resolved, language validation passed — nothing more to assert.
  });
});
