/**
 * @fileoverview wikipedia_search_nearby tool — find geotagged Wikipedia articles near a coordinate.
 * @module mcp-server/tools/definitions/wikipedia-search-nearby.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdown } from '@/mcp-server/tools/utils/escape-markdown.js';
import {
  GEOSEARCH_MAX_LIMIT,
  GEOSEARCH_MAX_RADIUS_METERS,
  GEOSEARCH_MIN_RADIUS_METERS,
  getWikipediaService,
  isMalformedLanguage,
} from '@/services/wikipedia/wikipedia-service.js';

/**
 * Truncation guidance for a list with no pagination behind it. MediaWiki's geosearch module has no
 * `offset` or `continue`, and this tool has no filter parameters, so the only routes to the omitted
 * articles are a higher `limit` or several narrower searches — and at the ceiling, only the latter.
 * `truncated` itself is reported the same either way: at the ceiling there is no room to probe past
 * the cap, so a full page is reported as capped.
 */
function truncationGuidance(limit: number): string {
  return limit >= GEOSEARCH_MAX_LIMIT
    ? `Results were capped at Wikipedia's ${GEOSEARCH_MAX_LIMIT}-result ceiling; more matches may exist. Reduce radius_meters and sweep adjacent sub-areas for exhaustive coverage — geosearch offers no pagination past the limit.`
    : `Results were capped. Raise limit (max ${GEOSEARCH_MAX_LIMIT}) to retrieve more, or reduce radius_meters and sweep adjacent sub-areas for exhaustive coverage — geosearch offers no pagination past the limit.`;
}

