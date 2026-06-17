import { describe, expect, it } from 'vitest';
import {
  CHUNK_PAYLOAD_BYTES,
  FrameAssembler,
  codecCandidates,
  encodeConfigMsg,
  encodeKeyframeRequest,
  packetizeFrame,
  parseMessage,
  type VideoChunkMsg,
} from './broadcast';

function vchunk(
  over: Partial<VideoChunkMsg> & { frameSeq: number; chunkIndex: number; chunkCount: number },
): VideoChunkMsg {
  return {
    kind: 'video',
    keyFrame: false,
    timestampUs: 0,
    payload: new Uint8Array([0]),
    ...over,
  };
}

describe('wire framing', () => {
  it('round-trips a single-chunk video frame', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const packets = packetizeFrame(data, 7, true, 1234.5);
    expect(packets).toHaveLength(1);
    const msg = parseMessage(packets[0]!);
    expect(msg.kind).toBe('video');
    if (msg.kind !== 'video') return;
    expect(msg.keyFrame).toBe(true);
    expect(msg.frameSeq).toBe(7);
    expect(msg.chunkIndex).toBe(0);
    expect(msg.chunkCount).toBe(1);
    expect(msg.timestampUs).toBe(1234.5);
    expect([...msg.payload]).toEqual([1, 2, 3, 4, 5]);
  });

  it('splits a large frame and reassembles it byte-for-byte', () => {
    const data = new Uint8Array(CHUNK_PAYLOAD_BYTES * 2 + 100);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const packets = packetizeFrame(data, 3, true, 0);
    expect(packets).toHaveLength(3);

    const a = new FrameAssembler();
    let frame;
    for (const p of packets) {
      const msg = parseMessage(p);
      if (msg.kind === 'video') frame = a.push(msg).frame;
    }
    expect(frame).toBeDefined();
    expect(frame!.keyFrame).toBe(true);
    expect(frame!.data.length).toBe(data.length);
    expect(frame!.data).toEqual(data);
  });

  it('round-trips a config message', () => {
    const msg = parseMessage(encodeConfigMsg('avc1.640028'));
    expect(msg).toEqual({ kind: 'config', codec: 'avc1.640028' });
  });

  it('round-trips a keyframe request', () => {
    expect(parseMessage(encodeKeyframeRequest())).toEqual({ kind: 'keyframe-request' });
  });

  it('reports malformed buffers as unknown', () => {
    expect(parseMessage(new ArrayBuffer(0)).kind).toBe('unknown');
    expect(parseMessage(new Uint8Array([0xff]).buffer).kind).toBe('unknown'); // bad type
    expect(parseMessage(new Uint8Array([0x01, 0x00]).buffer).kind).toBe('unknown'); // short video header
  });
});

describe('FrameAssembler', () => {
  it('cannot use a delta before any keyframe and asks for one', () => {
    const a = new FrameAssembler();
    const r = a.push(vchunk({ frameSeq: 0, chunkIndex: 0, chunkCount: 1, keyFrame: false }));
    expect(r.frame).toBeUndefined();
    expect(r.needKeyframe).toBe(true);
  });

  it('emits a keyframe then in-order deltas', () => {
    const a = new FrameAssembler();
    expect(a.push(vchunk({ frameSeq: 0, chunkIndex: 0, chunkCount: 1, keyFrame: true })).frame).toBeDefined();
    const r = a.push(vchunk({ frameSeq: 1, chunkIndex: 0, chunkCount: 1 }));
    expect(r.frame).toBeDefined();
    expect(r.frame!.keyFrame).toBe(false);
    expect(r.needKeyframe).toBeUndefined();
  });

  it('reassembles a multi-chunk frame regardless of arrival order', () => {
    const a = new FrameAssembler();
    const r0 = a.push(
      vchunk({ frameSeq: 0, chunkIndex: 1, chunkCount: 2, keyFrame: true, payload: new Uint8Array([3, 4]) }),
    );
    expect(r0.frame).toBeUndefined(); // still waiting on chunk 0
    const r1 = a.push(
      vchunk({ frameSeq: 0, chunkIndex: 0, chunkCount: 2, keyFrame: true, payload: new Uint8Array([1, 2]) }),
    );
    expect(r1.frame).toBeDefined();
    expect([...r1.frame!.data]).toEqual([1, 2, 3, 4]);
  });

  it('requests a keyframe after a dropped frame and recovers on the next keyframe', () => {
    const a = new FrameAssembler();
    a.push(vchunk({ frameSeq: 0, chunkIndex: 0, chunkCount: 1, keyFrame: true }));
    // Frame seq 1 never arrives; seq 2 shows the gap.
    const gap = a.push(vchunk({ frameSeq: 2, chunkIndex: 0, chunkCount: 1 }));
    expect(gap.frame).toBeUndefined();
    expect(gap.needKeyframe).toBe(true);
    // Deltas stay unusable until a keyframe arrives.
    expect(a.push(vchunk({ frameSeq: 3, chunkIndex: 0, chunkCount: 1 })).frame).toBeUndefined();
    // A fresh keyframe restores decoding.
    expect(a.push(vchunk({ frameSeq: 4, chunkIndex: 0, chunkCount: 1, keyFrame: true })).frame).toBeDefined();
  });

  it('drops a partially-received frame when the next frame begins', () => {
    const a = new FrameAssembler();
    a.push(vchunk({ frameSeq: 0, chunkIndex: 0, chunkCount: 1, keyFrame: true })); // baseline keyframe
    // Frame 1 loses chunk 1 of 2; only chunk 0 arrives.
    expect(a.push(vchunk({ frameSeq: 1, chunkIndex: 0, chunkCount: 2 })).frame).toBeUndefined();
    // Frame 2 arrives, abandoning the incomplete frame 1 — gap → needKeyFrame.
    const r = a.push(vchunk({ frameSeq: 2, chunkIndex: 0, chunkCount: 1 }));
    expect(r.frame).toBeUndefined();
    expect(r.needKeyframe).toBe(true);
  });
});

describe('codecCandidates', () => {
  it('prefers hardware-friendly codecs for auto', () => {
    expect(codecCandidates('auto')[0]).toMatch(/^avc1/);
    expect(codecCandidates('auto')).toContain('vp8');
  });

  it('maps an explicit codec choice to its candidate strings', () => {
    expect(codecCandidates('VP9')).toEqual(['vp09.00.10.08']);
    expect(codecCandidates('AV1').every((c) => c.startsWith('av01'))).toBe(true);
    expect(codecCandidates('H265').every((c) => c.startsWith('hev1'))).toBe(true);
  });
});
