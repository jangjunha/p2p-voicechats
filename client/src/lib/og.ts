/**
 * OpenGraph link unfurling, done entirely on the client so the server never
 * learns which URLs anyone shares (consistent with the E2E design). In the
 * desktop app we fetch through Tauri's HTTP plugin, which runs the request from
 * the Rust side and so isn't blocked by CORS; in browser dev most cross-origin
 * fetches fail and the card simply doesn't render.
 */
import { isTauri } from './platform';

export interface OgData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

// Per-session memo so a URL repeated across messages unfurls once. The promise
// is cached (not just the result) to dedupe concurrent lookups.
const cache = new Map<string, Promise<OgData | null>>();

const MAX_BYTES = 512 * 1024; // OG tags live in <head>; cap the download.

export function fetchOg(url: string): Promise<OgData | null> {
  let hit = cache.get(url);
  if (!hit) {
    hit = load(url).catch(() => null);
    cache.set(url, hit);
  }
  return hit;
}

async function load(url: string): Promise<OgData | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  return parseOg(html, url);
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const doFetch = isTauri()
      ? (await import('@tauri-apps/plugin-http')).fetch
      : window.fetch.bind(window);
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('html')) return null;
    const text = await res.text();
    return text.slice(0, MAX_BYTES);
  } catch {
    return null;
  }
}

function parseOg(html: string, baseUrl: string): OgData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const el =
        doc.querySelector(`meta[property="${k}"]`) ?? doc.querySelector(`meta[name="${k}"]`);
      const v = el?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return undefined;
  };

  const data: OgData = {
    url: baseUrl,
    title: meta('og:title', 'twitter:title') ?? doc.querySelector('title')?.textContent?.trim(),
    description: meta('og:description', 'twitter:description', 'description'),
    image: resolve(meta('og:image', 'og:image:url', 'twitter:image'), baseUrl),
    siteName: meta('og:site_name'),
  };
  // Nothing worth showing if we couldn't find a title or image.
  if (!data.title && !data.image) return null;
  return data;
}

function resolve(src: string | undefined, base: string): string | undefined {
  if (!src) return undefined;
  try {
    return new URL(src, base).href;
  } catch {
    return undefined;
  }
}
