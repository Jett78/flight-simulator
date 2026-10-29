import { useCallback, useRef, useState } from "react";
import { SceneCanvas } from "./components/SceneCanvas";
import type { FlightState } from "./game/AircraftController";
import type { FlightScene } from "./game/FlightScene";
import "./App.css";

export default function App() {
  const sceneRef = useRef<FlightScene | null>(null);
  const [cameraMode, setCameraMode] = useState("Chase");
  const [telemetry, setTelemetry] = useState<FlightState | null>(null);

  const handleReady = useCallback((scene: FlightScene | null) => {
    sceneRef.current = scene;
    if (scene) {
      scene.onCameraModeChange = (name) => setCameraMode(name);
      scene.onTelemetry = (state) => setTelemetry(state);
    }
  }, []);

  const handleResetCamera = useCallback(() => {
    sceneRef.current?.resetCamera();
  }, []);

  const speedKmh = Math.round((telemetry?.airspeed ?? 0) * 3.6);
  const altitude = Math.round(telemetry?.altitude ?? 0);
  const verticalSpeed = telemetry?.verticalSpeed ?? 0;
  const heading = Math.round(telemetry?.headingDeg ?? 0);
  const throttlePercent = Math.round((telemetry?.throttle ?? 0) * 100);
  const aoa = Math.round(telemetry?.angleOfAttackDeg ?? 0);
  const stalled = (telemetry?.stallFactor ?? 0) > 0.25;

  return (
    <main className="app-shell">
      <SceneCanvas onReady={handleReady} />

      <header className="hud hud-top-left">
        <div className="hud-badge">PHASE 5 · ISLAND ENVIRONMENT</div>
        <h1>Flight Simulator</h1>
        <p>Babylon.js · React · TypeScript · Vite</p>
      </header>

      <aside className="hud hud-top-right" aria-label="Flight controls">
        <ul className="controls-list">
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
            <strong>Shift / Ctrl</strong> throttle up / down
          </li>
          <li>
            <strong>C</strong> camera mode · <strong>R</strong> reset aircraft
          </li>
          <li className="controls-tip">Hold Shift — at ~110 km/h pull S to take off</li>
        </ul>
      </aside>

      <footer className="hud hud-bottom">
        <span className="hud-telemetry">
          <strong>{speedKmh}</strong> km/h
        </span>
        <span className="hud-telemetry">
          Alt <strong>{altitude} m</strong>
        </span>
        <span className="hud-telemetry">
          V/S{" "}
          <strong>
            {verticalSpeed >= 0 ? "+" : ""}
            {verticalSpeed.toFixed(1)} m/s
          </strong>
        </span>
        <span className="hud-telemetry">
          Hdg <strong>{heading}°</strong>
        </span>
        <span className="hud-telemetry">
          Thr <strong>{throttlePercent}%</strong>
        </span>
        <span className="hud-telemetry">
          AoA <strong>{aoa}°</strong>
        </span>
        {stalled && <span className="hud-stall">⚠ STALL</span>}
        <span className="hud-telemetry">
          Camera <strong>{cameraMode}</strong>
        </span>
        <button type="button" className="hud-reset" onClick={handleResetCamera}>
          ⟲ Reset view
        </button>
      </footer>
    </main>
  );
}
