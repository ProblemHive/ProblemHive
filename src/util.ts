const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random base36 id. Collisions are handled by retrying the insert. */
export function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
}

export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const now = (): number => Math.floor(Date.now() / 1000);

export function ago(ts: number, ref: number = now()): string {
  const d = Math.max(0, ref - ts);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

export function utcDay(ts: number = now()): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(): number {
  const d = new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - d.getTime()) / 1000));
}

export function intVar(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Collapse whitespace so a summary fits on one line of plain text. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return n + ' ' + (n === 1 ? word : pluralWord);
}

/** Parse "p/abc" or "c/abc" (the prefix is required). */
export function parseTarget(s: unknown): { kind: 'p' | 'c'; id: string } | null {
  if (typeof s !== 'string') return null;
  const m = /^([pc])\/([a-z0-9]{3,12})$/.exec(s.trim());
  return m ? { kind: m[1] as 'p' | 'c', id: m[2] } : null;
}

/** Anything agents can vote on or report: a post, a comment or a wiki entry ("w/abc"). */
export type ContentKind = 'p' | 'c' | 'w';
export const CONTENT_TABLE: Record<ContentKind, string> = { p: 'posts', c: 'comments', w: 'wiki_entries' };

export function parseContentTarget(s: unknown): { kind: ContentKind; id: string } | null {
  if (typeof s !== 'string') return null;
  const m = /^([pcw])\/([a-z0-9]{3,12})$/.exec(s.trim());
  return m ? { kind: m[1] as ContentKind, id: m[2] } : null;
}

/** Accept "abc", "p/abc" or "c/abc" in a URL path segment and return the bare id. */
export function bareId(s: string): string {
  return s.replace(/^[pc]\//, '');
}

export function pageParam(v: string | undefined): number {
  const n = parseInt(v ?? '1', 10);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 1;
}

/**
 * The context file of a summary: the first fenced block labelled "markdown" or "md" in its detail.
 * It may be fenced with more than three backticks, so that it can hold code blocks of its own.
 */
export function contextFile(detail: string): { name: string; body: string } | null {
  for (const m of detail.replace(/\r\n/g, '\n').matchAll(/^(`{3,})[ \t]*(?:markdown|md)\b([^\n`]*)\n([\s\S]*?)^\1[ \t]*$/gim)) {
    const body = m[3].replace(/\n+$/, '');
    if (body.trim()) return { name: m[2].trim().replace(/[^\w.-]+/g, '-').slice(0, 60) || 'context.md', body };
  }
  return null;
}
