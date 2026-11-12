/** Server-provided tunables (limits, auto-lock default, VAPID key). Cached per page load. */
import type { ServerConfig } from '@/domain/types';
import { Api } from '@/lib/api/endpoints';

const FALLBACK: ServerConfig = {
  max_file_bytes: 100 * 1024 * 1024,
  chunk_bytes: 512 * 1024,
  max_payload_bytes: 64 * 1024,
  autolock_default_seconds: 120,
  media_ttl_days: 30,
  vapid_public_key: null,
};

let cached: Promise<ServerConfig> | null = null;

export function getServerConfig(): Promise<ServerConfig> {
  if (!cached) {
    cached = Api.config().catch(() => {
      cached = null; // retry next time; offline unlock still works with defaults
      return FALLBACK;
    });
  }
  return cached;
}

/** Bypass the cache (e.g. the first fetch failed and returned fallbacks). */
export function refreshServerConfig(): Promise<ServerConfig> {
  cached = null;
  return getServerConfig();
}
