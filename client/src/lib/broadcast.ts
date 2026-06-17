/**
 * Single-encode screen broadcast over DataChannels.
 *
 * In the P2P mesh (see call.ts) a WebRTC video track is encoded once *per
 * peer* — four viewers means the GPU/CPU encodes the same screen four times.
 * This module breaks that coupling: the screen is captured and encoded **once**
 * with WebCodecs, and the resulting `EncodedVideoChunk`s are fanned out as bytes
 * over one `RTCDataChannel` per viewer. Encoding cost is now constant in the
 * number of viewers; only upload bandwidth still scales (unavoidable without an
 * SFU).
 *
 * Latency is the hard constraint, so the transport is deliberately thin:
 *   - DataChannels are `{ ordered: true, maxRetransmits: 0 }` — SCTP delivers
 *     whatever arrives in order and *drops* (never retransmits/HOL-blocks) the
 *     rest. A lost packet means a lost frame, not a stall.
 *   - There is no jitter buffer; decoded frames are rendered immediately and a
 *     newer frame supersedes an undisplayed one.
 *   - Loss is recovered with keyframes: the receiver detects a gap (or its very
 *     first frame) and asks the sender for an IDR, debounced on both ends.
 *
 * Audio is intentionally left on the WebRTC mesh (Opus is cheap to encode N
 * times and keeps congestion control + A/V machinery). Only video moves here.
 *
 * The wire framing and reassembly are pure functions (testable without a
 * browser); the encoder/decoder halves wrap WebCodecs and the breakout-box API.
 */
import type { BroadcastSettings } from './call';

// ---------- wire framing (pure) ----------

export const MSG_VIDEO = 0x01;
export const MSG_KEYFRAME_REQUEST = 0x02;
export const MSG_CONFIG = 0x03;

/** type(1) flags(1) frameSeq(u32) chunkIndex(u16) chunkCount(u16) timestamp(f64) */
export const VIDEO_HEADER_BYTES = 18;
/** Payload per DataChannel message; keeps each message well under SCTP limits. */
export const CHUNK_PAYLOAD_BYTES = 16 * 1024;

export interface VideoChunkMsg {
  kind: 'video';
  keyFrame: boolean;
  frameSeq: number;
  chunkIndex: number;
  chunkCount: number;
  timestampUs: number;
  payload: Uint8Array;
}
export interface ConfigMsg {
  kind: 'config';
  codec: string;
}
export interface KeyframeRequestMsg {
  kind: 'keyframe-request';
}
export interface UnknownMsg {
  kind: 'unknown';
}
export type BroadcastMsg = VideoChunkMsg | ConfigMsg | KeyframeRequestMsg | UnknownMsg;

/** Split one encoded frame into DataChannel-sized messages with framing headers. */
export function packetizeFrame(
  data: Uint8Array,
  frameSeq: number,
  keyFrame: boolean,
  timestampUs: number,
  maxPayload = CHUNK_PAYLOAD_BYTES,
): ArrayBuffer[] {
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / maxPayload));
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * maxPayload;
    const slice = data.subarray(start, Math.min(start + maxPayload, data.byteLength));
    const buf = new ArrayBuffer(VIDEO_HEADER_BYTES + slice.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, MSG_VIDEO);
    view.setUint8(1, keyFrame ? 1 : 0);
    view.setUint32(2, frameSeq >>> 0);
    view.setUint16(6, i);
    view.setUint16(8, chunkCount);
    view.setFloat64(10, timestampUs);
    new Uint8Array(buf, VIDEO_HEADER_BYTES).set(slice);
    out.push(buf);
  }
  return out;
}

export function encodeConfigMsg(codec: string): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ codec }));
  const buf = new ArrayBuffer(1 + json.byteLength);
  const bytes = new Uint8Array(buf);
  bytes[0] = MSG_CONFIG;
  bytes.set(json, 1);
  return buf;
}

export function encodeKeyframeRequest(): ArrayBuffer {
  return new Uint8Array([MSG_KEYFRAME_REQUEST]).buffer;
}

