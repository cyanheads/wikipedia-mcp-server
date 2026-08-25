/**
 * @fileoverview Tests for wikipedia_search_nearby tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search-nearby.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaSearchNearby } from '@/mcp-server/tools/definitions/wikipedia-search-nearby.tool.js';
import { mockWikipediaService } from '../../../helpers/wikipedia-service-mock.js';

describe('wikipediaSearchNearby', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Baseline stub so the pre-fetch edition guard resolves offline; tests that need
    // domain methods call mockWikipediaService again with their own.
    mockWikipediaService();
  });

  it('returns nearby articles for valid coordinates', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({
        truncated: false,
        results: [
          {
            title: 'Space Needle',
            pageid: 34567,
            latitude: 47.6205,
            longitude: -122.3493,
            distance_meters: 150,
          },
          {
            title: 'Seattle Center',
            pageid: 45678,
            latitude: 47.6212,
            longitude: -122.3509,
            distance_meters: 300,
          },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 47.6205,
      longitude: -122.3493,
    });
    const result = await wikipediaSearchNearby.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.title).toBe('Space Needle');
    expect(result.results[0]?.distance_meters).toBe(150);

    // Enrichment carries query echo and truncation disclosure
    const enrichment = getEnrichment(ctx);
    expect(enrichment.queryLatitude).toBe(47.6205);
    expect(enrichment.queryLongitude).toBe(-122.3493);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results with a notice when no articles found', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({ results: [], truncated: false }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0 });
    const result = await wikipediaSearchNearby.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.shown).toBe(0);
    expect(enrichment.notice).toContain('radius_meters');
  });

  it('throws invalid_coordinates for out-of-range latitude', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 91, longitude: 0 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_coordinates' },
    });
  });

  it('throws invalid_coordinates for out-of-range longitude', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 181 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_coordinates' },
    });
  });

  it('caps radius at 10000m', async () => {
    const nearbyFn = vi.fn().mockResolvedValue({
      truncated: false,
      results: [{ title: 'T', pageid: 1, latitude: 0, longitude: 0, distance_meters: 100 }],
    });
    mockWikipediaService({
      searchNearby: nearbyFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 0,
      longitude: 0,
      radius_meters: 99999,
    });
    await wikipediaSearchNearby.handler(input, ctx);

    // First 3 args are lat, lon, radius
    expect(nearbyFn.mock.calls[0]?.[2]).toBe(10_000);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.radiusMetersUsed).toBe(10_000);
  });

  it('format renders title, pageid, distance, and coordinates', () => {
    const output = {
      results: [
        {
          title: 'Space Needle',
          pageid: 34567,
          latitude: 47.6205,
          longitude: -122.3493,
          distance_meters: 150,
        },
      ],
      language: 'en',
    };
    const blocks = wikipediaSearchNearby.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Space Needle');
    expect(text).toContain('34567');
    expect(text).toContain('150');
    expect(text).toContain('47.6205');
    expect(text).toContain('-122.3493');
  });

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      language: 'INVALID!!',
    });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws invalid_language with data.reason for a nonexistent edition (issue #18)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      language: 'zz',
    });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('rejects float limit at schema parse time (issue #14)', () => {
    expect(() =>
      wikipediaSearchNearby.input.parse({ latitude: 47.6, longitude: -122.3, limit: 5.7 }),
    ).toThrow();
  });

  it('rejects negative limit at schema parse time (issue #10)', () => {
    expect(() =>
      wikipediaSearchNearby.input.parse({ latitude: 47.6, longitude: -122.3, limit: -1 }),
    ).toThrow();
  });

  it('rejects negative radius_meters at schema parse time (issue #10)', () => {
    expect(() =>
      wikipediaSearchNearby.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        radius_meters: -1000,
      }),
    ).toThrow();
  });

  it('rejects float radius_meters at schema parse time (issue #14)', () => {
    expect(() =>
      wikipediaSearchNearby.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        radius_meters: 500.5,
      }),
    ).toThrow();
  });

  it('rejects radius_meters below the upstream 10 m floor at schema parse time (issue #30)', () => {
    // Upstream gsradius reports min: 10; 5 previously passed the schema and came back as a raw
    // `outofrange` API error instead of this tool's typed contract.
    expect(() =>
      wikipediaSearchNearby.input.parse({ latitude: 48.8566, longitude: 2.3522, radius_meters: 5 }),
    ).toThrow(/10/);
    expect(() =>
      wikipediaSearchNearby.input.parse({ latitude: 48.8566, longitude: 2.3522, radius_meters: 9 }),
    ).toThrow();
  });

  it('accepts radius_meters exactly at the floor (issue #30)', () => {
    const input = wikipediaSearchNearby.input.parse({
      latitude: 48.8566,
      longitude: 2.3522,
      radius_meters: 10,
    });
    expect(input.radius_meters).toBe(10);
  });

  it('throws invalid_coordinates for -91 latitude (lower bound)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: -91, longitude: 0 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_coordinates' },
    });
  });

  it('throws invalid_coordinates for -181 longitude (lower bound)', async () => {
    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: -181 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_coordinates' },
    });
  });

  it('rejects a limit above the geosearch ceiling at schema parse time (issue #29)', () => {
    expect(() =>
      wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0, limit: 999 }),
    ).toThrow();
  });

  it('passes a limit up to the geosearch ceiling through to the service (issue #29)', async () => {
    const nearbyFn = vi.fn().mockResolvedValue({ results: [], truncated: false });
    mockWikipediaService({
      searchNearby: nearbyFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 0,
      longitude: 0,
      limit: 500,
    });
    await wikipediaSearchNearby.handler(input, ctx);

    // arg index 3 is limit — no longer clamped to 50 on the way in.
    expect(nearbyFn.mock.calls[0]?.[3]).toBe(500);
  });

  it('reports truncated with pagination-free guidance when the service overflows (issue #29)', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({
        truncated: true,
        results: [{ title: 'T', pageid: 1, latitude: 0, longitude: 0, distance_meters: 10 }],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0, limit: 1 });
    await wikipediaSearchNearby.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.cap).toBe(1);
    // The tool has no filter parameters, so the notice must not advise narrowing with filters.
    expect(enrichment.notice).toContain('radius_meters');
    expect(enrichment.notice).toContain('500');
    expect(enrichment.notice).not.toMatch(/filter/i);
  });

  it('reports truncated false for a full page that is not an overflow (issue #29)', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({
        truncated: false,
        results: [
          { title: 'A', pageid: 1, latitude: 0, longitude: 0, distance_meters: 10 },
          { title: 'B', pageid: 2, latitude: 0, longitude: 0, distance_meters: 20 },
        ],
      }),
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0, limit: 2 });
    await wikipediaSearchNearby.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    // Exactly `limit` matches is not truncation — the old `results.length >= limit` said it was.
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes non-default language to service', async () => {
    const nearbyFn = vi.fn().mockResolvedValue({
      truncated: false,
      results: [
        {
          title: 'Tour Eiffel',
          pageid: 111,
          latitude: 48.858,
          longitude: 2.294,
          distance_meters: 50,
        },
      ],
    });
    mockWikipediaService({
      searchNearby: nearbyFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 48.858,
      longitude: 2.294,
      language: 'fr',
    });
    const result = await wikipediaSearchNearby.handler(input, ctx);

    // arg index 4 is language
    expect(nearbyFn.mock.calls[0]?.[4]).toBe('fr');
    expect(result.language).toBe('fr');
  });

  it('format renders zero results correctly', () => {
    const output = { results: [], language: 'en' };
    const blocks = wikipediaSearchNearby.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('0 articles');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      results: [{ title: 'T', pageid: 1, latitude: 0, longitude: 0, distance_meters: 100 }],
      language: 'en',
    };
    const blocks = wikipediaSearchNearby.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('service error propagates without swallowing', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockRejectedValue(new Error('Upstream failure')),
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toThrow('Upstream failure');
  });

  it('enrichment radiusMetersUsed reflects effective (capped) value', async () => {
    const nearbyFn = vi.fn().mockResolvedValue({ results: [] });
    mockWikipediaService({
      searchNearby: nearbyFn,
    });

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({
      latitude: 0,
      longitude: 0,
      radius_meters: 500,
    });
    await wikipediaSearchNearby.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.radiusMetersUsed).toBe(500);
  });
});
