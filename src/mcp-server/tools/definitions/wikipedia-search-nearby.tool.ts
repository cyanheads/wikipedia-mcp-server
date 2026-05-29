/**
 * @fileoverview wikipedia_search_nearby tool — find geotagged Wikipedia articles near a coordinate.
 * @module mcp-server/tools/definitions/wikipedia-search-nearby.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWikipediaService } from '@/services/wikipedia/wikipedia-service.js';

export const wikipediaSearchNearby = tool('wikipedia_search_nearby', {
  title: 'Search Wikipedia Nearby',
  description:
    'Find Wikipedia articles about places near a geographic coordinate. Returns articles sorted by distance from the query point, with titles, page IDs, coordinates, and distance in meters. Useful for "what is notable near X?" research workflows. Only articles with geographic coordinates in their Wikidata record are returned — not all articles about locations are geotagged.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().describe('WGS 84 latitude in decimal degrees (range: −90 to 90).'),
    longitude: z.number().describe('WGS 84 longitude in decimal degrees (range: −180 to 180).'),
    radius_meters: z
      .number()
      .int()
      .min(1)
      .default(1000)
      .describe('Search radius in meters (default 1000, max 10000). Must be a positive integer.'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        'Maximum number of results to return (default 10, max 50). Must be a positive integer.',
      ),
    language: z
      .string()
      .default('en')
      .describe('Wikipedia language edition code (default "en"). Examples: "fr", "de", "ja".'),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            title: z.string().describe('Article title (e.g. "Eiffel Tower").'),
            pageid: z.number().describe('Wikipedia page ID — use as input to other tools.'),
            latitude: z.number().describe('Article subject latitude in decimal degrees.'),
            longitude: z.number().describe('Article subject longitude in decimal degrees.'),
            distance_meters: z.number().describe('Distance from the query coordinate in meters.'),
          })
          .describe('A single geotagged article result.'),
      )
      .describe('Geotagged articles sorted ascending by distance_meters.'),
    total_results: z.number().describe('Number of results returned.'),
    query_latitude: z.number().describe('Latitude used for the search.'),
    query_longitude: z.number().describe('Longitude used for the search.'),
    radius_meters_used: z.number().describe('Radius in meters used for the search.'),
    language: z.string().describe('Language edition queried.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No geotagged articles found within the search radius.',
      recovery: 'Increase radius_meters or verify the coordinates are correct and retry.',
    },
    {
      reason: 'invalid_coordinates',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Latitude or longitude is outside valid WGS 84 range.',
      recovery: 'Latitude must be between −90 and 90; longitude between −180 and 180.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language code is not a valid BCP 47 code.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    // Validate coordinate ranges
    if (input.latitude < -90 || input.latitude > 90) {
      throw ctx.fail(
        'invalid_coordinates',
        `Latitude ${input.latitude} is out of range (−90 to 90).`,
        {
          latitude: input.latitude,
          ...ctx.recoveryFor('invalid_coordinates'),
        },
      );
    }
    if (input.longitude < -180 || input.longitude > 180) {
      throw ctx.fail(
        'invalid_coordinates',
        `Longitude ${input.longitude} is out of range (−180 to 180).`,
        { longitude: input.longitude, ...ctx.recoveryFor('invalid_coordinates') },
      );
    }

    const radiusMeters = Math.min(input.radius_meters, 10_000);
    const limit = Math.min(input.limit, 50);
    const { language } = input;

    if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    ctx.log.info('Geo search', {
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters,
      limit,
      language,
    });

    const svc = getWikipediaService();
    const { results } = await svc.searchNearby(
      input.latitude,
      input.longitude,
      radiusMeters,
      limit,
      language,
      ctx,
    );

    if (results.length === 0) {
      throw ctx.fail(
        'no_results',
        `No geotagged Wikipedia articles found within ${radiusMeters}m of (${input.latitude}, ${input.longitude}).`,
        {
          latitude: input.latitude,
          longitude: input.longitude,
          radiusMeters,
          recovery: {
            hint: `Increase radius_meters beyond ${radiusMeters} or verify the coordinates are correct.`,
          },
        },
      );
    }

    ctx.log.info('Geo search complete', { count: results.length, language });

    return {
      results,
      total_results: results.length,
      query_latitude: input.latitude,
      query_longitude: input.longitude,
      radius_meters_used: radiusMeters,
      language,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_results} articles** near (${result.query_latitude}, ${result.query_longitude}) within ${result.radius_meters_used}m (${result.language})\n`,
    ];
    for (const item of result.results) {
      lines.push(`### ${item.title}`);
      lines.push(
        `**Page ID:** ${item.pageid} | **Distance:** ${item.distance_meters}m | **Coords:** (${item.latitude}, ${item.longitude})`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
