/**
 * @fileoverview Tests for wikipedia_search_nearby tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search-nearby.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaSearchNearby } from '@/mcp-server/tools/definitions/wikipedia-search-nearby.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

describe('wikipediaSearchNearby', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns nearby articles for valid coordinates', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      searchNearby: vi.fn().mockResolvedValue({
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
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearchNearby.input.parse({
      latitude: 47.6205,
      longitude: -122.3493,
    });
    const result = await wikipediaSearchNearby.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.title).toBe('Space Needle');
    expect(result.results[0]?.distance_meters).toBe(150);
    expect(result.total_results).toBe(2);
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

  it('throws no_results when no articles found', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      searchNearby: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaSearchNearby.errors });
    const input = wikipediaSearchNearby.input.parse({ latitude: 0, longitude: 0 });
    await expect(wikipediaSearchNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('caps radius at 10000m', async () => {
    const nearbyFn = vi.fn().mockResolvedValue({
      results: [{ title: 'T', pageid: 1, latitude: 0, longitude: 0, distance_meters: 100 }],
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      searchNearby: nearbyFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaSearchNearby.input.parse({
      latitude: 0,
      longitude: 0,
      radius_meters: 99999,
    });
    await wikipediaSearchNearby.handler(input, ctx);

    // First 3 args are lat, lon, radius
    expect(nearbyFn.mock.calls[0]?.[2]).toBe(10_000);
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
      total_results: 1,
      query_latitude: 47.6205,
      query_longitude: -122.3493,
      radius_meters_used: 1000,
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
});
