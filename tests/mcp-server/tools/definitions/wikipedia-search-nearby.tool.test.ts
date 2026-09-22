/**
 * @fileoverview Tests for wikipedia_search_nearby tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-search-nearby.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('escapes markdown-active upstream titles in format() and leaves the structured values raw (issue #43)', () => {
    const output = {
      results: [
        {
          title: 'Champ de Mars <parc> _central_',
          pageid: 123,
          latitude: 48.8556,
          longitude: 2.2986,
          distance_meters: 210,
        },
      ],
      language: 'en',
    };
    const text = wikipediaSearchNearby.format!(output)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');

    expect(text).toContain('Champ de Mars \\<parc\\> \\_central\\_');
    expect(text).not.toContain('<parc>');
    expect(output.results[0]?.title).toBe('Champ de Mars <parc> _central_');
  });
});

/** Every text block of a tool result, joined — the domain render plus the enrichment trailer. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
}

/** `n` nearby results in ascending distance order. */
const places = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: `Place ${i + 1}`,
    pageid: i + 1,
    latitude: 0,
    longitude: 0,
    distance_meters: i * 10,
  }));

describe('wikipediaSearchNearby — contract path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('renders a result on both surfaces (characterization)', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({
        truncated: false,
        results: [
          {
            title: 'Eiffel Tower',
            pageid: 9232,
            latitude: 48.85822222,
            longitude: 2.2945,
            distance_meters: 0,
          },
        ],
      }),
    });

    const result = await runToolContract(wikipediaSearchNearby, {
      latitude: 48.85822222,
      longitude: 2.2945,
      radius_meters: 500,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          title: 'Eiffel Tower',
          pageid: 9232,
          latitude: 48.85822222,
          longitude: 2.2945,
          distance_meters: 0,
        },
      ],
      language: 'en',
      queryLatitude: 48.85822222,
      queryLongitude: 2.2945,
      radiusMetersUsed: 500,
      truncated: false,
      shown: 1,
      cap: 10,
    });
    expect(contentText(result)).toContain(
      '**Page ID:** 9232 | **Distance:** 0m | **Coords:** (48.85822222, 2.2945)',
    );
  });
});

describe('wikipediaSearchNearby — cap notice at the 500 ceiling (issue #54)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('drops the raise-limit advice when the limit is already the ceiling, keeping truncated true', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({ truncated: true, results: places(500) }),
    });

    const result = await runToolContract(wikipediaSearchNearby, {
      latitude: 47.6,
      longitude: -122.3,
      radius_meters: 10_000,
      limit: 500,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(500);
    expect(structured.cap).toBe(500);
    expect(structured.notice).not.toMatch(/raise limit/i);
    expect(structured.notice).toContain("Wikipedia's 500-result ceiling");
    expect(structured.notice).toContain('radius_meters');
  });

  it('keeps the existing raise-limit notice for a below-ceiling truncation (characterization)', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({ truncated: true, results: places(50) }),
    });

    const result = await runToolContract(wikipediaSearchNearby, {
      latitude: 47.6,
      longitude: -122.3,
      radius_meters: 10_000,
      limit: 50,
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toBe(
      'Results were capped. Raise limit (max 500) to retrieve more, or reduce radius_meters and sweep adjacent sub-areas for exhaustive coverage — geosearch offers no pagination past the limit.',
    );
  });

  it("names the article's own GeoData coordinates, not Wikidata, in the tool description", () => {
    expect(wikipediaSearchNearby.description).not.toMatch(/Wikidata record/i);
    expect(wikipediaSearchNearby.description).toMatch(/GeoData/);
  });
});

describe('wikipediaSearchNearby — description and Wikidata QID (issue #52)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockWikipediaService();
  });

  it('declares and renders description and wikibase_item per result, omitting them when absent', async () => {
    mockWikipediaService({
      searchNearby: vi.fn().mockResolvedValue({
        truncated: false,
        results: [
          {
            title: 'Eiffel Tower',
            pageid: 9232,
            latitude: 48.8583,
            longitude: 2.2945,
            distance_meters: 0,
            description: 'Tower in Paris, France',
            wikibase_item: 'Q243',
          },
          // An article whose GeoData tag places it in Paris though it is about a Venice palace —
          // the description is what exposes the bad coordinate.
          {
            title: 'Palazzo Bernardo Nani',
            pageid: 48435351,
            latitude: 48.8583,
            longitude: 2.2923,
            distance_meters: 161.2,
            description: 'Palace on the Grand Canal, Venice',
            wikibase_item: 'Q16585996',
          },
          {
            title: 'Globe Céleste',
            pageid: 16201796,
            latitude: 48.8594,
            longitude: 2.2955,
            distance_meters: 149.4,
            wikibase_item: 'Q1468897',
          },
          { title: 'Untagged', pageid: 1, latitude: 0, longitude: 0, distance_meters: 400 },
        ],
      }),
    });

    const result = await runToolContract(wikipediaSearchNearby, {
      latitude: 48.85822222,
      longitude: 2.2945,
      radius_meters: 500,
    });

    expect(result.isError).toBeFalsy();
    const results = (result.structuredContent as { results: Array<Record<string, unknown>> })
      .results;
    expect(results[0]).toMatchObject({
      description: 'Tower in Paris, France',
      wikibase_item: 'Q243',
    });
    expect(results[1]?.description).toBe('Palace on the Grand Canal, Venice');
    expect(results[2]).not.toHaveProperty('description');
    expect(results[2]?.wikibase_item).toBe('Q1468897');
    expect(results[3]).not.toHaveProperty('description');
    expect(results[3]).not.toHaveProperty('wikibase_item');

    const text = contentText(result);
    expect(text).toContain('*Palace on the Grand Canal, Venice*');
    expect(text).toContain('**Wikidata QID:** Q243');
    expect(text).toContain('**Wikidata QID:** Q1468897');
    expect(text).not.toContain('undefined');
  });
});
