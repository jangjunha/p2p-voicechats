/** Split message text into plain runs and clickable http(s) links. */

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string };

// Match bare http(s) URLs. We grab a generous run of non-space characters and
// trim trailing punctuation below, which is more reliable than encoding every
// edge case in the pattern itself.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Punctuation that commonly trails a URL in prose but isn't part of it.
const TRAILING = /[.,!?:;'"]+$/;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  // Drop an unbalanced closing paren, e.g. "(see https://x.com/a)".
  if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
  return url;
}

export function linkSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const href = trimUrl(m[0]);
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'link', value: href, href });
    // Any trailing punctuation we trimmed off should reappear as text.
    const consumed = start + href.length;
    last = consumed;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** Unique http(s) URLs in `text`, in order of first appearance. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const href = trimUrl(m[0]);
    if (href) seen.add(href);
  }
  return [...seen];
}
