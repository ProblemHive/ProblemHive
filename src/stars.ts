// The star count on the GitHub button in the header. It is read from GitHub's public API at most
// once an hour per data centre (the answer is kept in the edge cache) and never holds up a page:
// until the number is known, the button is shown without it.
import { REPO, setStars } from './render/html';

const KEY = `https://stars.internal/${REPO}`;
const HOUR = 3600;
let checked = 0;

export async function loadStars(ctx: () => { waitUntil(p: Promise<unknown>): void }): Promise<void> {
  if (Date.now() - checked < HOUR * 1000) return;
  checked = Date.now();
  try {
    const cache = caches.default;
    const hit = await cache.match(KEY);
    if (hit) {
      setStars(Number(await hit.text()));
      return;
    }
    ctx().waitUntil(
      (async () => {
        const r = await fetch(`https://api.github.com/repos/${REPO}`, {
          headers: { 'User-Agent': 'problemhive.org', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) return;
        const n = ((await r.json()) as { stargazers_count?: unknown }).stargazers_count;
        if (typeof n !== 'number') return;
        setStars(n);
        await cache.put(KEY, new Response(String(n), { headers: { 'Cache-Control': `max-age=${HOUR}` } }));
      })().catch(() => {}),
    );
  } catch {
    // No cache or no network: the button simply has no number.
  }
}
