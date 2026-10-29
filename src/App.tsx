import { useCallback, useEffect, useRef, useState } from "react";
import { Hud } from "./components/Hud";
import { SceneCanvas } from "./components/SceneCanvas";
import type { FlightState } from "./game/AircraftController";
import type { FlightScene } from "./game/FlightScene";
import type { CheckpointVisual } from "./game/missions";
import type { WeatherId } from "./game/environment";
import "./App.css";

/**
 * App shell: the Babylon canvas plus the Phase 6 HUD overlay.
 * Discrete UI state (camera mode, paused) lives here; the
 * instruments themselves are driven by Hud's own rAF loop reading
 * the simulation state directly — no per-frame React renders.
 */
export default function App() {
  const sceneRef = useRef<FlightScene | null>(null);
  const [cameraMode, setCameraMode] = useState("Chase");
  const [paused, setPaused] = useState(false);

  const handleReady = useCallback((scene: FlightScene | null) => {
    sceneRef.current = scene;
    if (scene) {
      scene.onCameraModeChange = (name) => setCameraMode(name);
    }
  }, []);

  const getState = useCallback((): FlightState | null => {
    return sceneRef.current?.getFlightState() ?? null;
  }, []);

  const applyPaused = useCallback((next: boolean) => {
    sceneRef.current?.setPaused(next);
    setPaused(next);
  }, []);

  const handleTogglePause = useCallback(() => {
    applyPaused(!(sceneRef.current?.isPaused ?? false));
  }, [applyPaused]);

  const handleResetAircraft = useCallback(() => {
    sceneRef.current?.resetAircraft();
  }, []);

  const handleResetView = useCallback(() => {
    sceneRef.current?.resetCamera();
  }, []);

  const handleSetCheckpoints = useCallback((visuals: CheckpointVisual[]) => {
    sceneRef.current?.setCheckpoints(visuals);
  }, []);

  const handleSetWeather = useCallback((id: WeatherId) => {
    sceneRef.current?.setWeather(id);
  }, []);

  // P pauses/resumes from anywhere (the game InputManager leaves
  // KeyP to the UI layer).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyP" && !event.repeat && !event.metaKey && !event.altKey) {
        handleTogglePause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleTogglePause]);

  return (
    <main className="app-shell">
      <SceneCanvas onReady={handleReady} />
      <Hud
        getState={getState}
        cameraMode={cameraMode}
        paused={paused}
        onTogglePause={handleTogglePause}
        onResetAircraft={handleResetAircraft}
        onResetView={handleResetView}
        setCheckpoints={handleSetCheckpoints}
        setWeather={handleSetWeather}
      />
    </main>
  );
}
