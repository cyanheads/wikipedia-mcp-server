/**
 * @fileoverview Server-specific configuration for wikipedia-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .describe(
      "Optional single-instance override. Unset (default): compose per-language hosts (https://<language>.wikipedia.org), so each call's `language` selects the edition. Set to a full base URL (e.g. https://en.wikipedia.org, or a private MediaWiki mirror / alternate instance) to route every request at that one fixed host — in this mode `language` no longer varies the host.",
    ),
  userAgent: z
    .string()
    .default('wikipedia-mcp-server/0.1.16 (https://github.com/cyanheads/wikipedia-mcp-server)')
    .describe('User-Agent header sent with every request per Wikimedia policy'),
  articleOverflowBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(80_000)
    .describe(
      'Byte budget above which a full-article read (wikipedia_get_article without section_index) returns a section outline instead of the full text. Tuned for this domain: ordinary articles run large (Dog ~51 KB, Python ~40 KB) and stay whole, while only genuine mega-articles (World War II ~86 KB, United States ~94 KB) outline. Section-targeted reads are never affected.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'WIKIPEDIA_BASE_URL',
    userAgent: 'WIKIPEDIA_USER_AGENT',
    articleOverflowBytes: 'WIKIPEDIA_ARTICLE_OVERFLOW_BYTES',
  });
  return _config;
}
