import { useCallback, useRef, useState } from "react";
import { SceneCanvas } from "./components/SceneCanvas";
import type { FlightScene } from "./game/FlightScene";
import "./App.css";

export default function App() {
  const sceneRef = useRef<FlightScene | null>(null);
  const [cameraMode, setCameraMode] = useState("Chase");
  const [telemetry, setTelemetry] = useState({ speedKmh: 0, throttlePercent: 0 });

  const handleReady = useCallback((scene: FlightScene | null) => {
    sceneRef.current = scene;
    if (scene) {
      scene.onCameraModeChange = (name) => setCameraMode(name);
      scene.onTelemetry = (speedKmh, throttlePercent) =>
        setTelemetry({ speedKmh, throttlePercent });
    }
  }, []);

  const handleResetCamera = useCallback(() => {
    sceneRef.current?.resetCamera();
  }, []);

  return (
    <main className="app-shell">
      <SceneCanvas onReady={handleReady} />

      <header className="hud hud-top-left">
        <div className="hud-badge">PHASE 3 · KEYBOARD &amp; MOVEMENT</div>
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
        </ul>
      </aside>

      <footer className="hud hud-bottom">
        <span className="hud-telemetry">
          <strong>{telemetry.speedKmh}</strong> km/h
        </span>
        <span className="hud-telemetry">
          Throttle <strong>{telemetry.throttlePercent}%</strong>
        </span>
        <span className="hud-telemetry">
          Camera <strong>{cameraMode}</strong>
        </span>
        <button type="button" className="hud-reset" onClick={handleResetCamera}>
          ⟲ Reset view
        </button>
        <span className="hud-note">No aerodynamics yet — she flies where the nose points</span>
      </footer>
    </main>
  );
}