export function parseMessage(buf: ArrayBuffer): BroadcastMsg {
  if (buf.byteLength < 1) return { kind: 'unknown' };
  const view = new DataView(buf);
  switch (view.getUint8(0)) {
    case MSG_VIDEO: {
      if (buf.byteLength < VIDEO_HEADER_BYTES) return { kind: 'unknown' };
      return {
        kind: 'video',
        keyFrame: view.getUint8(1) === 1,
        frameSeq: view.getUint32(2),
        chunkIndex: view.getUint16(6),
        chunkCount: view.getUint16(8),
        timestampUs: view.getFloat64(10),
        payload: new Uint8Array(buf, VIDEO_HEADER_BYTES),
      };
    }
    case MSG_CONFIG: {
      try {
        const obj = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 1))) as {
          codec?: unknown;
        };
        if (typeof obj.codec === 'string') return { kind: 'config', codec: obj.codec };
      } catch {
        /* malformed */
      }
      return { kind: 'unknown' };
    }
    case MSG_KEYFRAME_REQUEST:
      return { kind: 'keyframe-request' };
    default:
      return { kind: 'unknown' };
  }
}

export interface AssembledFrame {
  data: Uint8Array;
  keyFrame: boolean;
  timestampUs: number;
}
export interface AssemblerResult {
  /** A complete frame ready to decode, if one just finished. */
  frame?: AssembledFrame;
  /** The receiver should ask the sender for a fresh keyframe. */
  needKeyframe?: boolean;
}

/**
 * Reassembles frames from ordered-but-lossy chunks. Because the channel is
 * ordered, all chunks of a frame arrive before the next frame's chunks; a
 * dropped chunk simply never shows, so a frame is "lost" the moment a chunk
 * with a newer `frameSeq` arrives while the current frame is still incomplete.
 * Deltas are unusable until the first keyframe and after any whole-frame gap,
 * which is when `needKeyframe` is raised.
 */
export class FrameAssembler {
  private seq = -1;
  private count = 0;
  private received = 0;
  private keyFrame = false;
  private timestampUs = 0;
  private chunks: (Uint8Array | undefined)[] = [];
  private haveKeyframe = false;
  private lastEmitted = -1;

  push(msg: VideoChunkMsg): AssemblerResult {
    if (msg.chunkCount === 0) return {};
    if (msg.frameSeq !== this.seq) {
      // A new frame began; any partial previous frame lost a chunk and is gone.
      this.seq = msg.frameSeq;
      this.count = msg.chunkCount;
      this.received = 0;
      this.keyFrame = msg.keyFrame;
      this.timestampUs = msg.timestampUs;
      this.chunks = new Array(msg.chunkCount);
    }
    if (msg.chunkIndex >= this.count) return {};
    if (!this.chunks[msg.chunkIndex]) {
      this.chunks[msg.chunkIndex] = msg.payload;
      this.received++;
    }
    if (this.received < this.count) return {};

    const data = concat(this.chunks, this.count);
    const keyFrame = this.keyFrame;
    const timestampUs = this.timestampUs;
    const seq = this.seq;
    this.seq = -1; // consumed; ignore any duplicate trailing chunks

    if (keyFrame) {
      this.haveKeyframe = true;
      this.lastEmitted = seq;
      return { frame: { data, keyFrame: true, timestampUs } };
    }
    if (!this.haveKeyframe) {
      return { needKeyframe: true }; // delta with no reference yet
    }
    if (this.lastEmitted >= 0 && seq !== ((this.lastEmitted + 1) >>> 0)) {
      // A whole frame was dropped; further deltas would decode garbage.
      this.haveKeyframe = false;
      return { needKeyframe: true };
    }
    this.lastEmitted = seq;
    return { frame: { data, keyFrame: false, timestampUs } };
  }

  /** Forget all reference state; the next usable frame must be a keyframe. */
  reset(): void {
    this.seq = -1;
    this.received = 0;
    this.haveKeyframe = false;
    this.lastEmitted = -1;
  }
}

function concat(parts: (Uint8Array | undefined)[], count: number): Uint8Array {
  let total = 0;
  for (let i = 0; i < count; i++) total += parts[i]?.byteLength ?? 0;
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const p = parts[i];
    if (p) {
      out.set(p, off);
      off += p.byteLength;
    }
  }
  return out;
}

// ---------- codec selection ----------

export interface ChosenEncoderConfig {
  config: VideoEncoderConfig;
  codec: string;
  hardware: boolean;
}

