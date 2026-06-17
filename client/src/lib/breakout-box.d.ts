/**
 * Ambient declarations for the "Insertable Streams for MediaStreamTrack"
 * (a.k.a. breakout box) API. It is shipped by Chromium / WebView2 but is not
 * yet part of TypeScript's bundled DOM lib, so the two classes we use are
 * declared here. Presence is feature-detected at runtime
 * (`broadcastVideoSupported`) before either is constructed.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  /** Frames buffered before backpressure; small keeps latency low. */
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}

interface MediaStreamTrackGeneratorInit {
  kind: 'video' | 'audio';
}

declare class MediaStreamTrackGenerator<T = VideoFrame> extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<T>;
}
