/* Test-only: a minimal recording stand-in for AudioContext (node has no Web Audio). */

interface Counts { oscillators: number; gains: number; buffers: number; filters: number }

const fakeParam = () => ({
  value: 0,
  setValueAtTime() { return this; },
  linearRampToValueAtTime() { return this; },
  exponentialRampToValueAtTime() { return this; },
});

export function makeFakeAudioContext(): { ctx: AudioContext; counts: Counts } {
  const counts: Counts = { oscillators: 0, gains: 0, buffers: 0, filters: 0 };
  const node = () => ({ connect() { /* chainable */ }, start() {}, stop() {}, disconnect() {} });
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createOscillator: () => { counts.oscillators++; return { ...node(), type: "sine", frequency: fakeParam(), detune: fakeParam() }; },
    createGain: () => { counts.gains++; return { ...node(), gain: fakeParam() }; },
    createBiquadFilter: () => { counts.filters++; return { ...node(), type: "lowpass", frequency: fakeParam(), Q: fakeParam() }; },
    createBufferSource: () => ({ ...node(), buffer: null }),
    createBuffer: (_ch: number, len: number) => { counts.buffers++; return { getChannelData: () => new Float32Array(len) }; },
    sampleRate: 44100,
  };
  return { ctx: ctx as unknown as AudioContext, counts };
}