/** Codec strings to try, most-preferred first, for a broadcast-settings choice. */
export function codecCandidates(pref: BroadcastSettings['codec']): string[] {
  switch (pref) {
    case 'H264':
      return ['avc1.640028', 'avc1.42E01F'];
    case 'H265':
      return ['hev1.1.6.L120.90', 'hev1.1.6.L93.B0'];
    case 'VP9':
      return ['vp09.00.10.08'];
    case 'AV1':
      return ['av01.0.08M.08', 'av01.0.04M.08'];
    case 'auto':
    default:
      // Hardware-friendly codecs first so a single encode is also a cheap one.
      return ['avc1.640028', 'avc1.42E01F', 'vp09.00.10.08', 'av01.0.04M.08', 'vp8'];
  }
}

function baseConfig(
  codec: string,
  width: number,
  height: number,
  settings: BroadcastSettings,
): VideoEncoderConfig {
  const cfg: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: Math.max(100_000, settings.maxBitrateKbps * 1000),
    framerate: settings.frameRate || 30,
    latencyMode: 'realtime',
  };
  if (codec.startsWith('avc1')) {
    cfg.avc = { format: 'annexb' }; // SPS/PPS in-band — no out-of-band description
  } else if (codec.startsWith('hev1') || codec.startsWith('hvc1')) {
    (cfg as VideoEncoderConfig & { hevc?: { format: 'annexb' } }).hevc = { format: 'annexb' };
  }
  return cfg;
}

/**
 * Pick a WebCodecs encoder config the platform actually supports for these
 * dimensions, preferring a hardware encoder. Returns null if nothing works.
 */
export async function chooseEncoderConfig(
  settings: BroadcastSettings,
  width: number,
  height: number,
): Promise<ChosenEncoderConfig | null> {
  for (const codec of codecCandidates(settings.codec)) {
    const base = baseConfig(codec, width, height, settings);
    // WebCodecs offers no readback of whether hardware was actually used, so
    // `hardware` is best-effort: true when a prefer-hardware config is accepted.
    for (const hw of ['prefer-hardware', 'no-preference'] as const) {
      try {
        const support = await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: hw });
        if (support.supported && support.config) {
          return { config: support.config, codec, hardware: hw === 'prefer-hardware' };
        }
      } catch {
        /* try the next acceleration/codec */
      }
    }
  }
  return null;
}

/** Whether this webview can encode/decode and bridge raw frames to/from tracks. */
export function broadcastVideoSupported(): boolean {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined'
  );
}

// ---------- tuning ----------

/** Safety-net keyframe cadence even if no viewer asks for one. */
const KEYFRAME_INTERVAL_MS = 2000;
/** Coalesce keyframe demand so a burst of requests costs at most one IDR. */
const KEYFRAME_MIN_INTERVAL_MS = 250;
/** Per-viewer send buffer ceiling; above it we drop frames to bound latency. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** Drop capture frames rather than let the encoder queue (and latency) grow. */
const MAX_ENCODE_QUEUE = 2;

export interface SenderStats {
  fps: number;
  kbps: number;
  codec: string;
  hardware: boolean;
}
export interface ReceiverStats {
  fps: number;
  kbps: number;
}

interface Viewer {
  channel: RTCDataChannel;
}

// ---------- sender ----------

/**
 * Owns the one encoder for a screen broadcast and fans encoded frames out to
 * every viewer's DataChannel. Viewers come and go as peers join/leave; each new
 * viewer triggers a keyframe so it can start decoding immediately.
 */
export class BroadcastSender {
  private encoder: VideoEncoder | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private track: MediaStreamTrack | null = null;
  private running = false;
  private viewers = new Map<string, Viewer>();
  private forceKeyframe = false;
  private reconfigure = false;
  private codecLabel = '';
  private hardware = false;
  private width = 0;
  private height = 0;
  private frameSeq = 0;
  private lastKeyframeAt = 0;
  private lastRequestAt = 0;
  // Windowed stats.
  private frames = 0;
  private bytes = 0;
  private since = 0;
  private fps = 0;
  private kbps = 0;

  constructor(private getSettings: () => BroadcastSettings) {}

