import { useCallback, useRef } from "react";
import { SceneCanvas } from "./components/SceneCanvas";
import type { FlightScene } from "./game/FlightScene";
import "./App.css";

export default function App() {
  const sceneRef = useRef<FlightScene | null>(null);

  const handleReady = useCallback((scene: FlightScene | null) => {
    sceneRef.current = scene;
  }, []);

  const handleResetCamera = useCallback(() => {
    sceneRef.current?.resetCamera();
  }, []);

  return (
    <main className="app-shell">
      <SceneCanvas onReady={handleReady} />

      <header className="hud hud-top-left">
        <div className="hud-badge">PHASE 2 · AIRCRAFT &amp; CHASE CAMERA</div>
        <h1>Flight Simulator</h1>
        <p>Babylon.js · React · TypeScript · Vite</p>
      </header>

      <aside className="hud hud-top-right" aria-label="Scene contents">
        <ul>
          <li>Detailed airplane on the runway start</li>
          <li>Smoothed third-person chase camera</li>
          <li>Hangars · Terminal · Tower</li>
          <li>Sun shadows + sky lighting</li>
        </ul>
      </aside>

      <footer className="hud hud-bottom">
        <span className="hud-note-left">Chase camera follows the aircraft</span>
        <button type="button" className="hud-reset" onClick={handleResetCamera}>
          ⟲ Reset camera
        </button>
        <span>
          or press <strong>R</strong>
        </span>
        <span className="hud-note">Flight physics &amp; controls arrive in a later phase</span>
      </footer>
    </main>
  );
}
