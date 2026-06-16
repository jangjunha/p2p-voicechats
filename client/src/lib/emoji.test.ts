import { describe, expect, it } from 'vitest';
import { EMOJI, replaceEmojiShortcodes, searchEmoji } from './emoji';

describe('replaceEmojiShortcodes', () => {
  it('expands known shortcodes', () => {
    expect(replaceEmojiShortcodes('lol :joy:')).toBe('lol 😂');
    expect(replaceEmojiShortcodes(':fire: it up :100:')).toBe('🔥 it up 💯');
  });

  it('supports +1/-1 style codes', () => {
    expect(replaceEmojiShortcodes(':+1:')).toBe('👍');
    expect(replaceEmojiShortcodes(':-1:')).toBe('👎');
  });

  it('leaves unknown codes untouched', () => {
    expect(replaceEmojiShortcodes('a :not_an_emoji: b')).toBe('a :not_an_emoji: b');
  });

  it('does not mangle bare colons or URLs', () => {
    expect(replaceEmojiShortcodes('time 10:30')).toBe('time 10:30');
    expect(replaceEmojiShortcodes('see https://x.com')).toBe('see https://x.com');
  });
});

describe('searchEmoji', () => {
  it('ranks prefix matches first', () => {
    const hits = searchEmoji('smi');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.code.startsWith('smi')).toBe(true);
    expect(hits[0]!.char).toBe(EMOJI[hits[0]!.code]);
  });

  it('returns nothing for an empty query', () => {
    expect(searchEmoji('')).toEqual([]);
  });

  it('honors the limit', () => {
    expect(searchEmoji('a', 3).length).toBeLessThanOrEqual(3);
  });
});
