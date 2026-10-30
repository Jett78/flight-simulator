import { useEffect, useRef, useState, type RefObject } from "react";
import type { FlightState } from "../game/AircraftController";
import { AIRCRAFT_VARIANTS } from "../game/aircraftVariants";
import {
  CHECKPOINTS,
  MISSION_INFO,
  MissionRun,
  TAKEOFF_TARGET_ALTITUDE,
  checkpointVisuals,
  formatTime,
  loadRecords,
  recordCompletion,
  recordStart,
  type CheckpointVisual,
  type MissionId,
  type MissionRecords,
} from "../game/missions";
import {
  SoundEngine,
  loadAudioPrefs,
  saveAudioPrefs,
  type AudioPrefs,
  type EngineSoundKind,
} from "../game/audio";
import "./Hud.css";

/**
 * Phase 6 flight HUD.
 *
 * Rendering strategy: the instruments are driven by a single
 * requestAnimationFrame loop that reads the live FlightState and
 * writes straight to DOM nodes through refs (text content and CSS
 * transforms). React state is NOT updated per frame, so the HUD
 * stays at 60 fps without re-rendering the React tree. React state
 * is used only for things that change on user action: help panel
 * open/closed (here) and pause / camera mode (owned by App).
 *
 * All values come from the actual simulation — nothing is animated
 * decoratively. Units match the earlier phases: km/h, metres, m/s.
 */

interface HudProps {
  /** Live simulation state, or null before the scene is ready. */
  getState: () => FlightState | null;
  cameraMode: string;
  paused: boolean;
  onTogglePause: () => void;
  onResetAircraft: () => void;
  onResetView: () => void;
  /** Phase 9: show/hide the 3D checkpoint rings. */
  setCheckpoints: (visuals: CheckpointVisual[]) => void;
  /** Phase 14: active aircraft variant + picker callback. */
  aircraftVariantId: string;
  onSelectAircraft: (id: string) => void;
  /** Phase 14: a gamepad is connected (shows the 🎮 chip). */
  gamepadConnected: boolean;
  /** Phase 2: the active aircraft's display name (from its config). */
  aircraftName: string;
  /** Phase 2: leave the flight and return to aircraft selection. */
  onChangeAircraft: () => void;
  /** Phase 3: active aircraft's max speed (km/h) — sizes the speed tape. */
  aircraftMaxSpeedKmh: number;
  /** Phase 3: active aircraft's rotate speed (km/h) for the help tip. */
  rotateKmh: number;
  /** Phase 5: category label for the title block ("Commercial jet"). */
  aircraftCategoryLabel: string;
  /** Phase 5: spec line for the title block — thrust (kN). */
  aircraftThrustKn: number;
  /** Phase 5: spec line for the title block — stall speed (km/h). */
  aircraftStallKmh: number;
  /** Per-aircraft engine sound (Jeet): the active aircraft's voice. */
  engineKind: EngineSoundKind;
}

interface RunSummary {
  id: MissionId;
  status: "complete" | "failed";
  score: number;
  time: number;
  quality: "smooth" | "hard" | null;
  failReason: string;
}

// --- Instrument geometry -------------------------------------------------
const TAPE_MAX = 500; // km/h and m share the same tape scale
const TAPE_PX = 1.1; // px per unit on the tapes
const TAPE_LABELS = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const COMPASS_PX = 2.2; // px per degree on the heading strip
const VSI_MAX = 20; // m/s full-scale on the vertical-speed indicator
const VSI_TRAVEL = 52; // px from centre to full-scale

// Mission minimap: world metres -> SVG viewBox units (0..100).
// North (-Z) is up, so screen y grows with world +Z (south).
const MAP_EXTENT = 1750; // Phase 12: the island grew to ~3.2 km across
const mapCoord = (v: number) => ((v + MAP_EXTENT) / (MAP_EXTENT * 2)) * 100;

function compassLabel(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return "N";
  if (norm === 90) return "E";
  if (norm === 180) return "S";
  if (norm === 270) return "W";
  return String(norm / 10).padStart(2, "0");
}

const COMPASS_MARKS: { deg: number; label: string }[] = [];
for (let d = -360; d <= 720; d += 30) {
  COMPASS_MARKS.push({ deg: d, label: compassLabel(d) });
}

