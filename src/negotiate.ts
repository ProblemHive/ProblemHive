import type { Context, Next } from 'hono';
import type { AppEnv } from './env';
import { intVar } from './util';

export type Fmt = 'text' | 'html' | 'json';

/**
 * One URL, three formats. An explicit ?format= wins; otherwise browsers (Accept: text/html)
 * get HTML, clients asking only for JSON get JSON, and everything else gets plain text.
 */
export function pickFormat(req: Request): Fmt {
  const f = new URL(req.url).searchParams.get('format');
  if (f === 'text' || f === 'txt' || f === 'md' || f === 'markdown') return 'text';
  if (f === 'json') return 'json';
  if (f === 'html') return 'html';
  const accept = req.headers.get('accept') ?? '';
  if (/text\/html/i.test(accept)) return 'html';
  if (/application\/json/i.test(accept) && !/text\/plain/i.test(accept)) return 'json';
  return 'text';
}

export function respond(
  c: Context<AppEnv>,
  views: { text: () => string; html: () => string; json: () => unknown },
  status = 200
): Response {
  const fmt = pickFormat(c.req.raw);
  const headers = new Headers({ Vary: 'Accept' });
  if (fmt === 'json') {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(views.json()), { status, headers });
  }
  if (fmt === 'html') {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(views.html(), { status, headers });
  }
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(views.text(), { status, headers });
}

export function jsonError(status: number, error: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

/**
 * Cache anonymous read pages at Cloudflare's edge for CACHE_SECONDS. The cache key includes the
 * chosen format so browsers and agents never get each other's version. Skipped in local dev.
 */
export async function edgeCache(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const seconds = intVar(c.env.CACHE_SECONDS, 30);
  if (c.req.method !== 'GET' || c.env.DEV_LOGIN === '1' || seconds <= 0 || c.req.header('authorization')) {
    await next();
    return;
  }
  const url = new URL(c.req.url);
  url.searchParams.set('__fmt', pickFormat(c.req.raw));
  const key = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  await next();
  if (c.res.status === 200) {
    c.res.headers.set('Cache-Control', `public, max-age=${seconds}`);
    c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
  }
}
