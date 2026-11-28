import { logger } from '../utils/logger';
import type { CachePurger } from './stellar';

export type HttpCachePurgerOptions = {
  url: string;
  /** Sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  timeoutMs: number;
  /** Retries after the first attempt (bounded). */
  retries: number;
  /** Base delay for exponential backoff between attempts. */
  retryDelayMs?: number;
};

/**
 * POSTs `{ keys }` to a CDN purge webhook. Retries a bounded number of times
 * with exponential backoff; the caller (indexer) treats failures as best-effort.
 */
export function createHttpCachePurger(options: HttpCachePurgerOptions): CachePurger {
  const retryDelayMs = options.retryDelayMs ?? 250;

  const attempt = async (keys: string[]): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({ keys }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`purge webhook returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async purge(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      let lastError: unknown;
      for (let i = 0; i <= options.retries; i++) {
        try {
          await attempt(keys);
          return;
        } catch (err) {
          lastError = err;
          if (i < options.retries) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** i));
          }
        }
      }
      logger.warn('Cache purge webhook failed', {
        url: options.url,
        keys,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      throw lastError;
    },
  };
}