  /**
   * Begin encoding from `track`. The caller should pass a dedicated track
   * (e.g. a clone): a MediaStreamTrackProcessor consumes the track's frames, so
   * the original stays free to drive the broadcaster's own local preview.
   */
  async start(track: MediaStreamTrack): Promise<void> {
    this.running = true;
    this.track = track;
    this.since = now();
    const processor = new MediaStreamTrackProcessor({ track });
    this.reader = processor.readable.getReader();
    void this.loop();
  }

  addViewer(id: string, channel: RTCDataChannel): void {
    this.viewers.set(id, { channel });
    this.forceKeyframe = true; // new viewer needs an IDR (+ config) right away
  }

  removeViewer(id: string): void {
    this.viewers.delete(id);
  }

  hasViewer(id: string): boolean {
    return this.viewers.has(id);
  }

  /** A viewer's keyframe request arrived on its channel. */
  handleControl(buf: ArrayBuffer): void {
    if (parseMessage(buf).kind !== 'keyframe-request') return;
    const t = now();
    if (t - this.lastRequestAt < KEYFRAME_MIN_INTERVAL_MS) return;
    this.lastRequestAt = t;
    this.forceKeyframe = true;
  }

  /** Re-read settings (codec/bitrate/fps) and reconfigure on the next frame. */
  updateSettings(): void {
    this.reconfigure = true;
  }

  stats(): SenderStats {
    return { fps: this.fps, kbps: this.kbps, codec: this.codecLabel, hardware: this.hardware };
  }

  stop(): void {
    this.running = false;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.track?.stop(); // the clone we were encoding from; the source's other
    this.track = null; // tracks (preview, system audio) are stopped by the caller
    if (this.encoder && this.encoder.state !== 'closed') {
      try {
        this.encoder.close();
      } catch {
        /* already gone */
      }
    }
    this.encoder = null;
    this.viewers.clear();
  }

  private async loop(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    while (this.running) {
      let res: ReadableStreamReadResult<VideoFrame>;
      try {
        res = await reader.read();
      } catch {
        break;
      }
      if (res.done) break;
      const frame = res.value;
      if (!frame) continue;
      try {
        // No viewers: keep draining the source (so it doesn't stall) but spend
        // nothing on encoding until someone is actually watching.
        if (this.viewers.size === 0) continue;
        const w = frame.displayWidth || frame.codedWidth;
        const h = frame.displayHeight || frame.codedHeight;
        if (!(await this.ensureEncoder(w, h))) continue;
        const enc = this.encoder;
        if (!enc || enc.encodeQueueSize > MAX_ENCODE_QUEUE) continue;
        const keyFrame = this.forceKeyframe || now() - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS;
        if (keyFrame) this.forceKeyframe = false;
        enc.encode(frame, { keyFrame });
      } catch (e) {
        console.warn('broadcast encode failed', e);
      } finally {
        frame.close();
      }
    }
  }

  private async ensureEncoder(width: number, height: number): Promise<boolean> {
    const fits = this.encoder && this.width === width && this.height === height && !this.reconfigure;
    if (fits) return true;
    const chosen = await chooseEncoderConfig(this.getSettings(), width, height);
    if (!chosen) return false;
    if (!this.encoder) {
      this.encoder = new VideoEncoder({
        output: (chunk) => this.onEncoded(chunk),
        error: (e) => console.warn('broadcast encoder error', e),
      });
    }
    this.encoder.configure(chosen.config);
    this.codecLabel = chosen.codec;
    this.hardware = chosen.hardware;
    this.width = width;
    this.height = height;
    this.reconfigure = false;
    this.forceKeyframe = true; // first frame after (re)configure must be an IDR
    return true;
  }

