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

/**
 * Engine sound profiles — one voice per aircraft type (Jeet:
 * "change the sounds according to the aircraft"). The prop
 * profile is the original Phase 10 sound, value for value; the
 * jet is a smoother, higher turbine whine that spools slowly;
 * the fighter is that whine's louder, harsher, eager cousin.
 */
export type EngineSoundKind = "prop" | "jet" | "fighter";

export interface EngineProfile {
  oscAType: OscillatorType;
  oscBType: OscillatorType;
  /** oscB frequency = oscA frequency × ratio + offset (Hz). */
  oscBRatio: number;
  oscBOffset: number;
  baseFreq: number;
  throttleFreq: number;
  speedFreq: number;
  speedCap: number;
  filterBase: number;
  filterThrottle: number;
  filterQ: number;
  gainBase: number;
  gainThrottle: number;
  /** Smoothing time constant — jets lag, the fighter snaps. */
  tau: number;
}

export const ENGINE_PROFILES: Record<EngineSoundKind, EngineProfile> = {
  prop: {
    oscAType: "sawtooth",
    oscBType: "square",
    oscBRatio: 1.5,
    oscBOffset: 4,
    baseFreq: 46,
    throttleFreq: 64,
    speedFreq: 0.35,
    speedCap: 45,
    filterBase: 260,
    filterThrottle: 640,
    filterQ: 2,
    gainBase: 0.015,
    gainThrottle: 0.11,
    tau: 0.09,
  },
  jet: {
    oscAType: "sine",
    oscBType: "triangle",
    oscBRatio: 2.02,
    oscBOffset: 6,
    baseFreq: 150,
    throttleFreq: 260,
    speedFreq: 1.1,
    speedCap: 120,
    filterBase: 500,
    filterThrottle: 1500,
    filterQ: 1.2,
    gainBase: 0.01,
    gainThrottle: 0.075,
    tau: 0.28,
  },
  fighter: {
    oscAType: "sawtooth",
    oscBType: "square",
    oscBRatio: 1.99,
    oscBOffset: 8,
    baseFreq: 190,
    throttleFreq: 340,
    speedFreq: 1.4,
    speedCap: 140,
    filterBase: 420,
    filterThrottle: 2100,
    filterQ: 1.6,
    gainBase: 0.014,
    gainThrottle: 0.105,
    tau: 0.13,
  },
};

export function engineProfileFor(kind: EngineSoundKind): EngineProfile {
  return ENGINE_PROFILES[kind] ?? ENGINE_PROFILES.prop;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Engine loudness from the throttle setting (idle putter included). */
export function engineGainFor(
  throttle: number,
  profile: EngineProfile = ENGINE_PROFILES.prop,
): number {
  const t = clamp01(throttle);
  return profile.gainBase + t * profile.gainThrottle;
}

/** Engine oscillator frequency: rises with power and airflow. */
export function engineFreqFor(
  throttle: number,
  airspeed: number,
  profile: EngineProfile = ENGINE_PROFILES.prop,
): number {
  const t = clamp01(throttle);
  return (
    profile.baseFreq +
    t * profile.throttleFreq +
    Math.min(Math.max(airspeed, 0), profile.speedCap) * profile.speedFreq
  );
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
  private profile: EngineProfile = ENGINE_PROFILES.prop;
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

  /**
   * Switch the engine voice (per aircraft type). Safe before or
   * after unlock: before, the graph is built with the profile;
   * after, the live oscillators/filter adopt it immediately.
   */
  setEngineKind(kind: EngineSoundKind): void {
    this.profile = engineProfileFor(kind);
    if (this.engineOscA) this.engineOscA.type = this.profile.oscAType;
    if (this.engineOscB) this.engineOscB.type = this.profile.oscBType;
    if (this.engineFilter) this.engineFilter.Q.value = this.profile.filterQ;
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

      // Engine: two profile oscillators -> lowpass -> gain.
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = "lowpass";
      this.engineFilter.frequency.value = 320;
      this.engineFilter.Q.value = this.profile.filterQ;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOscA = ctx.createOscillator();
      this.engineOscA.type = this.profile.oscAType;
      this.engineOscA.frequency.value = this.profile.baseFreq;
      this.engineOscA.connect(this.engineFilter);
      this.engineOscB = ctx.createOscillator();
      this.engineOscB.type = this.profile.oscBType;
      this.engineOscB.frequency.value =
        this.profile.baseFreq * this.profile.oscBRatio + this.profile.oscBOffset;
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
    const p = this.profile;
    const engineTarget =
      active && !state.crashed ? engineGainFor(state.throttle, p) : 0;
    this.engineGain.gain.setTargetAtTime(engineTarget, t, p.tau);
    if (this.engineOscA && this.engineOscB && this.engineFilter) {
      const f = engineFreqFor(state.throttle, state.airspeed, p);
      this.engineOscA.frequency.setTargetAtTime(f, t, p.tau);
      this.engineOscB.frequency.setTargetAtTime(f * p.oscBRatio + p.oscBOffset, t, p.tau);
      this.engineFilter.frequency.setTargetAtTime(
        p.filterBase + state.throttle * p.filterThrottle,
        t,
        p.tau,
      );
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
