import { SceneCanvas } from "./components/SceneCanvas";
import "./App.css";

export default function App() {
  return (
    <main className="app-shell">
      <SceneCanvas />

      <header className="hud hud-top-left">
        <div className="hud-badge">PHASE 1 · FOUNDATION</div>
        <h1>Flight Simulator</h1>
        <p>Babylon.js · React · TypeScript · Vite</p>
      </header>

      <aside className="hud hud-top-right" aria-label="Scene contents">
        <ul>
          <li>Runway 220m with markings</li>
          <li>Hangars · Terminal · Tower</li>
          <li>Placeholder airplane (primitives)</li>
          <li>Sun shadows + sky lighting</li>
        </ul>
      </aside>

      <footer className="hud hud-bottom">
        <span>
          <strong>Drag</strong> orbit
        </span>
        <span>
          <strong>Scroll</strong> zoom
        </span>
        <span>
          <strong>Right-drag</strong> pan
        </span>
        <span className="hud-note">Flight physics &amp; controls arrive in a later phase</span>
      </footer>
    </main>
  );
}
