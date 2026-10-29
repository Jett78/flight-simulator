import { useEffect, useRef, useState, type RefObject } from "react";
import type { FlightState } from "../game/AircraftController";
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
}

// --- Instrument geometry -------------------------------------------------
const TAPE_MAX = 500; // km/h and m share the same tape scale
const TAPE_PX = 1.1; // px per unit on the tapes
const TAPE_LABELS = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const COMPASS_PX = 2.2; // px per degree on the heading strip
const VSI_MAX = 20; // m/s full-scale on the vertical-speed indicator
const VSI_TRAVEL = 52; // px from centre to full-scale

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
}: {
  title: string;
  unit: string;
  side: "left" | "right";
  stripRef: RefObject<HTMLDivElement | null>;
  valueRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className={`tape tape-${side}`}>
      <div className="tape-title">{title}</div>
      <div className="tape-window">
        <div ref={stripRef} className="tape-strip">
          {TAPE_LABELS.map((v) => (
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
}: HudProps) {
  const [helpOpen, setHelpOpen] = useState(false);

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

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = getState();
      if (!s) return;

      const kmh = s.airspeed * 3.6;
      if (spdValue.current) spdValue.current.textContent = String(Math.round(kmh));
      if (spdStrip.current) {
        const clamped = Math.min(Math.max(kmh, 0), TAPE_MAX);
        spdStrip.current.style.top = `${tapeCenter - (TAPE_MAX - clamped) * TAPE_PX}px`;
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
        stallEl.current.style.opacity = s.stallFactor > 0.25 ? "1" : "0";
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
      if (prevGrounded && !s.grounded) liftoffAt = now;
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
      if (crashEl.current && s.crashed !== crashShown) {
        crashShown = s.crashed;
        crashEl.current.style.display = s.crashed ? "flex" : "none";
        if (s.crashed && crashReasonEl.current) {
          crashReasonEl.current.textContent = s.crashReason;
        }
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
        <div className="hud-badge">PHASE 7 · RUNWAY & LANDING</div>
        <h1>Flight Simulator</h1>
        <div ref={groundChip} className="hud-ground-chip" data-air="false">
          ON GROUND
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
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
          >
            ? Controls
          </button>
        </div>
        {helpOpen && (
          <aside className="hud-panel hud-help" aria-label="Flight controls">
            <ul>
              <li>
                <strong>W / S</strong> pitch — W nose down · S nose up
              </li>
              <li>
                <strong>A / D</strong> roll — bank left / right
              </li>
              <li>
                <strong>Q / E</strong> yaw — left / right
              </li>
              <li>
                <strong>Shift (hold) / Ctrl</strong> throttle — hold Shift for
                power, release and power falls; Ctrl cuts fast
              </li>
              <li>
                <strong>C</strong> camera · <strong>R</strong> reset aircraft ·{" "}
                <strong>P</strong> pause
              </li>
              <li className="hud-help-tip">
                Hold Shift — at ~100 km/h pull S to take off. Land back on
                the runway gently: sink under ~2.5 m/s, wings level.
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