export const wikipediaSearchNearby = tool('wikipedia_search_nearby', {
  title: 'Search Wikipedia Nearby',
  description:
    'Find Wikipedia articles about places near a geographic coordinate. Returns articles sorted by distance from the query point, with titles, short descriptions, Wikidata QIDs, page IDs, coordinates, and distance in meters. Useful for "what is notable near X?" research workflows. Only articles carrying their own coordinate tag (GeoData, set on the article itself — not the Wikidata item\'s coordinate) are returned, and that tag is what places and measures each result; not all articles about locations are geotagged, and an article whose tag is wrong appears where the tag puts it, which its description usually makes plain.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().describe('WGS 84 latitude in decimal degrees (range: −90 to 90).'),
    longitude: z.number().describe('WGS 84 longitude in decimal degrees (range: −180 to 180).'),
    radius_meters: z
      .number()
      .int()
      .min(GEOSEARCH_MIN_RADIUS_METERS)
      .default(1000)
      .describe(
        `Search radius in meters (default 1000, min ${GEOSEARCH_MIN_RADIUS_METERS}, max ${GEOSEARCH_MAX_RADIUS_METERS} — the MediaWiki geosearch bounds). Must be an integer; a value above the maximum is clamped to it.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(GEOSEARCH_MAX_LIMIT)
      .default(10)
      .describe(
        `Maximum number of results to return (default 10, max ${GEOSEARCH_MAX_LIMIT} — the MediaWiki geosearch ceiling). Must be a positive integer. Geosearch has no pagination, so articles past this limit are only reachable by raising it or searching narrower radii.`,
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
            pageid: z
              .number()
              .describe(
                'Stable numeric Wikipedia page ID — a durable reference for cross-referencing or de-duplication. Not a tool input; pass the title to follow-up tools.',
              ),
            latitude: z
              .number()
              .describe("Latitude of the article's own coordinate tag, in decimal degrees."),
            longitude: z
              .number()
              .describe("Longitude of the article's own coordinate tag, in decimal degrees."),
            distance_meters: z.number().describe('Distance from the query coordinate in meters.'),
            description: z
              .string()
              .optional()
              .describe(
                'Short description of the article subject (e.g. "Tower in Paris, France"). Absent when the article has none.',
              ),
            wikibase_item: z
              .string()
              .optional()
              .describe(
                'Wikidata QID (e.g. "Q243") for chaining into wikidata-mcp-server. Absent when the article has no Wikidata item.',
              ),
          })
          .describe('A single geotagged article result.'),
      )
      .describe('Geotagged articles sorted ascending by distance_meters.'),
    language: z.string().describe('Language edition queried.'),
  }),

  // Agent-facing context — echoes the search parameters, truncation disclosure, plus
  // an optional notice when nothing matched. Reaches both structuredContent and content[].
  enrichment: {
    queryLatitude: z.number().describe('Latitude used for the search.'),
    queryLongitude: z.number().describe('Longitude used for the search.'),
    radiusMetersUsed: z.number().describe('Radius in meters used for the search.'),
    truncated: z
      .boolean()
      .describe(
        'True when more articles matched than the limit allowed. Established by probing one result past the limit, so a match count landing exactly on the limit reports false — except at the 500 ceiling, where no probe is possible and any full page reports true.',
      ),
    shown: z.number().describe('Number of results returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results were capped (raise limit, or — at the 500 ceiling — sweep narrower radii) or when no geotagged articles were found (increase radius). Absent when neither applies.',
      ),
  },

  errors: [
    {
      reason: 'invalid_coordinates',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Latitude or longitude is outside valid WGS 84 range.',
      recovery: 'Latitude must be between −90 and 90; longitude between −180 and 180.',
    },
    {
      reason: 'invalid_language',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The language is not a valid BCP 47 code, or names a Wikipedia edition that does not exist.',
      recovery: 'Use a valid BCP 47 language code such as "fr", "de", or "ja".',
    },
  ],

  async handler(input, ctx) {
    const svc = getWikipediaService();

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

    const radiusMeters = Math.min(input.radius_meters, GEOSEARCH_MAX_RADIUS_METERS);
    const { limit, language } = input;

    if (isMalformedLanguage(language)) {
      throw ctx.fail(
        'invalid_language',
        `Invalid language code "${language}". Use a BCP 47 language code such as "fr", "de", or "ja".`,
        { language, ...ctx.recoveryFor('invalid_language') },
      );
    }

    // Reject a code that names no Wikipedia edition, checked against the live sitematrix registry
    // (skipped when a single-instance base-URL override is set — that host may serve any editions).
    if (await svc.isUnknownEdition(language, ctx)) {
      throw ctx.fail(
        'invalid_language',
        `Language edition "${language}" does not exist on Wikipedia. Use a valid Wikipedia language code such as "fr", "de", or "ja".`,
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

    const { results, truncated } = await svc.searchNearby(
      input.latitude,
      input.longitude,
      radiusMeters,
      limit,
      language,
      ctx,
    );

    ctx.enrich({
      queryLatitude: input.latitude,
      queryLongitude: input.longitude,
      radiusMetersUsed: radiusMeters,
    });
    if (truncated) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: limit,
        guidance: truncationGuidance(limit),
      });
    } else {
      ctx.enrich({ shown: results.length, cap: limit, truncated: false });
    }

    if (results.length === 0) {
      ctx.enrich.notice(
        `No geotagged Wikipedia articles found within ${radiusMeters}m of (${input.latitude}, ${input.longitude}). Try increasing radius_meters or verify the coordinates are correct.`,
      );
    }

    ctx.log.info('Geo search complete', { count: results.length, language });

    return { results, language };
  },

  // Upstream titles are escaped on the way into the markdown; structuredContent keeps them raw.
  format: (result) => {
    const lines: string[] = [`**${result.results.length} articles** (${result.language})\n`];
    for (const item of result.results) {
      lines.push(`### ${escapeMarkdown(item.title)}`);
      if (item.description) lines.push(`*${escapeMarkdown(item.description)}*`);
      lines.push(
        `**Page ID:** ${item.pageid} | **Distance:** ${item.distance_meters}m | **Coords:** (${item.latitude}, ${item.longitude})${item.wikibase_item ? ` | **Wikidata QID:** ${item.wikibase_item}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