  private onEncoded(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const keyFrame = chunk.type === 'key';
    const seq = this.frameSeq;
    this.frameSeq = (this.frameSeq + 1) >>> 0;
    if (keyFrame) this.lastKeyframeAt = now();

    const packets = packetizeFrame(data, seq, keyFrame, chunk.timestamp);
    const config = keyFrame ? encodeConfigMsg(this.codecLabel) : null;
    for (const { channel } of this.viewers.values()) {
      if (channel.readyState !== 'open') continue;
      // Congested viewer: skip this frame; it will ask for a keyframe to recover.
      if (channel.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      try {
        if (config) channel.send(config);
        for (const p of packets) channel.send(p);
      } catch {
        /* channel closing */
      }
    }
    this.tickStats(data.byteLength);
  }

  private tickStats(bytes: number): void {
    this.frames++;
    this.bytes += bytes;
    const elapsed = now() - this.since;
    if (elapsed >= 1000) {
      this.fps = (this.frames * 1000) / elapsed;
      this.kbps = (this.bytes * 8) / elapsed; // bytes*8 / ms == kbit/s
      this.frames = 0;
      this.bytes = 0;
      this.since = now();
    }
  }
}

// ---------- receiver ----------

/**
 * Decodes one broadcaster's frames arriving on a DataChannel and exposes them
 * as a `MediaStream` (via a MediaStreamTrackGenerator) the call UI can render
 * like any other video tile. Renders newest-frame-wins with no jitter buffer.
 */
export class BroadcastReceiver {
  readonly stream: MediaStream;
  private decoder: VideoDecoder | null = null;
  private generator: MediaStreamTrackGenerator;
  private writer: WritableStreamDefaultWriter<VideoFrame>;
  private assembler = new FrameAssembler();
  private codec = '';
  private pending: VideoFrame | null = null;
  private writing = false;
  private lastReqAt = 0;
  private closed = false;
  // Windowed stats.
  private frames = 0;
  private bytes = 0;
  private since = now();
  private fps = 0;
  private kbps = 0;

  constructor(private channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.writer = this.generator.writable.getWriter();
    this.stream = new MediaStream([this.generator]);
    channel.addEventListener('message', (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) this.onData(e.data);
    });
    channel.addEventListener('open', () => this.requestKeyframe());
    if (channel.readyState === 'open') this.requestKeyframe();
  }

  stats(): ReceiverStats {
    return { fps: this.fps, kbps: this.kbps };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      /* ignore */
    }
    this.pending?.close();
    this.pending = null;
    this.writer.close().catch(() => {});
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
    try {
      this.generator.stop();
    } catch {
      /* ignore */
    }
  }

  private onData(buf: ArrayBuffer): void {
    const msg = parseMessage(buf);
    if (msg.kind === 'config') {
      this.configure(msg.codec);
      return;
    }
    if (msg.kind !== 'video') return;
    this.bytes += msg.payload.byteLength;
    const res = this.assembler.push(msg);
    if (res.needKeyframe) this.requestKeyframe();
    if (!res.frame) return;
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.requestKeyframe();
      return;
    }
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: res.frame.keyFrame ? 'key' : 'delta',
          timestamp: res.frame.timestampUs,
          data: res.frame.data,
        }),
      );
    } catch (e) {
      console.warn('broadcast decode failed', e);
      this.assembler.reset();
      this.requestKeyframe();
    }
  }

  private configure(codec: string): void {
    if (this.codec === codec && this.decoder?.state === 'configured') return;
    if (!this.decoder) {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (e) => {
          console.warn('broadcast decoder error', e);
          this.assembler.reset();
          this.requestKeyframe();
        },
      });
    }
    try {
      this.decoder.configure({ codec, optimizeForLatency: true });
      this.codec = codec;
    } catch (e) {
      console.warn('broadcast decoder configure failed', codec, e);
    }
  }

  private onFrame(frame: VideoFrame): void {
    this.frames++;
    const elapsed = now() - this.since;
    if (elapsed >= 1000) {
      this.fps = (this.frames * 1000) / elapsed;
      this.kbps = (this.bytes * 8) / elapsed;
      this.frames = 0;
      this.bytes = 0;
      this.since = now();
    }
    if (this.closed) {
      frame.close();
      return;
    }
    // Newest-frame-wins: drop any frame still waiting to be written.
    this.pending?.close();
    this.pending = frame;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending && !this.closed) {
        const f = this.pending;
        this.pending = null;
        try {
          await this.writer.write(f); // generator consumes (and frees) the frame
        } catch {
          f.close();
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private requestKeyframe(): void {
    const t = now();
    if (t - this.lastReqAt < KEYFRAME_MIN_INTERVAL_MS) return;
    this.lastReqAt = t;
    if (this.channel.readyState === 'open') {
      try {
        this.channel.send(encodeKeyframeRequest());
      } catch {
        /* ignore */
      }
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