/** Vertical moving-tape readout (airspeed / altitude share the design). */
function Tape({
  title,
  unit,
  side,
  stripRef,
  valueRef,
  labels,
}: {
  title: string;
  unit: string;
  side: "left" | "right";
  stripRef: RefObject<HTMLDivElement | null>;
  valueRef: RefObject<HTMLSpanElement | null>;
  /** Tick labels up the strip (Phase 3: airspeed range follows the aircraft). */
  labels: number[];
}) {
  return (
    <div className={`tape tape-${side}`}>
      <div className="tape-title">{title}</div>
      <div className="tape-window">
        <div ref={stripRef} className="tape-strip">
          {labels.map((v) => (
            <span key={v} className="tape-label" style={{ bottom: v * TAPE_PX }}>
              {v}
            </span>
          ))}
        </div>
        <div className="tape-caret" />
      </div>
      <div className="tape-value">
        <span ref={valueRef}>0</span>
        <small>{unit}</small>
      </div>
    </div>
  );
}

export function Hud({
  getState,
  cameraMode,
  paused,
  onTogglePause,
  onResetAircraft,
  onResetView,
  setCheckpoints,
  aircraftVariantId,
  onSelectAircraft,
  gamepadConnected,
  aircraftName,
  onChangeAircraft,
  aircraftMaxSpeedKmh,
  rotateKmh,
  aircraftCategoryLabel,
  aircraftThrustKn,
  aircraftStallKmh,
  engineKind,
}: HudProps) {
  const speedTapeMax = Math.max(500, Math.ceil(aircraftMaxSpeedKmh / 100) * 100);
  const speedLabels: number[] = [];
  for (let v = 0; v <= speedTapeMax; v += 50) speedLabels.push(v);

  const [helpOpen, setHelpOpen] = useState(false);
  const [aircraftOpen, setAircraftOpen] = useState(false);

  // Phase 9 mission UI state (discrete changes only — per-frame
  // objective text is written through refs by the rAF loop below).
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeMission, setActiveMission] = useState<MissionId | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [records, setRecords] = useState<MissionRecords>(() => loadRecords());
  const [checkpointIndex, setCheckpointIndex] = useState(0);

  // Phase 10 audio UI state.
  const [audioPrefs, setAudioPrefs] = useState<AudioPrefs>(() => loadAudioPrefs());
  const soundRef = useRef<SoundEngine | null>(null);
  // Release the AudioContext if the HUD ever unmounts (Phase 11:
  // resource disposal — the engine is created lazily on first use).
  useEffect(
    () => () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    },
    [],
  );
  const getSound = () => {
    if (!soundRef.current) {
      soundRef.current = new SoundEngine(loadAudioPrefs());
    }
    return soundRef.current;
  };

  // Per-aircraft engine voice: follow the active aircraft. The
  // HUD remounts per flight, so this also covers the first pick.
  useEffect(() => {
    getSound().setEngineKind(engineKind);
  }, [engineKind]);

  // Audio starts only after a real user gesture (autoplay policy):
  // the first pointer/key press unlocks the context; unlock() is
  // idempotent, so the listeners can stay for the session.
  useEffect(() => {
    const unlock = () => getSound().unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const toggleMute = () => {
    const sound = getSound();
    sound.unlock();
    setAudioPrefs((p) => {
      const next = { ...p, muted: !p.muted };
      saveAudioPrefs(next);
      sound.setMuted(next.muted);
      return next;
    });
  };

  const changeVolume = (value: number) => {
    const sound = getSound();
    setAudioPrefs((p) => {
      const next = { ...p, volume: value };
      saveAudioPrefs(next);
      sound.setVolume(value);
      return next;
    });
  };

  const runRef = useRef<MissionRun | null>(null);
  const pausedRef = useRef(paused);
  const setCheckpointsRef = useRef(setCheckpoints);
  setCheckpointsRef.current = setCheckpoints;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const startMission = (id: MissionId) => {
    onResetAircraft();
    runRef.current = new MissionRun(id);
    setRecords((r) => recordStart(r, id));
    setActiveMission(id);
    setRunSummary(null);
    setMenuOpen(false);
    setCheckpointIndex(0);
    setCheckpoints(checkpointVisuals(runRef.current));
  };

  const endMission = () => {
    runRef.current = null;
    setActiveMission(null);
    setRunSummary(null);
    setMenuOpen(false);
    setCheckpointIndex(0);
    setCheckpoints([]);
  };

  // Instrument node refs — written directly by the rAF loop below.
  const spdStrip = useRef<HTMLDivElement>(null);
  const spdValue = useRef<HTMLSpanElement>(null);
  const altStrip = useRef<HTMLDivElement>(null);
  const altValue = useRef<HTMLSpanElement>(null);
  const hdgStrip = useRef<HTMLDivElement>(null);
  const hdgValue = useRef<HTMLSpanElement>(null);
  const vsiNeedle = useRef<HTMLDivElement>(null);
  const vsiValue = useRef<HTMLSpanElement>(null);
  const thrFill = useRef<HTMLDivElement>(null);
  const thrValue = useRef<HTMLSpanElement>(null);
  const horizon = useRef<HTMLDivElement>(null);
  const attitudeValue = useRef<HTMLDivElement>(null);
  const aoaValue = useRef<HTMLSpanElement>(null);
  const stallEl = useRef<HTMLDivElement>(null);
  const groundChip = useRef<HTMLDivElement>(null);
  const statusEl = useRef<HTMLDivElement>(null);
  const statusTextEl = useRef<HTMLSpanElement>(null);
  const crashEl = useRef<HTMLDivElement>(null);
  const crashReasonEl = useRef<HTMLDivElement>(null);
  const objectiveTextEl = useRef<HTMLSpanElement>(null);
  const navArrowEl = useRef<HTMLSpanElement>(null);
  // Phase 12.1: gold next-ring markers on the compass strip. Three
  // copies (bearing −360 / +0 / +360) so one is always in the
  // window no matter where the heading sits on the strip.
  const compassTargetEls = useRef<(HTMLSpanElement | null)[]>([]);
  const mapPlaneEl = useRef<SVGGElement>(null);
  const checkpointToastEl = useRef<HTMLDivElement>(null);
  const checkpointToastTextEl = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    // Instrument centres are measured from the DOM (the tape/compass
    // windows shrink at small breakpoints) and refreshed on resize.
    let tapeCenter = 88;
    let compassCenter = 132;
    const measure = () => {
      const tapeWindow = spdStrip.current?.parentElement;
      if (tapeWindow) tapeCenter = tapeWindow.clientHeight / 2;
      const compassWindow = hdgStrip.current?.parentElement;
      if (compassWindow) compassCenter = compassWindow.clientWidth / 2;
    };
    measure();
    window.addEventListener("resize", measure);

    // Phase 7 status/crash bookkeeping (edge detection, not per-frame state)
    let prevGrounded = true;
    let liftoffAt = 0;
    let lastStatusKey = "";
    let crashShown = false;

    // Phase 9 mission bookkeeping
    let lastFrameAt = 0;
    let lastObjectiveKey = "";
    let lastVisualKey = "";
    let handledRun: MissionRun | null = null;
    let toastUntil = 0;
    let toastVisible = false;
    let lastTouchdownSeq = 0;

    // Phase 12.1: position the gold compass markers at the next
    // ring's absolute bearing (same strip coordinates as the labels:
    // left = (deg + 360) * COMPASS_PX). Null hides all three.
    const setCompassTargets = (bearing: number | null) => {
      const offsets = [-360, 0, 360];
      compassTargetEls.current.forEach((el, i) => {
        if (!el) return;
        if (bearing === null) {
          el.style.opacity = "0";
          return;
        }
        el.style.left = `${(bearing + offsets[i] + 360) * COMPASS_PX}px`;
        el.style.opacity = "1";
      });
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = getState();
      if (!s) return;

      const kmh = s.airspeed * 3.6;
      if (spdValue.current) spdValue.current.textContent = String(Math.round(kmh));
      if (spdStrip.current) {
        const clamped = Math.min(Math.max(kmh, 0), speedTapeMax);
        spdStrip.current.style.top = `${tapeCenter - (speedTapeMax - clamped) * TAPE_PX}px`;
      }

      const alt = Math.max(0, Math.round(s.altitude));
      if (altValue.current) altValue.current.textContent = String(alt);
      if (altStrip.current) {
        const clamped = Math.min(alt, TAPE_MAX);
        altStrip.current.style.top = `${tapeCenter - (TAPE_MAX - clamped) * TAPE_PX}px`;
      }

      const hdg = ((s.headingDeg % 360) + 360) % 360;
      if (hdgValue.current) {
        hdgValue.current.textContent = String(Math.round(hdg)).padStart(3, "0");
      }
      if (hdgStrip.current) {
        hdgStrip.current.style.transform = `translateX(${compassCenter - (360 + hdg) * COMPASS_PX}px)`;
      }

      const vs = s.verticalSpeed;
      if (vsiValue.current) {
        vsiValue.current.textContent = `${vs >= 0 ? "+" : ""}${vs.toFixed(1)}`;
      }
      if (vsiNeedle.current) {
        const clamped = Math.min(Math.max(vs, -VSI_MAX), VSI_MAX);
        vsiNeedle.current.style.transform = `translateY(${(-clamped / VSI_MAX) * VSI_TRAVEL}px)`;
      }

      const thr = Math.round(s.throttle * 100);
      if (thrValue.current) thrValue.current.textContent = `${thr}%`;
      if (thrFill.current) thrFill.current.style.height = `${thr}%`;

      if (horizon.current) {
        const pitchPx = Math.min(Math.max(s.pitchDeg, -30), 30) * 2;
        horizon.current.style.transform = `rotate(${-s.rollDeg}deg) translateY(${pitchPx}px)`;
      }
      if (attitudeValue.current) {
        const p = Math.round(s.pitchDeg);
        const r = Math.round(s.rollDeg);
        attitudeValue.current.textContent = `PITCH ${p >= 0 ? "+" : ""}${p}° · ROLL ${r >= 0 ? "+" : ""}${r}°`;
      }
      if (aoaValue.current) {
        aoaValue.current.textContent = `${Math.round(s.angleOfAttackDeg)}°`;
      }

      if (stallEl.current) {
        // Phase 12.1: only warn while genuinely flying. The old
        // !grounded gate still let the banner flash during ground
        // bounces / the spawn settle; flight phase + flying speed
        // together mean a parked aircraft never shows STALL.
        stallEl.current.style.opacity =
          s.stallFactor > 0.25 && s.phase === "air" && s.airspeed > 5 ? "1" : "0";
      }
      if (groundChip.current) {
        const label = s.grounded ? "ON GROUND" : "AIRBORNE";
        if (groundChip.current.textContent !== label) {
          groundChip.current.textContent = label;
          groundChip.current.dataset.air = s.grounded ? "false" : "true";
        }
      }

      // Phase 7: flight-status line — derived from the real flight
      // phase, touchdown verdict and position each frame, written to
      // the DOM only when it actually changes.
      const now = performance.now();
      if (prevGrounded && !s.grounded) {
        liftoffAt = now;
        soundRef.current?.takeoff();
      }
      prevGrounded = s.grounded;
      let status = "";
      let tone = "info";
      if (!s.crashed) {
        if (s.touchdown && s.grounded) {
          const td = s.touchdown;
          if (td.quality === "smooth") {
            status = `✓ Successful landing (${td.verticalSpeed.toFixed(1)} m/s)`;
            tone = "ok";
          } else if (td.quality === "hard") {
            status = `⚠ Hard landing (${td.verticalSpeed.toFixed(1)} m/s)`;
            tone = "warn";
          } else {
            status = `✓ Off-runway landing (${td.verticalSpeed.toFixed(1)} m/s)`;
            tone = "ok";
          }
        } else if (!s.grounded && liftoffAt > 0 && now - liftoffAt < 4000) {
          status = "✈ Airborne";
          tone = "ok";
        } else if (s.grounded) {
          if (s.airspeed < 0.5) {
            status = s.onRunway ? "Ready for takeoff" : "On the ground — off runway";
          } else {
            status = s.onRunway ? "Takeoff roll" : "Rolling — off runway";
          }
        } else if (
          s.heightAboveGround < 70 &&
          Math.hypot(s.posX, s.posZ) < 600 &&
          s.verticalSpeed < 1
        ) {
          status = "Approaching runway";
        }
      }
      const statusKey = `${status}|${tone}`;
      if (statusEl.current && statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        statusEl.current.style.opacity = status ? "1" : "0";
        statusEl.current.dataset.tone = tone;
        if (statusTextEl.current) statusTextEl.current.textContent = status;
      }

      // Phase 7: crash overlay (reason + reset action).
      const crashEdge = s.crashed && !crashShown;
      if (crashEl.current && s.crashed !== crashShown) {
        crashShown = s.crashed;
        crashEl.current.style.display = s.crashed ? "flex" : "none";
        if (s.crashed && crashReasonEl.current) {
          crashReasonEl.current.textContent = s.crashReason;
        }
      }
      if (crashEdge) soundRef.current?.crash();

      // Phase 10: continuous engine/wind levels + touchdown thump.
      soundRef.current?.update(s, !pausedRef.current);
      if (s.touchdown && s.touchdown.sequence !== lastTouchdownSeq) {
        lastTouchdownSeq = s.touchdown.sequence;
        if (s.touchdown.quality === "smooth" || s.touchdown.quality === "hard") {
          soundRef.current?.touchdown(s.touchdown.quality);
        }
      }

      // Phase 9: step the active mission against the real flight
      // state. The timer freezes while paused. Discrete outcomes
      // (complete/failed) are handed to React state exactly once.
      const run = runRef.current;
      if (run) {
        const dtMs = lastFrameAt > 0 ? now - lastFrameAt : 0;
        lastFrameAt = now;
        const prevIndex = run.nextIndex;
        run.step(s, pausedRef.current ? 0 : Math.min(dtMs / 1000, 0.1));

        const visualKey = `${run.id}:${run.nextIndex}:${run.status}`;
        if (visualKey !== lastVisualKey) {
          lastVisualKey = visualKey;
          setCheckpointsRef.current(checkpointVisuals(run));
          if (run.id === "checkpoints") setCheckpointIndex(run.nextIndex);
        }

        // Checkpoint-passed toast (intermediate rings only — the
        // final ring gets the result card instead). Phase 12.1: name
        // the next ring and its distance, so the pilot knows exactly
        // where to look next instead of "the gold beacon" in general.
        if (
          run.id === "checkpoints" &&
          run.status === "active" &&
          run.nextIndex > prevIndex &&
          checkpointToastEl.current &&
          checkpointToastTextEl.current
        ) {
          const nextNav = run.navigationToNext(s);
          checkpointToastTextEl.current.textContent = nextNav
            ? `✓ Ring ${prevIndex + 1} cleared — Ring ${nextNav.index + 1} next · ${Math.round(nextNav.distance)} m`
            : `✓ Ring ${prevIndex + 1} cleared`;
          checkpointToastEl.current.style.opacity = "1";
          toastVisible = true;
          toastUntil = now + 2800;
          soundRef.current?.checkpoint();
        }
        if (toastVisible && now > toastUntil && checkpointToastEl.current) {
          checkpointToastEl.current.style.opacity = "0";
          toastVisible = false;
        }

        if (run.status === "active") {
          let objective = "";
          if (run.id === "checkpoints") {
            const nav = run.navigationToNext(s);
            setCompassTargets(nav ? nav.bearingDeg : null);
            if (nav) {
              const turn =
                nav.direction === "straight"
                  ? "Fly straight"
                  : nav.direction === "around"
                    ? "Turn around"
                    : `Turn ${nav.direction} ${Math.round(Math.abs(nav.relativeBearingDeg))}°`;
              const climb =
                nav.altitudeDelta > 8
                  ? `Climb ${Math.round(nav.altitudeDelta)} m`
                  : nav.altitudeDelta < -8
                    ? `Descend ${Math.round(-nav.altitudeDelta)} m`
                    : "Hold altitude";
              objective = `Ring ${nav.index + 1}/${CHECKPOINTS.length} · ${Math.round(nav.distance)} m · ${turn} · ${climb} · ⏱ ${formatTime(run.elapsed)}`;
              if (navArrowEl.current) {
                navArrowEl.current.style.transform = `rotate(${nav.relativeBearingDeg}deg)`;
              }
              if (mapPlaneEl.current) {
                mapPlaneEl.current.setAttribute(
                  "transform",
                  `translate(${mapCoord(s.posX)} ${mapCoord(s.posZ)}) rotate(${hdg})`,
                );
              }
            }
          } else if (run.id === "takeoff") {
            setCompassTargets(null);
            objective = `Altitude ${Math.max(0, Math.round(s.altitude))} / ${TAKEOFF_TARGET_ALTITUDE} m · ⏱ ${formatTime(run.elapsed)}`;
          } else {
            setCompassTargets(null);
            objective = `${s.grounded ? "Take off, then land on the runway" : "Land on the runway"} · ⏱ ${formatTime(run.elapsed)}`;
          }
          if (objective !== lastObjectiveKey) {
            lastObjectiveKey = objective;
            if (objectiveTextEl.current) objectiveTextEl.current.textContent = objective;
          }
        } else if (handledRun !== run) {
          handledRun = run;
          if (run.status === "complete") {
            setRecords((r) => recordCompletion(r, run.id, run.score));
            soundRef.current?.missionComplete();
          }
          setRunSummary({
            id: run.id,
            status: run.status,
            score: run.score,
            time: run.elapsed,
            quality: run.landingQuality,
            failReason: run.failReason,
          });
        }
      } else {
        lastFrameAt = 0;
        handledRun = null;
        lastVisualKey = "";
        lastObjectiveKey = "";
        setCompassTargets(null);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [getState]);

  return (
    <div className="hud-root">
      {/* Title */}
      <header className="hud-panel hud-title">
        <div className="hud-badge">PHASE 20 · NEW JET MODEL</div>
        <h1>Flight Simulator</h1>
        <div ref={groundChip} className="hud-ground-chip" data-air="false">
          ON GROUND
        </div>
        {/* Phase 5: aircraft-specific title presentation — the
            layout stays put, the labels follow the aircraft. */}
        <div className="hud-aircraft-line">
          {aircraftName} · {aircraftCategoryLabel}
        </div>
        <div className="hud-specs-line">
          Max {aircraftMaxSpeedKmh} km/h · {aircraftThrustKn} kN thrust · Stall{" "}
          {aircraftStallKmh} km/h
        </div>
      </header>

      {/* Buttons + camera + help */}
      <div className="hud-topright">
        <div className="hud-actions">
          <span className="hud-camera-chip" title="Camera mode (C)">
            📷 {cameraMode}
          </span>
          <button type="button" className="hud-btn" onClick={onTogglePause}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button type="button" className="hud-btn" onClick={onResetAircraft}>
            ⟲ Reset aircraft
          </button>
          <button type="button" className="hud-btn" onClick={onResetView}>
            Reset view
          </button>
          <button
            type="button"
            className="hud-btn"
            title="End this flight and pick a different aircraft"
            onClick={onChangeAircraft}
          >
            ✈ Change aircraft
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
          >
            ? Controls
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            🏁 Missions
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-expanded={aircraftOpen}
            onClick={() => setAircraftOpen((open) => !open)}
          >
            🛩 Edition
          </button>
          {gamepadConnected && (
            <span className="hud-camera-chip" title="Gamepad connected — see Controls for the mapping">
              🎮 Gamepad
            </span>
          )}
          <button
            type="button"
            className="hud-btn"
            title={audioPrefs.muted ? "Unmute sound" : "Mute sound"}
            onClick={toggleMute}
          >
            {audioPrefs.muted ? "🔇 Muted" : "🔊 Sound"}
          </button>
          <input
            type="range"
            className="hud-volume"
            min={0}
            max={100}
            value={Math.round(audioPrefs.volume * 100)}
            disabled={audioPrefs.muted}
            aria-label="Volume"
            title="Volume"
            onChange={(e) => changeVolume(Number(e.target.value) / 100)}
          />
        </div>
        {menuOpen && (
          <aside className="hud-panel hud-missions" aria-label="Mission selection">
            <div className="hud-missions-title">Missions</div>
            <button
              type="button"
              className={`hud-mission-row${activeMission === null ? " is-active" : ""}`}
              onClick={endMission}
            >
              <span className="hud-mission-name">✈ Free Flight</span>
              <span className="hud-mission-blurb">No objectives — just fly.</span>
            </button>
            {(Object.keys(MISSION_INFO) as MissionId[]).map((id) => {
              const rec = records[id];
              return (
                <button
                  key={id}
                  type="button"
                  className={`hud-mission-row${activeMission === id ? " is-active" : ""}`}
                  onClick={() => startMission(id)}
                >
                  <span className="hud-mission-name">
                    {MISSION_INFO[id].name}
                    {rec && rec.best > 0 ? (
                      <span className="hud-mission-best">best {rec.best}</span>
                    ) : null}
                  </span>
                  <span className="hud-mission-blurb">{MISSION_INFO[id].blurb}</span>
                </button>
              );
            })}
            <div className="hud-missions-note">Starting a mission resets the aircraft.</div>
          </aside>
        )}
        {aircraftOpen && (
          <aside className="hud-panel hud-missions" aria-label="Aircraft edition selection">
            <div className="hud-missions-title">Aircraft edition</div>
            {AIRCRAFT_VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`hud-mission-row${aircraftVariantId === v.id ? " is-active" : ""}`}
                onClick={() => {
                  onSelectAircraft(v.id);
                  setAircraftOpen(false);
                }}
              >
                <span className="hud-mission-name">{aircraftName} · {v.name}</span>
                <span className="hud-mission-blurb">{v.blurb}</span>
                <span className="hud-aircraft-stats">
                  Speed {"●".repeat(v.stats.speed)}{"○".repeat(5 - v.stats.speed)} · Agility{" "}
                  {"●".repeat(v.stats.agility)}{"○".repeat(5 - v.stats.agility)} · Ease{" "}
                  {"●".repeat(v.stats.ease)}{"○".repeat(5 - v.stats.ease)}
                </span>
              </button>
            ))}
            <div className="hud-missions-note">Switching edition resets the flight.</div>
          </aside>
        )}
        {helpOpen && (
          <aside className="hud-panel hud-help" aria-label="Flight controls">
            <ul>
              <li>
                <strong>W / S</strong> pitch — W nose down · S nose up
              </li>
              <li>
                <strong>A / D</strong> roll — bank right / left
              </li>
              <li>
                <strong>Q / E</strong> yaw — right / left
              </li>
              <li>
                <strong>Shift (hold) / Space</strong> throttle — hold Shift for
                power, release and power falls; Space cuts fast
              </li>
              <li>
                <strong>C</strong> camera · <strong>R</strong> reset aircraft ·{" "}
                <strong>P</strong> pause
              </li>
              <li>
                <strong>Mouse drag</strong> on the view — look around
                (Reset view recentres)
              </li>
              <li>
                <strong>Gamepad</strong> — left stick pitch/roll · right
                stick or bumpers yaw · RT throttle · LT/B cut · A camera
                · Y reset · Start pause
              </li>
              <li className="hud-help-tip">
                Buildings and trees are solid: bump them slowly and you
                stop — hit them fast and you crash.
              </li>
              <li className="hud-help-tip">
                Hold Shift — at ~{rotateKmh} km/h pull S to take off. Land back on
                the runway gently: sink under ~2.5 m/s, wings level.
              </li>
              <li className="hud-help-tip">
                Checkpoint Flight: follow the gold beacon and route line —
                the arrow, map and “Turn / Climb” cues point at the next ring.
              </li>
              <li className="hud-help-tip">
                Sound starts after your first click or keypress (browser
                rule).
              </li>
            </ul>
          </aside>
        )}
      </div>

      {/* Stall + paused banners (centre kept low-profile) */}
      <div ref={stallEl} className="hud-stall" style={{ opacity: 0 }}>
        ⚠ STALL
      </div>
      {paused && <div className="hud-paused">⏸ PAUSED</div>}

      {/* Phase 7 flight-status line (ready / airborne / approach / landing) */}
      <div ref={statusEl} className="hud-status" data-tone="info" style={{ opacity: 0 }}>
        <span ref={statusTextEl} />
      </div>

      {/* Phase 9 in-flight objective display */}
      {activeMission && !runSummary && (
        <div className="hud-objective">
          <span className="hud-objective-name">🎯 {MISSION_INFO[activeMission].name}</span>
          {activeMission === "checkpoints" && (
            <span className="hud-objective-progress" aria-label="Checkpoint progress">
              {CHECKPOINTS.map((_, i) => (
                <span
                  key={i}
                  className={
                    i < checkpointIndex
                      ? "is-done"
                      : i === checkpointIndex
                        ? "is-next"
                        : "is-todo"
                  }
                >
                  ●
                </span>
              ))}
            </span>
          )}
          {activeMission === "checkpoints" && (
            <span className="hud-objective-nav" aria-hidden="true">
              <span ref={navArrowEl}>↑</span>
            </span>
          )}
          <span ref={objectiveTextEl} className="hud-objective-text" />
          <button
            type="button"
            className="hud-btn hud-objective-btn"
            onClick={() => startMission(activeMission)}
          >
            ↻ Restart
          </button>
          <button type="button" className="hud-btn hud-objective-btn" onClick={endMission}>
            ✕ End
          </button>
        </div>
      )}

      {/* Phase 9.1 checkpoint-passed toast */}
      <div ref={checkpointToastEl} className="hud-checkpoint-toast" style={{ opacity: 0 }}>
        <span ref={checkpointToastTextEl} />
      </div>

      {/* Phase 9.1 mission minimap (checkpoint flight only) */}
      {activeMission === "checkpoints" && !runSummary && (
        <aside className="hud-panel hud-map" aria-label="Mission map">
          <div className="hud-map-head">
            <span>MISSION MAP</span>
            <span className="hud-map-north">N ↑</span>
          </div>
          <svg className="hud-map-svg" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="46" className="hud-map-island" />
            <line
              x1="50"
              y1={mapCoord(-150)}
              x2="50"
              y2={mapCoord(150)}
              className="hud-map-runway"
            />
            <polyline
              points={[
                `${mapCoord(0)},${mapCoord(105)}`,
                ...CHECKPOINTS.map((cp) => `${mapCoord(cp.x)},${mapCoord(cp.z)}`),
              ].join(" ")}
              className="hud-map-route"
            />
            {CHECKPOINTS.map((cp, i) => {
              const st =
                i < checkpointIndex ? "done" : i === checkpointIndex ? "next" : "todo";
              return (
                <g key={i} className={`hud-map-cp hud-map-cp-${st}`}>
                  <circle cx={mapCoord(cp.x)} cy={mapCoord(cp.z)} r={st === "next" ? 3.6 : 2.8} />
                  <text x={mapCoord(cp.x)} y={mapCoord(cp.z) + 1.3}>
                    {st === "done" ? "✓" : i + 1}
                  </text>
                </g>
              );
            })}
            <g
              ref={mapPlaneEl}
              transform={`translate(${mapCoord(0)} ${mapCoord(105)}) rotate(0)`}
            >
              <path d="M 0 -3.4 L 2.2 2.8 L 0 1.5 L -2.2 2.8 Z" className="hud-map-plane" />
            </g>
          </svg>
          <div className="hud-map-legend">
            <span className="is-next">● Next</span>
            <span className="is-done">● Done</span>
            <span className="is-todo">● Later</span>
            <span className="is-you">▲ You</span>
          </div>
        </aside>
      )}

      {/* Phase 9 mission result card */}
      {runSummary && (
        <div className="hud-panel hud-result" data-status={runSummary.status}>
          <div className="hud-result-title">
            {runSummary.status === "complete" ? "✓ MISSION COMPLETE" : "✕ MISSION FAILED"}
          </div>
          <div className="hud-result-name">{MISSION_INFO[runSummary.id].name}</div>
          {runSummary.status === "complete" ? (
            <div className="hud-result-stats">
              <span>
                Score <strong>{runSummary.score}</strong>
              </span>
              <span>
                Time <strong>{formatTime(runSummary.time)}</strong>
              </span>
              {runSummary.quality && (
                <span>
                  Landing <strong>{runSummary.quality}</strong>
                </span>
              )}
            </div>
          ) : (
            <div className="hud-result-reason">{runSummary.failReason}</div>
          )}
          <div className="hud-result-actions">
            <button
              type="button"
              className="hud-btn"
              onClick={() => startMission(runSummary.id)}
            >
              ↻ Restart mission
            </button>
            <button type="button" className="hud-btn" onClick={endMission}>
              Free flight
            </button>
          </div>
        </div>
      )}

      {/* Phase 7 crash overlay */}
      <div ref={crashEl} className="hud-crash" style={{ display: "none" }}>
        <div className="hud-crash-title">✕ CRASH DETECTED</div>
        <div ref={crashReasonEl} className="hud-crash-reason" />
        <button type="button" className="hud-btn hud-crash-btn" onClick={onResetAircraft}>
          ⟲ Reset aircraft
        </button>
        <div className="hud-crash-hint">or press R</div>
      </div>

      {/* Airspeed — left edge */}
      <div className="hud-left">
        <Tape
          title="AIRSPEED"
          unit="km/h"
          side="left"
          stripRef={spdStrip}
          valueRef={spdValue}
          labels={speedLabels}
        />
      </div>

      {/* Altitude + VSI — right edge */}
      <div className="hud-right">
        <Tape
          title="ALTITUDE"
          unit="m"
          side="right"
          stripRef={altStrip}
          valueRef={altValue}
          labels={TAPE_LABELS}
        />
        <div className="vsi">
          <div className="tape-title">VERT SPEED</div>
          <div className="vsi-track">
            <span className="vsi-mark vsi-top">+20</span>
            <span className="vsi-mark vsi-mid">0</span>
            <span className="vsi-mark vsi-bottom">−20</span>
            <div ref={vsiNeedle} className="vsi-needle" />
          </div>
          <div className="tape-value">
            <span ref={vsiValue}>+0.0</span>
            <small>m/s</small>
          </div>
        </div>
      </div>

      {/* Throttle + AoA — bottom left */}
      <div className="hud-panel hud-throttle">
        <div className="tape-title">THROTTLE</div>
        <div className="thr-track">
          <div ref={thrFill} className="thr-fill" />
        </div>
        <span ref={thrValue} className="thr-value">
          0%
        </span>
        <div className="hud-aoa">
          AoA <span ref={aoaValue}>0°</span>
        </div>
      </div>

      {/* Heading — bottom centre */}
      <div className="hud-panel hud-compass">
        <div className="compass-window">
          <div ref={hdgStrip} className="compass-strip">
            {COMPASS_MARKS.map((m) => (
              <span
                key={m.deg}
                className="compass-label"
                style={{ left: (m.deg + 360) * COMPASS_PX }}
              >
                {m.label}
              </span>
            ))}
            {[-360, 0, 360].map((off, i) => (
              <span
                key={off}
                ref={(el) => {
                  compassTargetEls.current[i] = el;
                }}
                className="compass-target"
                style={{ opacity: 0 }}
                aria-hidden="true"
              >
                ◆
              </span>
            ))}
          </div>
          <div className="compass-caret" />
        </div>
        <div className="compass-value">
          <span ref={hdgValue}>000</span>°
        </div>
      </div>

      {/* Artificial horizon — bottom right */}
      <div className="hud-panel hud-horizon-box">
        <div className="horizon">
          <div ref={horizon} className="horizon-inner">
            <div className="horizon-line horizon-plus10" />
            <div className="horizon-line horizon-minus10" />
          </div>
          <div className="horizon-symbol">
            <span className="horizon-wing horizon-wing-left" />
            <span className="horizon-dot" />
            <span className="horizon-wing horizon-wing-right" />
          </div>
        </div>
        <div ref={attitudeValue} className="attitude-value">
          PITCH +0° · ROLL +0°
        </div>
      </div>
    </div>
  );
}
