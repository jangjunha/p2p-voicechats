/**
 * Tiny synthesized UI sounds for call presence — no asset files to ship. A
 * rising two-note chime when someone joins, a falling one when they leave, so
 * the two are instantly distinguishable without being intrusive.
 */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  // Autoplay policies suspend the context until a user gesture; joining a call
  // is a click, so by the time these fire it can be resumed.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Play a sequence of notes, each `{ freq, start, dur }` seconds from now. */
function chime(notes: { freq: number; start: number; dur: number }[], peak = 0.16): void {
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    const t0 = now + n.start;
    const t1 = t0 + n.dur;
    // Short attack + exponential release for a soft, bell-like blip.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }
}

/** Someone joined the call: a bright ascending two-tone. */
export function playJoin(): void {
  chime([
    { freq: 587.33, start: 0, dur: 0.12 }, // D5
    { freq: 880.0, start: 0.11, dur: 0.16 }, // A5
  ]);
}

/** Someone left the call: a softer descending two-tone. */
export function playLeave(): void {
  chime(
    [
      { freq: 587.33, start: 0, dur: 0.12 }, // D5
      { freq: 392.0, start: 0.11, dur: 0.18 }, // G4
    ],
    0.12,
  );
}
