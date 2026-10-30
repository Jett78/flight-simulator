import { useCallback, useEffect, useRef, useState } from "react";
import { Hud } from "./components/Hud";
import { SceneCanvas } from "./components/SceneCanvas";
import { AircraftSelect } from "./components/AircraftSelect";
import {
  AIRCRAFT_CATEGORY_LABELS,
  getAircraftConfig,
  loadAircraftChoiceId,
  saveAircraftChoiceId,
  type AircraftCategory,
} from "./game/aircraftConfigs";
import type { EngineSoundKind } from "./game/audio";

/** Per-aircraft engine voice, keyed by category. */
const ENGINE_KIND_BY_CATEGORY: Record<AircraftCategory, EngineSoundKind> = {
  propeller: "prop",
  "commercial-jet": "jet",
  fighter: "fighter",
};
import type { FlightState } from "./game/AircraftController";
import type { FlightScene } from "./game/FlightScene";
import type { CheckpointVisual } from "./game/missions";
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
  // Multi-aircraft Phase 2: the start flow. "select" shows the
  // aircraft selection screen (no scene built yet); "fly" mounts
  // the scene with the chosen aircraft's configuration.
  const [screen, setScreen] = useState<"select" | "fly">("select");
  const [aircraftId, setAircraftId] = useState<string>(() => loadAircraftChoiceId());

  const handleSelectAircraftChoice = useCallback((id: string) => {
    setAircraftId(id);
    saveAircraftChoiceId(id);
  }, []);

  const handleFlyNow = useCallback(() => {
    setPaused(false);
    setScreen("fly");
  }, []);

  const handleChangeAircraft = useCallback(() => {
    setPaused(false);
    setScreen("select");
  }, []);
  const [aircraftVariantId, setAircraftVariantId] = useState("standard");
  const [gamepadConnected, setGamepadConnected] = useState(false);

  const handleReady = useCallback((scene: FlightScene | null) => {
    sceneRef.current = scene;
    if (scene) {
      scene.onCameraModeChange = (name) => setCameraMode(name);
      scene.reportCameraMode(); // sync the chip to the fresh scene's mode
      scene.onGamepadConnectionChange = (connected) => setGamepadConnected(connected);
      setAircraftVariantId(scene.getAircraftVariantId());
      setGamepadConnected(scene.isGamepadConnected());
    }
  }, []);

  const handleSelectAircraft = useCallback((id: string) => {
    sceneRef.current?.setAircraftVariant(id);
    setAircraftVariantId(id);
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

  // P pauses/resumes while flying (the game InputManager leaves
  // KeyP to the UI layer). On the selection screen P does nothing.
  useEffect(() => {
    if (screen !== "fly") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyP" && !event.repeat && !event.metaKey && !event.altKey) {
        handleTogglePause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleTogglePause, screen]);

  if (screen === "select") {
    return (
      <main className="app-shell">
        <AircraftSelect
          selectedId={aircraftId}
          onSelect={handleSelectAircraftChoice}
          onFly={handleFlyNow}
        />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <SceneCanvas aircraftId={aircraftId} onReady={handleReady} />
      <Hud
        getState={getState}
        cameraMode={cameraMode}
        paused={paused}
        onTogglePause={handleTogglePause}
        onResetAircraft={handleResetAircraft}
        onResetView={handleResetView}
        setCheckpoints={handleSetCheckpoints}
        aircraftVariantId={aircraftVariantId}
        onSelectAircraft={handleSelectAircraft}
        gamepadConnected={gamepadConnected}
        aircraftName={getAircraftConfig(aircraftId).name}
        onChangeAircraft={handleChangeAircraft}
        aircraftMaxSpeedKmh={Math.round(getAircraftConfig(aircraftId).maxSpeed * 3.6)}
        rotateKmh={Math.round(getAircraftConfig(aircraftId).stallSpeed * 1.2 * 3.6)}
        aircraftCategoryLabel={
          AIRCRAFT_CATEGORY_LABELS[getAircraftConfig(aircraftId).category]
        }
        aircraftThrustKn={Math.round(getAircraftConfig(aircraftId).thrust / 1000)}
        aircraftStallKmh={Math.round(getAircraftConfig(aircraftId).stallSpeed * 3.6)}
        engineKind={ENGINE_KIND_BY_CATEGORY[getAircraftConfig(aircraftId).category]}
      />
    </main>
  );
}
