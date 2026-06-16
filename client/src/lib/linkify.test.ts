import { describe, expect, it } from 'vitest';
import { extractUrls, linkSegments } from './linkify';

describe('linkSegments', () => {
  it('splits text and links', () => {
    const segs = linkSegments('hi https://example.com bye');
    expect(segs).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: ' bye' },
    ]);
  });

  it('trims trailing sentence punctuation off the link', () => {
    const segs = linkSegments('go to https://example.com/path.');
    expect(segs[1]).toEqual({
      type: 'link',
      value: 'https://example.com/path',
      href: 'https://example.com/path',
    });
    expect(segs[2]).toEqual({ type: 'text', value: '.' });
  });

  it('drops an unbalanced trailing paren', () => {
    const segs = linkSegments('(see https://example.com/a)');
    expect(segs[1]!.type).toBe('link');
    expect((segs[1] as { href: string }).href).toBe('https://example.com/a');
  });

  it('returns a single text segment when there is no link', () => {
    expect(linkSegments('just text')).toEqual([{ type: 'text', value: 'just text' }]);
  });
});

describe('extractUrls', () => {
  it('dedupes and preserves order', () => {
    const urls = extractUrls('a https://x.com b https://y.com c https://x.com');
    expect(urls).toEqual(['https://x.com', 'https://y.com']);
  });

  it('ignores non-http schemes', () => {
    expect(extractUrls('mailto:a@b.com and ftp://x')).toEqual([]);
  });
});
