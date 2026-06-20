/**
 * @fileoverview Server-specific configuration for wikipedia-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://en.wikipedia.org')
    .describe('Base Wikipedia URL — language selection is per-call, not global'),
  userAgent: z
    .string()
    .default('wikipedia-mcp-server/0.1.10 (https://github.com/cyanheads/wikipedia-mcp-server)')
    .describe('User-Agent header sent with every request per Wikimedia policy'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'WIKIPEDIA_BASE_URL',
    userAgent: 'WIKIPEDIA_USER_AGENT',
  });
  return _config;
}
