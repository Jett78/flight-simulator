/**
 * Phase 10 headless checks for the procedural audio engine.
 * The level mappings are pure; the SoundEngine graph is exercised
 * against a minimal fake AudioContext (no real audio in Node).
 *
 * Run: npx tsx test-headless/audio.test.ts
 */
import {
  SoundEngine,
  engineFreqFor,
  engineGainFor,
} from "../src/game/audio";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- Fake WebAudio -----------------------------------------------------

class FakeParam {
  value = 0;
  setTargetAtTime(v: number): void {
    this.value = v;
  }
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number): void {
    this.value = v;
  }
}
class FakeNode {
  connect(): void {}
  disconnect(): void {}
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeOsc extends FakeNode {
  type = "";
  frequency = new FakeParam();
  start(): void {}
  stop(): void {}
}
class FakeFilter extends FakeNode {
  type = "";
  frequency = new FakeParam();
  Q = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam();
  start(): void {}
  stop(): void {}
}
class FakeCtx {
  currentTime = 0;
  state = "running";
  destination = {};
  sampleRate = 44100;
  gains: FakeGain[] = [];
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator(): FakeOsc {
    return new FakeOsc();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  createBuffer(_c: number, len: number): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array(len) };
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

// --- A. Pure level mappings ---------------------------------------------
check("A1 engine idles quietly, full power is louder",
  engineGainFor(0) > 0 && engineGainFor(0) < engineGainFor(0.5) && engineGainFor(0.5) < engineGainFor(1));
check("A2 engine pitch rises with throttle",
  engineFreqFor(0, 0) < engineFreqFor(1, 0) && engineFreqFor(1, 0) < engineFreqFor(1, 40));
// A3/A4 (wind level mapping) retired in 0.12.1: the wind layer
// was removed from the game at Jeet's request.

// --- B. Graph lifecycle with the fake context ---------------------------
{
  let factoryCalls = 0;
  const ctx = new FakeCtx();
  const engine = new SoundEngine({ muted: false, volume: 0.8 }, () => {
    factoryCalls++;
    return ctx as unknown as AudioContext;
  });

  // Before unlock: everything is a safe no-op.
  engine.update({ throttle: 1, airspeed: 50, grounded: false, crashed: false }, true);
  engine.crash();
  check("B1 pre-unlock calls are no-ops", factoryCalls === 0 && !engine.unlocked);

  engine.unlock();
  engine.unlock();
  check("B2 unlock creates the context exactly once", factoryCalls === 1 && engine.unlocked);

  const master = ctx.gains[0];
  check("B3 master starts at the saved volume", Math.abs(master.gain.value - 0.8) < 1e-9);

  engine.update({ throttle: 1, airspeed: 50, grounded: false, crashed: false }, true);
  const engineGain = ctx.gains[1];
  check(
    "B4 full throttle drives the engine gain",
    Math.abs(engineGain.gain.value - engineGainFor(1)) < 1e-9,
    `gain=${engineGain.gain.value}`,
  );

  engine.update({ throttle: 1, airspeed: 50, grounded: false, crashed: true }, true);
  check("B5 crash silences the engine loop", engineGain.gain.value === 0);

  engine.setMuted(true);
  check("B6 mute drops the master to zero", master.gain.value === 0);
  engine.setVolume(0.4);
  check("B7 volume change while muted stays silent", master.gain.value === 0);
  engine.setMuted(false);
  check("B8 unmute restores the new volume", Math.abs(master.gain.value - 0.4) < 1e-9);

  // Event one-shots must not throw against the fake graph.
  engine.takeoff();
  engine.touchdown("smooth");
  engine.touchdown("hard");
  engine.checkpoint();
  engine.missionComplete();
  engine.crash();
  check("B9 all event sounds play without errors", true);

  engine.dispose();
}

console.log(failures === 0 ? "ALL AUDIO TESTS PASSED" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
