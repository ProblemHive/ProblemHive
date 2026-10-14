// The papers, data and code a thread uses, gathered from its post and comments: every `sources.json`
// block, every code block with a file name on the line above it, and every run record. Shown beside the
// post, so a reader does not have to search the comments for them. The same rules as the archive
// repository's export (github.com/ProblemHive/archive, tools/export.mjs), so both list the same things.

export interface SourceEntry {
  title: string;
  doi?: string;
  url?: string;
  sha256?: string;
  license?: string;
  note?: string;
  /** Where it was listed first: `p/<id>` or `c/<id>`; `also` counts further listings of the same source. */
  from: string;
  also: number;
}
export interface FileEntry {
  name: string;
  from: string;
}
export interface RunEntry {
  id: string;
  from: string;
}
export interface ThreadResources {
  sources: SourceEntry[];
  files: FileEntry[];
  runs: RunEntry[];
}

// Fences of any length: a block ends at a line with the same number of backticks.
const FENCE = /^(`{3,})([^\n`]*)\n([\s\S]*?)^\1[ \t]*$/gm;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A file name as written above a code block, or null: plain parts, no "..", an extension. */
function fileName(raw: string): string | null {
  const t = raw.trim().replace(/^`+|`+$/g, '').replace(/:$/, '').trim();
  if (!t || t.length > 120 || /\s/.test(t)) return null;
  const parts = t.split('/');
  if (parts.some((p) => p === '..' || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(p))) return null;
  const base = parts[parts.length - 1];
  if (!/\.[A-Za-z0-9]{1,10}$/.test(base) && !/^(Makefile|Dockerfile)$/.test(base)) return null;
  return t;
}

function sourcesIn(text: string, from: string): SourceEntry[] {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return [];
  }
  const out: SourceEntry[] = [];
  for (const e of (Array.isArray(list) ? list : [list]) as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || typeof e.title !== 'string' || !e.title.trim()) continue;
    const s: SourceEntry = { title: oneLine(e.title).slice(0, 300), from, also: 0 };
    if (typeof e.doi === 'string' && /^10\.\d{4,9}\/\S+$/.test(e.doi.trim())) s.doi = e.doi.trim();
    if (typeof e.url === 'string' && /^https:\/\/\S+$/.test(e.url.trim())) s.url = e.url.trim();
    if (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(e.sha256.trim())) s.sha256 = e.sha256.trim().toLowerCase();
    if (typeof e.license === 'string' && e.license.trim()) s.license = oneLine(e.license).slice(0, 60);
    if (typeof e.note === 'string' && e.note.trim()) s.note = oneLine(e.note).slice(0, 200);
    out.push(s);
  }
  return out;
}

export function threadResources(post: { id: string; detail: string }, comments: { id: string; detail: string; removed_at: number | null }[]): ThreadResources {
  const res: ThreadResources = { sources: [], files: [], runs: [] };
  const seen = new Map<string, SourceEntry>();
  const take = (from: string, detail: string) => {
    const text = (detail ?? '').replace(/\r\n/g, '\n');
    for (const m of text.matchAll(FENCE)) {
      const body = m[3];
      if (/^\s*problemhive-(tools|sandbox) run record v1\b/.test(body)) {
        const id = /^id: ([a-z0-9]+)\s*$/im.exec(body)?.[1];
        if (id && !res.runs.some((r) => r.id === id)) res.runs.push({ id, from });
        continue;
      }
      const before = text.slice(0, m.index).replace(/\s+$/, '');
      const info = m[2].trim().split(/\s+/);
      const name = fileName(before.slice(before.lastIndexOf('\n') + 1)) ?? (info[1] ? fileName(info[1]) : null);
      if (!name) continue;
      // A sources.json block is shown as the papers it lists, not as a code file.
      if (name.split('/').pop() !== 'sources.json') res.files.push({ name, from });
      else {
        for (const s of sourcesIn(body, from)) {
          const key = (s.doi ?? s.url ?? s.title).toLowerCase();
          const had = seen.get(key);
          if (had) {
            had.also++;
            had.sha256 ??= s.sha256;
            had.license ??= s.license;
            had.url ??= s.url;
          } else {
            seen.set(key, s);
            res.sources.push(s);
          }
        }
      }
    }
  };
  take(`p/${post.id}`, post.detail);
  for (const c of comments) if (c.removed_at === null) take(`c/${c.id}`, c.detail);
  return res;
}
