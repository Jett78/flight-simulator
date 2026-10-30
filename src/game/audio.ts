/**
 * Phase 10 — procedural audio (Web Audio API, no assets, no cost).
 *
 * Everything is synthesized: the engine is two detuned oscillators
 * through a lowpass filter, and the event
 * sounds (takeoff whoosh, touchdown thump, crash, checkpoint blip,
 * mission-complete arpeggio) are short oscillator/noise envelopes.
 *
 * Autoplay policy: the AudioContext is created only inside
 * unlock(), which the HUD calls from real user gestures (pointer /
 * key presses and button clicks). Before that, every method is a
 * no-op. Mute + volume persist in localStorage.
 */

export interface AudioPrefs {
  muted: boolean;
  volume: number; // 0..1
}

const PREFS_KEY = "flightsim.audio.v1";
const DEFAULT_PREFS: AudioPrefs = { muted: false, volume: 0.8 };

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      muted: parsed.muted === true,
      volume:
        typeof parsed.volume === "number"
          ? Math.min(1, Math.max(0, parsed.volume))
          : DEFAULT_PREFS.volume,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Optional — ignore storage failures.
  }
}

// --- Pure level mappings (unit-tested headlessly) ---------------------

/** Engine loudness from the throttle setting (idle putter included). */
export function engineGainFor(throttle: number): number {
  const t = Math.min(1, Math.max(0, throttle));
  return 0.015 + t * 0.11;
}

/** Engine oscillator frequency: rises with power and airflow. */
export function engineFreqFor(throttle: number, airspeed: number): number {
  const t = Math.min(1, Math.max(0, throttle));
  return 46 + t * 64 + Math.min(Math.max(airspeed, 0), 45) * 0.35;
}

// --- Engine ------------------------------------------------------------

interface FlightSoundState {
  throttle: number;
  airspeed: number;
  grounded: boolean;
  crashed: boolean;
}

function defaultContextFactory(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  // Kept for the one-shot stingers (takeoff/touchdown/crash
  // bursts). The continuous wind layer was removed in 0.12.1 at
  // Jeet's request — no wind sound in flight any more.
  private noiseBuffer: AudioBuffer | null = null;
  private prefs: AudioPrefs;
  private readonly contextFactory: () => AudioContext | null;

  constructor(
    prefs: AudioPrefs,
    contextFactory: () => AudioContext | null = defaultContextFactory,
  ) {
    this.prefs = prefs;
    this.contextFactory = contextFactory;
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Create/resume the context. Call ONLY from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const ctx = this.contextFactory();
      if (!ctx) return;
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.prefs.muted ? 0 : this.prefs.volume;
      this.master.connect(ctx.destination);

      // Engine: saw + square oscillators -> lowpass -> gain.
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 320;
      this.engineFilter.Q.value = 2;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOscA = ctx.createOscillator();
      this.engineOscA.type = "sawtooth";
      this.engineOscA.frequency.value = 46;
      this.engineOscA.connect(this.engineFilter);
      this.engineOscB = ctx.createOscillator();
      this.engineOscB.type = "square";
      this.engineOscB.frequency.value = 72;
      this.engineOscB.connect(this.engineFilter);
      this.engineOscA.start();
      this.engineOscB.start();

      // Shared white-noise buffer for the one-shot stingers.
      const len = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.prefs = { ...this.prefs, muted };
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(
        muted ? 0 : this.prefs.volume,
        this.ctx.currentTime,
        0.03,
      );
    }
  }

  setVolume(volume: number): void {
    this.prefs = { ...this.prefs, volume: Math.min(1, Math.max(0, volume)) };
    if (this.ctx && this.master && !this.prefs.muted) {
      this.master.gain.setTargetAtTime(this.prefs.volume, this.ctx.currentTime, 0.03);
    }
  }

  /** Per-frame levels. `active` is false while paused (sounds hush). */
  update(state: FlightSoundState, active: boolean): void {
    if (!this.ctx || !this.engineGain) return;
    const t = this.ctx.currentTime;
    const engineTarget =
      active && !state.crashed ? engineGainFor(state.throttle) : 0;
    this.engineGain.gain.setTargetAtTime(engineTarget, t, 0.09);
    if (this.engineOscA && this.engineOscB && this.engineFilter) {
      const f = engineFreqFor(state.throttle, state.airspeed);
      this.engineOscA.frequency.setTargetAtTime(f, t, 0.09);
      this.engineOscB.frequency.setTargetAtTime(f * 1.5 + 4, t, 0.09);
      this.engineFilter.frequency.setTargetAtTime(260 + state.throttle * 640, t, 0.09);
    }
  }

  // --- One-shot events ---------------------------------------------------

  private tone(
    freqFrom: number,
    freqTo: number,
    delay: number,
    duration: number,
    peak: number,
    type: OscillatorType = "sine",
  ): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  private noiseBurst(
    delay: number,
    duration: number,
    peak: number,
    filterType: BiquadFilterType,
    freqFrom: number,
    freqTo: number,
  ): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.9;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freqFrom, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 10), t0 + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t0, Math.random());
    src.stop(t0 + duration + 0.05);
  }

  /** Liftoff: a rising whoosh as the gear leaves the runway. */
  takeoff(): void {
    this.noiseBurst(0, 0.7, 0.1, "bandpass", 280, 1250);
  }

  /** Touchdown thump — harder landings land louder and lower. */
  touchdown(quality: "smooth" | "hard"): void {
    if (quality === "smooth") {
      this.tone(95, 42, 0, 0.22, 0.16);
    } else {
      this.tone(80, 32, 0, 0.32, 0.3);
      this.noiseBurst(0, 0.18, 0.12, "lowpass", 900, 220);
    }
  }

  crash(): void {
    this.noiseBurst(0, 0.85, 0.42, "lowpass", 1400, 120);
    this.tone(150, 28, 0, 0.7, 0.3, "triangle");
  }

  /** Ring passed: a short friendly blip. */
  checkpoint(): void {
    this.tone(880, 880, 0, 0.09, 0.12, "sine");
    this.tone(1318, 1318, 0.09, 0.14, 0.12, "sine");
  }

  /** Mission complete: a small four-note arpeggio. */
  missionComplete(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone(f, f, i * 0.11, 0.22, 0.13, "triangle"));
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}
