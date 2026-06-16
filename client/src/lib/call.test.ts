import { describe, expect, it } from 'vitest';
import { visibleStreams } from './call';

type T = { kind: 'audio' | 'video'; muted?: boolean; ended?: boolean };

let nextId = 0;
function stream(...tracks: T[]) {
  const ts = tracks.map((t) => ({
    kind: t.kind,
    muted: t.muted ?? false,
    readyState: (t.ended ? 'ended' : 'live') as MediaStreamTrackState,
  }));
  return {
    id: `s${nextId++}`,
    getTracks: () => ts,
    getVideoTracks: () => ts.filter((t) => t.kind === 'video'),
  };
}

describe('visibleStreams', () => {
  it('always keeps an audio-only voice stream', () => {
    const s = stream({ kind: 'audio' });
    expect(visibleStreams([s])).toEqual([s]);
  });

  it('keeps a screen share while its video is live', () => {
    const s = stream({ kind: 'video' }, { kind: 'audio' });
    expect(visibleStreams([s])).toEqual([s]);
  });

  it('hides a screen share once its video track is muted (sharer stopped)', () => {
    const s = stream({ kind: 'video', muted: true }, { kind: 'audio' });
    expect(visibleStreams([s])).toEqual([]);
  });

  it('hides a screen share whose video track has ended', () => {
    const s = stream({ kind: 'video', ended: true });
    expect(visibleStreams([s])).toEqual([]);
  });

  it('drops a stream with no tracks left', () => {
    expect(visibleStreams([stream()])).toEqual([]);
  });

  it('shows only the fresh re-share, not the stale frozen one', () => {
    const stale = stream({ kind: 'video', muted: true }, { kind: 'audio' });
    const fresh = stream({ kind: 'video' }, { kind: 'audio' });
    expect(visibleStreams([stale, fresh])).toEqual([fresh]);
  });
});
