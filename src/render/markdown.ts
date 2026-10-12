// A small Markdown renderer for the site's own documents (rules, API docs). It covers what those
// files use: headings, paragraphs, lists, tables, fenced code, and inline code, bold and links.
// Everything is escaped first, so it is safe for any text, but it is not used for agent content.
import { esc } from '../util';

/** A code block with a copy button. Also used for fenced blocks in post and comment details. */
export function codeBlock(code: string, label: string, wrap = false): string {
  return `<div class="code${wrap ? ' wrap' : ''}"><div class="codebar"><span>${esc(label || 'code')}</span><button type="button" data-copy-code>Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
}

// Site pages that are linked automatically when a document mentions their path in plain prose.
const SITE_PATHS = /(^|[\s(])(\/(?:keys|submit|subs|rules|needs|changelog|models|faq|license|skill\.md|skill|docs\/write|me\/feed|mod\/log|mod\/team|mod\/routines|mod\/skill\.md|mod\/skill))(?=[\s.,;:)]|$)/g;

function inline(s: string): string {
  return s
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 2
        ? `<code>${esc(part.slice(1, -1))}</code>`
        : esc(part)
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>')
            .replace(SITE_PATHS, '$1<a href="$2">$2</a>')
    )
    .join('');
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/**
 * The headings of a document with the id each one gets on the page, so sections can be linked as
 * /page#id. A heading may fix its id with a trailing "{#id}"; otherwise it is made from its words.
 */
export function markdownHeadings(md: string): Heading[] {
  const seen = new Map<string, number>();
  const out: Heading[] = [];
  let fence = '';
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const f = /^(`{3,})/.exec(line);
    if (f) {
      fence = fence ? (line.startsWith(fence) ? '' : fence) : f[1];
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,4})\s+(.*?)(?:\s*\{#([a-z0-9-]+)\})?\s*$/.exec(line);
    if (!h) continue;
    const base = h[3] ?? (h[2].toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ level: h[1].length, text: h[2], id: n === 1 ? base : `${base}-${n}` });
  }
  return out;
}

export function markdownHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings = markdownHeadings(md);
  let headingNo = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^(`{3,})(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].startsWith(fence[1]) && !lines[i].slice(fence[1].length).trim())) body.push(lines[i++]);
      i++;
      // Prose in a block (a prompt to copy) wraps; code keeps its lines.
      const lang = fence[2].trim();
      out.push(codeBlock(body.join('\n'), lang, lang === 'prompt' || lang === 'text'));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const h = headings[headingNo++];
      // Sections below the title can be linked to: each gets an id and a small link that shows on hover.
      out.push(
        level === 1 || !h
          ? `<h${level}>${inline(h?.text ?? heading[2])}</h${level}>`
          : `<h${level} id="${h.id}">${inline(h.text)} <a class="anchor" href="#${h.id}" aria-label="Link to this section">#</a></h${level}>`
      );
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }
    const item = (l: string) => /^\s*(?:(\d+)\.|[-*])\s+(.*)$/.exec(l);
    const first = item(line);
    if (first) {
      const ordered = first[1] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = item(lines[i]);
        if (!m || (m[1] !== undefined) !== ordered) break;
        items.push(`<li${ordered ? ` value="${m[1]}"` : ''}>${inline(m[2])}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|`{3,}|\s*(?:\d+\.|[-*])\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
